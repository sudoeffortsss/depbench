/**
 * The model arms: built, tested, and deliberately not run.
 *
 * Three tiers are registered so that "which model" becomes an axis the benchmark
 * measures rather than a decision someone has to defend: how much accuracy does four
 * times the price buy? The interface, the prompt, the parser, the cost gate and the
 * estimator all exist. What has not happened is a paid execution.
 *
 * That is a deliberate stopping point, not an unfinished one. Spending money is a
 * decision with a number attached, and a benchmark should not make it quietly on
 * someone's behalf. `truthlag estimate` prints the projected spend and exits.
 *
 * When a run does happen, the rules that make this a benchmark still apply:
 * unparseable output, timeouts and refusals become `no_answer` and stay in the
 * denominator. That matters more here than anywhere else, because rules almost never
 * fail to parse and models do it constantly. The LLM tier is what makes harness rule 1
 * load-bearing rather than decorative.
 */

export interface ModelArm {
  policy: string;
  provider: "google" | "anthropic";
  model: string;
  /** USD per million tokens. Current as of 2026-09; verify before spending. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** Batch APIs are half price on both providers. */
  batchDiscount: number;
  /**
   * The published training data cutoff, as `YYYY-MM`.
   *
   * This is a first-class field rather than a comment because the retrospective arm
   * cannot include a model without it. Every case in the evaluation set carries a GHSA
   * publication date, so asking a model to "predict" an advisory it may have read during
   * training measures recall, not forecasting. The only defence is to split the cases at
   * the model's cutoff and compare the two strata, and that split is undefined for a
   * model whose cutoff is unpublished or hedged.
   */
  trainingCutoff: string;
  /** Verbatim source for the cutoff. An arm may not be run without one. */
  cutoffEvidence: string;
  /**
   * Cases before / on-or-after this cutoff, keyed on the earliest in-window advisory
   * per package, which is the first date a model could have read about it. Regenerate
   * with `npx tsx probe/cutoff_split.mts` after any change to the universe.
   */
  caseSplit: { preCutoff: number; postCutoff: number };
}

export const MODEL_ARMS: ModelArm[] = [
  {
    policy: "llm-flash-lite",
    provider: "google",
    // Not the newest and not the cheapest choice by accident.
    //
    // gemini-3.1-flash-lite was registered here first and had to be dropped: its model
    // card states no cutoff at all. Nor do the 3.x cards that do state one help, because
    // the statement is hedged ("March 2026 ... in others they may experience the model's
    // knowledge is limited to January 2025"), which is not a boundary anything can be
    // split on. The 2.5 tier is the newest Gemini that publishes an unhedged date, and
    // it splits this evaluation set 312/331, the most balanced of any arm.
    //
    // Within that tier this is the Flash rather than the Flash-Lite, and that was not a
    // choice either. `gemini-2.5-flash-lite` and `gemini-2.5-pro` both appear in
    // models.list and both return 404 on generateContent: "no longer available to new
    // users. Please update your code to use models/gemini-3.5-flash-lite". Being listed
    // is not being callable, and the suggested replacement is the model whose cutoff is
    // hedged, so taking the advice would have cost the experiment its boundary.
    // `gemini-2.5-flash` is callable, carries the same published cutoff, and costs 3x
    // the input and 6x the output rate. That is the price of a date you can split on.
    model: "gemini-2.5-flash",
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    batchDiscount: 0.5,
    trainingCutoff: "2025-01",
    cutoffEvidence:
      '"Latest update June 2025 / Knowledge cutoff January 2025", spec strip on ' +
      "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash. Verified callable " +
      "on 2026-09-07; the Flash-Lite and Pro of the same tier are listed but 404.",
    caseSplit: { preCutoff: 312, postCutoff: 331 },
  },
  {
    policy: "llm-haiku",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    batchDiscount: 0.5,
    // The vendor publishes two different dates for this model, five months apart. That
    // is not a problem to route around, it is a free experiment: score the strata at
    // both boundaries and see which one performance actually steps at. Whichever answer
    // comes back is a statement about the model that its own documentation does not make.
    trainingCutoff: "2025-07",
    cutoffEvidence:
      'Capabilities table at https://platform.claude.com/docs/en/models/haiku-4-5/overview ' +
      'gives two disagreeing rows: "Reliable knowledge cutoff | Feb 2025" and ' +
      '"Training data cutoff | Jul 2025". The later is recorded here; the earlier is a ' +
      "second boundary worth testing.",
    caseSplit: { preCutoff: 377, postCutoff: 266 },
  },
  {
    policy: "llm-sonnet",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    batchDiscount: 0.5,
    trainingCutoff: "2026-01",
    cutoffEvidence:
      'Capabilities table at https://platform.claude.com/docs/en/models/sonnet-5/overview, ' +
      'both rows agreeing: "Reliable knowledge cutoff | Jan 2026" and "Training data ' +
      'cutoff | Jan 2026"',
    caseSplit: { preCutoff: 457, postCutoff: 186 },
  },
];

