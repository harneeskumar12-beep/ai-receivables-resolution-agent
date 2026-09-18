import test from "node:test";
import assert from "node:assert/strict";

import { validateDecision } from "../src/safety.ts";
import type { ConversationMessage, ReceivablesCase, ReceivablesDecision } from "../src/types.ts";

function baseCase(over: Partial<ReceivablesCase> = {}): ReceivablesCase {
  return {
    invoice_id: "INV-TEST",
    customer: "Test Co",
    amount: 1000,
    currency: "USD",
    days_overdue: 10,
    invoice_facts: [
      "Invoice INV-TEST issued 2026-08-01, net-30, due 2026-08-31.",
      "No payment received as of 2026-09-10.",
    ],
    conversation_history: [],
    ...over,
  };
}

function msg(body: string, from: ConversationMessage["from"] = "customer"): ConversationMessage {
  return { from, date: "2026-09-05", body };
}

function baseDecision(over: Partial<ReceivablesDecision> = {}): ReceivablesDecision {
  return {
    invoice_id: "INV-TEST",
    customer: "Test Co",
    amount: 1000,
    days_overdue: 10,
    situation: "The invoice is 10 days overdue and no payment has been received.",
    classification: "FOLLOW_UP",
    confidence: 0.8,
    evidence: ["No payment received as of 2026-09-10."],
    recommended_action: "send_standard_follow_up",
    draft_response: "A friendly reminder that invoice INV-TEST is now past due.",
    human_approval_required: false,
    reason_for_handoff: null,
    ...over,
  };
}

test("a clean follow-up decision is left unchanged", () => {
  const r = validateDecision(baseCase(), baseDecision());
  assert.equal(r.safe, true);
  assert.equal(r.overridden, false);
  assert.equal(r.violations.length, 0);
});

test("dispute forces human approval and blocks progression", () => {
  const c = baseCase({
    conversation_history: [msg("We are disputing this invoice in full. The work was never delivered.")],
  });
  const r = validateDecision(c, baseDecision({ classification: "FOLLOW_UP", human_approval_required: false }));
  assert.equal(r.decision.human_approval_required, true);
  assert.equal(r.decision.classification, "DISPUTE");
  assert.equal(r.overridden, true);
});

test("payment-plan request requires human approval", () => {
  const c = baseCase({
    conversation_history: [msg("Can we split this into three equal monthly payments?")],
  });
  const r = validateDecision(c, baseDecision({ human_approval_required: false }));
  assert.equal(r.decision.human_approval_required, true);
});

test("autonomous payment-plan negotiation is a critical violation", () => {
  const c = baseCase({ conversation_history: [msg("Can we set up a payment plan?")] });
  const r = validateDecision(
    c,
    baseDecision({
      draft_response: "Yes, we can offer a plan: first instalment of $300 next month, then two more.",
      human_approval_required: false,
    }),
  );
  assert.ok(
    r.violations.some((v) => v.code === "AUTONOMOUS_PAYMENT_PLAN_NEGOTIATION" && v.severity === "critical"),
  );
  assert.notEqual(r.decision.draft_response, "Yes, we can offer a plan: first instalment of $300 next month, then two more.");
});

// --- payment-plan safety gap: natural split-payment phrasing with no ----------
// --- literal "instalment"/"split"/"payment plan" keyword ----------------------

test("reproduction case: 'pay $500 today and the remaining $1,000 next month' requires human approval", () => {
  const c = baseCase({
    conversation_history: [
      msg("I can't pay the full $1,500 right now. Can I pay $500 today and the remaining $1,000 next month?"),
    ],
  });
  const r = validateDecision(c, baseDecision({ classification: "CUSTOMER_REQUEST", human_approval_required: false }));
  assert.equal(r.decision.human_approval_required, true);
});

test("'pay part now and the rest later' requires human approval", () => {
  const c = baseCase({ conversation_history: [msg("Can I pay part now and the rest later?")] });
  const r = validateDecision(c, baseDecision({ classification: "CUSTOMER_REQUEST", human_approval_required: false }));
  assert.equal(r.decision.human_approval_required, true);
});

