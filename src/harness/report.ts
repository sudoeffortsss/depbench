/**
 * Prints the leaderboard.
 *
 *   npx tsx src/harness/report.ts
 *   npx tsx src/harness/report.ts --no-report-unknowns   # demonstrates rule 3
 *
 * This is the first place in the pipeline that reads `outcome`. Everything before it —
 * ingest, reconstruction, scoring — ran without ever seeing a label.
 */

import { migrate, openDb } from "../db/migrate.js";
import { SCORING_DATE } from "../snapshot/build.js";
import { computeMetrics, type Metrics, type ScoredPackage } from "./metrics.js";

const HIDE_UNKNOWNS = process.argv.includes("--no-report-unknowns");

function pct(x: number): string {
  return Number.isNaN(x) ? "   n/a" : `${(x * 100).toFixed(1).padStart(5)}%`;
}

async function main(): Promise<void> {
  const db = await openDb();
  try {
    await migrate(db);

    const run = await db.query<{ id: string; universe_hash: string }>(
      `SELECT id, universe_hash FROM run ORDER BY id DESC LIMIT 1`,
    );
    if (run.rows.length === 0) {
      console.error("no run found; run src/policies/run.ts first");
      process.exit(1);
    }
    const runId = Number(run.rows[0]!.id);
    const universeHash = run.rows[0]!.universe_hash;

    const rows = await db.query<{
      policy: string;
      pkg_name: string;
      score: number | null;
      abstain: boolean;
      parse_status: string;
      cost_usd: string;
      is_case: boolean;
      releases_last_90d: number;
      downloads_prior_month: string | null;
    }>(
      `SELECT ps.policy, ps.pkg_name, ps.score, ps.abstain, ps.parse_status, ps.cost_usd,
              (o.pkg_name IS NOT NULL) AS is_case,
              s.releases_last_90d, s.downloads_prior_month
         FROM policy_score ps
         JOIN snapshot s
           ON s.pkg_name = ps.pkg_name AND s.as_of_date = ps.as_of_date
         LEFT JOIN outcome o
           ON o.pkg_name = ps.pkg_name AND o.as_of_date = ps.as_of_date
          AND o.kind = 'advisory'
        WHERE ps.run_id = $1
        ORDER BY ps.policy, ps.pkg_name`,
      [runId],
    );

    const byPolicy = new Map<string, ScoredPackage[]>();
    const costByPolicy = new Map<string, number>();
    for (const r of rows.rows) {
      const list = byPolicy.get(r.policy) ?? [];
      list.push({
        pkg_name: r.pkg_name,
        score: r.score === null ? null : Number(r.score),
        abstain: r.abstain,
        parse_status: r.parse_status,
        is_case: r.is_case,
        releases_last_90d: r.releases_last_90d,
        downloads_prior_month:
          r.downloads_prior_month === null ? null : Number(r.downloads_prior_month),
      });
      byPolicy.set(r.policy, list);
      costByPolicy.set(r.policy, (costByPolicy.get(r.policy) ?? 0) + Number(r.cost_usd));
    }

    console.log(`truthlag report`);
    console.log(`  run           : ${runId}`);
    console.log(`  scoring date  : ${SCORING_DATE}`);
    console.log(`  universe hash : ${universeHash.slice(0, 16)}...`);
    console.log(`  headline      : AUC (case-control makes precision@k uninterpretable)\n`);

    const results: Metrics[] = [];
    for (const [policy, list] of byPolicy) {
      results.push(computeMetrics(policy, list, costByPolicy.get(policy) ?? 0));
    }
    results.sort((a, b) => (a.ok ? a.auc : -1) < (b.ok ? b.auc : -1) ? 1 : -1);

    // Rule 3, enforced at the point of printing rather than trusted to a convention.
    if (HIDE_UNKNOWNS) {
      console.error(
        `refusing to print a headline metric.\n` +
          `  --no-report-unknowns suppresses the abstention and no_answer columns,\n` +
          `  and an AUC without them is not a number this benchmark will stand behind.\n` +
          `  See BLUEPRINT.md section 7, rule 3.`,
      );
      process.exit(2);
    }

    console.log(
      `  ${"policy".padEnd(12)} ${"AUC".padStart(6)}  ${"cases".padStart(5)} ` +
        `${"ctrls".padStart(5)}  ${"scored".padStart(6)} ${"abstain".padStart(7)} ` +
        `${"no_ans".padStart(6)}  ${"top10%".padStart(6)} ${"falseflag".padStart(9)}`,
    );
    console.log(`  ${"-".repeat(84)}`);

    for (const m of results) {
      if (!m.ok) {
        console.log(`  ${m.policy.padEnd(12)} REFUSED  ${m.reason}`);
        continue;
      }
      console.log(
        `  ${m.policy.padEnd(12)} ${m.auc.toFixed(3).padStart(6)}  ` +
          `${String(m.casesScored).padStart(5)} ${String(m.controlsScored).padStart(5)}  ` +
          `${pct(m.coverage.scoredFraction)} ${pct(m.coverage.abstainRate)} ` +
          `${pct(m.coverage.noAnswerRate)}  ` +
          `${pct(m.guardrails.topDecileCaseRecall)} ` +
          `${pct(m.guardrails.activeControlFalseFlagRate)}`,
      );
    }

    const baseline = results.find((m) => m.ok && m.policy === "popularity");
    const floor = results.find((m) => m.ok && m.policy === "random");
    console.log(`\n  reading this table:`);
    console.log(
      `    AUC 0.5 is chance. Above 0.5 means the policy ranks cases above controls.`,
    );
    if (floor?.ok) {
      console.log(`    random     = ${floor.auc.toFixed(3)}  <- the floor`);
    }
    if (baseline?.ok) {
      console.log(
        `    popularity = ${baseline.auc.toFixed(3)}  <- the number every other ` +
          `policy has to beat`,
      );
      const beaten = results.filter(
        (m) => m.ok && m.policy !== "popularity" && m.policy !== "random" &&
          m.auc > baseline.auc,
      );
      console.log(
        `\n  policies beating popularity: ` +
          (beaten.length === 0
            ? `none`
            : beaten.map((m) => (m.ok ? `${m.policy} (${m.auc.toFixed(3)})` : "")).join(", ")),
      );
    }

    console.log(
      `\n  Reminder on interpretation: cases are packages that received a GHSA advisory,\n` +
        `  and advisories are found by people looking. 45% of cases sit above a million\n` +
        `  monthly downloads. These numbers measure agreement with where attention went,\n` +
        `  not with where danger was. See FINDINGS.md F4.`,
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
