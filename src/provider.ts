/**
 * Provider interface plus a deterministic parser for raw model output.
 *
 * `parseDecision` validates one raw decision payload. `parseBatchDecisions`
 * (below) covers the case where many cases were sent in a single batched
 * request and one JSON array came back covering all of them - it does not
 * duplicate parseDecision's validation, it just unbundles the array by
 * invoice_id and runs each item through parseDecision individually.
 */

import type { ReceivablesCase, ReceivablesDecision } from "./types.ts";
import { isReceivablesClassification } from "./types.ts";

/**
 * The single seam a real LLM integration must satisfy.
 *
 * `analyze` returns the RAW model output (typically a JSON string, but a plain
 * object is also accepted) - it does NOT return an already-trusted
 * ReceivablesDecision. `ReceivablesAgent.resolve` runs that raw output through
 * `parseDecision` before anything downstream (safety, evaluator) ever sees it,
 * so a malformed response fails closed instead of being trusted as-is.
 */
export interface AIProvider {
  /** Human-readable provider name, for reporting. */
  readonly name: string;
  /** Analyze one case and return the provider's raw, unvalidated output. */
  analyze(receivablesCase: ReceivablesCase): Promise<unknown>;
}

/** Thrown when code paths that need a real provider are reached in V0. */
export class ProviderNotConfiguredError extends Error {
  constructor(message = "No real LLM provider is configured for V0.") {
    super(message);
    this.name = "ProviderNotConfiguredError";
  }
}

export interface DecisionParseResult {
  ok: boolean;
  decision: ReceivablesDecision | null;
  errors: string[];
}

function stripCodeFences(s: string): string {
  const t = s.trim();
  if (t.startsWith("```")) {
    return t
      .replace(/^```[a-zA-Z]*\s*/, "")
      .replace(/```$/, "")
      .trim();
  }
  return t;
}

/**
 * Parse and validate raw model output (a JSON string or a plain object) into a
 * typed ReceivablesDecision. Returns every validation error found, never throws.
 */
export function parseDecision(input: unknown): DecisionParseResult {
  const errors: string[] = [];
  let obj: unknown = input;

  if (typeof input === "string") {
    try {
      obj = JSON.parse(stripCodeFences(input));
    } catch {
      return { ok: false, decision: null, errors: ["Response is not valid JSON."] };
    }
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, decision: null, errors: ["Decision must be a JSON object."] };
  }

  const r = obj as Record<string, unknown>;

  const requireString = (k: string): void => {
    if (typeof r[k] !== "string" || (r[k] as string).length === 0) {
      errors.push(`Missing or invalid string field: ${k}`);
    }
  };
  const requireNumber = (k: string): void => {
    if (typeof r[k] !== "number" || Number.isNaN(r[k] as number)) {
      errors.push(`Missing or invalid number field: ${k}`);
    }
  };
  const requireBoolean = (k: string): void => {
    if (typeof r[k] !== "boolean") {
      errors.push(`Missing or invalid boolean field: ${k}`);
    }
  };
  const requireStringArray = (k: string): void => {
    const v = r[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      errors.push(`Field ${k} must be an array of strings.`);
    }
  };

  requireString("invoice_id");
  requireString("customer");
  requireNumber("amount");
  requireNumber("days_overdue");
  requireString("situation");
  requireNumber("confidence");
  requireStringArray("evidence");
  requireString("recommended_action");
  requireString("draft_response");
  requireBoolean("human_approval_required");

  if (typeof r["confidence"] === "number" && (r["confidence"] < 0 || r["confidence"] > 1)) {
    errors.push("confidence must be between 0 and 1.");
  }
  if (!isReceivablesClassification(r["classification"])) {
    errors.push(`Invalid classification: ${String(r["classification"])}`);
  }
  if (!(r["reason_for_handoff"] === null || typeof r["reason_for_handoff"] === "string")) {
    errors.push("reason_for_handoff must be a string or null.");
  }

  if (errors.length > 0) {
    return { ok: false, decision: null, errors };
  }

  const decision: ReceivablesDecision = {
    invoice_id: r["invoice_id"] as string,
    customer: r["customer"] as string,
    amount: r["amount"] as number,
    days_overdue: r["days_overdue"] as number,
    situation: r["situation"] as string,
    classification: r["classification"] as ReceivablesDecision["classification"],
    confidence: r["confidence"] as number,
    evidence: (r["evidence"] as string[]).slice(),
    recommended_action: r["recommended_action"] as string,
    draft_response: r["draft_response"] as string,
    human_approval_required: r["human_approval_required"] as boolean,
    reason_for_handoff: (r["reason_for_handoff"] ?? null) as string | null,
  };

  return { ok: true, decision, errors: [] };
}

