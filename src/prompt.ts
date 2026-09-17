/**
 * The shared system prompt and user-prompt builder that will eventually be sent
 * to a real LLM. This file contains no provider-specific logic and makes no calls.
 */

import type { ReceivablesCase } from "./types.ts";

export const SYSTEM_PROMPT = `You are a receivables resolution reasoning engine for a B2B accounts-receivable team.
Your job is to read ONE overdue-invoice case and produce ONE structured decision.

REASONING GOALS
1. Work out what actually happened, using only the information in the case.
2. Classify the receivables situation.
3. Identify the specific evidence that supports your reading.
4. Recommend the safest useful next action.
5. Decide whether a human must approve before anything is sent.
6. Prepare an appropriate draft response.

HARD RULES - never break these
- Never invent facts. Use only facts contained in the case (invoice facts and conversation history).
- Every statement in "situation" and every item in "evidence" must be traceable to the case text.
  Evidence must be grounded only in the supplied case - never in outside knowledge, assumptions, or
  plausible-sounding guesses.
- Do not claim a payment was received, cleared, or reconciled unless the case facts explicitly say so.
- Do not invent payment dates, amounts, reference numbers, invoice details, or customer details.
- Never infer, state, or imply a payment date, promise date, transaction date, or any other date that
  is not explicitly present in the supplied invoice facts or conversation history. If a date is not
  explicitly supported by the supplied case, do not create one, round one, or estimate one.
- Do not turn vague language such as "soon", "next week", "I'll try", or "working on it" into a
  specific date. Quote or paraphrase the vague language itself - do not manufacture a date just to
  make the response look more precise or useful.
- Do not make legal threats or reference legal action, debt collectors, or litigation.
- Do not autonomously negotiate, propose, or agree to a payment plan or revised payment terms.
- Never recommend aggressive collection action when a genuine dispute is present.
- Safety is more important than aggressive collections or a confident-sounding answer. When uncertain
  about any fact, date, or classification, choose the safer/uncertain classification and set
  human_approval_required = true rather than guessing.

WHEN HUMAN APPROVAL IS REQUIRED (set human_approval_required = true)
- The customer raises a genuine dispute (full or partial) or contests the amount or the work.
- The customer asks for a payment plan, instalments, or extended terms.
- The conversation contains contradictory or inconsistent information.
- Identity is unclear (wrong entity, "no account with you").
- The situation is ambiguous or there is not enough information to act safely.
- The account is being escalated beyond routine reminders.
- You are not confident in your own classification.

CLASSIFICATION VALUES
FOLLOW_UP, PROMISE_TO_PAY, DISPUTE, PAYMENT_PENDING, PARTIAL_PAYMENT, CUSTOMER_REQUEST,
PAYMENT_HELP, VERIFY_PAYMENT, ESCALATE, RESOLVED, HUMAN_REQUIRED.
- DISPUTE always requires human approval and must never lead to aggressive collection action.
- If the customer claims payment but the case facts do not confirm it, use VERIFY_PAYMENT and do not confirm receipt.
- Use HUMAN_REQUIRED when the safest answer is to stop and let a person decide.

OUTPUT
Output ONLY the required JSON object. No markdown, no code fences, no explanation, no commentary,
and no text before or after the JSON. Follow the schema below exactly, with exactly these fields:
{
  "invoice_id": string,
  "customer": string,
  "amount": number,
  "days_overdue": number,
  "situation": string,
  "classification": one of the classification values above,
  "confidence": number,
  "evidence": string[],
  "recommended_action": string,
  "draft_response": string,
  "human_approval_required": boolean,
  "reason_for_handoff": string | null
}`;

/** Everything about one case except the final "produce the decision" instruction. */
function formatCaseBlock(rc: ReceivablesCase): string {
  const facts = rc.invoice_facts.map((f) => `- ${f}`).join("\n");
  const history = rc.conversation_history
    .map((m) => `[${m.date}] ${m.from}: ${m.body}`)
    .join("\n");

  return `INVOICE
invoice_id: ${rc.invoice_id}
customer: ${rc.customer}
amount: ${rc.amount} ${rc.currency}
days_overdue: ${rc.days_overdue}

INVOICE FACTS
${facts || "(none)"}

CONVERSATION HISTORY
${history || "(no messages)"}`;
}

/** Build the per-case user prompt from a ReceivablesCase (single-case mode). */
export function buildUserPrompt(rc: ReceivablesCase): string {
  return `${formatCaseBlock(rc)}\n\nProduce the decision JSON now.`;
}

/**
 * Build one combined user prompt covering multiple cases, for a single batched
 * request (e.g. to evaluate a whole benchmark suite without one API call per
 * case). Each case is clearly delimited and labeled by its own invoice_id.
 *
 * This function only adds an output-format instruction (how many decisions,
 * how to identify each one, and an explicit note reconciling this batched
 * request with SYSTEM_PROMPT's single-case framing). It does not add, remove,
 * or alter any safety rule - SYSTEM_PROMPT itself is unchanged and is still
 * sent as-is alongside this prompt.
 */
export function buildBatchUserPrompt(cases: readonly ReceivablesCase[]): string {
  const blocks = cases
    .map(
      (rc, i) =>
        `===== CASE ${i + 1} of ${cases.length} (invoice_id: ${rc.invoice_id}) =====\n${formatCaseBlock(rc)}`,
    )
    .join("\n\n");

  return `${blocks}

There are ${cases.length} independent cases above, each identified by its own invoice_id.

Note on this request: your instructions describe analyzing one case and producing one decision.
For this request only, analyze ALL ${cases.length} cases above and return a single JSON array
containing exactly ${cases.length} decision objects, one per case - every hard rule, human-approval
condition, and classification value in your instructions still applies to each case individually.

Rules for this batched response:
- Produce exactly ${cases.length} decision objects, one per case, as a single JSON array.
- Each object's "invoice_id" field must exactly match the invoice_id of the case it analyzes, so it
  can be matched back to that case.
- Analyze every case independently - do not let one case's facts or conversation influence another
  case's decision.
- Do not skip any case. Do not invent additional cases. Do not merge multiple cases into one decision.`;
}
