/**
 * Deterministic-first classifier: recognizes a small set of unambiguous
 * receivables situations directly from the case, with no provider call and no
 * LLM involved. Pure and deterministic - no I/O, no randomness, no network,
 * no dependency on safety.ts, provider.ts, or any other module (kept
 * intentionally isolated, per the brief).
 *
 * This module NEVER bypasses the safety layer. It only PROPOSES a decision -
 * ReceivablesAgent still returns it in the exact same shape an LLM-produced
 * decision would be returned in, so every existing caller runs it through the
 * unmodified, existing validateDecision() exactly as before. If this
 * classifier cannot confidently distinguish the situation - including any
 * hint of contradictory signals - it returns `{ matched: false }` and the
 * existing LLM path handles the case, with safety.ts as the backstop either
 * way.
 */

import type {
  ReceivablesCase,
  ReceivablesClassification,
  ReceivablesDecision,
} from "./types.ts";

export type DeterministicResult =
  | { readonly matched: false }
  | {
      readonly matched: true;
      readonly decision: ReceivablesDecision;
      readonly reason: string;
      readonly confidence: number;
    };

// --- small, self-contained negation-aware phrase matching -------------------
// Deliberately independent of safety.ts's own (private) negation helper, to
// keep this module isolated - same 3-word-window spirit, separate code.

const NEGATION_WORDS = new Set([
  "no",
  "not",
  "never",
  "isn't",
  "wasn't",
  "aren't",
  "weren't",
  "doesn't",
  "don't",
  "didn't",
  "won't",
  "wouldn't",
  "cannot",
  "can't",
  "without",
]);

function lc(s: string): string {
  return s.toLowerCase();
}

