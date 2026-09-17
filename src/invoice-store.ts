/**
 * Small, pure invoice-store module for the work-queue prototype. No HTTP, no
 * I/O - just an in-memory collection of prototype invoices plus the
 * operations the UI needs (import, lookup, recording an analysis result,
 * and the human-review state machine). server.ts holds the single
 * module-level instance used at runtime; tests create their own.
 *
 * Does not modify ReceivablesCase or any other core domain type - mapping a
 * PrototypeInvoice into a ReceivablesCase happens in invoice-analysis.ts.
 */

import type { ReceivablesDecision } from "./types.ts";
import type { SafetyViolation } from "./safety.ts";
import type { ParsedInvoiceRow } from "./csv-parser.ts";

export type ReviewStatus = "not_reviewed" | "approved" | "rejected";

export interface AnalysisResult {
  raw: ReceivablesDecision;
  final: ReceivablesDecision;
  overridden: boolean;
  violations: SafetyViolation[];
}

export interface PrototypeInvoice {
  invoice_id: string;
  customer: string;
  customer_email: string;
  amount: number;
  /** CSV import has no currency column; defaults to DEFAULT_CURRENCY. */
  currency: string;
  due_date: string;
  status: string;
  /** Raw pasted conversation text, in the existing "[YYYY-MM-DD] from: body" format. */
  conversation: string;
  analysis: AnalysisResult | null;
  /** Set when the last analyze attempt could not produce a decision. */
  analysis_unavailable_reason: string | null;
  draft_response: string | null;
  review_status: ReviewStatus;
}

const DEFAULT_CURRENCY = "USD";

/**
 * Days between `dueDateIso` (YYYY-MM-DD) and `referenceDate`, both compared
 * at UTC midnight so the result is stable regardless of server timezone.
 * Positive = overdue by that many days, 0 = due today, negative = not yet
 * due. Pure - never reads the system clock itself and never modifies the
 * invoice's original due date.
 */
export function daysOverdue(dueDateIso: string, referenceDate: Date): number {
  const due = new Date(`${dueDateIso}T00:00:00Z`);
  const ref = Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((ref - due.getTime()) / msPerDay);
}

export class InvoiceStore {
  #invoices = new Map<string, PrototypeInvoice>();

  /** Replaces the entire current invoice list - CSV import is a full reset, per the prototype spec. */
  importFromRows(rows: readonly ParsedInvoiceRow[]): void {
    const next = new Map<string, PrototypeInvoice>();
    for (const r of rows) {
      next.set(r.invoice_id, {
        invoice_id: r.invoice_id,
        customer: r.customer,
        customer_email: r.customer_email,
        amount: r.amount,
        currency: DEFAULT_CURRENCY,
        due_date: r.due_date,
        status: r.status,
        conversation: "",
        analysis: null,
        analysis_unavailable_reason: null,
        draft_response: null,
        review_status: "not_reviewed",
      });
    }
    this.#invoices = next;
  }

  list(): PrototypeInvoice[] {
    return [...this.#invoices.values()];
  }

  get(id: string): PrototypeInvoice | undefined {
    return this.#invoices.get(id);
  }

  setConversation(id: string, text: string): boolean {
    const inv = this.#invoices.get(id);
    if (!inv) return false;
    inv.conversation = text;
    return true;
  }

  /** Records a completed analysis, seeds the editable draft from it, and clears any prior review decision. */
  setAnalysisResult(id: string, result: AnalysisResult): boolean {
    const inv = this.#invoices.get(id);
    if (!inv) return false;
    inv.analysis = result;
    inv.analysis_unavailable_reason = null;
    inv.draft_response = result.final.draft_response;
    inv.review_status = "not_reviewed";
    return true;
  }

  /** Records that an analyze attempt failed to produce a decision - never a fabricated one. */
  setAnalysisUnavailable(id: string, reason: string): boolean {
    const inv = this.#invoices.get(id);
    if (!inv) return false;
    inv.analysis_unavailable_reason = reason;
    return true;
  }

  /** Editing the draft always returns review status to not_reviewed - a prior approve/reject no longer applies to changed text. */
  setDraftResponse(id: string, draft: string): boolean {
    const inv = this.#invoices.get(id);
    if (!inv) return false;
    inv.draft_response = draft;
    inv.review_status = "not_reviewed";
    return true;
  }

  /** Never sends anything - only records the reviewer's decision and the (possibly edited) draft text. */
  approve(id: string, draft: string): boolean {
    const inv = this.#invoices.get(id);
    if (!inv) return false;
    inv.draft_response = draft;
    inv.review_status = "approved";
    return true;
  }

  /** Preserves the analysis and draft; only the review status changes. */
  reject(id: string): boolean {
    const inv = this.#invoices.get(id);
    if (!inv) return false;
    inv.review_status = "rejected";
    return true;
  }
}
