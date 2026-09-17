/**
 * Google Gemini provider for the V0 real-LLM experiment.
 *
 * Implements the existing `AIProvider` contract (`analyze`, one case per call)
 * unchanged, and adds one additional method - `analyzeBatch` - that sends many
 * cases to Gemini in a single Interactions API request and expects a single
 * JSON array back, one decision per case. This exists purely to avoid spending
 * one free-tier request per case; it does not change what is asked of the
 * model per case (same SYSTEM_PROMPT, same per-decision schema) or how a raw
 * response is validated (still parseDecision(), via parseBatchDecisions() for
 * unbundling the array - see src/provider.ts).
 *
 * No retries anywhere in this file. No fallback models. No automatic model
 * switching. Exactly one request in, one response (or one thrown error) out,
 * whether calling analyze() or analyzeBatch().
 */

import { ApiError, GoogleGenAI } from "@google/genai";
import type { AIProvider } from "./provider.ts";
import type { ReceivablesCase } from "./types.ts";
import { RECEIVABLES_CLASSIFICATIONS } from "./types.ts";
import { SYSTEM_PROMPT, buildBatchUserPrompt, buildUserPrompt } from "./prompt.ts";

/** Model under test for this experiment. Not configurable - see run instructions. */
export const GEMINI_MODEL = "gemini-3.8-flash";

/**
 * Bounds a single-case request attempt. This is NOT a retry (there is still
 * exactly one attempt, no `retries` option is set anywhere below) - without a
 * bound, a stalled connection hangs the SDK's fetch indefinitely instead of
 * failing, which is the opposite of "surfaced clearly."
 */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Bounds the single batched request (many cases, one call). Generous because
 * generating a full decision for every case in one response legitimately
 * takes longer than one case - still exactly one attempt, no retry.
 */
const BATCH_REQUEST_TIMEOUT_MS = 600_000;

/**
 * A generation hint mirroring ReceivablesDecision (src/types.ts) field-for-field,
 * so the model is asked for exactly the shape parseDecision() already validates.
 * This is NOT a second parser or a second source of truth - parseDecision()
 * remains the only place a raw response is turned into a trusted decision.
 * Reused as-is (never redefined) for both single-case and batched requests -
 * batched requests simply wrap it in a JSON array schema, see analyzeBatch().
 */
const RESPONSE_SCHEMA = {
  type: "object",
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
    reason_for_handoff: { type: "string", nullable: true },
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
 * Raised on any provider-level failure: transport/auth errors from the SDK, or
 * an interaction that did not complete successfully. Always carries the model
 * name and, when available, the HTTP status - and NEVER the API key.
 */
export class GeminiProviderError extends Error {
  readonly model: string;
  readonly status: number | undefined;

  constructor(model: string, detail: string, status?: number) {
    const statusPart = status !== undefined ? `, status=${status}` : "";
    super(`Gemini request failed (model=${model}${statusPart}): ${detail}`);
    this.name = "GeminiProviderError";
    this.model = model;
    this.status = status;
  }
}

export class GeminiProvider implements AIProvider {
  readonly name: string;
  readonly #client: GoogleGenAI;

  constructor(apiKey: string) {
    if (apiKey.length === 0) {
      throw new Error("GeminiProvider requires a non-empty API key.");
    }
    this.#client = new GoogleGenAI({ apiKey });
    this.name = `gemini:${GEMINI_MODEL}`;
  }

  /**
   * Send one case to Gemini via the Interactions API and return its raw
   * output text. Never parses, validates, or evaluates the response.
   */
  async analyze(receivablesCase: ReceivablesCase): Promise<unknown> {
    return this.#runInteraction(buildUserPrompt(receivablesCase), RESPONSE_SCHEMA, REQUEST_TIMEOUT_MS);
  }

  /**
   * Send MANY cases to Gemini in a single Interactions API request (one call
   * instead of one-per-case) and return the raw output text, expected to be a
   * JSON array with exactly `cases.length` decisions, each identified by its
   * own `invoice_id`. Never parses, validates, or evaluates the response -
   * see parseBatchDecisions() in src/provider.ts for unbundling it.
   */
  async analyzeBatch(cases: readonly ReceivablesCase[]): Promise<unknown> {
    const arraySchema = {
      type: "array",
      minItems: cases.length,
      maxItems: cases.length,
      items: RESPONSE_SCHEMA,
    };
    return this.#runInteraction(buildBatchUserPrompt(cases), arraySchema, BATCH_REQUEST_TIMEOUT_MS);
  }

  /**
   * Shared request path for both analyze() and analyzeBatch(): one Interactions
   * API call, bounded by `timeoutMs`, no retry. Surfaces any failure (transport,
   * auth, or a non-"completed" interaction) as a GeminiProviderError carrying
   * the model name and HTTP status when available.
   */
  async #runInteraction(input: string, schema: unknown, timeoutMs: number): Promise<string> {
    let interaction;
    try {
      interaction = await this.#client.interactions.create(
        {
          model: GEMINI_MODEL,
          input,
          system_instruction: SYSTEM_PROMPT,
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema,
          },
        },
        { timeout_ms: timeoutMs },
      );
    } catch (err) {
      if (err instanceof ApiError) {
        throw new GeminiProviderError(GEMINI_MODEL, err.message, err.status);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new GeminiProviderError(GEMINI_MODEL, message);
    }

    if (interaction.status === "failed") {
      const detail =
        interaction.errors
          ?.map((e) => e.message ?? e.code)
          .filter((x): x is string => Boolean(x))
          .join("; ") || "no error detail returned by the API";
      throw new GeminiProviderError(GEMINI_MODEL, `interaction status=failed: ${detail}`);
    }
    if (interaction.status !== "completed") {
      throw new GeminiProviderError(GEMINI_MODEL, `unexpected interaction status: ${interaction.status}`);
    }

    // Return the RAW output text, even if it turns out not to be valid JSON
    // or not the expected shape. parseDecision() / parseBatchDecisions() (not
    // this file) are the only places that validate it and fail closed on
    // malformed content.
    return interaction.output_text ?? "";
  }
}
