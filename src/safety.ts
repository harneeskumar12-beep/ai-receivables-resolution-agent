/**
 * Deterministic safety validator, fully independent of the LLM.
 *
 * It inspects the case and the model's proposed decision, records violations,
 * and returns a sanitized decision that is safe to act on. It never trusts the
 * model just because the model sounds confident, AND it never trusts keyword
 * matches alone - see Rule 0 below for the model-aware backstop.
 */

import type { ReceivablesCase } from "./types.ts";
import type { ReceivablesClassification, ReceivablesDecision } from "./types.ts";

export type SafetySeverity = "critical" | "high" | "medium";

export interface SafetyViolation {
  code: string;
  severity: SafetySeverity;
  message: string;
}

export interface SafetyValidationResult {
  /** True only if the model's decision needed no changes. */
  safe: boolean;
  /** True if the safety layer changed the decision in any way. */
  overridden: boolean;
  /** Human-readable summary of why it was overridden, or null. */
  override_reason: string | null;
  /** Every violation detected in the original decision. */
  violations: SafetyViolation[];
  /** Sanitized decision, safe to act on. */
  decision: ReceivablesDecision;
  /** The decision exactly as produced by the model. */
  original_decision: ReceivablesDecision;
}

const SAFE_HANDOFF_DRAFT =
  "Thank you for your message. This account needs review by a member of our accounts receivable team before we can respond further. A colleague will follow up with you directly.";

const PAYMENT_VERIFICATION_DRAFT =
  "Thank you for letting us know. We do not yet see this payment matched against the invoice on our side. Could you send the remittance details or payment reference so we can trace and confirm it? We will not treat the invoice as settled until it is matched.";

const DISPUTE_TERMS: readonly string[] = [
  "dispute",
  "disputing",
  "disputed",
  "we dispute",
  "contest this",
  "contesting",
  "we never received",
  "never received the",
  "did not receive",
  "didn't receive",
  "never ordered",
  "did not order",
  "didn't order",
  "not our invoice",
  "wrong company",
  "no account with you",
  "no account or contract",
  "double-billed",
  "double billed",
  "billed twice",
  "billed it twice",
  "charged twice",
  "overcharged",
  "over-charged",
  "incorrect amount",
  "amount is wrong",
  "total should be",
  "we don't owe",
  "do not owe",
  "we won't be paying",
  "we will not be paying",
  "reject this invoice",
  "not liable",
  "were not delivered",
  "not delivered as agreed",
  "never delivered",
  "was never delivered",
  "never took place",
  "was cancelled",
  "was canceled",
  "cancelled by your team",
  "services that were not delivered",
];

// Tightened per V0 correction pass: "pay over", "pay in two/2/three/3" and bare
// "equal monthly" were broad enough to match ordinary payment language ("pay over
// the phone", "pay in 2 days") with no actual plan request. Every remaining term
// requires an unambiguous plan-shaped phrase.
const PAYMENT_PLAN_TERMS: readonly string[] = [
  "payment plan",
  "instalment",
  "instalments",
  "installment",
  "installments",
  "split this into",
  "split it into",
  "split the invoice",
  "monthly payments",
  "monthly instalments",
  "monthly installments",
  "equal monthly payments",
  "equal monthly instalments",
  "equal monthly installments",
  "pay in stages",
  "spread the cost",
  "spread payment",
  "spread the payment",
  "partial payments over",
  "extended payment terms",
  "extend the payment terms",
  // Natural split-payment phrasing that names no specific plan keyword
  // ("instalment", "split", "payment plan") but still proposes paying part
  // now and the rest later - the connective is the actual signal, since the
  // amount and timing vary too much to enumerate literally.
  "and the remaining",
  "and the rest",
  "and the balance",
];

const PAYMENT_CLAIM_TERMS: readonly string[] = [
  "already paid",
  "we paid",
  "we've paid",
  "we have paid",
  "payment was made",
  "made the payment",
  "sent the payment",
  "transfer was sent",
  "transfer sent",
  "paid this invoice",
  "paid this weeks ago",
  "paid weeks ago",
  "paid last month",
  "paid in full on",
  "settled this invoice",
  "remittance",
];

const PLAN_NEGOTIATION_TERMS: readonly string[] = [
  "we can offer",
  "we agree to",
  "agreed to a plan",
  "we can accept",
  "here is the plan",
  "first instalment of",
  "first installment of",
  "monthly instalment of",
  "monthly installment of",
  "we'll accept",
  "we will accept",
  "we can arrange",
  "your plan is approved",
  "we approve the plan",
  "spread it over",
];