/**
 * Result of unbundling a single batched provider response (one API call
 * covering many cases) back into a per-case parse result.
 */
export interface BatchParseResult {
  /** True only if the batch as a whole was a well-formed array of exactly the expected size. */
  ok: boolean;
  /** Batch-level problems (wrong item count, unidentifiable items) - independent of any single case. */
  errors: string[];
  /** Every expected invoice_id maps to a result, even when nothing was found for it. */
  decisionsByInvoiceId: Map<string, DecisionParseResult>;
}

function batchFailureForEveryCase(expectedInvoiceIds: readonly string[], reason: string): BatchParseResult {
  const decisionsByInvoiceId = new Map<string, DecisionParseResult>();
  for (const id of expectedInvoiceIds) {
    decisionsByInvoiceId.set(id, { ok: false, decision: null, errors: [reason] });
  }
  return { ok: false, errors: [reason], decisionsByInvoiceId };
}

/**
 * Parse a single batched provider response (a JSON array covering many cases)
 * into one DecisionParseResult per expected invoice_id, reusing parseDecision()
 * for each individual item - there is no second/parallel schema or validator.
 *
 * Fails closed at whatever granularity the problem actually is:
 *  - Unparseable / non-array top-level response -> every expected case fails.
 *  - A specific invoice_id missing, duplicated, or individually malformed ->
 *    only that case fails; other, well-formed cases are still parsed and scored.
 * Never fabricates a decision for a case that has none.
 */
export function parseBatchDecisions(
  raw: unknown,
  expectedInvoiceIds: readonly string[],
): BatchParseResult {
  let arr: unknown;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(stripCodeFences(raw));
    } catch {
      return batchFailureForEveryCase(expectedInvoiceIds, "Batch response is not valid JSON.");
    }
  } else {
    arr = raw;
  }

  if (!Array.isArray(arr)) {
    return batchFailureForEveryCase(expectedInvoiceIds, "Batch response is not a JSON array.");
  }

  // Group raw items by their own invoice_id field (read before any per-item
  // validation), so a missing/duplicate/unidentifiable item can be reported
  // precisely instead of guessed at.
  const itemsByInvoiceId = new Map<string, unknown[]>();
  let unidentifiedCount = 0;
  for (const item of arr) {
    const invoiceId =
      item !== null && typeof item === "object" && typeof (item as Record<string, unknown>)["invoice_id"] === "string"
        ? ((item as Record<string, unknown>)["invoice_id"] as string)
        : null;
    if (invoiceId === null) {
      unidentifiedCount += 1;
      continue;
    }
    const bucket = itemsByInvoiceId.get(invoiceId);
    if (bucket) {
      bucket.push(item);
    } else {
      itemsByInvoiceId.set(invoiceId, [item]);
    }
  }

  const decisionsByInvoiceId = new Map<string, DecisionParseResult>();
  for (const id of expectedInvoiceIds) {
    const bucket = itemsByInvoiceId.get(id);
    if (!bucket || bucket.length === 0) {
      decisionsByInvoiceId.set(id, {
        ok: false,
        decision: null,
        errors: [`No decision for invoice_id ${id} was found in the batch response.`],
      });
      continue;
    }
    if (bucket.length > 1) {
      decisionsByInvoiceId.set(id, {
        ok: false,
        decision: null,
        errors: [`Batch response contained ${bucket.length} decisions for invoice_id ${id}; expected exactly 1.`],
      });
      continue;
    }
    decisionsByInvoiceId.set(id, parseDecision(bucket[0]));
  }

  const batchErrors: string[] = [];
  if (arr.length !== expectedInvoiceIds.length) {
    batchErrors.push(
      `Batch response contained ${arr.length} item(s); expected exactly ${expectedInvoiceIds.length}.`,
    );
  }
  if (unidentifiedCount > 0) {
    batchErrors.push(`${unidentifiedCount} item(s) in the batch response had no recognizable invoice_id.`);
  }

  return { ok: batchErrors.length === 0, errors: batchErrors, decisionsByInvoiceId };
}
