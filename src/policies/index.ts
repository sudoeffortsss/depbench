/**
 * The deterministic policies under test.
 *
 * A policy receives a `SnapshotRow` and nothing else. It cannot reach an outcome, a
 * label, or another package's result, because the function signature does not offer
 * them. Leakage is prevented by the type rather than by remembering not to do it.
 *
 * Every policy returns a score in [0, 1] where higher means higher predicted risk, or
 * abstains. Abstention is not a low score: it is a separate outcome, reported separately,
 * and scored separately (BLUEPRINT.md section 7, rule 2).
 *
 * Two of these exist to be beaten:
 *
 *   random      the floor. A signal that cannot beat chance is noise.
 *   popularity  the control that matters. A Reddit commenter's complaint about a
 *               commercial advisor was that its number one metric is popularity; if
 *               popularity alone does as well as anything else here, that complaint
 *               generalises to the whole category.
 */

export interface PolicyInput {
  pkg_name: string;
  downloads_prior_month: number | null;
  version_count: number;
  days_since_last_pub: number | null;
  releases_last_90d: number;
  releases_last_365d: number;
  first_published_at: string | null;
  has_install_hook: boolean | null;
  has_repo_url: boolean | null;
  license: string | null;
  reconstructed: boolean;
}

export interface PolicyOutput {
  /** null iff abstaining. Higher means higher predicted risk. */
  score: number | null;
  abstain: boolean;
  /** How much evidence backed this call. Reported, and used for abstention analysis. */
  evidence_n: number;
}

export interface Policy {
  name: string;
  description: string;
  score(input: PolicyInput, ctx: PolicyContext): PolicyOutput;
}

/**
 * Context a policy may use. Deliberately minimal, and deliberately contains no outcome
 * data. `rank01` maps a value to its position within the universe, which is what makes
 * scores comparable across policies without any of them seeing a label.
 */
export interface PolicyContext {
  /** Deterministic pseudo-random in [0,1), seeded per package name. */
  hashUnit(key: string): number;
  /** Position of `value` among all non-null values of `field`, in [0,1]. */
  rank01(field: keyof PolicyInput, value: number): number;
}

const ABSTAIN: PolicyOutput = { score: null, abstain: true, evidence_n: 0 };

/** Not enough versions to say anything about rhythm. Threshold stated, not hidden. */
const MIN_VERSIONS_FOR_CADENCE = 3;

export const RANDOM: Policy = {
  name: "random",
  description:
    "Deterministic hash of the package name. The floor: any policy that cannot beat " +
    "this is measuring noise. Seeded so the benchmark is reproducible.",
  score(input, ctx) {
    return { score: ctx.hashUnit(input.pkg_name), abstain: false, evidence_n: 0 };
  },
};

export const POPULARITY: Policy = {
  name: "popularity",
  description:
    "Download rank alone, more downloads meaning higher predicted risk. This direction " +
    "is not a guess: 45% of our cases sit above a million monthly downloads, because a " +
    "vulnerability has to be found to become an advisory and nobody audits a package " +
    "nobody uses (F4). The control group that matters.",
  score(input, ctx) {
    if (input.downloads_prior_month === null) return ABSTAIN;
    return {
      score: ctx.rank01("downloads_prior_month", input.downloads_prior_month),
      abstain: false,
      evidence_n: 1,
    };
  },
};

export const AGE: Policy = {
  name: "age",
  description:
    "Days since the last publish, staler meaning riskier. The most common intuition " +
    "about dependency risk, and the cheapest to compute.",
  score(input, ctx) {
    if (input.days_since_last_pub === null) return ABSTAIN;
    return {
      score: ctx.rank01("days_since_last_pub", input.days_since_last_pub),
      abstain: false,
      evidence_n: 1,
    };
  },
};

export const CADENCE: Policy = {
  name: "cadence",
  description:
    "Change in release rhythm: recent 90-day rate against the trailing year. A project " +
    "that was shipping and stopped scores high; steady or accelerating scores low. " +
    "Abstains below three versions, where rhythm is not a meaningful concept.",
  score(input) {
    if (input.version_count < MIN_VERSIONS_FOR_CADENCE) return ABSTAIN;
    if (input.releases_last_365d === 0) {
      // Nothing in a year. Unambiguously stale, and we have the evidence to say so.
      return { score: 1, abstain: false, evidence_n: input.version_count };
    }
    const quarterlyRate = input.releases_last_90d / 90;
    const yearlyRate = input.releases_last_365d / 365;
    // 1 when recent activity has collapsed to zero, 0 when it has held or risen.
    const slowdown = 1 - Math.min(1, quarterlyRate / Math.max(yearlyRate, 1e-9));
    return { score: slowdown, abstain: false, evidence_n: input.releases_last_365d };
  },
};

export const COMPOSITE: Policy = {
  name: "composite",
  description:
    "An equally weighted blend of staleness, cadence collapse, a missing repository " +
    "link, a missing licence, and an install hook. Deliberately in the style of an " +
    "aggregate health score, because that is the shape the ecosystem actually ships " +
    "and the shape whose usefulness is in question.",
  score(input, ctx) {
    const parts: number[] = [];
    if (input.days_since_last_pub !== null) {
      parts.push(ctx.rank01("days_since_last_pub", input.days_since_last_pub));
    }
    const cad = CADENCE.score(input, ctx);
    if (!cad.abstain && cad.score !== null) parts.push(cad.score);
    if (input.has_repo_url !== null) parts.push(input.has_repo_url ? 0 : 1);
    if (input.license !== null) parts.push(input.license ? 0 : 1);
    if (input.has_install_hook !== null) parts.push(input.has_install_hook ? 1 : 0);

    // Fewer than three usable components is not a weak score, it is no score.
    if (parts.length < 3) return ABSTAIN;

    // A note on the first run, kept because it is a real trap: composite's scores sat
    // between 0.005 and 0.767 with a median of 0.19, which looked like the signal had
    // been crushed. It had not. AUC depends only on ordering, so the compressed range
    // changes nothing about the measured 0.461. The compression is cosmetic; the poor
    // discrimination is real. Rescaling would have made the numbers prettier and the
    // conclusion identical, which is exactly why it is not done here.
    const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
    return { score: mean, abstain: false, evidence_n: parts.length };
  },
};

export const RULE_POLICIES: Policy[] = [RANDOM, POPULARITY, AGE, CADENCE, COMPOSITE];