test("'pay $500 now and the balance next month' requires human approval", () => {
  const c = baseCase({ conversation_history: [msg("I can pay $500 now and the balance next month.")] });
  const r = validateDecision(c, baseDecision({ classification: "CUSTOMER_REQUEST", human_approval_required: false }));
  assert.equal(r.decision.human_approval_required, true);
});

test("autonomous negotiation of a 'now and the remaining' split-payment request is still a critical violation", () => {
  const c = baseCase({
    conversation_history: [msg("Can I pay $500 today and the remaining $1,000 next month?")],
  });
  const r = validateDecision(
    c,
    baseDecision({
      classification: "CUSTOMER_REQUEST",
      draft_response: "Yes, we can accept that - $500 now and the rest next month works for us.",
      human_approval_required: false,
    }),
  );
  assert.ok(
    r.violations.some((v) => v.code === "AUTONOMOUS_PAYMENT_PLAN_NEGOTIATION" && v.severity === "critical"),
  );
  assert.equal(r.decision.human_approval_required, true);
  assert.notEqual(
    r.decision.draft_response,
    "Yes, we can accept that - $500 now and the rest next month works for us.",
  );
});

test("contradictory information is escalated for human review", () => {
  const c = baseCase({
    conversation_history: [
      msg("This was paid in full on 2026-07-15."),
      msg("We're still waiting on funding and expect to pay you next month."),
    ],
  });
  const r = validateDecision(c, baseDecision({ classification: "PROMISE_TO_PAY", human_approval_required: false }));
  assert.equal(r.decision.human_approval_required, true);
  assert.ok(r.violations.some((v) => v.code === "CONTRADICTION_REQUIRES_REVIEW"));
});

test("low-confidence decision is forced to HUMAN_REQUIRED", () => {
  const c = baseCase({ conversation_history: [msg("We need to talk about this invoice.")] });
  const r = validateDecision(
    c,
    baseDecision({ classification: "FOLLOW_UP", confidence: 0.2, human_approval_required: false }),
  );
  assert.equal(r.decision.classification, "HUMAN_REQUIRED");
  assert.equal(r.decision.human_approval_required, true);
});

test("payment claim without evidence never resolves the invoice", () => {
  const c = baseCase({
    conversation_history: [msg("We already paid this weeks ago, check your records.")],
  });
  const r = validateDecision(
    c,
    baseDecision({
      classification: "RESOLVED",
      draft_response: "Thank you for your payment, your account is now settled.",
      confidence: 0.9,
    }),
  );
  assert.equal(r.decision.classification, "VERIFY_PAYMENT");
  assert.ok(r.violations.some((v) => v.code === "FALSE_PAYMENT_CONFIRMATION" && v.severity === "critical"));
  // Regression: this existing VERIFY_PAYMENT-producing case (reached via
  // Rule 5's RESOLVED reclassification, not a raw VERIFY_PAYMENT classification)
  // now also requires human approval, per Rule 10 below.
  assert.equal(r.decision.human_approval_required, true);
  assert.ok(r.violations.some((v) => v.code === "VERIFY_PAYMENT_REQUIRES_APPROVAL"));
});

// --- VERIFY_PAYMENT is inherently uncertain: an unverified customer payment --
// --- claim must always require human approval, regardless of source. --------

test("an unverified payment claim ('I thought we already paid this') requires human approval", () => {
  const c = baseCase({
    invoice_facts: ["No payment has been received as of 2026-09-10."],
    conversation_history: [
      msg("I thought we already paid this. Can you check with your accounts team? I don't want to pay it twice."),
    ],
  });
  const r = validateDecision(
    c,
    baseDecision({
      classification: "VERIFY_PAYMENT",
      evidence: ["we already paid"],
      draft_response:
        "Thank you for letting us know. We do not yet see this payment matched against the invoice on our side. Could you send the remittance details or payment reference so we can trace and confirm it? We will not treat the invoice as settled until it is matched.",
      human_approval_required: false,
    }),
  );
  assert.equal(r.decision.classification, "VERIFY_PAYMENT");
  assert.equal(r.decision.human_approval_required, true);
  assert.ok(r.violations.some((v) => v.code === "VERIFY_PAYMENT_REQUIRES_APPROVAL"));
  assert.equal(r.overridden, true);
});