function isNegatedBefore(haystack: string, matchIndex: number): boolean {
  const before = haystack.slice(Math.max(0, matchIndex - 30), matchIndex);
  const words = before
    .replace(/[^a-z0-9' ]/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lastWords = words.slice(-3);
  return lastWords.some((w) => NEGATION_WORDS.has(lc(w)));
}

/** Does `text` contain any phrase, not immediately preceded (within 3 words) by a negation word? Returns the matched phrase, or null. */
function findUnnegatedPhrase(text: string, phrases: readonly string[]): string | null {
  const h = lc(text);
  for (const phrase of phrases) {
    let idx = h.indexOf(phrase);
    while (idx !== -1) {
      if (!isNegatedBefore(h, idx)) return phrase;
      idx = h.indexOf(phrase, idx + 1);
    }
  }
  return null;
}

function customerText(rc: ReceivablesCase): string {
  return rc.conversation_history
    .filter((m) => m.from === "customer")
    .map((m) => m.body)
    .join("\n");
}

function factsText(rc: ReceivablesCase): string {
  return rc.invoice_facts.join("\n");
}

// --- contradiction guard: never confidently match on a contradictory case ---
// Narrow and deliberately duplicated rather than imported from safety.ts (see
// module isolation note above) - just enough to avoid a confident wrong
// answer; safety.ts's own, more thorough contradiction handling still applies
// via the normal LLM path whenever this guard defers.

const PAID_CLAIM_PHRASES: readonly string[] = [
  "paid in full",
  "already paid",
  "we paid this",
  "payment was made",
  "settled this invoice",
];

const UNPAID_ADMISSION_PHRASES: readonly string[] = [
  "waiting on funding",
  "waiting on funds",
  "cash flow is tight",
  "will pay you next month",
  "expect to pay you next month",
  "haven't paid",
  "have not paid yet",
  "unable to pay right now",
];

function hasContradictionSignal(rc: ReceivablesCase): boolean {
  const text = lc(`${factsText(rc)}\n${rc.conversation_history.map((m) => m.body).join("\n")}`);
  const paidClaim = PAID_CLAIM_PHRASES.some((p) => text.includes(p));
  const unpaidAdmission = UNPAID_ADMISSION_PHRASES.some((p) => text.includes(p));
  return paidClaim && unpaidAdmission;
}

// --- rule phrase sets --------------------------------------------------

const PAYMENT_HELP_PHRASES: readonly string[] = [
  "how can i pay",
  "how do i pay",
  "how do we pay",
  "where can i pay",
  "where do i pay",
  "payment instructions",
  "payment method",
  "send me the payment details",
  "send payment instructions",
  "best way to pay",
  "how to pay",
];

const DISPUTE_PHRASES: readonly string[] = [
  "we dispute this invoice",
  "we dispute the invoice",
  "we dispute this",
  "disputing this invoice",
  "disputing the invoice",
  "we disagree with this invoice",
  "the invoice is incorrect",
  "services were not delivered",
  "we will not pay because",
  "this invoice is wrong",
  "we do not owe",
  "we don't owe",
  // A customer contesting the billed amount ("the total should be X, not Y")
  // is disputing the invoice even when the same message also promises to pay
  // the amount they believe is actually owed - dispute must be recognized
  // before a PROMISE_TO_PAY phrase elsewhere in the same message can match
  // (tryDispute is checked before tryPromiseToPay, below).
  "total should be",
];

const PROMISE_TO_PAY_PHRASES: readonly string[] = [
  "we will pay",
  "we'll pay",
  "payment will be made",
  "i will pay",
  "i'll pay",
  "we will make payment",
  "we will settle this",
];

const PAYMENT_PENDING_PHRASES: readonly string[] = [
  "in accounts payable",
  "in our ap system",
  "ap cycle",
  "awaiting internal processing",
  "payment is scheduled",
  "payment has been scheduled",
  "scheduled to send",
  "scheduled via ach",
  "payment is processing",
  "payment is in process",
  // A transfer/payment the customer says has already been SENT but is still
  // in transit/settling is payment-in-progress, not an unverified claim of a
  // completed payment (that distinction is what separates PAYMENT_PENDING
  // from VERIFY_PAYMENT here - see tryVerifyPayment below, checked later).
  "transfer sent",
  "transfer has been sent",
  "sent the transfer",
  "waiting for it to settle",
];

// A customer/recipient identity or account mismatch - "you have the wrong
// company", "this isn't our account" - is not an ordinary billing dispute:
// it needs a human to resolve who the invoice actually belongs to. Checked
// before tryDispute (and before every other rule) so it always outranks a
// DISPUTE match on the same message. Deliberately narrow - see the guard
// note above hasContradictionSignal's spirit: only unambiguous
// identity/recipient mismatch language, not general disagreement.
const IDENTITY_MISMATCH_PHRASES: readonly string[] = [
  "wrong company",
  "wrong customer",
  "wrong account",
  "no account with you",
  "no account or contract",
  "recipient name does not match",
  "sent to the wrong account",
  "sent to the wrong customer",
  "for another entity",
  "not our account",
];

// A prior reminder went out and the customer simply never replied - no
// dispute, no identity issue, no other signal. This is checked LAST, after
// every other rule, and additionally requires there to be no customer
// messages at all in the conversation, so any case where the customer
// actually said something (a dispute, a promise, a plan request, etc.)
// already matched an earlier, more specific rule and never reaches this one.
const SILENCE_PHRASES: readonly string[] = [
  "no response has ever been received",
  "no response received",
  "no response",
  "no reply",
  "have not responded",
  "has not responded",
  "hasn't responded",
  "haven't heard back",
  "has not replied",
];

const PAYMENT_CLAIM_PHRASES: readonly string[] = [
  "we already paid",
  "already paid",
  "we paid this",
  "payment was made",
  "we've paid",
  "we have paid",
];

const PAYMENT_CONFIRMED_FACT_PHRASES: readonly string[] = [
  "payment received",
  "paid in full",
  "reconciled",
  "payment posted",
  "payment cleared",
  "funds received",
  "marked as paid",
  "balance settled",
  "invoice closed",
];

const PAYMENT_NOT_CONFIRMED_PHRASES: readonly string[] = [
  "no payment",
  "not received",
  "no record of payment",
  "has not been received",
  "not yet reconciled",
  "not reconciled",
  "outstanding",
  "unpaid",
  "not been paid",
];

function factsConfirmPayment(rc: ReceivablesCase): boolean {
  return rc.invoice_facts.some((f) => {
    const l = lc(f);
    const positive = PAYMENT_CONFIRMED_FACT_PHRASES.some((p) => l.includes(p));
    const negated = PAYMENT_NOT_CONFIRMED_PHRASES.some((n) => l.includes(n));
    return positive && !negated;
  });
}

// --- shared decision scaffolding ----------------------------------------

interface DecisionFields {
  situation: string;
  classification: ReceivablesClassification;
  evidence: string[];
  recommended_action: string;
  draft_response: string;
  human_approval_required: boolean;
  reason_for_handoff: string | null;
}

function buildDecision(rc: ReceivablesCase, fields: DecisionFields): ReceivablesDecision {
  return {
    invoice_id: rc.invoice_id,
    customer: rc.customer,
    amount: rc.amount,
    days_overdue: rc.days_overdue,
    confidence: 0.95,
    ...fields,
  };
}

// --- rules, checked in priority order ------------------------------------

function tryPaymentHelp(rc: ReceivablesCase): DeterministicResult | null {
  const match = findUnnegatedPhrase(customerText(rc), PAYMENT_HELP_PHRASES);
  if (!match) return null;
  const decision = buildDecision(rc, {
    situation: `Customer asked how to pay invoice ${rc.invoice_id}.`,
    classification: "PAYMENT_HELP",
    // Verbatim matched text only - no wrapper prose ("Customer message
    // included:" etc.) that would dilute safety.ts's evidence token-overlap
    // check with words that aren't actually in the case.
    evidence: [match],
    recommended_action: "provide_payment_instructions",
    draft_response: `Thank you for reaching out about invoice ${rc.invoice_id}. We will share the accepted payment methods for this invoice shortly.`,
    human_approval_required: false,
    reason_for_handoff: null,
  });
  return { matched: true, decision, reason: `Customer asked how to pay ("${match}").`, confidence: 0.95 };
}

function tryIdentityMismatch(rc: ReceivablesCase): DeterministicResult | null {
  const match = findUnnegatedPhrase(customerText(rc), IDENTITY_MISMATCH_PHRASES);
  if (!match) return null;
  const decision = buildDecision(rc, {
    situation: `Customer indicates a recipient/account identity mismatch on invoice ${rc.invoice_id} ("${match}").`,
    classification: "HUMAN_REQUIRED",
    evidence: [match],
    recommended_action: "escalate_to_human_for_identity_review",
    draft_response:
      "Thank you for flagging this. This needs review by a member of our accounts receivable team to confirm the correct account before we respond further. A colleague will follow up with you directly.",
    human_approval_required: true,
    reason_for_handoff: "Recipient/account identity mismatch requires human review.",
  });
  return { matched: true, decision, reason: `Identity/recipient mismatch language ("${match}").`, confidence: 0.95 };
}

function tryDispute(rc: ReceivablesCase): DeterministicResult | null {
  const match = findUnnegatedPhrase(customerText(rc), DISPUTE_PHRASES);
  if (!match) return null;
  const decision = buildDecision(rc, {
    situation: `Customer disputes invoice ${rc.invoice_id} ("${match}").`,
    classification: "DISPUTE",
    // Verbatim matched text only - see the note in tryPaymentHelp above.
    evidence: [match],
    recommended_action: "escalate_to_human_for_dispute",
    draft_response:
      "Thank you for letting us know. This account needs review by a member of our accounts receivable team before we can respond further. A colleague will follow up with you directly.",
    human_approval_required: true,
    reason_for_handoff: "Customer dispute requires human approval.",
  });
  return { matched: true, decision, reason: `Clear dispute language ("${match}").`, confidence: 0.97 };
}

function tryPromiseToPay(rc: ReceivablesCase): DeterministicResult | null {
  const match = findUnnegatedPhrase(customerText(rc), PROMISE_TO_PAY_PHRASES);
  if (!match) return null;
  const decision = buildDecision(rc, {
    situation: `Customer committed to paying invoice ${rc.invoice_id} ("${match}").`,
    classification: "PROMISE_TO_PAY",
    // Verbatim matched text only - see the note in tryPaymentHelp above.
    evidence: [match],
    recommended_action: "acknowledge_promise_to_pay",
    draft_response: `Thank you for confirming payment for invoice ${rc.invoice_id}. We will follow up if it has not been received.`,
    human_approval_required: false,
    reason_for_handoff: null,
  });
  return { matched: true, decision, reason: `Explicit promise to pay ("${match}").`, confidence: 0.9 };
}

function tryPaymentPending(rc: ReceivablesCase): DeterministicResult | null {
  const combined = `${customerText(rc)}\n${factsText(rc)}`;
  const match = findUnnegatedPhrase(combined, PAYMENT_PENDING_PHRASES);
  if (!match) return null;
  const decision = buildDecision(rc, {
    situation: `Payment for invoice ${rc.invoice_id} is reported in progress but not yet received ("${match}").`,
    classification: "PAYMENT_PENDING",
    // Verbatim matched text only - see the note in tryPaymentHelp above.
    evidence: [match],
    recommended_action: "wait_and_monitor",
    draft_response: `Thank you for the update on invoice ${rc.invoice_id}. We will monitor for the payment and follow up if it has not been received.`,
    human_approval_required: false,
    reason_for_handoff: null,
  });
  return {
    matched: true,
    decision,
    reason: `Payment reported as scheduled/in-process, not received ("${match}").`,
    confidence: 0.9,
  };
}

function tryPartialPayment(rc: ReceivablesCase): DeterministicResult | null {
  const facts = factsText(rc);
  const receivedMatch = /payment of \$[\d,]+(?:\.\d{2})?\s+(?:was\s+)?(?:received|reconciled)/i.exec(facts);
  const outstandingMatch = /remaining balance of \$[\d,]+(?:\.\d{2})?\s+is\s+outstanding/i.exec(facts);
  if (!receivedMatch || !outstandingMatch) return null;
  const decision = buildDecision(rc, {
    situation: `A partial payment for invoice ${rc.invoice_id} has been received; a balance remains outstanding.`,
    classification: "PARTIAL_PAYMENT",
    evidence: [receivedMatch[0], outstandingMatch[0]],
    recommended_action: "acknowledge_partial_payment",
    draft_response: `Thank you for the partial payment on invoice ${rc.invoice_id}. We will follow up regarding the remaining balance.`,
    human_approval_required: false,
    reason_for_handoff: null,
  });
  return {
    matched: true,
    decision,
    reason: "Invoice facts explicitly confirm a partial payment and a known remaining balance.",
    confidence: 0.95,
  };
}

function tryVerifyPayment(rc: ReceivablesCase): DeterministicResult | null {
  const claim = findUnnegatedPhrase(customerText(rc), PAYMENT_CLAIM_PHRASES);
  if (!claim) return null;
  if (factsConfirmPayment(rc)) return null; // already confirmed - not this classifier's job
  const decision = buildDecision(rc, {
    situation: `Customer states invoice ${rc.invoice_id} was already paid; the case facts do not confirm this.`,
    classification: "VERIFY_PAYMENT",
    // Verbatim matched text only - see the note in tryPaymentHelp above.
    evidence: [claim],
    recommended_action: "request_remittance_details",
    draft_response:
      "Thank you for letting us know. We do not yet see this payment matched against the invoice on our side. Could you send the remittance details or payment reference so we can trace and confirm it? We will not treat the invoice as settled until it is matched.",
    human_approval_required: false,
    reason_for_handoff: null,
  });
  return {
    matched: true,
    decision,
    reason: `Customer claims payment was made ("${claim}"), but the case facts do not confirm it.`,
    confidence: 0.9,
  };
}

function trySilence(rc: ReceivablesCase): DeterministicResult | null {
  const hasCustomerMessage = rc.conversation_history.some((m) => m.from === "customer");
  if (hasCustomerMessage) return null; // a real customer message means this is not pure silence
  const match = findUnnegatedPhrase(factsText(rc), SILENCE_PHRASES);
  if (!match) return null;
  const decision = buildDecision(rc, {
    situation: `No response has been received to prior outreach on invoice ${rc.invoice_id}.`,
    classification: "FOLLOW_UP",
    evidence: [match],
    recommended_action: "send_standard_follow_up",
    draft_response: `Following up again on invoice ${rc.invoice_id}, which remains outstanding. Please let us know if you have any questions.`,
    human_approval_required: false,
    reason_for_handoff: null,
  });
  return {
    matched: true,
    decision,
    reason: `No customer response on file, no other signal present ("${match}").`,
    confidence: 0.9,
  };
}

/**
 * Attempt to classify a case deterministically. Returns `{ matched: false }`
 * for anything other than one of the narrow, high-confidence patterns below
 * - including any hint of contradictory signals (a payment claim alongside an
 * unpaid admission) - so ambiguous cases always fall through to the existing
 * LLM + safety pipeline rather than being guessed at here.
 */
export function classifyDeterministically(rc: ReceivablesCase): DeterministicResult {
  if (hasContradictionSignal(rc)) {
    return { matched: false };
  }

  const rules = [
    tryIdentityMismatch,
    tryPaymentHelp,
    tryDispute,
    tryPromiseToPay,
    tryPaymentPending,
    tryPartialPayment,
    tryVerifyPayment,
    trySilence,
  ];
  for (const rule of rules) {
    const result = rule(rc);
    if (result) return result;
  }
  return { matched: false };
}