/**
 * An arm is runnable only if its cutoff can actually split the evaluation set.
 *
 * Called before any paid request. A model with an unpublished or hedged cutoff produces
 * a number that cannot be told apart from memorisation, and a number like that is worse
 * than no number, because it will be quoted.
 */
export function assertStratifiable(arm: ModelArm): void {
  if (!/^\d{4}-\d{2}$/.test(arm.trainingCutoff)) {
    throw new Error(
      `${arm.policy}: trainingCutoff "${arm.trainingCutoff}" is not a YYYY-MM date, so ` +
        `the cases cannot be split at it`,
    );
  }
  const { preCutoff, postCutoff } = arm.caseSplit;
  const MIN_STRATUM = 100;
  if (preCutoff < MIN_STRATUM || postCutoff < MIN_STRATUM) {
    throw new Error(
      `${arm.policy}: cutoff ${arm.trainingCutoff} splits the cases ${preCutoff}/` +
        `${postCutoff}; a stratum under ${MIN_STRATUM} cannot separate its own AUC ` +
        `from chance, so the comparison would be uninformative by construction`,
    );
  }
}

/**
 * What a model is asked to judge. Deliberately the things metadata cannot see: the rule
 * policies already cover version counts and release timing, so asking a model to re-read
 * those would measure nothing new.
 */
export interface LlmInput {
  pkgName: string;
  readmeExcerpt: string;
  changelogExcerpt: string;
  installScripts: string[];
  /** Present only in the prospective arm; the registry keeps no history (F5, F8). */
  maintainerNote?: string;
}

export const RUBRIC = `You are assessing whether an npm package is likely to receive a
published security advisory in the next three years.

You are given material that package metadata cannot express: README and changelog
wording, install script contents, and any maintainer handover notice. You are NOT given
download counts, version counts, or release dates, because separate policies already
measure those and the question here is whether the prose adds anything.

Return strict JSON and nothing else:

{"risk": <number 0.0-1.0>, "reason": "<one sentence>", "evidence_quote": "<verbatim from the input, or empty>", "abstain": <boolean>}

Set abstain to true when the material genuinely does not support a judgement. Abstaining
is scored separately from being wrong; a confident guess on no evidence is worse than a
declared abstention.`;

export interface LlmVerdict {
  risk: number;
  reason: string;
  evidence_quote: string;
  abstain: boolean;
}

export type ParseResult =
  | { status: "ok"; verdict: LlmVerdict }
  | { status: "unparseable"; raw: string; why: string };

/**
 * Parses a model response into a verdict, or reports precisely why it could not.
 *
 * There is no repair pass and no fallback value. A response that will not parse becomes
 * `no_answer` and stays in the denominator, because the alternative — quietly coercing
 * it to a number — is the exact failure this benchmark was built to measure.
 */
