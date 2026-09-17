import test from "node:test";
import assert from "node:assert/strict";

import { InvoiceStore, daysOverdue } from "../src/invoice-store.ts";
import type { ParsedInvoiceRow } from "../src/csv-parser.ts";
import type { ReceivablesDecision } from "../src/types.ts";

function row(over: Partial<ParsedInvoiceRow> = {}): ParsedInvoiceRow {
  return {
    invoice_id: "INV-1",
    customer: "Acme Co",
    customer_email: "ap@acme.com",
    amount: 1000,
    due_date: "2026-08-29",
    status: "unpaid",
    ...over,
  };
}

function decision(over: Partial<ReceivablesDecision> = {}): ReceivablesDecision {
  return {
    invoice_id: "INV-1",
    customer: "Acme Co",
    amount: 1000,
    days_overdue: 12,
    situation: "s",
    classification: "FOLLOW_UP",
    confidence: 0.9,
    evidence: [],
    recommended_action: "a",
    draft_response: "Hello",
    human_approval_required: false,
    reason_for_handoff: null,
    ...over,
  };
}

// --- daysOverdue -------------------------------------------------------------

test("daysOverdue: a past due_date returns a positive count", () => {
  assert.equal(daysOverdue("2026-08-29", new Date("2026-09-10T00:00:00Z")), 12);
});

test("daysOverdue: a future due_date returns a negative count", () => {
  assert.equal(daysOverdue("2026-09-20", new Date("2026-09-10T00:00:00Z")), -10);
});

test("daysOverdue: due today returns 0", () => {
  assert.equal(daysOverdue("2026-09-10", new Date("2026-09-10T00:00:00Z")), 0);
});

test("daysOverdue: never modifies the original due_date - purely computed", () => {
  const due = "2026-08-29";
  daysOverdue(due, new Date("2026-09-10T00:00:00Z"));
  assert.equal(due, "2026-08-29");
});

// --- import / lookup ----------------------------------------------------------

test("importFromRows replaces the current list", () => {
  const store = new InvoiceStore();
  store.importFromRows([row({ invoice_id: "INV-1" })]);
  assert.equal(store.list().length, 1);
  store.importFromRows([row({ invoice_id: "INV-2" }), row({ invoice_id: "INV-3" })]);
  assert.equal(store.list().length, 2);
  assert.equal(store.get("INV-1"), undefined);
});

test("get looks up a single invoice by id, with default field values", () => {
  const store = new InvoiceStore();
  store.importFromRows([row({ invoice_id: "INV-7" })]);
  const inv = store.get("INV-7");
  assert.ok(inv);
  assert.equal(inv?.invoice_id, "INV-7");
  assert.equal(inv?.review_status, "not_reviewed");
  assert.equal(inv?.analysis, null);
  assert.equal(inv?.conversation, "");
});

// --- analysis result storage --------------------------------------------------

test("setAnalysisResult stores the result and seeds the draft response", () => {
  const store = new InvoiceStore();
  store.importFromRows([row()]);
  const d = decision();
  store.setAnalysisResult("INV-1", { raw: d, final: d, overridden: false, violations: [] });
  const inv = store.get("INV-1");
  assert.equal(inv?.draft_response, "Hello");
  assert.equal(inv?.review_status, "not_reviewed");
  assert.ok(inv?.analysis);
  assert.equal(inv?.analysis_unavailable_reason, null);
});

test("setAnalysisUnavailable records the reason without fabricating a decision", () => {
  const store = new InvoiceStore();
  store.importFromRows([row()]);
  store.setAnalysisUnavailable("INV-1", "AI analysis unavailable - human review required.");
  const inv = store.get("INV-1");
  assert.equal(inv?.analysis, null);
  assert.equal(inv?.analysis_unavailable_reason, "AI analysis unavailable - human review required.");
});

// --- approval workflow ---------------------------------------------------------

test("approve sets review status and saves the given draft, never sends anything", () => {
  const store = new InvoiceStore();
  store.importFromRows([row()]);
  store.approve("INV-1", "Edited draft text");
  const inv = store.get("INV-1");
  assert.equal(inv?.review_status, "approved");
  assert.equal(inv?.draft_response, "Edited draft text");
});

test("reject sets review status and preserves the draft/analysis", () => {
  const store = new InvoiceStore();
  store.importFromRows([row()]);
  store.setDraftResponse("INV-1", "Some draft");
  store.reject("INV-1");
  const inv = store.get("INV-1");
  assert.equal(inv?.review_status, "rejected");
  assert.equal(inv?.draft_response, "Some draft");
});

test("editing the draft after approval returns review status to not_reviewed", () => {
  const store = new InvoiceStore();
  store.importFromRows([row()]);
  store.approve("INV-1", "v1");
  store.setDraftResponse("INV-1", "v2");
  const inv = store.get("INV-1");
  assert.equal(inv?.review_status, "not_reviewed");
  assert.equal(inv?.draft_response, "v2");
});

test("operations on an unknown invoice id fail cleanly, returning false", () => {
  const store = new InvoiceStore();
  assert.equal(store.setConversation("NOPE", "x"), false);
  assert.equal(store.approve("NOPE", "x"), false);
  assert.equal(store.reject("NOPE"), false);
  assert.equal(store.setDraftResponse("NOPE", "x"), false);
});
