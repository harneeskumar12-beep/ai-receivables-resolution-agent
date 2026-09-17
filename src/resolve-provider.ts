/**
 * Provider selection for the work-queue prototype server, extracted into its
 * own tiny module (rather than living inline in server.ts) so it can be unit
 * tested without starting an HTTP server - server.ts calls main()/listen() at
 * import time, which importing it directly in a test would trigger.
 *
 * Precedence mirrors run-evaluation.ts's resolveProvider() exactly:
 * OPENROUTER_API_KEY first, then GEMINI_API_KEY, else no provider. Neither
 * AIProvider, GeminiProvider, nor OpenRouterProvider are changed by this file.
 */

import type { AIProvider } from "./provider.ts";
import { GeminiProvider } from "./gemini-provider.ts";
import { OpenRouterProvider } from "./openrouter-provider.ts";

export type ResolvedProviderKind = "openrouter" | "gemini";

export interface ResolvedProvider {
  readonly kind: ResolvedProviderKind;
  readonly provider: AIProvider;
}

/**
 * Selects OPENROUTER_API_KEY first, then GEMINI_API_KEY, else null. Reads
 * from the given env (defaulting to process.env) so callers - and tests -
 * control which environment is inspected, without touching real environment
 * variables. Never logs a key's value.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ResolvedProvider | null {
  const openRouterKey = env["OPENROUTER_API_KEY"];
  if (typeof openRouterKey === "string" && openRouterKey.length > 0) {
    return { kind: "openrouter", provider: new OpenRouterProvider(openRouterKey) };
  }
  const geminiKey = env["GEMINI_API_KEY"];
  if (typeof geminiKey === "string" && geminiKey.length > 0) {
    return { kind: "gemini", provider: new GeminiProvider(geminiKey) };
  }
  return null;
}
