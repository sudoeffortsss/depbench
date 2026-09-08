/**
 * What a model arm actually produced, read against the three reference points.
 *
 * A single AUC beside a single 0.5 line would be uninterpretable here, for the reason
 * the whole arm was reframed around: the label records who was audited, not what was
 * dangerous. Against three points it becomes legible.
 *
 *     0.357   age            reproduced the field's inverted heuristic
 *     0.500   chance         the prose carries nothing
 *     0.529   popularity     found the popularity channel in the text
 *
 * Four other numbers decide whether the AUC may be quoted at all:
 *
 *   cutoff strata   the same AUC computed on cases disclosed before and after the
 *                   model's training cutoff. A large pre>post gap means recall, not
 *                   prediction. The strata share their controls, so this compares two
 *                   dependent AUCs and the interval is bootstrapped rather than assumed.
 *   re-identification  how often the model names the package from blinded text. Above
 *                   roughly 20-30% the blind arm is nominal and must be described so.
 *   recall probe    asked of every package, cases and controls alike, so it yields an
 *                   AUC and a false-alarm rate rather than an uninterpretable recall
 *                   figure on positives only.
 *   abstention      split by whether the package shipped any prose at all. A model that
 *                   abstains at the same rate on both is not exercising judgement.
 */

import type { PGlite } from "@electric-sql/pglite";
import { auc, aucInterval, type AucInterval } from "./metrics.js";
import { REFERENCE_POINTS } from "../policies/prompts.js";

export interface StratumResult {
  label: string;
  cases: number;
  controls: number;
  auc: number;
  ci: AucInterval;
}

export interface ConditionResult {
  condition: string;
  total: number;
  scored: number;
  abstained: number;
  failed: number;
  auc: number | null;
  ci: AucInterval | null;
  /** Null when the arm has no cutoff, or a stratum is too small to interpret. */
  strata: { pre: StratumResult; post: StratumResult; gap: number } | null;
  abstainOnThinEvidence: number | null;
  abstainOnNormalEvidence: number | null;
}

interface Row {
  pkg_name: string;
  policy: string;
  score: number | null;
  abstain: boolean;
  parse_status: string;
  raw_output: string | null;
  evidence_n: number | null;
  is_case: boolean;
  occurred_at: string | null;
}

async function load(db: PGlite, runId: number, members: string[]): Promise<Row[]> {
  const r = await db.query<Row>(
    `SELECT ps.pkg_name, ps.policy, ps.score, ps.abstain, ps.parse_status, ps.raw_output,
            ps.evidence_n,
            (o.pkg_name IS NOT NULL) AS is_case,
            o.occurred_at::text AS occurred_at
       FROM policy_score ps
       LEFT JOIN outcome o
         ON o.pkg_name = ps.pkg_name AND o.as_of_date = ps.as_of_date AND o.kind = 'advisory'
      WHERE ps.run_id = $1 AND ps.pkg_name = ANY($2::text[])`,
    [runId, members],
  );
  return r.rows.map((x) => ({ ...x, score: x.score === null ? null : Number(x.score) }));
}

const usable = (rows: Row[]): Row[] =>
  rows.filter((r) => !r.abstain && r.score !== null && r.parse_status === "ok");

function stratum(rows: Row[], label: string, keep: (r: Row) => boolean): StratumResult | null {
  const u = usable(rows);
  const cases = u.filter((r) => r.is_case && keep(r)).map((r) => r.score as number);
  const controls = u.filter((r) => !r.is_case).map((r) => r.score as number);
  // Under 100 a stratum cannot separate its own AUC from chance, so reporting one would
  // be reporting noise with a decimal point on it.
  if (cases.length < 100 || controls.length < 100) return null;
  return {
    label, cases: cases.length, controls: controls.length,
    auc: auc(cases, controls), ci: aucInterval(cases, controls),
  };
}

export async function analyseArm(
  db: PGlite,
  runId: number,
  members: string[],
  cutoff: string | null,
): Promise<ConditionResult[]> {
  const rows = await load(db, runId, members);
  const byCondition = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byCondition.get(r.policy) ?? [];
    list.push(r);
    byCondition.set(r.policy, list);
  }

  const out: ConditionResult[] = [];
  for (const [condition, list] of byCondition) {
    const u = usable(list);
    const cases = u.filter((r) => r.is_case).map((r) => r.score as number);
    const controls = u.filter((r) => !r.is_case).map((r) => r.score as number);
    const scorable = cases.length >= 10 && controls.length >= 10;

    // Thin evidence is evidence_n === 0: the package shipped no prose at all. Whether a
    // model declines there rather than producing a number is the one thing it can do
    // that a rule cannot.
    const thin = list.filter((r) => r.evidence_n === 0);
    const normal = list.filter((r) => r.evidence_n !== 0);

    let strata: ConditionResult["strata"] = null;
    if (cutoff && scorable) {
      const boundary = cutoff + "-01";
      const pre = stratum(list, "disclosed before " + cutoff, (r) =>
        Boolean(r.occurred_at && r.occurred_at < boundary));
      const post = stratum(list, "disclosed on or after " + cutoff, (r) =>
        Boolean(r.occurred_at && r.occurred_at >= boundary));
      if (pre && post) strata = { pre, post, gap: pre.auc - post.auc };
    }

    out.push({
      condition,
      total: list.length,
      scored: u.length,
      abstained: list.filter((r) => r.abstain).length,
      failed: list.filter((r) => r.parse_status !== "ok").length,
      auc: scorable ? auc(cases, controls) : null,
      ci: scorable ? aucInterval(cases, controls) : null,
      strata,
      abstainOnThinEvidence:
        thin.length > 0 ? thin.filter((r) => r.abstain).length / thin.length : null,
      abstainOnNormalEvidence:
        normal.length > 0 ? normal.filter((r) => r.abstain).length / normal.length : null,
    });
  }
  return out.sort((a, b) => a.condition.localeCompare(b.condition));
}