const LEGAL_THREAT_TERMS: readonly string[] = [
  "legal action",
  "take legal",
  "pursue legal",
  "legal proceedings",
  "lawsuit",
  "sue you",
  "take you to court",
  "small claims",
  "litigation",
  "our lawyers will",
  "our attorney will",
  "cease and desist",
  "debt collection agency",
  "collections agency",
  "collection agency",
  "hand this to collections",
  "refer this to a collection agency",
  "statutory demand",
  "we will pursue you",
  "court action",
];

const AGGRESSIVE_TERMS: readonly string[] = [
  "demand immediate payment",
  "pay immediately or",
  "final demand",
  "suspend your account immediately",
  "suspend all services",
  "cut off service",
  "cut off your service",
  "escalate to collections",
  "hand over to debt collectors",
  "failure to pay will result in",
  "immediate payment is required to avoid",
  "we will escalate",
  "aggressively pursue",
  "pay now or",
];

// Broadened per V0 correction pass to catch a false confirmation stated as plain
// prose, not just a canned "thank you for your payment" line.
const PAYMENT_RECEIPT_ASSERTIONS: readonly string[] = [
  "we have received your payment",
  "we've received your payment",
  "your payment has been received",
  "payment has been received",
  "confirming receipt of your payment",
  "thank you for your payment",
  "your account is now settled",
  "payment has been applied",
  "we can confirm payment",
  "received your payment of",
  "your balance is now zero",
  "the invoice is now paid",
  "marked as paid",
  "payment received, thank you",
  "received and cleared",
  "has cleared",
  "funds have cleared",
];

const DATE_REGEX =
  /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi;

const AMOUNT_REGEX = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;

// A model that classifies into any of these three values is, by definition,
// saying "a human needs to be involved" - see Rule 0.
const HUMAN_OK: readonly ReceivablesClassification[] = ["HUMAN_REQUIRED", "DISPUTE", "ESCALATE"];

// A small, explicit list of phrases that mean "please have a person call/discuss
// this with me" with no other identifiable intent. This is deliberately narrow -
// see hasVagueInquirySignal() for what it is and is not meant to cover.
const VAGUE_INQUIRY_TERMS: readonly string[] = [
  "need to talk about this",
  "we need to talk",
  "can someone call me",
  "give us a call",
  "call me to discuss",
  "we need to discuss",
];

// Negation words checked in the 3 words immediately before a keyword match, so
// "no dispute has been raised" / "not a dispute" / "not disputing" do not count
// as a dispute signal. Deliberately small and literal - not a grammar parser.
const NEGATION_WORDS = new Set([
  "no",
  "not",
  "never",
  "isn't",
  "wasn't",
  "aren't",
  "weren't",
  "doesn't",
  "don't",
  "didn't",
  "without",
  "n't",
]);

function lc(s: string): string {
  return s.toLowerCase();
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  const h = lc(haystack);
  return needles.some((n) => h.includes(n));
}

