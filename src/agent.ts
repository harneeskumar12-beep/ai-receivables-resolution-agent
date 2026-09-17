/**
 * The thin agent layer: ReceivablesCase -> deterministic classifier (if it
 * confidently matches) OR AIProvider -> parseDecision -> result.
 * No memory, tools, loops, retries, fallbacks, or integrations.
 */

import type { AIProvider, DecisionParseResult } from "./provider.ts";
import { parseDecision } from "./provider.ts";
import type { ReceivablesCase } from "./types.ts";
import { classifyDeterministically } from "./deterministic-classifier.ts";

export class ReceivablesAgent {
  readonly #provider: AIProvider;

  constructor(provider: AIProvider) {
    this.#provider = provider;
  }

  get providerName(): string {
    return this.#provider.name;
  }

  /**
   * Deterministic-first: a small set of high-confidence, narrow situations
   * (see deterministic-classifier.ts) are recognized directly from the case,
   * with no provider call at all. Everything else falls through to the
   * existing provider -> parseDecision() flow, unchanged.
   *
   * Either way this method's return shape is exactly the same
   * `DecisionParseResult` as before, so every existing caller still runs the
   * result through the unmodified safety layer exactly as it already did -
   * a deterministic match is never treated as final on its own.
   *
   * Never fabricates a decision: if parsing fails, the result is
   * `{ ok: false, decision: null, errors: [...] }`, not a thrown exception
   * and not a silently-repaired guess.
   */
  async resolve(receivablesCase: ReceivablesCase): Promise<DecisionParseResult> {
    const deterministic = classifyDeterministically(receivablesCase);
    if (deterministic.matched) {
      return { ok: true, decision: deterministic.decision, errors: [] };
    }

    const raw = await this.#provider.analyze(receivablesCase);
    return parseDecision(raw);
  }
}
