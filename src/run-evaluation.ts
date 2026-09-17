/**
 * Evaluation entry point.
 *
 * Pipeline: case -> prompt -> provider (raw output) -> parseDecision -> safety
 * -> evaluator. Two providers are available, selected once at startup by
 * resolveProvider() (not switched automatically mid-run):
 *
 *   - OpenRouter (src/openrouter-provider.ts, model google/gemma-4-31b-it:free):
 *     the ORIGINAL single-case path - ReceivablesAgent.resolve() (unchanged)
 *     once per case, exactly 20 requests, no batching.
 *   - Gemini (src/gemini-provider.ts): all 20 cases sent in a SINGLE batched
 *     Interactions API request (see GeminiProvider.analyzeBatch /
 *     prompt.ts buildBatchUserPrompt) instead of one request per case, to
 *     avoid burning one free-tier request per case.
 *
 * Whichever path runs, SYSTEM_PROMPT, parseDecision, the safety layer, the
 * evaluator, and the 20 cases are exactly the same, unmodified. Every case
 * still goes through validateDecision() and evaluateCase()/
 * evaluateParseFailure() individually and independently.
 *
 * Credentials are loaded from a local `.env` file in the project root (next to
 * package.json) via dotenv, NOT from the shell environment. `.env` is never
 * committed (see .gitignore) and its contents are never printed, logged, or
 * included in any error or report.
 *
 * With neither OPENROUTER_API_KEY nor GEMINI_API_KEY present, this makes no
 * external calls and produces no score - it reports that no real-LLM provider
 * is configured (unchanged from before).
 *
 * A provider failure fails every case closed (no data was ever obtained, so
 * none can be scored); for Gemini, a batch response that is malformed or
 * missing specific cases fails closed at the per-case level - see
 * parseBatchDecisions() in src/provider.ts. No decision is ever fabricated.
 * No retries, no fallback providers, no automatic re-runs, no per-case
 * re-request.
 */

import { config as loadEnvFile } from "dotenv";
// Loads GEMINI_API_KEY (and anything else) from .env in the project root into
// process.env. `quiet: true` only suppresses dotenv's own "injecting env from
// .env" tip line so the evaluation report stays clean - it has no effect on
// which variables are loaded and never touches their values.
loadEnvFile({ quiet: true });

import { EVALUATION_CASES } from "./cases.ts";
import { ReceivablesAgent } from "./agent.ts";
import { validateDecision } from "./safety.ts";
import { evaluateAll } from "./evaluator.ts";
import type { CaseEvaluation, EvaluationInput, EvaluationReport } from "./evaluator.ts";
import { parseBatchDecisions } from "./provider.ts";
import type { BatchParseResult } from "./provider.ts";
import { GEMINI_MODEL, GeminiProvider } from "./gemini-provider.ts";
import { OPENROUTER_MODEL, OpenRouterProvider } from "./openrouter-provider.ts";

/** Which provider resolveProvider() picked, and the concrete instance to use. */
type ResolvedProvider =
  | { readonly kind: "gemini"; readonly provider: GeminiProvider }
  | { readonly kind: "openrouter"; readonly provider: OpenRouterProvider };

/**
 * The single wiring point for the real-LLM experiment.
 *
 * Selects OpenRouter when OPENROUTER_API_KEY is present (added so the
 * experiment can run without depending on Gemini's quota); otherwise selects
 * Gemini when GEMINI_API_KEY is present; otherwise returns null and no
 * network call is made (the original no-provider behavior is preserved).
 * This is a one-time startup check, not automatic switching mid-run - never
 * logs either key's value, only whether one is present.
 */
function resolveProvider(): ResolvedProvider | null {
  const openRouterKey = process.env["OPENROUTER_API_KEY"];
  if (typeof openRouterKey === "string" && openRouterKey.length > 0) {
    return { kind: "openrouter", provider: new OpenRouterProvider(openRouterKey) };
  }
  const geminiKey = process.env["GEMINI_API_KEY"];
  if (typeof geminiKey === "string" && geminiKey.length > 0) {
    return { kind: "gemini", provider: new GeminiProvider(geminiKey) };
  }
  return null;
}

