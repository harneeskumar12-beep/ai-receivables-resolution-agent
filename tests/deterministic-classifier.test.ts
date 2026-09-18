import test from "node:test";
import assert from "node:assert/strict";

import { classifyDeterministically } from "../src/deterministic-classifier.ts";
import type { ConversationMessage, ReceivablesCase } from "../src/types.ts";

function baseCase(over: Partial<ReceivablesCase> = {}): ReceivablesCase {
  return {
    invoice_id: "INV-TEST",
    customer: "Test Co",
    amount: 1000,
    currency: "USD",
    days_overdue: 10,
    invoice_facts: ["Invoice INV-TEST issued 2026-08-01, net-30, due 2026-08-31."],
    conversation_history: [],
    ...over,
  };
}

function msg(body: string, from: ConversationMessage["from"] = "customer"): ConversationMessage {
  return { from, date: "2026-09-05", body };
}

/** Test-local re-derivation of customer message text, independent of the module under test. */
function testCustomerText(c: ReceivablesCase): string {
  return c.conversation_history
    .filter((m) => m.from === "customer")
    .map((m) => m.body)
    .join("\n");
}

test("clear PAYMENT_HELP: 'How do I pay this?' matches, with human approval false", () => {
  const c = baseCase({ conversation_history: [msg("How do I pay this?")] });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "PAYMENT_HELP");
  assert.ok(r.matched && r.decision.human_approval_required === false);
});

test("'How do I pay this?' does NOT become PROMISE_TO_PAY", () => {
  const c = baseCase({ conversation_history: [msg("How do I pay this?")] });
  const r = classifyDeterministically(c);
  assert.ok(r.matched && r.decision.classification !== "PROMISE_TO_PAY");
});

