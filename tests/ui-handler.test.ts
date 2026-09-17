import test from "node:test";
import assert from "node:assert/strict";

import { buildCaseFromRequestBody, handleAnalyze, parseConversationLines } from "../src/ui-handler.ts";
import type { AIProvider } from "../src/provider.ts";
import type { ReceivablesCase } from "../src/types.ts";

const validBody = {
  invoice_id: "INV-9001",
  customer: "Test Co",
  amount: 4200,
  currency: "USD",
  days_overdue: 12,
  invoice_facts: "Invoice INV-9001 issued 2026-08-05, net-30, due 2026-08-29.\nNo payment received as of 2026-09-10.",
  conversation: "[2026-09-03] collections_agent: Friendly reminder that invoice INV-9001 is past due.",
};

function validRawDecisionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    invoice_id: "INV-9001",
    customer: "Test Co",
    amount: 4200,
    days_overdue: 12,
    situation: "Invoice is 12 days overdue, one reminder sent, no response.",
    classification: "FOLLOW_UP",
    confidence: 0.8,
    evidence: ["No payment received as of 2026-09-10."],
    recommended_action: "send_standard_follow_up",
    draft_response: "A friendly reminder that invoice INV-9001 is now past due.",
    human_approval_required: false,
    reason_for_handoff: null,
    ...overrides,
  });
}

function fakeProvider(raw: unknown): AIProvider {
  return {
    name: "fake",
    analyze: async (_case: ReceivablesCase) => raw,
  };
}

// --- parseConversationLines -----------------------------------------------

test("parseConversationLines accepts an empty conversation", () => {
  const r = parseConversationLines("   \n  \n");
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.messages.length === 0);
});

test("parseConversationLines parses well-formed lines", () => {
  const r = parseConversationLines(
    "[2026-09-03] collections_agent: Reminder sent.\n[2026-09-05] customer: We dispute this.",
  );
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.messages.length === 2);
  assert.ok(r.ok && r.messages[0]?.from === "collections_agent");
  assert.ok(r.ok && r.messages[1]?.from === "customer");
});

test("parseConversationLines fails closed on a malformed line, without guessing", () => {
  const r = parseConversationLines("this is not in the required format");
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.length > 0);
  assert.ok(!r.ok && r.errors[0]?.includes("line 1"));
});

// --- buildCaseFromRequestBody ----------------------------------------------

test("buildCaseFromRequestBody builds a valid case from well-formed input", () => {
  const r = buildCaseFromRequestBody(validBody);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.case.invoice_id === "INV-9001");
  assert.ok(r.ok && r.case.invoice_facts.length === 2);
  assert.ok(r.ok && r.case.conversation_history.length === 1);
});

test("buildCaseFromRequestBody fails closed on missing required fields, never inventing them", () => {
  const r = buildCaseFromRequestBody({ ...validBody, invoice_id: "", amount: "not-a-number" });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.toLowerCase().includes("invoice id")));
  assert.ok(!r.ok && r.errors.some((e) => e.toLowerCase().includes("amount")));
});

test("buildCaseFromRequestBody rejects a non-object body", () => {
  const r = buildCaseFromRequestBody("not an object");
  assert.equal(r.ok, false);
});

// --- handleAnalyze -----------------------------------------------------------

test("handleAnalyze fails closed with 503 when no provider is configured, without any network call", async () => {
  const result = await handleAnalyze(validBody, null);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.status === 503);
});

test("handleAnalyze fails closed on invalid input before ever touching the provider", async () => {
  let called = false;
  const provider: AIProvider = {
    name: "fake",
    analyze: async () => {
      called = true;
      return validRawDecisionJson();
    },
  };
  const result = await handleAnalyze({ ...validBody, customer: "" }, provider);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("handleAnalyze returns raw and final decisions, distinguished, for a clean decision", async () => {
  const provider = fakeProvider(validRawDecisionJson());
  const result = await handleAnalyze(validBody, provider);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.raw.classification === "FOLLOW_UP");
  assert.ok(result.ok && result.final.classification === "FOLLOW_UP");
  assert.ok(result.ok && result.overridden === false);
  assert.ok(result.ok && result.violations.length === 0);
});

test("handleAnalyze surfaces a safety override and keeps raw vs final distinct", async () => {
  // The conversation contains a real, unnegated dispute - the safety layer
  // must override human_approval_required to true even though the model said
  // false. Phrased to be caught by safety.ts's own dispute detection while
  // NOT matching the deterministic classifier's (narrower) DISPUTE phrases -
  // this test is specifically about the safety-layer backstop, not the
  // deterministic-first shortcut (see deterministic-classifier.test.ts for that).
  const disputeBody = {
    ...validBody,
    conversation: "[2026-09-05] customer: We won't be paying for this - the work was never delivered.",
  };
  const provider = fakeProvider(validRawDecisionJson({ classification: "FOLLOW_UP", human_approval_required: false }));
  const result = await handleAnalyze(disputeBody, provider);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.raw.classification === "FOLLOW_UP");
  assert.ok(result.ok && result.raw.human_approval_required === false);
  assert.ok(result.ok && result.final.classification === "DISPUTE");
  assert.ok(result.ok && result.final.human_approval_required === true);
  assert.ok(result.ok && result.overridden === true);
  assert.ok(result.ok && result.violations.length > 0);
});

test("handleAnalyze fails closed (never fabricates) when the provider returns malformed output", async () => {
  const provider = fakeProvider("not valid json at all");
  const result = await handleAnalyze(validBody, provider);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.status === 502);
  assert.ok(!result.ok && result.errors.length > 0);
});

test("handleAnalyze fails closed when the provider itself throws", async () => {
  const provider: AIProvider = {
    name: "fake",
    analyze: async () => {
      throw new Error("simulated transport failure");
    },
  };
  const result = await handleAnalyze(validBody, provider);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.status === 502);
  assert.ok(!result.ok && result.errors.some((e) => e.includes("simulated transport failure")));
});