export interface ProbeResult {
  answered: number;
  unparseable: number;
  /** Cases where the model recalled an advisory, over all cases. */
  recallOnCases: number;
  /** Controls where it recalled one anyway. There are none to recall by definition. */
  falseAlarmOnControls: number;
  /** Discrimination of "the model claims to remember" as a case predictor. */
  auc: number | null;
}

/**
 * The recall probe, scored as a classifier rather than as a recall percentage.
 *
 * A model that confabulates an advisory for every popular package scores high recall and
 * carries no information. Controls have no in-window advisory by construction, so every
 * claim on a control is a false alarm, and the two rates together are the measurement.
 */
export async function analyseRecallProbe(
  db: PGlite, runId: number, members: string[], policy: string,
): Promise<ProbeResult> {
  const rows = (await load(db, runId, members)).filter((r) => r.policy === policy);
  let unparseable = 0;
  const scored: Array<{ isCase: boolean; claim: number }> = [];
  for (const r of rows) {
    if (r.parse_status !== "ok" || !r.raw_output) { unparseable++; continue; }
    try {
      const o = JSON.parse(r.raw_output) as any;
      if (typeof o.recalls !== "boolean") { unparseable++; continue; }
      // Confidence carries the ranking; the boolean alone would tie almost everything.
      const conf = typeof o.confidence === "number" ? o.confidence : 0.5;
      scored.push({ isCase: r.is_case, claim: o.recalls ? conf : 0 });
    } catch { unparseable++; }
  }
  const cases = scored.filter((s) => s.isCase);
  const controls = scored.filter((s) => !s.isCase);
  return {
    answered: scored.length,
    unparseable,
    recallOnCases: cases.length ? cases.filter((s) => s.claim > 0).length / cases.length : 0,
    falseAlarmOnControls:
      controls.length ? controls.filter((s) => s.claim > 0).length / controls.length : 0,
    auc: cases.length >= 10 && controls.length >= 10
      ? auc(cases.map((s) => s.claim), controls.map((s) => s.claim))
      : null,
  };
}

export interface ReidResult {
  answered: number;
  unparseable: number;
  identified: number;
  rate: number;
  /** Above this the blind condition is nominal and has to be reported as such. */
  nominalThreshold: number;
  blindArmIsNominal: boolean;
  examples: Array<{ pkg: string; guess: string; clue: string }>;
}

export async function analyseReidentification(
  db: PGlite, runId: number, members: string[], policy: string,
): Promise<ReidResult> {
  const rows = (await load(db, runId, members)).filter((r) => r.policy === policy);
  const NOMINAL = 0.25;
  let unparseable = 0, identified = 0, answered = 0;
  const examples: ReidResult["examples"] = [];
  for (const r of rows) {
    if (r.parse_status !== "ok" || !r.raw_output) { unparseable++; continue; }
    try {
      const o = JSON.parse(r.raw_output) as any;
      if (typeof o.identified !== "boolean") { unparseable++; continue; }
      answered++;
      // Only a correct guess counts. Naming the wrong package is not re-identification,
      // it is a hallucination, and counting it would overstate the leak.
      const guess = String(o.package ?? "").trim().toLowerCase();
      if (o.identified && guess === r.pkg_name.toLowerCase()) {
        identified++;
        if (examples.length < 10) {
          examples.push({ pkg: r.pkg_name, guess, clue: String(o.clue ?? "").slice(0, 160) });
        }
      }
    } catch { unparseable++; }
  }
  const rate = answered ? identified / answered : 0;
  return {
    answered, unparseable, identified, rate,
    nominalThreshold: NOMINAL,
    blindArmIsNominal: rate > NOMINAL,
    examples,
  };
}

/** Which of the three reference points a result sits closest to. */
export function nearestReference(value: number): string {
  const points: ReadonlyArray<{ label: string; auc: number }> = REFERENCE_POINTS;
  let best = points[0]!;
  for (const p of points) {
    if (Math.abs(p.auc - value) < Math.abs(best.auc - value)) best = p;
  }
  return best.label;
}
