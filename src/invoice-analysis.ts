/**
 * Maps a PrototypeInvoice into the EXISTING ReceivablesCase shape and runs
 * it through the EXISTING, unmodified pipeline - ReceivablesAgent.resolve()
 * (deterministic classifier first, provider otherwise) then
 * validateDecision(). No classification or safety logic is duplicated here;
 * this file only builds the input and forwards the two existing calls.
 *
 * Reuses parseConversationLines() from ui-handler.ts as-is - it is not
 * reimplemented or rewritten.
 *
 * Never fabricates a decision: if there is no provider, the conversation
 * text does not parse, the provider throws, or its output fails to parse,
 * this returns a clear failure reason instead of a guessed result.
 */

import type { AIProvider } from "./provider.ts";
import { ReceivablesAgent } from "./agent.ts";
import { validateDecision } from "./safety.ts";
import type { ReceivablesCase } from "./types.ts";
import { parseConversationLines } from "./ui-handler.ts";
import type { AnalysisResult, PrototypeInvoice } from "./invoice-store.ts";
import { daysOverdue } from "./invoice-store.ts";

export type InvoiceAnalyzeResult = { ok: true; result: AnalysisResult } | { ok: false; reason: string };

export const AI_UNAVAILABLE_MESSAGE = "AI analysis unavailable - human review required.";

/**
 * Literal, directly-derived facts from the invoice's own stored fields only -
 * never an inferred or invented fact about the customer or the account.
 */
function buildInvoiceFacts(invoice: PrototypeInvoice, referenceDate: Date): string[] {
  const overdue = daysOverdue(invoice.due_date, referenceDate);
  const asOf = referenceDate.toISOString().slice(0, 10);
  const overdueFact =
    overdue > 0
      ? `${overdue} day(s) overdue as of ${asOf}.`
      : overdue === 0
        ? `Due today (${asOf}).`
        : `Not yet due - ${Math.abs(overdue)} day(s) remaining as of ${asOf}.`;
  return [
    `Invoice ${invoice.invoice_id} issued to ${invoice.customer}, amount ${invoice.currency} ${invoice.amount}.`,
    `Due date: ${invoice.due_date}.`,
    `Status on file: ${invoice.status}.`,
    overdueFact,
  ];
}

export async function analyzeInvoice(
  invoice: PrototypeInvoice,
  referenceDate: Date,
  provider: AIProvider | null,
): Promise<InvoiceAnalyzeResult> {
  if (provider === null) {
    return { ok: false, reason: AI_UNAVAILABLE_MESSAGE };
  }

  const conversationResult = parseConversationLines(invoice.conversation);
  if (!conversationResult.ok) {
    return { ok: false, reason: conversationResult.errors.join(" ") };
  }

  const receivablesCase: ReceivablesCase = {
    invoice_id: invoice.invoice_id,
    customer: invoice.customer,
    amount: invoice.amount,
    currency: invoice.currency,
    days_overdue: daysOverdue(invoice.due_date, referenceDate),
    invoice_facts: buildInvoiceFacts(invoice, referenceDate),
    conversation_history: conversationResult.messages,
  };

  let parsed;
  try {
    parsed = await new ReceivablesAgent(provider).resolve(receivablesCase);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `${AI_UNAVAILABLE_MESSAGE} (${message})` };
  }

  if (!parsed.ok || parsed.decision === null) {
    return { ok: false, reason: AI_UNAVAILABLE_MESSAGE };
  }

  const safety = validateDecision(receivablesCase, parsed.decision);
  return {
    ok: true,
    result: {
      raw: safety.original_decision,
      final: safety.decision,
      overridden: safety.overridden,
      violations: safety.violations,
    },
  };
}
