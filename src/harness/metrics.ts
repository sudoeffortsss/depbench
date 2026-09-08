/**
 * The scoring harness.
 *
 * Three rules govern everything here, and they are the reason this is a benchmark rather
 * than a leaderboard (BLUEPRINT.md section 7):
 *
 *   1. Anything unanswerable stays in the denominator. A package a policy could not score
 *      is counted, named, and reported. It never quietly leaves the sample.
 *
 *   2. Abstention is scored apart from being wrong. A policy that declines is not a
 *      policy that guessed low. We report how often it declined and how often declining
 *      was the right call.
 *
 *   3. The headline refuses to compute without 1 and 2. `computeMetrics` returns a
 *      discriminated union; there is no code path that yields an AUC without coverage
 *      beside it. The refusal is structural, not a reminder.
 *
 * On the headline being AUC rather than precision@k: under case-control sampling the
 * positive rate is chosen by the designer, not by nature, so precision at a fixed budget
 * is not interpretable without reweighting to a base rate this design cannot estimate
 * (FINDINGS.md F4).
 */

export interface ScoredPackage {
  pkg_name: string;
  /** null when abstaining or unanswerable. */
  score: number | null;
  abstain: boolean;
  /** 'ok' | 'repaired' | 'unparseable' | 'error' | 'timeout' */
  parse_status: string;
  /** True iff the package is a case: hit by an in-window GHSA. */
  is_case: boolean;
  /** Context for guardrails, all knowable on the scoring date. */
  releases_last_90d: number;
  downloads_prior_month: number | null;
}

export interface Coverage {
  total: number;
  scored: number;
  abstained: number;
  /** parse_status other than ok/repaired: the fetch or the model failed outright. */
  noAnswer: number;
  scoredFraction: number;
  abstainRate: number;
  noAnswerRate: number;
}

export interface Guardrails {
  /**
   * Of the cases, what fraction land in the policy's riskiest decile. A policy that
   * only catches easy ones shows up here.
   */
  topDecileCaseRecall: number;
  /**
   * How many packages share the score at the decile boundary. Large means the slice is
   * an arbitrary cut through a tie block, and the recall above should be read with that
   * in mind rather than as a clean ranking.
   */
  boundaryTieSize: number;
  /**
   * Of the packages in the riskiest decile, what fraction were actively maintained
   * controls. A policy that flags everything shows up here.
   *
   * Uninformative for any policy that ranks by staleness. Its riskiest decile consists
   * of the least actively maintained packages by construction, so `releases_last_90d > 0`
   * is false throughout and the rate is 0.0% for definitional reasons rather than
   * precision. Measured: age and cadence each had exactly 0 active controls in their top
   * decile, against 92 for random (FINDINGS.md F12). Read with `tautological` beside it.
   */
  activeControlFalseFlagRate: number;
  /** True when the rate above cannot carry information, see the note on it. */
  falseFlagIsTautological: boolean;
  /**
   * Of the packages a policy declined to score, what fraction were cases. High means
   * the policy was declining precisely where it mattered; low means abstention was
   * cheap and well placed.
   */
  abstainHitRate: number | null;
}

export interface AucInterval {
  /** Bootstrap percentile bounds. */
  lo: number;
  hi: number;
  /** Resamples drawn. Fixed seed, so the interval is reproducible. */
  resamples: number;
  /** True when the interval contains 0.5, i.e. chance is not excluded. */
  includesChance: boolean;
}

export interface MetricsOk {
  ok: true;
  policy: string;
  auc: number;
  /**
   * The headline is not publishable without this. For one release the table carried a
   * 0.088 spread between best and worst policy with no indication that two of the five
   * intervals crossed 0.5 outright (FINDINGS.md F12).
   */
  aucCi: AucInterval;
  /** Cases and controls actually used, after abstentions and failures. */
  casesScored: number;
  controlsScored: number;
  coverage: Coverage;
  guardrails: Guardrails;
  costUsd: number;
}

export interface MetricsRefused {
  ok: false;
  policy: string;
  reason: string;
}

export type Metrics = MetricsOk | MetricsRefused;

/**
 * Mann-Whitney U formulation, with proper handling of ties: a case and a control
 * sharing a score contribute half a point, exactly as they should.
 */
