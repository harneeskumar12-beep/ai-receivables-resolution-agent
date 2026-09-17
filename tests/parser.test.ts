import test from "node:test";
import assert from "node:assert/strict";

import { parseDecision } from "../src/provider.ts";

const valid = {
  invoice_id: "INV-1",
  customer: "Acme",
  amount: 1000,
  days_overdue: 5,
  situation: "Overdue, no response yet.",
  classification: "FOLLOW_UP",
  confidence: 0.7,
  evidence: ["reminder sent 2026-09-03"],
  recommended_action: "send_standard_follow_up",
  draft_response: "A reminder about your outstanding invoice.",
  human_approval_required: false,
  reason_for_handoff: null,
};

test("parses a valid structured decision object", () => {
  const r = parseDecision(valid);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.decision?.classification, "FOLLOW_UP");
  assert.equal(r.decision?.human_approval_required, false);
});

test("parses a valid decision from a JSON string with code fences", () => {
  const r = parseDecision("```json\n" + JSON.stringify(valid) + "\n```");
  assert.equal(r.ok, true);
  assert.equal(r.decision?.invoice_id, "INV-1");
});

test("rejects malformed JSON", () => {
  const r = parseDecision("{ not json ");
  assert.equal(r.ok, false);
  assert.equal(r.decision, null);
  assert.ok(r.errors.length > 0);
});

test("rejects a decision missing required fields", () => {
  const partial: Record<string, unknown> = { ...valid };
  delete partial["situation"];
  delete partial["confidence"];
  const r = parseDecision(partial);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("situation")));
  assert.ok(r.errors.some((e) => e.includes("confidence")));
});

test("rejects an invalid classification", () => {
  const r = parseDecision({ ...valid, classification: "NOT_A_REAL_CLASS" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.toLowerCase().includes("classification")));
});

test("rejects confidence outside the 0..1 range", () => {
  const r = parseDecision({ ...valid, confidence: 1.7 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.toLowerCase().includes("confidence")));
});
