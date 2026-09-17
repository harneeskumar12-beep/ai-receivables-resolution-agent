/**
 * Core domain types for the AI Receivables Resolution Agent (V0).
 *
 * These types describe the inputs the reasoning engine reads (a ReceivablesCase)
 * and the single structured output it must eventually produce (a ReceivablesDecision).
 * No `any` is used for domain data.
 */

/** ISO-4217 code such as "USD". Kept as a string so fixtures stay simple. */
export type Currency = string;

/** One message in the back-and-forth about an invoice. */
export interface ConversationMessage {
  /** Who wrote the message. */
  from: "customer" | "collections_agent" | "system";
  /** ISO date (YYYY-MM-DD) the message was sent. */
  date: string;
  /** Plain-text body of the message. */
  body: string;
}

/** Everything the engine is allowed to reason from for a single overdue invoice. */
export interface ReceivablesCase {
  invoice_id: string;
  customer: string;
  amount: number;
  currency: Currency;
  days_overdue: number;
  /** Discrete, verified factual statements about the invoice and its account. */
  invoice_facts: string[];
  /** Full conversation history, oldest first. */
  conversation_history: ConversationMessage[];
}

/** The explicit set of receivables situations the engine can classify. */
export type ReceivablesClassification =
  | "FOLLOW_UP"
  | "PROMISE_TO_PAY"
  | "DISPUTE"
  | "PAYMENT_PENDING"
  | "PARTIAL_PAYMENT"
  | "CUSTOMER_REQUEST"
  | "PAYMENT_HELP"
  | "VERIFY_PAYMENT"
  | "ESCALATE"
  | "RESOLVED"
  | "HUMAN_REQUIRED";

/** Runtime list of the classification values, for validation. */
export const RECEIVABLES_CLASSIFICATIONS = [
  "FOLLOW_UP",
  "PROMISE_TO_PAY",
  "DISPUTE",
  "PAYMENT_PENDING",
  "PARTIAL_PAYMENT",
  "CUSTOMER_REQUEST",
  "PAYMENT_HELP",
  "VERIFY_PAYMENT",
  "ESCALATE",
  "RESOLVED",
  "HUMAN_REQUIRED",
] as const satisfies readonly ReceivablesClassification[];

/** Type guard: is `v` one of the known classification values? */
export function isReceivablesClassification(v: unknown): v is ReceivablesClassification {
  return typeof v === "string" && (RECEIVABLES_CLASSIFICATIONS as readonly string[]).includes(v);
}

/** The single structured decision the engine must produce for a case. */
export interface ReceivablesDecision {
  invoice_id: string;
  customer: string;
  amount: number;
  days_overdue: number;
  /** Narrative of what actually happened, grounded only in the case. */
  situation: string;
  classification: ReceivablesClassification;
  /** Confidence in the classification, 0..1. */
  confidence: number;
  /** Short quotes or references from the case that support the reading. */
  evidence: string[];
  /** The safest useful next action, described in plain text. */
  recommended_action: string;
  /** The message the engine would send, subject to approval. */
  draft_response: string;
  /** Whether a human must approve before anything is sent. */
  human_approval_required: boolean;
  /** Why a human is needed, or null when no hand-off is required. */
  reason_for_handoff: string | null;
}
