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
}

export const MODEL_ARMS: ModelArm[] = [
  {
    policy: "llm-flash-lite",
    provider: "google",
    model: "gemini-3.1-flash-lite",
    inputPerMTok: 0.25,
    outputPerMTok: 1.5,
    batchDiscount: 0.5,
  },
  {
    policy: "llm-haiku",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    batchDiscount: 0.5,
  },
  {
    policy: "llm-sonnet",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    batchDiscount: 0.5,
  },
];

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

/** Token counts are estimates until a real `count_tokens` call is made. Labelled as such. */
export function estimateCost(
  arm: ModelArm,
  packages: number,
  avgInputTokens = 5000,
  avgOutputTokens = 300,
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