function printCase(c: CaseEvaluation): void {
  console.log(`  ${c.id} - ${c.title}`);
  if (c.parse_failed) {
    console.log(`    PARSE FAILURE (yes): ${c.parse_errors.join("; ")}`);
    console.log(`    critical safety failure: NO (not applicable - no decision was parsed)`);
    return;
  }
  console.log(
    `    classification: raw=${c.raw_classification}  expected=${c.classification_expected}  ` +
      `${c.classification_correct ? "CORRECT" : "INCORRECT"}`,
  );
  console.log(
    `    human_approval_required: raw=${c.raw_human_approval_required}  expected=${c.human_approval_expected}  ` +
      `${c.human_approval_correct ? "CORRECT" : "INCORRECT"}`,
  );
  console.log(
    `    final safety decision: classification=${c.final_classification}  human_approval_required=${c.final_human_approval_required}`,
  );
  console.log(`    overridden: ${c.overridden ? "YES" : "NO"}`);
  console.log(
    `    safety violations: ${c.safety_violations.length > 0 ? c.safety_violations.join("; ") : "none"}`,
  );
  console.log(`    parse failure: NO`);
  console.log(`    critical safety failure: ${c.critical_safety_failure ? "YES" : "NO"}`);
}

function printReport(report: EvaluationReport, providerLabel: string, modelLabel: string): void {
  const s = report.summary;

  console.log("");
  console.log(`Provider: ${providerLabel}`);
  console.log(`Model: ${modelLabel}`);

  console.log("");
  console.log("PER-CASE RESULTS");
  for (const c of report.cases) {
    printCase(c);
  }

  console.log("");
  console.log("SUMMARY");
  console.log(`  cases:                     ${s.total}`);
  console.log(
    `  classification accuracy:   ${s.classification_correct}/${s.total} (${s.classification_accuracy})  [scored against the RAW model decision]`,
  );
  console.log(
    `  human-approval accuracy:   ${s.human_approval_correct}/${s.total} (${s.human_approval_accuracy})  [scored against the RAW model decision]`,
  );
  console.log(`  safety result:              ${s.safety_expectations_met}/${s.total} expectations met (${s.safety_accuracy})`);
  console.log(`  safety-layer overrides:     ${s.overridden_count}/${s.total}`);
  console.log(`  critical safety failures:   ${s.critical_safety_failures}`);
  console.log(`  parse failures:             ${s.parse_failures}/${s.total}`);
  console.log(`  passed:                     ${s.passed}/${s.total}`);

  if (s.critical_safety_failures > 0) {
    console.log("");
    console.log("  CRITICAL SAFETY FAILURES");
    for (const c of report.cases.filter((x) => x.critical_safety_failure)) {
      console.log(`    - ${c.id} (${c.title}): ${c.critical_safety_failure_reasons.join("; ")}`);
    }
  }
  if (s.parse_failure_ids.length > 0) {
    console.log("");
    console.log("  UNPARSEABLE CASES");
    for (const c of report.cases.filter((x) => x.parse_failed)) {
      console.log(`    - ${c.id} (${c.title}): ${c.parse_errors.join("; ")}`);
    }
  }
  if (s.failed_ids.length > 0) {
    console.log("");
    console.log("  FAILED CASES");
    for (const c of report.cases.filter((x) => !x.passed && !x.parse_failed)) {
      const why: string[] = [];
      if (!c.classification_correct) {
        why.push(
          `raw classification ${c.raw_classification} != ${c.classification_expected} (final: ${c.final_classification})`,
        );
      }
      if (!c.human_approval_correct) {
        why.push(
          `raw human_approval_required ${c.raw_human_approval_required} != ${c.human_approval_expected} (final: ${c.final_human_approval_required})`,
        );
      }
      why.push(...c.safety_failures);
      console.log(`    - ${c.id} (${c.title}): ${why.join("; ")}`);
    }
  }

  console.log("");
  console.log(
    `FINAL VERDICT INPUT: classification_accuracy=${s.classification_accuracy} human_approval_accuracy=${s.human_approval_accuracy} ` +
      `critical_safety_failures=${s.critical_safety_failures} parse_failures=${s.parse_failures} overridden_count=${s.overridden_count}`,
  );
}

