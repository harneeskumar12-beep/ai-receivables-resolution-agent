# AI Receivables Resolution Agent - V0

A minimal reasoning-engine foundation for an AI agent that reads an overdue-invoice
case and produces a single structured decision. This is **V0**: architecture and
evaluation scaffolding only. It makes **no real LLM or API calls**.

## What V0 is testing

The hypothesis under test is that, given:

- invoice information
- customer information
- amount
- days overdue
- conversation history

an LLM can eventually: understand what happened, classify the receivables
situation, identify supporting evidence, recommend the safest next action, decide
whether human approval is required, and prepare an appropriate response.

V0 builds only the pieces needed to run that experiment later in a controlled way:
the domain types, a fixed set of evaluation cases with expected outcomes, the
shared prompt, a replaceable provider seam, a thin agent, a deterministic safety
layer, and an evaluation engine.

## Current architecture

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Core domain types: `ReceivablesCase`, `ReceivablesClassification`, `ReceivablesDecision`. |
| `src/cases.ts` | 20 deterministic evaluation fixtures, each with an expected outcome. |
| `src/prompt.ts` | Shared system prompt and per-case user-prompt builder. |
| `src/provider.ts` | `AIProvider` interface (returns the provider's RAW output) + deterministic parser (`parseDecision`) for that output. No provider is implemented. |
| `src/agent.ts` | `ReceivablesAgent`: `ReceivablesCase -> AIProvider (raw output) -> parseDecision -> DecisionParseResult`. Nothing else. |
| `src/safety.ts` | Deterministic safety validator, independent of any LLM. |
| `src/evaluator.ts` | Compares the model's RAW decision against a case's expected outcome; separately reports what the safety layer changed; surfaces critical failures and parse failures without hiding them in an aggregate score. |
| `src/run-evaluation.ts` | Evaluation entry point: `case -> prompt -> provider (raw) -> parseDecision -> safety -> evaluator`. Reports that no real provider is configured; a parse failure or provider error on any single case is recorded as a failed case, not a crash of the whole run. |

The provider is the only seam a real LLM integration touches: it returns raw
output, and `parseDecision` (already wired into the agent) turns that into a
typed decision or a explicit parse failure. Adding a provider must not require
changes to the safety layer, evaluator, or cases.

Classification accuracy and human-approval accuracy are always scored against
the model's **raw** decision, never the safety-sanitized one - a safety
override can make a decision safe to act on, but it must never quietly improve
the model's own score. The evaluator reports `raw_classification` /
`final_classification`, `raw_human_approval_required` /
`final_human_approval_required`, and an `overridden` flag per case, plus an
`overridden_count` in the summary, so "the model got it right" and "the safety
layer corrected the model" stay visibly different things.

## Safety philosophy

Safety outranks aggressive collection. The safety layer never trusts the model
just because it sounds confident. It deterministically enforces, at minimum:

- a dispute always requires human approval and never leads to aggressive collection;
- payment-plan situations require human approval; terms are never negotiated autonomously;
- contradictory information requires human review;
- low confidence or missing evidence forces `HUMAN_REQUIRED`;
- a claimed-but-unverified payment is never recorded as received;
- unsupported facts (invented dates, amounts, evidence) never become asserted facts;
- legal threats are never allowed.

When the model's decision breaks a rule, the safety layer returns a sanitized
decision plus the list of violations. Critical violations are reported on their
own, never folded into an aggregate accuracy score.

## Why there is no UI / database / integration yet

V0 exists to validate one reasoning hypothesis as cheaply and reliably as
possible. A UI, dashboard, database, auth, billing, email/CRM integrations,
autonomous sending, and multi-agent structure would all be effort spent before
knowing whether the core reasoning works. They are deliberately out of scope.

## Install

Requires Node.js >= 22.18 (runs TypeScript sources directly).

```
npm install
```

## Run tests

Focused unit tests for the safety layer, the output parser, and the evaluator.
They make no network calls.

```
npm test
```

## Build (type-check + emit)

```
npm run build
```

## Evaluation harness

```
npm run eval
```

In V0 this reports that the real-LLM evaluation provider is not configured and
exits non-zero. It does not fabricate a passing result.

## Next controlled step

The real-LLM validation is the next experiment. To run it:

1. Implement an `AIProvider` (in `src/provider.ts` or a new file) that sends
   `SYSTEM_PROMPT` + `buildUserPrompt(case)` to a real model and returns its
   RAW output (string or object) - `ReceivablesAgent.resolve` already runs that
   through `parseDecision` for you; a malformed response comes back as
   `{ ok: false, errors: [...] }`, never a fabricated decision.
2. Return that provider from `resolveProvider()` in `src/run-evaluation.ts`,
   reading credentials from the environment (see `.env.example`).
3. Run `npm run eval` and review classification accuracy, human-approval
   accuracy (both scored against the raw model decision), the safety-override
   count, safety-expectation accuracy, the critical-safety-failure list, and
   any unparseable cases.
