/**
 * What each model arm is actually asked, and why there is more than one question.
 *
 * The retrospective arm established that every health signal in this dataset runs
 * backwards: `age` scores 0.357, and inverted it scores 0.643, the best number in the
 * benchmark. Packages that later received an advisory were fresher, shipped more often,
 * and were more downloaded than those that did not. "Stale means risky" is not merely
 * unhelpful here, it is a reliable way to be wrong.
 *
 * That is the sentence the model arms exist to test, and it is not the same as asking
 * whether a model can predict danger. It cannot be, because the label cannot support
 * that question: a GHSA advisory records that somebody looked, so a model reasoning
 * perfectly about code danger would score below chance, and one reciting memorised
 * advisories would score above it. Neither result would mean what it appeared to.
 *
 * So the question is turned around. The model is not being marked against the truth. It
 * is being asked whether it repeats a belief that this data contradicts, and whether it
 * signals any doubt while doing so.
 *
 * Three reference points make the outcome legible, which one line at 0.5 could not:
 *
 *     0.357   age            the model reproduced the field's inverted heuristic
 *     0.500   chance         the prose carries nothing
 *     0.529   popularity     the model found the popularity channel in the text
 *
 * Two prompts, because they separate two different failures. PRACTITIONER asks the
 * question a developer actually asks and is where the heuristic lives. FORECAST asks the
 * literal question the label answers. A model that scores below chance on the first and
 * above it on the second knows that advisories follow attention, and gives advice
 * anyway based on the intuition that does not.
 */

export type Condition =
  | "practitioner-named"
  | "practitioner-blind"
  | "forecast-named"
  | "forecast-blind"
  | "reidentify"
  | "recall";

export interface ConditionSpec {
  key: Condition;
  /** Whether the package's identity is substituted out of the input. */
  blinded: boolean;
  /** Whether the README and package.json are supplied at all. */
  withText: boolean;
  prompt: string;
  /** One line, for the report. */
  purpose: string;
}

const ABSTAIN_CLAUSE = `Set "abstain" to true when the material genuinely does not
support a judgement. Abstaining is scored separately from being wrong, and a confident
guess on no evidence is scored worse than a declared abstention. Do not abstain merely
because the question is hard.`;

const SCHEMA_CLAUSE = `Return strict JSON and nothing else:

{"risk": <number 0.0-1.0>, "reason": "<one sentence>", "evidence_quote": "<verbatim from the input, or empty>", "abstain": <boolean>}`;

/**
 * The question a developer asks before adding a dependency, in their words rather than
 * in the benchmark's. No mention of advisories, disclosure, or prediction: naming the
 * outcome would prompt reasoning about disclosure processes, and the heuristic under
 * test is the one that operates when nobody is thinking that carefully.
 */
const PRACTITIONER = `You are advising a developer deciding whether to add an npm package
to a production application. Based only on the material below, how much of a dependency
risk is this package?

0.0 means you would add it without hesitation. 1.0 means you would advise against it.

You are given the package's README and package.json as they stood on a specific date.
You are NOT given download counts, version counts, or release dates.

${ABSTAIN_CLAUSE}

${SCHEMA_CLAUSE}`;

/**
 * The literal question the ground truth answers. Deliberately explicit that a published
 * advisory, not a defect, is what is being asked about.
 */
const FORECAST = `You are assessing an npm package as it stood on 2023-01-01.

Estimate the probability that this package will have a security advisory published
against it in the GitHub Advisory Database at some point in the following three and a
half years. Note that this asks about an advisory being *published*, which requires
somebody to find and report a vulnerability, not merely for one to exist.

0.0 means almost certainly no advisory. 1.0 means almost certainly one.

You are given the package's README and package.json as they stood on that date. You are
NOT given download counts, version counts, or release dates.

${ABSTAIN_CLAUSE}

${SCHEMA_CLAUSE}`;

/**
 * The blinding validity check. Not optional: without it the blind arm is an assumption.
 * Reported as a rate beside the blind AUC, and above roughly 20-30% the blind condition
 * is nominal and has to be described that way.
 */