test("clear DISPUTE: explicit dispute language matches, with human approval required", () => {
  const c = baseCase({
    conversation_history: [msg("We dispute this invoice, the service was never delivered.")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "DISPUTE");
  assert.ok(r.matched && r.decision.human_approval_required === true);
});

test("dispute negation: 'We are NOT disputing this invoice' does not become DISPUTE", () => {
  const c = baseCase({ conversation_history: [msg("We are NOT disputing this invoice.")] });
  const r = classifyDeterministically(c);
  // No other rule should confidently fire on this text either.
  assert.equal(r.matched, false);
});

test("clear PROMISE_TO_PAY: a commitment after an initial refusal still matches", () => {
  const c = baseCase({
    conversation_history: [msg("We cannot pay today, but we will pay on Friday.")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "PROMISE_TO_PAY");
});

test("clear PAYMENT_PENDING: payment reported as scheduled/in AP process", () => {
  const c = baseCase({
    conversation_history: [
      msg("Payment was entered in our AP system and is scheduled to send via ACH."),
    ],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "PAYMENT_PENDING");
  // Must never affirmatively claim payment was received (a negated mention,
  // e.g. "has not been received", is fine and expected).
  assert.ok(r.matched && !/we have received|payment received|payment has been received/i.test(r.decision.draft_response));
});

test("clear PARTIAL_PAYMENT: facts explicitly confirm a partial payment and remaining balance", () => {
  const c = baseCase({
    invoice_facts: [
      "Invoice INV-TEST issued 2026-07-27, net-30, due 2026-08-26.",
      "A payment of $4,000.00 was received and reconciled on 2026-09-02.",
      "Remaining balance of $8,000.00 is outstanding as of 2026-09-10.",
    ],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "PARTIAL_PAYMENT");
});

test("clear VERIFY_PAYMENT: customer claims payment, facts do not confirm it", () => {
  const c = baseCase({
    invoice_facts: ["No payment has been received as of 2026-09-10."],
    conversation_history: [msg("We already paid this weeks ago, check your records.")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "VERIFY_PAYMENT");
});

test("'we already paid' does NOT automatically mean RESOLVED", () => {
  const c = baseCase({
    invoice_facts: ["No payment has been received as of 2026-09-10."],
    conversation_history: [msg("We already paid this weeks ago, check your records.")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification !== "RESOLVED");
  assert.ok(r.matched && r.decision.classification === "VERIFY_PAYMENT");
});

test("a payment claim the facts already confirm is left for the LLM path (no RESOLVED rule)", () => {
  const c = baseCase({
    invoice_facts: ["A payment of $1,000.00 was received and reconciled on 2026-09-05."],
    conversation_history: [msg("We already paid this.")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, false);
});

test("contradictory case (paid claim + unpaid admission) returns no deterministic match", () => {
  const c = baseCase({
    invoice_facts: ["No payment has been received as of 2026-09-10."],
    conversation_history: [
      msg("This was paid in full on 2026-07-15, check your bank."),
      msg("We're still waiting on funding from our client and expect to pay you next month."),
    ],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, false);
});

test("an ambiguous, unrelated message returns no deterministic match", () => {
  const c = baseCase({ conversation_history: [msg("Re: your invoice - we need to talk about this.")] });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, false);
});

test("a case with no conversation history and no matching facts returns no deterministic match", () => {
  const c = baseCase();
  const r = classifyDeterministically(c);
  assert.equal(r.matched, false);
});

// --- cleanup iteration regression tests ------------------------------------

test("C14-style: a billing dispute that also contains a promise to pay classifies as DISPUTE, not PROMISE_TO_PAY", () => {
  const c = baseCase({
    conversation_history: [
      msg("We think the total should be $1,200, not $1,800 as billed - but we'll pay once this is corrected."),
    ],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "DISPUTE");
  assert.ok(r.matched && r.decision.human_approval_required === true);
});

test("a plain promise to pay with no dispute language still classifies as PROMISE_TO_PAY", () => {
  const c = baseCase({ conversation_history: [msg("We will pay this invoice on Friday.")] });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "PROMISE_TO_PAY");
  assert.ok(r.matched && r.decision.human_approval_required === false);
});

test("deterministic evidence contains only source-supported, verbatim matched text", () => {
  const disputeCase = baseCase({
    conversation_history: [msg("We dispute this invoice, the service was never delivered.")],
  });
  const disputeResult = classifyDeterministically(disputeCase);
  assert.equal(disputeResult.matched, true);
  assert.ok(
    disputeResult.matched &&
      disputeResult.decision.evidence.every((e) =>
        testCustomerText(disputeCase).toLowerCase().includes(e.toLowerCase()),
      ),
  );

  const promiseCase = baseCase({ conversation_history: [msg("We will pay this invoice on Friday.")] });
  const promiseResult = classifyDeterministically(promiseCase);
  assert.equal(promiseResult.matched, true);
  assert.ok(
    promiseResult.matched &&
      promiseResult.decision.evidence.every((e) =>
        testCustomerText(promiseCase).toLowerCase().includes(e.toLowerCase()),
      ),
  );
});

test("no wrapper prose ('Customer message included:', 'Case text included:', 'The customer stated:') appears in evidence", () => {
  const cases: ReceivablesCase[] = [
    baseCase({ conversation_history: [msg("How do I pay this?")] }),
    baseCase({ conversation_history: [msg("We dispute this invoice, the service was never delivered.")] }),
    baseCase({ conversation_history: [msg("We will pay this invoice on Friday.")] }),
    baseCase({
      conversation_history: [
        msg("Payment was entered in our AP system and is scheduled to send via ACH."),
      ],
    }),
    baseCase({
      invoice_facts: ["No payment has been received as of 2026-09-10."],
      conversation_history: [msg("We already paid this weeks ago, check your records.")],
    }),
  ];
  for (const c of cases) {
    const r = classifyDeterministically(c);
    assert.equal(r.matched, true);
    for (const e of (r.matched ? r.decision.evidence : [])) {
      assert.ok(!/customer message included|case text included|the customer stated/i.test(e));
    }
  }
});

// --- Fix 1 (C16): payment already sent but still in transit -> PAYMENT_PENDING, not VERIFY_PAYMENT ---

test("Fix 1: 'transfer has been sent; confirmation is attached' classifies as PAYMENT_PENDING", () => {
  const c = baseCase({
    conversation_history: [msg("The transfer has been sent; confirmation is attached.")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "PAYMENT_PENDING");
});

test("Fix 1: 'we sent the transfer and are waiting for it to settle' classifies as PAYMENT_PENDING", () => {
  const c = baseCase({
    conversation_history: [msg("We sent the transfer and are waiting for it to settle.")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "PAYMENT_PENDING");
});

test("Fix 1 (C16 case text): 'transfer sent this morning - confirmation attached' is PAYMENT_PENDING", () => {
  const c = baseCase({
    conversation_history: [
      msg("Transfer sent this morning - confirmation TRX-55019 attached. Should be with you tomorrow."),
    ],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "PAYMENT_PENDING");
  assert.ok(r.matched && r.decision.human_approval_required === false);
});

test("Fix 1 guard: a bare payment claim with no in-transit language may still require VERIFY_PAYMENT", () => {
  const c = baseCase({
    invoice_facts: ["No payment has been received as of 2026-09-10."],
    conversation_history: [msg("We paid this last week, can you confirm receipt?")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "VERIFY_PAYMENT");
});

// --- Fix 2 (C18): recipient/identity mismatch -> HUMAN_REQUIRED, outranks DISPUTE ---

test("Fix 2: 'you have the wrong company... no account or contract with you' classifies as HUMAN_REQUIRED", () => {
  const c = baseCase({
    conversation_history: [
      msg("You have the wrong company. This LLC has no account or contract with you. Please stop sending us these."),
    ],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "HUMAN_REQUIRED");
  assert.ok(r.matched && r.decision.human_approval_required === true);
});

test("Fix 2: identity mismatch outranks an ordinary dispute phrase in the same message", () => {
  const c = baseCase({
    conversation_history: [msg("We dispute this invoice - it was sent to the wrong account entirely.")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "HUMAN_REQUIRED");
});

test("Fix 2 guard: an ordinary disagreement with no identity/recipient language is not forced to HUMAN_REQUIRED", () => {
  const c = baseCase({
    conversation_history: [msg("We dispute this invoice, the service was never delivered.")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "DISPUTE");
});

// --- Fix 3 (C20): pure customer silence -> FOLLOW_UP, no escalation ---

test("Fix 3: prior reminders with no customer response classify as FOLLOW_UP, not escalated", () => {
  const c = baseCase({
    invoice_facts: [
      "Invoice INV-TEST issued 2026-06-26, net-30, due 2026-07-26.",
      "Unpaid as of 2026-09-10.",
      "Four reminders were sent.",
      "No response has ever been received. No dispute is on file.",
    ],
    conversation_history: [msg("Fourth reminder: invoice INV-TEST is now past due. Please respond.", "collections_agent")],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "FOLLOW_UP");
  assert.ok(r.matched && r.decision.human_approval_required === false);
});

test("Fix 3 guard: a case with an actual customer reply is never treated as silence", () => {
  const c = baseCase({
    invoice_facts: ["No response has ever been received. No dispute is on file."],
    conversation_history: [
      msg("Reminder sent.", "collections_agent"),
      msg("Will clear this next week."),
    ],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, false);
});

// --- production incident: "promise to pay" phrasing was missing from PROMISE_TO_PAY_PHRASES ---

test('real-world conversation ("We promise to pay the full invoice on 2026-09-20.") classifies as PROMISE_TO_PAY without calling the provider', () => {
  const c = baseCase({
    conversation_history: [
      msg("Friendly reminder that invoice TEST-001 is past due.", "collections_agent"),
      msg("We promise to pay the full invoice on 2026-09-20."),
    ],
  });
  const r = classifyDeterministically(c);
  assert.equal(r.matched, true);
  assert.ok(r.matched && r.decision.classification === "PROMISE_TO_PAY");
  assert.ok(r.matched && r.decision.human_approval_required === false);
});

test("existing deterministic rules still pass unaffected by the DISPUTE_PHRASES and evidence-format changes", () => {
  const paymentHelp = classifyDeterministically(baseCase({ conversation_history: [msg("How do I pay this?")] }));
  assert.ok(paymentHelp.matched && paymentHelp.decision.classification === "PAYMENT_HELP");

  const pending = classifyDeterministically(
    baseCase({
      conversation_history: [
        msg("Payment was entered in our AP system and is scheduled to send via ACH."),
      ],
    }),
  );
  assert.ok(pending.matched && pending.decision.classification === "PAYMENT_PENDING");

  const partial = classifyDeterministically(
    baseCase({
      invoice_facts: [
        "Invoice INV-TEST issued 2026-07-27, net-30, due 2026-08-26.",
        "A payment of $4,000.00 was received and reconciled on 2026-09-02.",
        "Remaining balance of $8,000.00 is outstanding as of 2026-09-10.",
      ],
    }),
  );
  assert.ok(partial.matched && partial.decision.classification === "PARTIAL_PAYMENT");

  const verify = classifyDeterministically(
    baseCase({
      invoice_facts: ["No payment has been received as of 2026-09-10."],
      conversation_history: [msg("We already paid this weeks ago, check your records.")],
    }),
  );
  assert.ok(verify.matched && verify.decision.classification === "VERIFY_PAYMENT");
});
