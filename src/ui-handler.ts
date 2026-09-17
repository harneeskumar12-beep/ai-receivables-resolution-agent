/**
 * Pure request-handling logic for the V0 web UI. No HTTP, no network, no I/O -
 * just: raw form input -> a validated ReceivablesCase (never inventing a
 * missing fact) -> the EXISTING, unmodified ReceivablesAgent + validateDecision
 * -> a response that keeps the raw model decision and the safety-adjusted
 * final decision clearly distinct.
 *
 * This is the single-case path the core was originally built around (agent.ts
 * + AIProvider.analyze), unrelated to the 20-case batch path added for the
 * benchmark harness. Nothing in src/types.ts, cases.ts, prompt.ts, provider.ts,
 * agent.ts, safety.ts, or evaluator.ts is changed or reimplemented here.
 */

import type { AIProvider } from "./provider.ts";
import { validateDecision } from "./safety.ts";
import type { SafetyViolation } from "./safety.ts";
import { ReceivablesAgent } from "./agent.ts";
import type { ConversationMessage, ReceivablesCase, ReceivablesDecision } from "./types.ts";

export type CaseBuildResult =
  | { ok: true; case: ReceivablesCase }
  | { ok: false; errors: string[] };

export type ConversationParseResult =
  | { ok: true; messages: ConversationMessage[] }
  | { ok: false; errors: string[] };

export interface AnalyzeSuccess {
  ok: true;
  raw: ReceivablesDecision;
  final: ReceivablesDecision;
  overridden: boolean;
  violations: SafetyViolation[];
}

export interface AnalyzeFailure {
  ok: false;
  status: number;
  errors: string[];
}

export type AnalyzeResult = AnalyzeSuccess | AnalyzeFailure;

const CONVERSATION_FROM_VALUES = new Set<ConversationMessage["from"]>([
  "customer",
  "collections_agent",
  "system",
]);

// Required, explicit format - "[YYYY-MM-DD] customer|collections_agent|system: message text"
const CONVERSATION_LINE = /^\[(\d{4}-\d{2}-\d{2})\]\s*(customer|collections_agent|system)\s*:\s*(.+)$/;

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parse conversation text, one message per line, in the strict
 * "[YYYY-MM-DD] from: body" format. A blank conversation is valid (a
 * brand-new invoice may have no contact yet). A line that does not match the
 * required format fails closed with a precise per-line error - it is never
 * guessed at (no invented date, sender, or content).
 */
export function parseConversationLines(text: string): ConversationParseResult {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { ok: true, messages: [] };
  }

  const messages: ConversationMessage[] = [];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const m = CONVERSATION_LINE.exec(line);
    if (!m) {
      errors.push(
        `Conversation line ${i + 1} is not in the required format ` +
          `"[YYYY-MM-DD] customer|collections_agent|system: message". Got: "${line}"`,
      );
      return;
    }
    const [, date, from, body] = m;
    if (date === undefined || from === undefined || body === undefined) {
      errors.push(`Conversation line ${i + 1} could not be parsed.`);
      return;
    }
    if (!CONVERSATION_FROM_VALUES.has(from as ConversationMessage["from"])) {
      errors.push(`Conversation line ${i + 1} has an unrecognized sender: "${from}"`);
      return;
    }
    messages.push({ date, from: from as ConversationMessage["from"], body: body.trim() });
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, messages };
}

/**
 * Build a ReceivablesCase from raw request-body input. Collects every
 * validation problem (never stops at the first) and never fills in a missing
 * or malformed field with a guessed/default value - a case is only produced
 * once every required field is present and valid.
 */
export function buildCaseFromRequestBody(body: unknown): CaseBuildResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["Request body must be a JSON object."] };
  }
  const r = body as Record<string, unknown>;
  const errors: string[] = [];

  const str = (k: string): string => (typeof r[k] === "string" ? (r[k] as string).trim() : "");

  const invoiceId = str("invoice_id");
  if (invoiceId.length === 0) errors.push("Invoice ID is required.");

  const customer = str("customer");
  if (customer.length === 0) errors.push("Customer name is required.");

  const currency = str("currency");
  if (currency.length === 0) errors.push("Currency is required.");

  const amount = toFiniteNumber(r["amount"]);
  if (amount === null || amount < 0) errors.push("Amount must be a non-negative number.");

  const daysOverdue = toFiniteNumber(r["days_overdue"]);
  if (daysOverdue === null || daysOverdue < 0) errors.push("Days overdue must be a non-negative number.");

  const factsRaw = typeof r["invoice_facts"] === "string" ? (r["invoice_facts"] as string) : "";
  const invoiceFacts = factsRaw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (invoiceFacts.length === 0) errors.push("At least one invoice fact is required.");

  const conversationRaw = typeof r["conversation"] === "string" ? (r["conversation"] as string) : "";
  const conversationResult = parseConversationLines(conversationRaw);
  if (!conversationResult.ok) {
    errors.push(...conversationResult.errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    case: {
      invoice_id: invoiceId,
      customer,
      amount: amount as number,
      currency,
      days_overdue: daysOverdue as number,
      invoice_facts: invoiceFacts,
      // conversationResult is guaranteed ok here (errors.length === 0 above).
      conversation_history: conversationResult.ok ? conversationResult.messages : [],
    },
  };
}

/**
 * Analyze one case: validate input -> (if a provider is configured) the
 * EXISTING ReceivablesAgent.resolve() -> the EXISTING validateDecision().
 * Fails closed at every stage: invalid input, no provider configured, a
 * provider error, or malformed provider output all return a clear error and
 * never fabricate a decision.
 */
export async function handleAnalyze(body: unknown, provider: AIProvider | null): Promise<AnalyzeResult> {
  const built = buildCaseFromRequestBody(body);
  if (!built.ok) {
    return { ok: false, status: 400, errors: built.errors };
  }

  if (provider === null) {
    return {
      ok: false,
      status: 503,
      errors: ["No LLM provider is configured (GEMINI_API_KEY is not set). Analysis is unavailable."],
    };
  }

  const agent = new ReceivablesAgent(provider);
  let parsed;
  try {
    parsed = await agent.resolve(built.case);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, errors: [`Provider failed before a decision could be parsed: ${message}`] };
  }

  if (!parsed.ok || parsed.decision === null) {
    return { ok: false, status: 502, errors: parsed.errors };
  }

  const safety = validateDecision(built.case, parsed.decision);
  return {
    ok: true,
    raw: safety.original_decision,
    final: safety.decision,
    overridden: safety.overridden,
    violations: safety.violations,
  };
}