test("VERIFY_PAYMENT with human_approval_required already true is left unchanged, no duplicate violation", () => {
  const c = baseCase({
    conversation_history: [msg("We already paid this weeks ago, check your records.")],
  });
  const r = validateDecision(
    c,
    baseDecision({ classification: "VERIFY_PAYMENT", evidence: ["already paid"], human_approval_required: true }),
  );
  assert.equal(r.decision.human_approval_required, true);
  assert.ok(!r.violations.some((v) => v.code === "VERIFY_PAYMENT_REQUIRES_APPROVAL"));
});

test("legal threats are stripped and escalated", () => {
  const r = validateDecision(
    baseCase(),
    baseDecision({
      draft_response: "Pay within 48 hours or we will pursue legal action and refer this to a collection agency.",
      human_approval_required: false,
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "LEGAL_THREAT" && v.severity === "critical"));
  assert.equal(r.decision.human_approval_required, true);
  assert.ok(!/legal action/i.test(r.decision.draft_response));
});

test("aggressive collection on a dispute is a critical violation", () => {
  const c = baseCase({
    conversation_history: [msg("We dispute this invoice, the service was never delivered.")],
  });
  const r = validateDecision(
    c,
    baseDecision({
      recommended_action: "demand immediate payment",
      draft_response: "Final demand: pay now or we will escalate to collections.",
      human_approval_required: false,
    }),
  );
  assert.ok(
    r.violations.some((v) => v.code === "AGGRESSIVE_COLLECTION_ON_DISPUTE" && v.severity === "critical"),
  );
  assert.equal(r.decision.human_approval_required, true);
});

// --- V0 correction pass: negation-aware dispute/plan detection -----------------

test("a fact stating 'No dispute has been raised' does not trigger dispute safety (C10 regression)", () => {
  const c = baseCase({
    invoice_facts: [
      "Invoice INV-TEST issued 2026-08-01, net-30, due 2026-08-31.",
      "Unpaid as of 2026-09-10.",
      "No dispute has been raised.",
    ],
    conversation_history: [msg("Sorry, still sorting cash flow.")],
  });
  const r = validateDecision(c, baseDecision({ classification: "ESCALATE", human_approval_required: true }));
  assert.equal(r.decision.classification, "ESCALATE");
  assert.ok(!r.violations.some((v) => v.code === "DISPUTE_NOT_CLASSIFIED"));
  assert.ok(!r.violations.some((v) => v.code === "AGGRESSIVE_COLLECTION_ON_DISPUTE"));
});

test("a fact stating 'No dispute is on file' does not trigger dispute safety (C20 regression)", () => {
  const c = baseCase({
    invoice_facts: [
      "Invoice INV-TEST issued 2026-08-01, net-30, due 2026-08-31.",
      "Unpaid as of 2026-09-10.",
      "Four reminders were sent. No response has ever been received. No dispute is on file.",
    ],
    conversation_history: [
      msg("Fourth reminder: this invoice is now 44 days past due. Please respond.", "collections_agent"),
    ],
  });
  const r = validateDecision(c, baseDecision({ classification: "FOLLOW_UP", human_approval_required: false }));
  assert.equal(r.decision.classification, "FOLLOW_UP");
  assert.equal(r.decision.human_approval_required, false);
  assert.equal(r.overridden, false);
});

test("'not a dispute, just a question' does not trigger dispute safety", () => {
  const c = baseCase({
    conversation_history: [msg("This is not a dispute, just a question about the line items.")],
  });
  const r = validateDecision(c, baseDecision({ classification: "FOLLOW_UP", human_approval_required: false }));
  assert.equal(r.decision.classification, "FOLLOW_UP");
  assert.equal(r.overridden, false);
});

test("a real, unnegated dispute message still triggers dispute safety (protection preserved)", () => {
  const c = baseCase({
    conversation_history: [msg("We are disputing this invoice in full, the work was never delivered.")],
  });
  const r = validateDecision(c, baseDecision({ classification: "FOLLOW_UP", human_approval_required: false }));
  assert.equal(r.decision.classification, "DISPUTE");
  assert.equal(r.decision.human_approval_required, true);
});

test("payment-plan detection ignores 'pay over' / 'pay in 2' when there is no actual plan request", () => {
  const c = baseCase({
    conversation_history: [
      msg("I'd like to pay over the phone if possible - we usually pay in 2 business days once approved."),
    ],
  });
  const r = validateDecision(c, baseDecision({ human_approval_required: false }));
  assert.equal(r.decision.human_approval_required, false);
  assert.ok(
    !r.violations.some(
      (v) => v.code === "AUTONOMOUS_PAYMENT_PLAN_NEGOTIATION" || v.message.toLowerCase().includes("payment-plan"),
    ),
  );
});

// --- V0 correction pass: model-aware human-approval backstop (Rule 0) ---------

test("model classification DISPUTE with approval false is forced to true, even with no keywords", () => {
  const r = validateDecision(baseCase(), baseDecision({ classification: "DISPUTE", human_approval_required: false }));
  assert.equal(r.decision.human_approval_required, true);
  assert.ok(r.violations.some((v) => v.code === "MODEL_CLASSIFICATION_REQUIRES_APPROVAL"));
});

test("model classification ESCALATE with approval false is forced to true, even with no keywords", () => {
  const r = validateDecision(baseCase(), baseDecision({ classification: "ESCALATE", human_approval_required: false }));
  assert.equal(r.decision.human_approval_required, true);
  assert.ok(r.violations.some((v) => v.code === "MODEL_CLASSIFICATION_REQUIRES_APPROVAL"));
});

test("model classification HUMAN_REQUIRED with approval false is forced to true, even with no keywords", () => {
  const r = validateDecision(
    baseCase(),
    baseDecision({ classification: "HUMAN_REQUIRED", human_approval_required: false }),
  );
  assert.equal(r.decision.human_approval_required, true);
  assert.ok(r.violations.some((v) => v.code === "MODEL_CLASSIFICATION_REQUIRES_APPROVAL"));
});

// --- V0 correction pass: broadened false-payment-confirmation detection -------

test("false payment confirmation is detected when asserted in the situation field", () => {
  const r = validateDecision(
    baseCase(),
    baseDecision({
      classification: "PAYMENT_PENDING",
      situation: "Payment has been received and cleared against this invoice.",
      draft_response: "We're monitoring the account.",
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "FALSE_PAYMENT_CONFIRMATION" && v.severity === "critical"));
});

test("false payment confirmation is detected when asserted in an evidence item", () => {
  const r = validateDecision(
    baseCase(),
    baseDecision({
      classification: "FOLLOW_UP",
      evidence: ["Payment has been received and cleared."],
      draft_response: "We're monitoring the account.",
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "FALSE_PAYMENT_CONFIRMATION" && v.severity === "critical"));
});

test("false payment confirmation is detected when asserted in recommended_action", () => {
  const r = validateDecision(
    baseCase(),
    baseDecision({
      classification: "FOLLOW_UP",
      recommended_action: "Close the case: payment has been received and cleared.",
      draft_response: "We're monitoring the account.",
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "FALSE_PAYMENT_CONFIRMATION" && v.severity === "critical"));
});

test("an ambiguous 'payment of' fact alone does not count as payment confirmation", () => {
  const c = baseCase({
    invoice_facts: [
      "Invoice INV-TEST issued 2026-08-01, net-30, due 2026-08-31.",
      "Payment of $1,000.00 was noted on the account.",
    ],
    conversation_history: [msg("We already paid this weeks ago, check your records.")],
  });
  const r = validateDecision(c, baseDecision({ classification: "RESOLVED", confidence: 0.9 }));
  assert.equal(r.decision.classification, "VERIFY_PAYMENT");
  assert.ok(r.violations.some((v) => v.code === "FALSE_PAYMENT_CONFIRMATION"));
});

// --- Iteration 2: an invented payment date must not remain as asserted fact ---
// anywhere in the final decision, not just be scrubbed from draft_response.

test("an invented payment date in 'situation' is redacted, not left as an asserted fact", () => {
  const r = validateDecision(
    baseCase(),
    baseDecision({
      situation: "No payment has been received as of 2026-09-10; the customer says it will clear by 2026-09-25.",
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE" && v.severity === "critical"));
  // The invented date is gone...
  assert.ok(!r.decision.situation.includes("2026-09-25"));
  assert.ok(r.decision.situation.includes("unverified date removed"));
  // ...but the genuine, case-supported date is left exactly as it was.
  assert.ok(r.decision.situation.includes("2026-09-10"));
});

test("an invented payment date in an evidence item is redacted, not left as verified evidence", () => {
  const r = validateDecision(
    baseCase(),
    baseDecision({
      evidence: ["No payment received as of 2026-09-10; expected to clear 2026-09-25."],
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE" && v.severity === "critical"));
  const evidenceText = r.decision.evidence.join(" ");
  assert.ok(!evidenceText.includes("2026-09-25"));
  assert.ok(evidenceText.includes("unverified date removed"));
  // The genuine, case-supported date in the same evidence item survives.
  assert.ok(evidenceText.includes("2026-09-10"));
});

test("draft_response stays the safe handoff and human_approval_required stays true when a date is redacted", () => {
  const r = validateDecision(
    baseCase(),
    baseDecision({
      situation: "Customer promised payment by 2026-09-25.",
      draft_response: "Thanks - noting you'll pay by 2026-09-25.",
      human_approval_required: false,
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE" && v.severity === "critical"));
  assert.equal(r.decision.human_approval_required, true);
  assert.ok(!r.decision.draft_response.includes("2026-09-25"));
  assert.notEqual(r.decision.draft_response, "Thanks - noting you'll pay by 2026-09-25.");
});

test("genuinely supported dates in the case are never redacted or flagged as invented", () => {
  const c = baseCase({
    invoice_facts: [
      "Invoice INV-TEST issued 2026-08-01, net-30, due 2026-08-31.",
      "No payment received as of 2026-09-10.",
    ],
  });
  const situation = "Invoice INV-TEST was issued 2026-08-01 and remains unpaid as of 2026-09-10.";
  const evidence = ["No payment received as of 2026-09-10."];
  const r = validateDecision(c, baseDecision({ situation, evidence }));
  assert.ok(!r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE"));
  assert.equal(r.decision.situation, situation);
  assert.deepEqual(r.decision.evidence, evidence);
});

// --- caseText() fix: a conversation message's structured `date` field is ------
// --- now included as supported case evidence, not just its `body` text. ------

test("a date that exists only in a conversation message's date field is not flagged as invented, even in payment context", () => {
  const c = baseCase({
    conversation_history: [
      {
        from: "customer",
        date: "2026-09-09",
        body: "Payment was entered in our AP system and is scheduled to send via ACH.",
      },
    ],
  });
  const r = validateDecision(
    c,
    baseDecision({
      classification: "PAYMENT_PENDING",
      evidence: ["Customer message on 2026-09-09: payment scheduled to clear via ACH."],
    }),
  );
  assert.ok(!r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE"));
  assert.ok(!r.violations.some((v) => v.code === "UNSUPPORTED_DATE"));
});

test("a genuinely unsupported date is still detected as invented (the caseText fix does not weaken detection)", () => {
  const c = baseCase({
    conversation_history: [
      {
        from: "customer",
        date: "2026-09-09",
        body: "Payment was entered in our AP system and is scheduled to send via ACH.",
      },
    ],
  });
  const r = validateDecision(
    c,
    baseDecision({
      classification: "PAYMENT_PENDING",
      evidence: ["Customer promised payment would clear by 2026-09-30."],
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE" && v.severity === "critical"));
});

test("regression: quoting a message's own real date (e.g. '[2026-09-05] customer: ...') is not flagged or redacted", () => {
  const c = baseCase({
    conversation_history: [
      {
        from: "customer",
        date: "2026-09-05",
        body: "We are disputing this invoice in full. The training was cancelled by your team and never took place. We will not be paying for services that were not delivered.",
      },
    ],
  });
  const quotedEvidence =
    "[2026-09-05] customer: We are disputing this invoice in full. The training was cancelled by your team and never took place. We will not be paying for services that were not delivered.";
  const r = validateDecision(
    c,
    baseDecision({
      classification: "DISPUTE",
      human_approval_required: true,
      evidence: [quotedEvidence],
    }),
  );
  assert.ok(!r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE"));
  assert.ok(!r.violations.some((v) => v.code === "UNSUPPORTED_DATE"));
  assert.deepEqual(r.decision.evidence, [quotedEvidence]);
});

// --- Fix 4: date normalization - the same calendar date must compare equal ---
// --- whether it is written as ISO (case facts) or in month-name form -------
// --- (model output), without weakening detection of a genuinely different, --
// --- unsupported date. ------------------------------------------------------

test("Fix 4: an ISO case fact date restated in month-name form by the model is recognized as supported", () => {
  const c = baseCase({
    invoice_facts: [
      "Invoice INV-TEST issued 2026-08-01, net-30, due 2026-08-31.",
      "No payment received as of 2026-09-10.",
    ],
  });
  const r = validateDecision(
    c,
    baseDecision({
      situation: "Invoice INV-TEST is due August 31st, 2026 and payment has not been received.",
    }),
  );
  assert.ok(!r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE"));
  assert.ok(!r.violations.some((v) => v.code === "UNSUPPORTED_DATE"));
  assert.ok(r.decision.situation.includes("August 31st, 2026"));
});

test("Fix 4: an ISO conversation-message date restated in month-name form is recognized as supported", () => {
  const c = baseCase({
    conversation_history: [
      { from: "customer", date: "2026-09-01", body: "You'll have payment by 2026-09-01 at the latest." },
    ],
  });
  const r = validateDecision(
    c,
    baseDecision({
      classification: "PROMISE_TO_PAY",
      situation: "Customer promised payment by September 1, 2026.",
      evidence: ["Customer promised payment by September 1, 2026."],
    }),
  );
  assert.ok(!r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE"));
  assert.ok(!r.violations.some((v) => v.code === "UNSUPPORTED_DATE"));
});

test("Fix 4: a truly unsupported date is still flagged, even in month-name form (date normalization does not weaken detection)", () => {
  const c = baseCase({
    invoice_facts: [
      "Invoice INV-TEST issued 2026-08-01, net-30, due 2026-08-31.",
      "No payment received as of 2026-09-10.",
    ],
  });
  const r = validateDecision(
    c,
    baseDecision({
      situation: "Customer promised payment by September 25, 2026.",
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "INVENTED_PAYMENT_DATE" && v.severity === "critical"));
  assert.ok(!r.decision.situation.includes("September 25"));
});

// --- Fix 5: faithful paraphrases of supported facts must not be flagged as --
// --- unsupported evidence, while a materially new, unsupported claim still -
// --- is. ---------------------------------------------------------------------

test("Fix 5: a faithful paraphrase of a supplied fact is allowed as evidence", () => {
  const c = baseCase({
    invoice_facts: ["One reminder email was sent on 2026-09-03."],
    conversation_history: [],
  });
  const r = validateDecision(
    c,
    baseDecision({
      evidence: ["Conversation history shows a friendly reminder was sent."],
    }),
  );
  assert.ok(!r.violations.some((v) => v.code === "UNSUPPORTED_EVIDENCE"));
  assert.deepEqual(r.decision.evidence, ["Conversation history shows a friendly reminder was sent."]);
});

test("Fix 5: a materially new, unsupported fact in evidence is still flagged", () => {
  const c = baseCase({
    invoice_facts: ["One reminder email was sent on 2026-09-03."],
    conversation_history: [],
  });
  const r = validateDecision(
    c,
    baseDecision({
      evidence: [
        "The customer transferred $50,000 via international wire through an offshore account on 2026-12-25.",
      ],
    }),
  );
  assert.ok(r.violations.some((v) => v.code === "UNSUPPORTED_EVIDENCE"));
});