export function auc(caseScores: number[], controlScores: number[]): number {
  const all = [
    ...caseScores.map((s) => ({ s, isCase: true })),
    ...controlScores.map((s) => ({ s, isCase: false })),
  ].sort((a, b) => a.s - b.s);

  // Average ranks within tied groups.
  const ranks = new Array<number>(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.s === all[i]!.s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  let rankSumCases = 0;
  for (let k = 0; k < all.length; k++) if (all[k]!.isCase) rankSumCases += ranks[k]!;

  const n1 = caseScores.length;
  const n2 = controlScores.length;
  if (n1 === 0 || n2 === 0) return Number.NaN;
  const u = rankSumCases - (n1 * (n1 + 1)) / 2;
  return u / (n1 * n2);
}

/** Deterministic PRNG, so a published interval can be reproduced exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap over cases and controls independently, which is the resampling
 * scheme that matches how a case-control sample was drawn.
 */
export function aucInterval(
  caseScores: number[],
  controlScores: number[],
  resamples = 2000,
  seed = 20260906,
): AucInterval {
  const rnd = mulberry32(seed);
  const draw = (a: number[]): number[] => {
    const out = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[Math.floor(rnd() * a.length)]!;
    return out;
  };
  const boots = new Array<number>(resamples);
  for (let b = 0; b < resamples; b++) boots[b] = auc(draw(caseScores), draw(controlScores));
  boots.sort((x, y) => x - y);
  const lo = boots[Math.floor(0.025 * resamples)]!;
  const hi = boots[Math.floor(0.975 * resamples)]!;
  return { lo, hi, resamples, includesChance: lo <= 0.5 && hi >= 0.5 };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

export function computeMetrics(
  policy: string,
  rows: ScoredPackage[],
  costUsd = 0,
): Metrics {
  const total = rows.length;
  if (total === 0) return { ok: false, policy, reason: "no rows" };

  const noAnswer = rows.filter(
    (r) => r.parse_status !== "ok" && r.parse_status !== "repaired",
  ).length;
  const abstained = rows.filter(
    (r) => r.abstain && (r.parse_status === "ok" || r.parse_status === "repaired"),
  ).length;
  const usable = rows.filter(
    (r) =>
      !r.abstain &&
      r.score !== null &&
      (r.parse_status === "ok" || r.parse_status === "repaired"),
  );

  const coverage: Coverage = {
    total,
    scored: usable.length,
    abstained,
    noAnswer,
    scoredFraction: usable.length / total,
    abstainRate: abstained / total,
    noAnswerRate: noAnswer / total,
  };

  // Rule 3. The refusal lives here so that no caller can print a headline without the
  // numbers that make it meaningful.
  if (coverage.scored === 0) {
    return { ok: false, policy, reason: "no package received a score" };
  }
  const caseScores = usable.filter((r) => r.is_case).map((r) => r.score!);
  const controlScores = usable.filter((r) => !r.is_case).map((r) => r.score!);
  if (caseScores.length === 0 || controlScores.length === 0) {
    return {
      ok: false,
      policy,
      reason:
        `AUC needs both classes present after abstentions and failures; got ` +
        `${caseScores.length} cases and ${controlScores.length} controls`,
    };
  }

  const value = auc(caseScores, controlScores);
  const ci = aucInterval(caseScores, controlScores);

  // Guardrails on the riskiest decile.
  //
  // Taking `score >= quantile(0.9)` is wrong when a policy produces heavy ties, and
  // `cadence` produces exactly that: 704 of its 1,878 scored packages sit at 1.000, so
  // the 0.9 quantile lands *inside* that block and "top decile" silently becomes the
  // top 37.5%. The first run reported 32.1% case recall for cadence and it looked like
  // a signal; against a 37.5% slice it is worse than chance. Take a fixed-size slice
  // instead, breaking ties by name so the choice is deterministic rather than dependent
  // on row order.
  // Ties are not broken, they are shared. Breaking them by name looked reasonable and
  // was quietly biased: in a block where every score is equal, alphabetical order put
  // every `case*` ahead of every `ctl*`, and the guardrail reported a perfect 0% false
  // flag rate for a policy that flags literally everything. The unit test caught it.
  //
  // Instead, a tie block that straddles the decile boundary contributes proportionally.
  // A policy whose scores are one big tie gets the universe's own composition back,
  // which is the honest answer: it has expressed no preference.
  const desiredSize = Math.max(1, Math.round(usable.length * 0.1));
  const ordered = [...usable].sort((a, b) => b.score! - a.score!);

  let casesInTop = 0;
  let activeControlsInTop = 0;
  let topDecileSize = 0;
  let idx = 0;
  while (idx < ordered.length && topDecileSize < desiredSize) {
    let end = idx;
    while (end + 1 < ordered.length && ordered[end + 1]!.score === ordered[idx]!.score) end++;
    const block = ordered.slice(idx, end + 1);
    const room = desiredSize - topDecileSize;
    // Whole block fits, or we take a proportional share of it.
    const share = Math.min(1, room / block.length);
    casesInTop += block.filter((r) => r.is_case).length * share;
    activeControlsInTop +=
      block.filter((r) => !r.is_case && r.releases_last_90d > 0).length * share;
    topDecileSize += block.length * share;
    idx = end + 1;
  }
  const topDecile = { length: topDecileSize };
  const boundaryScore = ordered[Math.min(ordered.length - 1, idx - 1)]!.score;

  const declined = rows.filter((r) => r.abstain || r.score === null);
  const abstainHitRate =
    declined.length === 0
      ? null
      : declined.filter((r) => r.is_case).length / declined.length;

  return {
    ok: true,
    policy,
    auc: value,
    aucCi: ci,
    casesScored: caseScores.length,
    controlsScored: controlScores.length,
    coverage,
    guardrails: {
      topDecileCaseRecall: casesInTop / caseScores.length,
      boundaryTieSize: usable.filter((r) => r.score === boundaryScore).length,
      activeControlFalseFlagRate:
        topDecile.length === 0 ? Number.NaN : activeControlsInTop / topDecile.length,
      // No active control can enter a staleness-ranked top decile, so a 0 here is a
      // property of the ranking, not evidence about the policy.
      falseFlagIsTautological: activeControlsInTop === 0 && topDecileSize > 0,
      abstainHitRate,
    },
    costUsd,
  };
}
