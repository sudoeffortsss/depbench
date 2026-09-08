/**
 * Reads a model arm back out.
 *
 *   npx tsx src/harness/llm-report.ts [--run N]
 *
 * The rule policies are recomputed here on exactly the packages the model scored, and
 * that is not a nicety. The published rule figures come from all 3,215 members; a model
 * run that covered a subset would be compared against a different population, and during
 * the pilot that mattered enormously. On the alphabetically-first 300 packages the
 * `random` floor scored 0.417 rather than 0.500, with an interval that excluded chance.
 * Quoting the model against the full-universe baselines there would have credited it with
 * most of a sampling artefact.
 */

import { migrate, openDb } from "../db/migrate.js";
import { readUniverse } from "../ingest/registry.js";
import { SCORING_DATE } from "../snapshot/build.js";
import { auc, aucInterval } from "./metrics.js";
import { analyseArm, analyseRecallProbe, analyseReidentification } from "./llm-metrics.js";
import { MODEL_ARMS } from "../policies/llm.js";

interface Line {
  policy: string;
  auc: number;
  lo: number;
  hi: number;
  n: number;
  kind: "model" | "rule";
}

async function main(): Promise<void> {
  const argv = process.argv;
  const runArg = argv.indexOf("--run");
  const db = await openDb();
  try {
    await migrate(db);

    const runId = runArg > -1
      ? Number(argv[runArg + 1])
      : Number(
          (await db.query<{ id: string }>(
            `SELECT id FROM run WHERE notes LIKE 'model arm%' ORDER BY id DESC LIMIT 1`,
          )).rows[0]?.id ?? 0,
        );
    if (!runId) throw new Error("no model-arm run found; run src/policies/llm-run.ts first");

    const armPolicy = (await db.query<{ policy: string }>(
      `SELECT DISTINCT split_part(policy, ':', 1) AS policy
         FROM policy_score WHERE run_id = $1 LIMIT 1`,
      [runId],
    )).rows[0]?.policy ?? "llm-flash-lite";
    const arm = MODEL_ARMS.find((a) => a.policy === armPolicy);

    const members = (await readUniverse()).map((m) => m.name);

    // The exact packages this run scored. Everything below is restricted to them.
    const covered = (await db.query<{ pkg_name: string }>(
      `SELECT DISTINCT pkg_name FROM policy_score WHERE run_id = $1`,
      [runId],
    )).rows.map((r) => r.pkg_name);

    const mix = await db.query<{ cases: string; ctrls: string }>(
      `SELECT count(*) FILTER (WHERE o.pkg_name IS NOT NULL) AS cases,
              count(*) FILTER (WHERE o.pkg_name IS NULL)     AS ctrls
         FROM unnest($1::text[]) AS p(pkg_name)
         LEFT JOIN outcome o ON o.pkg_name = p.pkg_name
                            AND o.as_of_date = $2 AND o.kind = 'advisory'`,
      [covered, SCORING_DATE],
    );

    console.log("truthlag model arm");
    console.log("  run          : " + runId);
    console.log("  arm          : " + armPolicy + (arm ? "  (" + arm.model + ")" : ""));
    if (arm) console.log("  cutoff       : " + arm.trainingCutoff);
    console.log("  packages     : " + covered.length + " of " + members.length);
    console.log("  cases/ctrls  : " + mix.rows[0]!.cases + " / " + mix.rows[0]!.ctrls);
    const spend = await db.query<{ usd: string }>(
      `SELECT coalesce(sum(cost_usd), 0) AS usd FROM policy_score WHERE run_id = $1`,
      [runId],
    );
    console.log("  spent        : $" + Number(spend.rows[0]!.usd).toFixed(4));

    // ---- rules, recomputed on the same packages -------------------------------------
    const ruleRun = (await db.query<{ id: string }>(
      `SELECT id FROM run WHERE notes NOT LIKE 'model arm%' ORDER BY id DESC LIMIT 1`,
    )).rows[0]?.id;

    const lines: Line[] = [];
    if (ruleRun) {
      const r = await db.query<{ policy: string; score: string; is_case: boolean }>(
        `SELECT ps.policy, ps.score, (o.pkg_name IS NOT NULL) AS is_case
           FROM policy_score ps
           LEFT JOIN outcome o ON o.pkg_name = ps.pkg_name
                              AND o.as_of_date = ps.as_of_date AND o.kind = 'advisory'
          WHERE ps.run_id = $1 AND ps.pkg_name = ANY($2::text[])
            AND ps.score IS NOT NULL AND NOT ps.abstain AND ps.parse_status = 'ok'`,
        [Number(ruleRun), covered],
      );
      const by = new Map<string, { c: number[]; k: number[] }>();
      for (const x of r.rows) {
        const e = by.get(x.policy) ?? { c: [], k: [] };
        (x.is_case ? e.c : e.k).push(Number(x.score));
        by.set(x.policy, e);
      }
      for (const [policy, { c, k }] of by) {
        if (c.length < 10 || k.length < 10) continue;
        const ci = aucInterval(c, k);
        lines.push({ policy, auc: auc(c, k), lo: ci.lo, hi: ci.hi, n: c.length + k.length, kind: "rule" });
      }
    }

    // ---- the model's scoring conditions ---------------------------------------------
    const results = await analyseArm(db, runId, members, arm?.trainingCutoff ?? null);
    for (const r of results) {
      if (r.auc === null || !r.ci) continue;
      lines.push({ policy: r.condition, auc: r.auc, lo: r.ci.lo, hi: r.ci.hi, n: r.scored, kind: "model" });
    }

    lines.sort((a, b) => b.auc - a.auc);
    console.log("\n  everything below is computed on the same " + covered.length + " packages\n");
    console.log("  " + "policy".padEnd(36) + "AUC".padStart(6) + "95% CI".padStart(18) + "n".padStart(6));
    console.log("  " + "-".repeat(66));
    for (const l of lines) {
      const mark = l.kind === "model" ? " *" : "  ";
      console.log(
        "  " + l.policy.padEnd(36) + l.auc.toFixed(3).padStart(6) +
        ("[" + l.lo.toFixed(3) + ", " + l.hi.toFixed(3) + "]").padStart(18) +
        String(l.n).padStart(6) + mark,
      );
    }
    console.log("\n  * model condition. Chance is 0.500 and the floor is whatever `random`");
    console.log("    scored here, which on a subset need not be 0.500.");

    // ---- coverage and abstention ----------------------------------------------------
    console.log("\n  condition                             total scored abstain failed");
    for (const r of results) {
      console.log(
        "  " + r.condition.padEnd(38) + String(r.total).padStart(5) +
        String(r.scored).padStart(7) + String(r.abstained).padStart(8) +
        String(r.failed).padStart(7),
      );
    }
    const totalScored = results.reduce((a, r) => a + r.scored, 0);
    const totalAbstain = results.reduce((a, r) => a + r.abstained, 0);
    console.log("\n  abstentions across every scoring call: " + totalAbstain + " of " + totalScored);
    if (totalAbstain === 0) {
      console.log("  The rubric offers abstention and states it is scored apart from being");
      console.log("  wrong. It was never taken, including where the package ships one line.");
    }

    // ---- cutoff strata --------------------------------------------------------------
    console.log("\n=== training-cutoff strata ===");
    console.log("  Cases disclosed before the cutoff could have been read during training.");
    console.log("  Cases disclosed after it could not. A large gap is recall, not foresight.\n");
    let anyStrata = false;
    for (const r of results) {
      if (!r.strata) continue;
      anyStrata = true;
      const { pre, post, gap } = r.strata;
      console.log("  " + r.condition);
      console.log("    " + pre.label.padEnd(32) + pre.auc.toFixed(3) +
        "  [" + pre.ci.lo.toFixed(3) + ", " + pre.ci.hi.toFixed(3) + "]  n=" + pre.cases);
      console.log("    " + post.label.padEnd(32) + post.auc.toFixed(3) +
        "  [" + post.ci.lo.toFixed(3) + ", " + post.ci.hi.toFixed(3) + "]  n=" + post.cases);
      console.log("    gap (pre - post)                " + gap.toFixed(3) +
        (Math.abs(gap) < 0.05 ? "   <- no evidence of recall at this resolution" : ""));
    }
    if (!anyStrata) {
      console.log("  Not computed: a stratum under 100 cases cannot separate its own AUC");
      console.log("  from chance, so reporting one would be reporting noise.");
    }

    // ---- probes ---------------------------------------------------------------------
    const re = await analyseReidentification(db, runId, members, armPolicy + ":reidentify");
    console.log("\n=== re-identification (does blinding blind?) ===");
    console.log("  answered            : " + re.answered + "   unparseable " + re.unparseable);
    console.log("  named the package   : " + re.identified + " = " +
      (re.rate * 100).toFixed(1) + "%");
    console.log("  blind arm is nominal: " + (re.blindArmIsNominal ? "YES" : "no") +
      "   (threshold " + (re.nominalThreshold * 100) + "%)");
    if (re.blindArmIsNominal) {
      console.log("  The blind condition must be reported as nominal. Removing the name does");
      console.log("  not remove the identity when the document introduces itself.");
    }
    for (const e of re.examples.slice(0, 5)) {
      console.log("    " + e.pkg.padEnd(30) + e.clue.slice(0, 74));
    }

    const rc = await analyseRecallProbe(db, runId, members, armPolicy + ":recall");
    console.log("\n=== recall probe (does it already know?) ===");
    console.log("  answered              : " + rc.answered + "   unparseable " + rc.unparseable);
    console.log("  claims recall on cases: " + (rc.recallOnCases * 100).toFixed(1) + "%");
    console.log("  false alarm, controls : " + (rc.falseAlarmOnControls * 100).toFixed(1) +
      "%   <- controls have no in-window advisory to recall");
    console.log("  recall as a classifier: " +
      (rc.auc === null ? "too few" : rc.auc.toFixed(3)));
    console.log("\n  Explicit recall is not the whole of what a model absorbed, so a low");
    console.log("  figure here does not clear a high AUC above. The strata do that.");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