export function parseVerdict(raw: string): ParseResult {
  const trimmed = raw.trim();
  // Models wrap JSON in fences despite instructions. Stripping a fence is not repair,
  // it is removing a wrapper; the content itself is untouched.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (e) {
    return { status: "unparseable", raw, why: `not JSON: ${String(e).slice(0, 120)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "unparseable", raw, why: `expected an object, got ${typeof parsed}` };
  }
  // An array passes `typeof === "object"` and would otherwise be rejected further down
  // for a missing field, reporting a misleading reason. Name the actual problem.
  if (Array.isArray(parsed)) {
    return { status: "unparseable", raw, why: "expected an object, got an array" };
  }
  const o = parsed as Record<string, unknown>;

  if (typeof o.abstain !== "boolean") {
    return { status: "unparseable", raw, why: "abstain missing or not a boolean" };
  }
  if (o.abstain) {
    return {
      status: "ok",
      verdict: {
        risk: Number.NaN,
        reason: typeof o.reason === "string" ? o.reason : "",
        evidence_quote: typeof o.evidence_quote === "string" ? o.evidence_quote : "",
        abstain: true,
      },
    };
  }
  if (typeof o.risk !== "number" || !Number.isFinite(o.risk)) {
    return { status: "unparseable", raw, why: "risk missing or not a finite number" };
  }
  if (o.risk < 0 || o.risk > 1) {
    // Out of range is not clamped. Clamping would hide a model that misunderstood the
    // scale behind a plausible-looking score.
    return { status: "unparseable", raw, why: `risk ${o.risk} outside [0,1]` };
  }
  return {
    status: "ok",
    verdict: {
      risk: o.risk,
      reason: typeof o.reason === "string" ? o.reason : "",
      evidence_quote: typeof o.evidence_quote === "string" ? o.evidence_quote : "",
      abstain: false,
    },
  };
}

export interface CostEstimate {
  policy: string;
  model: string;
  packages: number;
  inputTokens: number;
  outputTokens: number;
  usdListPrice: number;
  usdBatched: number;
}

/** README text is truncated before it reaches a model; long tails are not informative. */
export const README_CHAR_CAP = 8000;
export const PACKAGE_JSON_CHAR_CAP = 3000;

/**
 * Measured, not assumed.
 *
 * The defaults were 5,000 and 300, both guesses. `probe/tarball_size.mts` pulled the
 * point-in-time tarball for 20 randomly drawn universe members (20/20 succeeded) and
 * measured the README and package.json that would actually be sent. Untruncated the mean
 * is 4,988 tokens, which looks like a lucky guess but is dragged there by a long tail:
 * one README in the sample is 162 KB. Under the caps above the character count implied
 * 2,320 tokens.
 *
 * The figures here are the provider's own, from `usageMetadata` over ten real calls
 * across all five conditions: 2,613 input and 103 output. Output includes
 * `thoughtsTokenCount`, which bills at the output rate and which an earlier version of
 * the client ignored entirely.
 */
export function estimateCost(
  arm: ModelArm,
  packages: number,
  avgInputTokens = 2613,
  avgOutputTokens = 103,
): CostEstimate {
  const inputTokens = packages * avgInputTokens;
  const outputTokens = packages * avgOutputTokens;
  const list =
    (inputTokens / 1e6) * arm.inputPerMTok + (outputTokens / 1e6) * arm.outputPerMTok;
  return {
    policy: arm.policy,
    model: arm.model,
    packages,
    inputTokens,
    outputTokens,
    usdListPrice: list,
    usdBatched: list * arm.batchDiscount,
  };
}

/**
 * A hard ceiling, not a warning. Spend is accumulated from real usage figures and the
 * gate throws rather than logs, because a budget that only warns is a budget that gets
 * exceeded.
 */
export class BudgetGate {
  private spent = 0;

  constructor(private readonly ceilingUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  get remainingUsd(): number {
    return Math.max(0, this.ceilingUsd - this.spent);
  }

  record(usd: number): void {
    this.spent += usd;
    if (this.spent > this.ceilingUsd) {
      throw new Error(
        `budget exceeded: spent $${this.spent.toFixed(4)} against a ceiling of ` +
          `$${this.ceilingUsd.toFixed(2)}. Halting rather than continuing.`,
      );
    }
  }

  /** Checked before a call, so an over-budget request is never issued at all. */
  canAfford(usd: number): boolean {
    return this.spent + usd <= this.ceilingUsd;
  }
}