/** Is a keyword match at `matchIndex` in `haystack` immediately preceded (within 3 words) by a negation word? */
function isNegatedBefore(haystack: string, matchIndex: number): boolean {
  const before = haystack.slice(Math.max(0, matchIndex - 30), matchIndex);
  const words = before
    .replace(/[^a-z0-9' ]/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lastWords = words.slice(-3);
  return lastWords.some((w) => NEGATION_WORDS.has(lc(w)));
}

/** Like includesAny, but a match immediately preceded by a negation word does not count. */
function includesUnnegated(haystack: string, needles: readonly string[]): boolean {
  const h = lc(haystack);
  for (const needle of needles) {
    let idx = h.indexOf(needle);
    while (idx !== -1) {
      if (!isNegatedBefore(h, idx)) return true;
      idx = h.indexOf(needle, idx + 1);
    }
  }
  return false;
}

/**
 * All text the case genuinely supports: invoice facts plus, for every
 * conversation message, BOTH its structured `date` field and its `body` text.
 * The date is included alongside the body (not instead of it) so that a date
 * which only ever appears in a message's `date` field - e.g. the model
 * correctly citing "[2026-09-05] customer: ..." - is still recognized as
 * genuinely supported case evidence, not flagged as invented.
 */
function caseText(rc: ReceivablesCase): string {
  return [
    ...rc.invoice_facts,
    ...rc.conversation_history.flatMap((m) => [m.date, m.body]),
  ].join("\n");
}

function customerText(rc: ReceivablesCase): string {
  return rc.conversation_history
    .filter((m) => m.from === "customer")
    .map((m) => m.body)
    .join("\n");
}

/** Primary source for customer-intent signals (dispute, plan request, vague inquiry). */
function customerSignalText(rc: ReceivablesCase): string {
  return customerText(rc);
}

/**
 * Secondary source for customer-intent signals: documented invoice facts.
 * Scanned negation-aware so an administrative note like "No dispute has been
 * raised" is not mistaken for a dispute. Our own collections_agent / system
 * messages are deliberately excluded - they are our outbound text, not customer
 * evidence, and scanning them invites unrelated false positives.
 */
function factSignalText(rc: ReceivablesCase): string {
  return rc.invoice_facts.join("\n");
}

function isDisputeSignal(rc: ReceivablesCase): boolean {
  return (
    includesUnnegated(customerSignalText(rc), DISPUTE_TERMS) ||
    includesUnnegated(factSignalText(rc), DISPUTE_TERMS)
  );
}

function isPlanSignal(rc: ReceivablesCase): boolean {
  return (
    includesUnnegated(customerSignalText(rc), PAYMENT_PLAN_TERMS) ||
    includesUnnegated(factSignalText(rc), PAYMENT_PLAN_TERMS)
  );
}

/**
 * Narrow, explicit case-side anchor for the uncertainty rule: a customer message
 * asking for a call/discussion with no other identifiable intent (no dispute, no
 * plan request, no payment claim). This is NOT a general ambiguity detector - see
 * the "uncertainty rule" note in validateDecision for the known limitation.
 */
function hasVagueInquirySignal(rc: ReceivablesCase): boolean {
  const custT = customerSignalText(rc);
  if (!includesUnnegated(custT, VAGUE_INQUIRY_TERMS)) return false;
  return !isDisputeSignal(rc) && !isPlanSignal(rc) && !includesAny(custT, PAYMENT_CLAIM_TERMS);
}

function factsConfirmPayment(rc: ReceivablesCase): boolean {
  return rc.invoice_facts.some((f) => {
    const l = lc(f);
    // NOTE: a bare "payment of $X" is deliberately NOT treated as confirmation -
    // it only describes an amount, not that it was actually received/matched.
    const positive = [
      "payment received",
      "paid in full",
      "reconciled",
      "payment posted",
      "payment cleared",
      "funds received",
      "marked as paid",
      "balance settled",
      "balance was settled",
      "invoice closed",
      "payment matched",
    ].some((p) => l.includes(p));
    const negated = [
      "no payment",
      "not received",
      "no record of payment",
      "has not been received",
      "not yet reconciled",
      "not reconciled",
      "outstanding",
      "unpaid",
      "not been paid",
      "no matching payment",
      "not matched",
    ].some((n) => l.includes(n));
    return positive && !negated;
  });
}

function detectContradiction(rc: ReceivablesCase, d: ReceivablesDecision): boolean {
  const t = lc(caseText(rc));
  const paidClaim = [
    "paid in full",
    "already paid",
    "we paid this",
    "payment was made",
    "settled this invoice",
    "paid weeks ago",
    "paid last month",
  ].some((p) => t.includes(p));
  const unpaidAdmission = [
    "waiting on funding",
    "waiting on funds",
    "cash flow is tight",
    "still sorting cash flow",
    "will pay you next month",
    "expect to pay you next month",
    "haven't paid",
    "have not paid yet",
    "unable to pay right now",
    "once we receive funding",
  ].some((p) => t.includes(p));
  const identityConflict = [
    "wrong company",
    "no account with you",
    "no account or contract",
    "you have the wrong",
  ].some((p) => t.includes(p));
  const modelFlags = includesAny(`${d.situation} ${d.evidence.join(" ")}`, [
    "contradict",
    "contradictory",
    "inconsistent",
    "conflicting",
  ]);
  return (paidClaim && unpaidAdmission) || identityConflict || modelFlags;
}

function normalize(s: string): string {
  return lc(s)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseAmount(raw: string): number {
  return Number(raw.replace(/[$,\s]/g, ""));
}

// Words that describe HOW a fact is being reported (paraphrase/narration
// scaffolding), not the fact itself - no case fact is ever phrased this way,
// so requiring them to match punishes a faithful paraphrase for its wording
// rather than its content. Domain words (customer, invoice, payment,
// amounts, dates, etc.) are deliberately NOT included here: they must still
// match, so a genuinely fabricated or materially different claim is still
// caught by the token-overlap check below.
const EVIDENCE_META_WORDS = new Set([
  "conversation",
  "history",
  "shows",
  "shown",
  "showing",
  "indicates",
  "indicate",
  "indicated",
  "states",
  "stated",
  "state",
  "mentions",
  "mentioned",
  "mention",
  "notes",
  "noted",
  "note",
  "according",
  "appears",
  "appear",
  "appeared",
  "suggests",
  "suggest",
  "suggested",
  "summary",
  "summarizes",
  "summarized",
  "confirms",
  "confirmed",
  "confirm",
]);

/** Minimal, conservative suffix stripping so simple morphological variants
 * (e.g. "reminders"/"reminder") compare equal without adding a broader
 * synonym/semantic matcher that could hide a genuinely different claim.
 * Deliberately only strips a single trailing "s" (never "es"/"ies"/"ed"/"ing"
 * - those change more of the word and risk mangling unrelated terms, e.g.
 * turning "dates" into "dat" instead of "date"). */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function evidenceIsSupported(evidence: string, haystackStemmedTokens: ReadonlySet<string>): boolean {
  const en = normalize(evidence);
  if (en.length < 12) return true;
  const toks = en.split(" ").filter((w) => w.length > 3 && !EVIDENCE_META_WORDS.has(w));
  if (toks.length === 0) return true;
  const hits = toks.filter((w) => haystackStemmedTokens.has(stem(w))).length;
  return hits / toks.length >= 0.5;
}

const MONTH_NUMBERS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/**
 * Parse a date string matched by DATE_REGEX into every canonical YYYY-MM-DD
 * form it could plausibly denote. An ISO string parses to itself. A
 * month-name string (e.g. "September 1st, 2026" or "September 1") parses to
 * one candidate per year in `knownYears` when the raw string carries no year
 * of its own - this never invents a year, it only tries years that actually
 * appear somewhere in the case, so it can still only ever recognize a date
 * that genuinely exists in the case, never approve an arbitrary new one.
 */
function toISOCandidates(raw: string, knownYears: readonly string[]): string[] {
  const iso = /^\d{4}-\d{2}-\d{2}$/.exec(raw);
  if (iso) return [raw];

  const monthName = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/.exec(raw.trim());
  if (!monthName) return [];
  const prefix = monthName[1]!.toLowerCase();
  const month = MONTH_NUMBERS[prefix];
  if (!month) return [];
  const day = monthName[2]!.padStart(2, "0");
  const year = monthName[3];
  if (year) return [`${year}-${month}-${day}`];
  return knownYears.map((y) => `${y}-${month}-${day}`);
}

/**
 * Marker substituted for a date the model asserted but the case never
 * supported. Deliberately NOT a date, and deliberately not silent removal -
 * it leaves a visible trace that something was redacted, rather than
 * inventing a replacement fact or quietly shrinking the text.
 */
const INVENTED_DATE_REDACTION_MARKER = "[unverified date removed - not supported by case facts]";

/**
 * Replace every occurrence of each given raw date string with the redaction
 * marker. Only ever called with strings detectUnsupported() already proved
 * do NOT appear anywhere in the case text, so this can never touch a
 * genuinely case-supported date - by construction, a date present in the
 * case is skipped before it can ever reach `inventedDates` (see the `continue`
 * on a haystack match, below).
 */
function redactInventedDates(text: string, inventedDates: readonly string[]): string {
  let result = text;
  for (const raw of inventedDates) {
    if (raw.length === 0) continue;
    result = result.split(raw).join(INVENTED_DATE_REDACTION_MARKER);
  }
  return result;
}

function detectUnsupported(
  rc: ReceivablesCase,
  d: ReceivablesDecision,
  violations: SafetyViolation[],
  inventedDates: string[],
): void {
  const rawHaystack = caseText(rc);
  const haystackNorm = normalize(rawHaystack);
  const haystackTokens = new Set(haystackNorm.split(" ").filter(Boolean));
  const haystackStemmedTokens = new Set([...haystackTokens].map(stem));

  // Every calendar date the case genuinely supports, in canonical YYYY-MM-DD
  // form, plus every year that appears anywhere in the case - used below to
  // recognize a month-name date (e.g. "September 1st, 2026") as the same
  // calendar date as a case-supported ISO date, not a different, invented one.
  const supportedISODates = new Set<string>();
  const knownYears = new Set<string>();
  for (const m of rawHaystack.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    supportedISODates.add(m[0]);
    knownYears.add(m[1]!);
  }
  const knownYearsList = [...knownYears];

  for (const e of d.evidence) {
    if (!evidenceIsSupported(e, haystackStemmedTokens)) {
      violations.push({
        code: "UNSUPPORTED_EVIDENCE",
        severity: "high",
        message: `Evidence item is not supported by the case: "${e.slice(0, 80)}"`,
      });
    }
  }

  const scan = `${d.situation}\n${d.draft_response}\n${d.evidence.join("\n")}`;
  for (const m of scan.matchAll(DATE_REGEX)) {
    const raw = m[0];
    const idx = m.index ?? 0;
    if (haystackNorm.includes(normalize(raw))) continue;
    // Same calendar date, different representation (ISO vs. month-name) -
    // genuinely supported, not invented.
    if (toISOCandidates(raw.trim(), knownYearsList).some((c) => supportedISODates.has(c))) continue;
    const ctx = lc(scan.slice(Math.max(0, idx - 40), idx + raw.length + 40));
    const paymentCtx = /pay|paid|receiv|settl|remit|clear/.test(ctx);
    if (paymentCtx) {
      inventedDates.push(raw.trim());
    }
    violations.push({
      code: paymentCtx ? "INVENTED_PAYMENT_DATE" : "UNSUPPORTED_DATE",
      severity: paymentCtx ? "critical" : "high",
      message: `Date "${raw.trim()}" does not appear anywhere in the case.`,
    });
  }

  const allowed = new Set<number>([rc.amount]);
  for (const m of rawHaystack.matchAll(AMOUNT_REGEX)) allowed.add(parseAmount(m[0]));
  for (const m of `${d.situation}\n${d.draft_response}`.matchAll(AMOUNT_REGEX)) {
    const val = parseAmount(m[0]);
    if (!allowed.has(val)) {
      violations.push({
        code: "UNSUPPORTED_AMOUNT",
        severity: "high",
        message: `Amount "${m[0].trim()}" does not appear anywhere in the case.`,
      });
    }
  }
}

/**
 * Validate a decision against its case. Returns a sanitized decision plus the
 * list of violations found in the original.
 *
 * KNOWN LIMITATION (documented, not fixed in this pass): Rule 4's uncertainty
 * detection combines the model's own confidence/evidence with a single narrow
 * case-side signal (hasVagueInquirySignal). It does not attempt general-purpose
 * ambiguity detection independent of the model - that would require either a
 * structured case schema or a real NLU component, both out of scope for V0. A
 * model that is confident, cites some evidence, and is not asking a vague
 * "please call me" question can still avoid Rule 4.
 */
export function validateDecision(
  rc: ReceivablesCase,
  original: ReceivablesDecision,
): SafetyValidationResult {
  const violations: SafetyViolation[] = [];
  const d: ReceivablesDecision = { ...original, evidence: [...original.evidence] };
  let overridden = false;

  const actionDraft = `${original.recommended_action}\n${original.draft_response}`;

  const isDispute = isDisputeSignal(rc);
  const isPlan = isPlanSignal(rc);
  const contradiction = detectContradiction(rc, original);
  const paymentConfirmed = factsConfirmPayment(rc);

  // Rule 0: model-aware human-approval backstop, independent of keyword detection.
  // A model that classifies DISPUTE / ESCALATE / HUMAN_REQUIRED must always
  // require approval, even when the case text contains no listed keyword at all.
  // This is the "trust the model's own classification for THIS ONE THING" half
  // of the safety layer; Rule 1 below is the "trust the case evidence" half.
  if (HUMAN_OK.includes(original.classification) && !original.human_approval_required) {
    violations.push({
      code: "MODEL_CLASSIFICATION_REQUIRES_APPROVAL",
      severity: "high",
      message: `Classification ${original.classification} requires human approval but human_approval_required was false.`,
    });
    d.human_approval_required = true;
    overridden = true;
  }

  // Rule 7: never allow legal threats.
  if (includesAny(actionDraft, LEGAL_THREAT_TERMS)) {
    violations.push({
      code: "LEGAL_THREAT",
      severity: "critical",
      message: "Decision contains a legal threat or reference to legal/collections action.",
    });
    d.draft_response = SAFE_HANDOFF_DRAFT;
    d.recommended_action = "escalate_to_human";
    d.human_approval_required = true;
    d.reason_for_handoff =
      d.reason_for_handoff ?? "Legal threat removed by safety layer; human review required.";
    overridden = true;
  }

  // Rules 8 + 9: never allow aggressive collection; worst when a dispute is present.
  if (includesAny(actionDraft, AGGRESSIVE_TERMS)) {
    if (isDispute) {
      violations.push({
        code: "AGGRESSIVE_COLLECTION_ON_DISPUTE",
        severity: "critical",
        message: "Aggressive collection action recommended while a dispute is present.",
      });
    } else {
      violations.push({
        code: "AGGRESSIVE_COLLECTION",
        severity: "high",
        message: "Aggressive collection language present in the decision.",
      });
    }
    d.draft_response = SAFE_HANDOFF_DRAFT;
    d.recommended_action = "send_standard_follow_up";
    d.human_approval_required = true;
    overridden = true;
  }

  // Rule 1: case-evidence dispute detection -> human approval required, never
  // RESOLVED. This is the backstop for when the model FAILS to recognize a
  // dispute the customer actually raised. Scoped to customer messages (primary)
  // and invoice facts (secondary, negation-aware) - our own outbound agent/system
  // messages are never treated as customer evidence.
  if (isDispute) {
    if (!d.human_approval_required) {
      d.human_approval_required = true;
      overridden = true;
    }
    if (!HUMAN_OK.includes(d.classification)) {
      violations.push({
        code: "DISPUTE_NOT_CLASSIFIED",
        severity: "high",
        message: `Dispute language present but classified as ${d.classification}.`,
      });
      d.classification = "DISPUTE";
      overridden = true;
    }
    if (original.classification === "RESOLVED") {
      violations.push({
        code: "DISPUTE_MARKED_RESOLVED",
        severity: "critical",
        message: "A disputed invoice was marked RESOLVED.",
      });
    }
    d.reason_for_handoff = d.reason_for_handoff ?? "Customer dispute requires human approval.";
  }

  // Rule 2: payment-plan situations -> human approval; never negotiate autonomously.
  if (isPlan) {
    if (!d.human_approval_required) {
      d.human_approval_required = true;
      overridden = true;
    }
    if (includesAny(actionDraft, PLAN_NEGOTIATION_TERMS)) {
      violations.push({
        code: "AUTONOMOUS_PAYMENT_PLAN_NEGOTIATION",
        severity: "critical",
        message: "Decision negotiates or agrees payment-plan terms without a human.",
      });
      d.draft_response = SAFE_HANDOFF_DRAFT;
      d.recommended_action = "route_to_human_for_payment_plan";
      overridden = true;
    }
    d.reason_for_handoff = d.reason_for_handoff ?? "Payment-plan request requires human approval.";
  }

  // Rule 3: contradictory information -> human review.
  if (contradiction) {
    if (!d.human_approval_required) {
      d.human_approval_required = true;
      overridden = true;
    }
    if (!HUMAN_OK.includes(d.classification)) {
      d.classification = "HUMAN_REQUIRED";
      overridden = true;
    }
    violations.push({
      code: "CONTRADICTION_REQUIRES_REVIEW",
      severity: "high",
      message: "Conversation contains contradictory or inconsistent information.",
    });
    d.reason_for_handoff =
      d.reason_for_handoff ?? "Contradictory information in the conversation; human review required.";
  }

  // Rule 4: uncertain / insufficient information -> HUMAN_REQUIRED. See the
  // KNOWN LIMITATION note above validateDecision for what this does and does not
  // cover.
  const lowConfidence = typeof original.confidence === "number" && original.confidence < 0.45;
  const noEvidence = original.evidence.length === 0;
  const vagueInquiry = hasVagueInquirySignal(rc);
  if (
    !isDispute &&
    !contradiction &&
    original.classification !== "RESOLVED" &&
    (lowConfidence || vagueInquiry || (noEvidence && original.classification !== "HUMAN_REQUIRED"))
  ) {
    if ((lowConfidence || vagueInquiry) && d.classification !== "HUMAN_REQUIRED") {
      d.classification = "HUMAN_REQUIRED";
      overridden = true;
    }
    if (!d.human_approval_required) {
      d.human_approval_required = true;
      overridden = true;
    }
    violations.push({
      code: "UNCERTAIN_REQUIRES_HUMAN",
      severity: "high",
      message: vagueInquiry
        ? "Customer asked for a call/discussion with no other identifiable intent; human review required."
        : "Low confidence or missing supporting evidence; human review required.",
    });
    d.reason_for_handoff =
      d.reason_for_handoff ?? "Insufficient certainty or evidence to act automatically.";
  }

  // Rule 5: payment claimed or asserted, but not independently confirmed by the
  // case facts -> never let the decision present payment as received, in ANY
  // field (situation, evidence, recommended_action, draft_response) and
  // regardless of the classification label.
  const assertionText = [
    original.situation,
    original.draft_response,
    original.recommended_action,
    ...original.evidence,
  ].join("\n");
  // Negation-aware: "no payment has been received" must not match "payment has
  // been received" just because it is a substring of the negated sentence.
  const modelAssertsReceipt = includesUnnegated(assertionText, PAYMENT_RECEIPT_ASSERTIONS);
  if (!paymentConfirmed && (modelAssertsReceipt || original.classification === "RESOLVED")) {
    violations.push({
      code: "FALSE_PAYMENT_CONFIRMATION",
      severity: "critical",
      message: "Payment treated as received although the case facts do not independently confirm it.",
    });
    if (d.classification === "RESOLVED") {
      d.classification = "VERIFY_PAYMENT";
    }
    d.draft_response = PAYMENT_VERIFICATION_DRAFT;
    overridden = true;
  }

  // Rule 6: unsupported facts must not become asserted facts.
  const inventedDates: string[] = [];
  detectUnsupported(rc, original, violations, inventedDates);
  if (inventedDates.length > 0) {
    // The invented date(s) must never remain represented as trustworthy fact
    // anywhere in the final decision - not just scrubbed from draft_response.
    // Redact them from situation and evidence too, without inventing a
    // replacement fact and without discarding evidence that is otherwise
    // genuinely supported by the case.
    d.situation = redactInventedDates(d.situation, inventedDates);
    d.evidence = d.evidence.map((e) => redactInventedDates(e, inventedDates));
    d.draft_response = SAFE_HANDOFF_DRAFT;
    d.human_approval_required = true;
    d.reason_for_handoff =
      d.reason_for_handoff ??
      "Decision referenced an unverifiable date; the unsupported date was removed and human review is required.";
    overridden = true;
  }
  if (violations.some((v) => v.code === "UNSUPPORTED_EVIDENCE")) {
    const haystackTokens = new Set(normalize(caseText(rc)).split(" ").filter(Boolean));
    const haystackStemmedTokens = new Set([...haystackTokens].map(stem));
    d.evidence = d.evidence.filter((e) => evidenceIsSupported(e, haystackStemmedTokens));
    overridden = true;
  }

  // Rule 10: VERIFY_PAYMENT is, by definition, an unresolved factual question -
  // the customer's account of events conflicts with the case's own records,
  // and nobody yet knows who is right. That is a form of uncertainty Rule 4
  // does not otherwise cover (it only looks at the model's own confidence/
  // evidence/vague-inquiry signals, not at what the classification itself
  // means). Checked last, against the FINAL classification `d.classification`
  // (not just the model's original one), so this also covers a decision that
  // only became VERIFY_PAYMENT via Rule 5's RESOLVED reclassification above -
  // not only a decision that started out as VERIFY_PAYMENT. Deliberately
  // independent of HUMAN_OK (which also gates whether Rule 1/Rule 3 relabel
  // the classification) - this only ever forces approval, never changes the
  // classification label or any other field. Applies regardless of whether
  // the decision came from the deterministic classifier or the LLM.
  if (d.classification === "VERIFY_PAYMENT" && !d.human_approval_required) {
    violations.push({
      code: "VERIFY_PAYMENT_REQUIRES_APPROVAL",
      severity: "high",
      message: "An unverified customer payment claim requires human approval before further action.",
    });
    d.human_approval_required = true;
    overridden = true;
  }

  const safe = violations.length === 0 && !overridden;
  const override_reason = overridden
    ? violations.map((v) => `${v.code}: ${v.message}`).join("; ") || "Safety normalization applied."
    : null;

  return {
    safe,
    overridden,
    override_reason,
    violations,
    decision: d,
    original_decision: original,
  };
}