async function main(): Promise<void> {
  console.log("AI Receivables Resolution Agent - evaluation harness");
  console.log(`Loaded ${EVALUATION_CASES.length} deterministic evaluation cases.`);

  const resolved = resolveProvider();
  if (resolved === null) {
    console.log("");
    console.log("STATUS: real LLM evaluation provider is NOT configured.");
    console.log("No analysis was run and no score was produced.");
    console.log("");
    console.log("Set OPENROUTER_API_KEY or GEMINI_API_KEY in .env to run the experiment");
    console.log("(src/openrouter-provider.ts / src/gemini-provider.ts), then re-run `npm run eval`.");
    process.exitCode = 1;
    return;
  }

  let inputs: EvaluationInput[];
  let providerLabel: string;
  let modelLabel: string;

  if (resolved.kind === "gemini") {
    providerLabel = "Gemini";
    modelLabel = GEMINI_MODEL;
    const provider = resolved.provider;
    const invoiceIds = EVALUATION_CASES.map((ec) => ec.case.invoice_id);

    console.log("");
    console.log(
      `Sending all ${EVALUATION_CASES.length} cases to Gemini in a single batched request (one API call, not ${EVALUATION_CASES.length}).`,
    );

    let batch: BatchParseResult;
    try {
      const raw = await provider.analyzeBatch(EVALUATION_CASES.map((ec) => ec.case));
      batch = parseBatchDecisions(raw, invoiceIds);
    } catch (err) {
      // The single batched request itself failed (transport/auth/timeout) - no
      // data was obtained for ANY case, so every case fails closed identically.
      // This is not a retry: main() does not attempt the request again.
      const message = err instanceof Error ? err.message : String(err);
      const reason = `Provider failed before any decision could be parsed: ${message}`;
      batch = {
        ok: false,
        errors: [reason],
        decisionsByInvoiceId: new Map(invoiceIds.map((id) => [id, { ok: false, decision: null, errors: [reason] }])),
      };
    }

    if (batch.errors.length > 0) {
      console.log("");
      console.log("BATCH-LEVEL ISSUES");
      for (const e of batch.errors) {
        console.log(`  - ${e}`);
      }
    }

    inputs = [];
    for (const ec of EVALUATION_CASES) {
      const parsed = batch.decisionsByInvoiceId.get(ec.case.invoice_id) ?? {
        ok: false,
        decision: null,
        errors: [`No decision found for invoice_id ${ec.case.invoice_id}.`],
      };
      if (!parsed.ok || parsed.decision === null) {
        inputs.push({ evalCase: ec, kind: "parse_failure", errors: parsed.errors });
        continue;
      }
      const safety = validateDecision(ec.case, parsed.decision);
      inputs.push({ evalCase: ec, kind: "decision", safety });
    }
  } else {
    // OpenRouter: the original single-case path (ReceivablesAgent.resolve() ->
    // parseDecision -> validateDecision, unchanged), once per case, in order.
    // No batching, no retries - one request per case, exactly 20 requests.
    providerLabel = "OpenRouter";
    modelLabel = OPENROUTER_MODEL;
    const agent = new ReceivablesAgent(resolved.provider);

    console.log("");
    console.log(`Sending each of the ${EVALUATION_CASES.length} cases to OpenRouter individually (one request per case).`);

    inputs = [];
    for (const ec of EVALUATION_CASES) {
      try {
        const parsed = await agent.resolve(ec.case);
        if (!parsed.ok || parsed.decision === null) {
          inputs.push({ evalCase: ec, kind: "parse_failure", errors: parsed.errors });
          continue;
        }
        const safety = validateDecision(ec.case, parsed.decision);
        inputs.push({ evalCase: ec, kind: "decision", safety });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        inputs.push({
          evalCase: ec,
          kind: "parse_failure",
          errors: [`Provider failed before a decision could be parsed: ${message}`],
        });
      }
    }
  }

  const report = evaluateAll(inputs);
  printReport(report, providerLabel, modelLabel);
  if (
    report.summary.critical_safety_failures > 0 ||
    report.summary.parse_failures > 0 ||
    report.summary.failed > 0
  ) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
