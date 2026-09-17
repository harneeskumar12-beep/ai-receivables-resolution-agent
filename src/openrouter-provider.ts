/**
 * OpenRouter provider - a SECOND AIProvider implementation, added so the
 * real-LLM baseline experiment can run without depending on Gemini's quota.
 *
 * Implements the exact same `AIProvider` contract as GeminiProvider
 * (src/gemini-provider.ts), which is completely unchanged by this file. Sends
 * the existing SYSTEM_PROMPT and buildUserPrompt(case) unchanged, via
 * OpenRouter's OpenAI-compatible chat completions endpoint, and returns the
 * model's RAW output text. It does not parse, validate, run safety checks, or
 * evaluate - that remains parseDecision() / validateDecision() / the
 * evaluator, all unmodified. Uses Node's built-in fetch - no new dependency.
 *
 * No retries. No fallback model. No automatic model switching. Exactly one
 * request in, one response (or one thrown error) out.
 */

import type { AIProvider } from "./provider.ts";
import type { ReceivablesCase } from "./types.ts";
import { RECEIVABLES_CLASSIFICATIONS } from "./types.ts";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.ts";

/** Fixed model for this experiment - not configurable, per instructions. */
export const OPENROUTER_MODEL = "google/gemma-4-26b-a4b-it:free";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Bounds a single request attempt. This is NOT a retry (there is still
 * exactly one attempt, nothing here re-sends the request) - without a bound,
 * a stalled connection hangs indefinitely instead of failing, which is the
 * opposite of "surfaced clearly."
 */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Structured-output schema hint mirroring ReceivablesDecision (src/types.ts)
 * field-for-field, in the OpenAI-compatible `json_schema` strict-mode shape -
 * the same generation hint GeminiProvider sends, expressed for the
 * OpenAI-compatible response_format mechanism instead. This is NOT a second
 * parser or a second source of truth - parseDecision() (unchanged, in
 * src/provider.ts) remains the only place a raw response is turned into a
 * trusted decision.
 */
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    invoice_id: { type: "string" },
    customer: { type: "string" },
    amount: { type: "number" },
    days_overdue: { type: "number" },
    situation: { type: "string" },
    classification: { type: "string", enum: [...RECEIVABLES_CLASSIFICATIONS] },
    confidence: { type: "number" },
    evidence: { type: "array", items: { type: "string" } },
    recommended_action: { type: "string" },
    draft_response: { type: "string" },
    human_approval_required: { type: "boolean" },
    reason_for_handoff: { type: ["string", "null"] },
  },
  required: [
    "invoice_id",
    "customer",
    "amount",
    "days_overdue",
    "situation",
    "classification",
    "confidence",
    "evidence",
    "recommended_action",
    "draft_response",
    "human_approval_required",
    "reason_for_handoff",
  ],
};

/**
 * Raised on any provider-level failure: transport errors, a non-2xx HTTP
 * response, or a response with no usable message content. Always carries the
 * model name and, when available, the HTTP status - and NEVER the API key.
 */
export class OpenRouterProviderError extends Error {
  readonly model: string;
  readonly status: number | undefined;

  constructor(model: string, detail: string, status?: number) {
    const statusPart = status !== undefined ? `, status=${status}` : "";
    super(`OpenRouter request failed (model=${model}${statusPart}): ${detail}`);
    this.name = "OpenRouterProviderError";
    this.model = model;
    this.status = status;
  }
}

/** Pull `choices[0].message.content` out of an OpenAI-compatible response body, if present. */
function extractMessageContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : null;
}

export class OpenRouterProvider implements AIProvider {
  readonly name: string;
  readonly #apiKey: string;

  constructor(apiKey: string) {
    if (apiKey.length === 0) {
      throw new Error("OpenRouterProvider requires a non-empty API key.");
    }
    this.#apiKey = apiKey;
    this.name = `openrouter:${OPENROUTER_MODEL}`;
  }

  /**
   * Send one case to OpenRouter's OpenAI-compatible chat completions endpoint
   * and return the raw assistant message content. Never parses, validates, or
   * evaluates the response - see parseDecision() / validateDecision().
   */
  async analyze(receivablesCase: ReceivablesCase): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(receivablesCase) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "receivables_decision",
              strict: true,
              schema: RESPONSE_JSON_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpenRouterProviderError(OPENROUTER_MODEL, message);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new OpenRouterProviderError(OPENROUTER_MODEL, bodyText || response.statusText, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpenRouterProviderError(
        OPENROUTER_MODEL,
        `Response was not valid JSON: ${message}`,
        response.status,
      );
    }

    // Return the RAW assistant content, even if it turns out not to be valid
    // JSON itself or missing entirely. parseDecision() (invoked by
    // ReceivablesAgent, not here) is the single place that validates it and
    // fails closed on malformed content.
    return extractMessageContent(payload) ?? "";
  }
}
