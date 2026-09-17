import test from "node:test";
import assert from "node:assert/strict";

import { analyzeInvoice, AI_UNAVAILABLE_MESSAGE } from "../src/invoice-analysis.ts";
import type { PrototypeInvoice } from "../src/invoice-store.ts";
import type { AIProvider } from "../src/provider.ts";

function baseInvoice(over: Partial<PrototypeInvoice> = {}): PrototypeInvoice {
  return {
    invoice_id: "INV-1",
    customer: "Acme Co",
    customer_email: "ap@acme.com",
    amount: 1000,
    currency: "USD",
    due_date: "2026-08-29",
    status: "unpaid",
    conversation: "",
    analysis: null,
    analysis_unavailable_reason: null,
    draft_response: null,
    review_status: "not_reviewed",
    ...over,
  };
}

test("no provider configured -> safe failure, never fabricates a decision", async () => {
  const r = await analyzeInvoice(baseInvoice(), new Date("2026-09-10T00:00:00Z"), null);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === AI_UNAVAILABLE_MESSAGE);
});

test("provider throws -> safe failure, never fabricates a decision", async () => {
  const provider: AIProvider = {
    name: "fake",
    analyze: async () => {
      throw new Error("simulated transport failure");
    },
  };
  const r = await analyzeInvoice(baseInvoice(), new Date("2026-09-10T00:00:00Z"), provider);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes(AI_UNAVAILABLE_MESSAGE));
  assert.ok(!r.ok && r.reason.includes("simulated transport failure"));
});

test("malformed conversation text fails closed before calling the provider", async () => {
  let called = false;
  const provider: AIProvider = {
    name: "fake",
    analyze: async () => {
      called = true;
      return "{}";
    },
  };
  const r = await analyzeInvoice(
    baseInvoice({ conversation: "this is not the required format" }),
    new Date("2026-09-10T00:00:00Z"),
    provider,
  );
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test("provider returning malformed output fails closed, no fabricated decision", async () => {
  const provider: AIProvider = {
    name: "fake",
    analyze: async () => "not valid json at all",
  };
  const r = await analyzeInvoice(baseInvoice(), new Date("2026-09-10T00:00:00Z"), provider);
  assert.equal(r.ok, false);
});

test("a clean provider response is analyzed through the existing agent + safety pipeline", async () => {
  const provider: AIProvider = {
    name: "fake",
    analyze: async () =>
      JSON.stringify({
        invoice_id: "INV-1",
        customer: "Acme Co",
        amount: 1000,
        days_overdue: 12,
        situation: "Invoice is overdue, no response yet.",
        classification: "FOLLOW_UP",
        confidence: 0.8,
        evidence: ["12 day(s) overdue as of 2026-09-10."],
        recommended_action: "send_standard_follow_up",
        draft_response: "A friendly reminder.",
        human_approval_required: false,
        reason_for_handoff: null,
      }),
  };
  const r = await analyzeInvoice(baseInvoice(), new Date("2026-09-10T00:00:00Z"), provider);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.result.final.classification === "FOLLOW_UP");
  assert.ok(r.ok && r.result.overridden === false);
});

test("a real, unnegated dispute in the conversation still triggers the existing safety backstop", async () => {
  const provider: AIProvider = {
    name: "fake",
    analyze: async () =>
      JSON.stringify({
        invoice_id: "INV-1",
        customer: "Acme Co",
        amount: 1000,
        days_overdue: 12,
        situation: "Customer disputes the invoice.",
        classification: "FOLLOW_UP",
        confidence: 0.8,
        evidence: ["12 day(s) overdue as of 2026-09-10."],
        recommended_action: "send_standard_follow_up",
        draft_response: "A friendly reminder.",
        human_approval_required: false,
        reason_for_handoff: null,
      }),
  };
  const r = await analyzeInvoice(
    baseInvoice({ conversation: "[2026-09-05] customer: We won't be paying for this - the work was never delivered." }),
    new Date("2026-09-10T00:00:00Z"),
    provider,
  );
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.result.raw.classification === "FOLLOW_UP");
  assert.ok(r.ok && r.result.final.classification === "DISPUTE");
  assert.ok(r.ok && r.result.overridden === true);
});