const REIDENTIFY = `Below is the README and package.json of an npm package, with its name,
scope, repository and contact details replaced by substitutes.

Name the real package if you recognise it. Do not guess from the general subject matter:
answer only if specific wording, API names, option names or structure identify it to you.

Return strict JSON and nothing else:

{"identified": <boolean>, "package": "<npm package name, or empty>", "confidence": <number 0.0-1.0>, "clue": "<the specific text that gave it away, verbatim, or empty>"}`;

/**
 * The memorisation probe, run on the name alone with no text.
 *
 * An adversarial review made four objections to an earlier version of this and all four
 * are addressed here. It runs on every package, cases and controls alike, so the output
 * is an AUC and a false-alarm rate rather than an uninterpretable recall figure on
 * positives only. It does not ask for GHSA identifiers, which are random tokens that
 * nothing memorises and that are trivial to hallucinate in a valid-looking shape; it
 * asks for the vulnerability class and affected version range, which a model that
 * genuinely encoded the advisory can supply and a model reasoning from priors cannot.
 * And it names the year window explicitly so that a refusal is a refusal rather than an
 * ambiguity about scope.
 */
const RECALL = `Do you know of any security advisory published in the GitHub Advisory
Database against the npm package named below, between 2023-01-01 and 2026-09-01?

Answer from memory. Do not speculate from the package's popularity or subject area: if
you do not specifically recall an advisory, say so, which is a useful answer.

Return strict JSON and nothing else:

{"recalls": <boolean>, "vulnerability_class": "<e.g. prototype pollution, ReDoS, path traversal, or empty>", "affected_versions": "<e.g. <4.17.21, or empty>", "approximate_year": <number or null>, "confidence": <number 0.0-1.0>}`;

export const CONDITIONS: ConditionSpec[] = [
  {
    key: "practitioner-named",
    blinded: false,
    withText: true,
    prompt: PRACTITIONER,
    purpose: "Does the model repeat the field's inverted health heuristic?",
  },
  {
    key: "practitioner-blind",
    blinded: true,
    withText: true,
    prompt: PRACTITIONER,
    purpose: "The same question with the package's identity substituted out.",
  },
  {
    key: "forecast-named",
    blinded: false,
    withText: true,
    prompt: FORECAST,
    purpose: "The literal label question: will an advisory be published?",
  },
  {
    key: "forecast-blind",
    blinded: true,
    withText: true,
    prompt: FORECAST,
    purpose: "The missing cell: is the forecast signal in the text or in the identity?",
  },
  {
    key: "reidentify",
    blinded: true,
    withText: true,
    prompt: REIDENTIFY,
    purpose: "Validity check: can the model name the package anyway?",
  },
  {
    key: "recall",
    blinded: false,
    withText: false,
    prompt: RECALL,
    purpose: "Contamination: does the model already know what happened?",
  },
];

/** The conditions that produce a risk score and therefore an AUC. */
export const SCORING_CONDITIONS: Condition[] = [
  "practitioner-named",
  "practitioner-blind",
  "forecast-named",
  "forecast-blind",
];

/**
 * Why the fourth scoring cell exists.
 *
 * The first run left the design as a ragged 2x2: both practitioner conditions, but only
 * the named forecast. That made the arm's largest result, forecast at 0.814 against
 * practitioner at 0.529, open to a reading it could not answer. Two mechanisms produce a
 * high forecast score and the run could not separate them:
 *
 *   the text        the model read the README and inferred something real about the
 *                   package's exposure
 *   the identity    the model recognised the package, which it does 57.8% of the time
 *                   even from substituted text, and applied what it knows about that
 *                   package's prominence
 *
 * Two other checks already argue for the first. The cutoff strata are 0.827 against
 * 0.802, so it is not recall of the advisory itself. Document length alone scores 0.606
 * and the model still scores 0.775 to 0.818 within every length quartile, so it is not
 * a proxy for size. Neither rules out identity.
 *
 * This condition does. If blinding costs the forecast little, the signal survives without
 * the name. If it collapses toward chance the way practitioner-blind did, the forecast
 * was reading a label rather than a document, and the headline needs rewriting rather
 * than defending.
 */

/** Reference points the report prints beside every model AUC, from run 4. */
export const REFERENCE_POINTS = [
  { label: "age (inverted heuristic)", auc: 0.357 },
  { label: "chance", auc: 0.5 },
  { label: "popularity (best rule)", auc: 0.529 },
] as const;
