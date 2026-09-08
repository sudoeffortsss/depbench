/**
 * Scores every universe member with every rule policy.
 *
 *   npx tsx src/policies/run.ts
 *
 * Reads `snapshot`. Does not read `outcome`, and does not join to it. Outcomes are only
 * touched later, by the harness, when metrics are computed. Keeping the scoring pass
 * ignorant of labels is not a stylistic preference; it is the reason the numbers mean
 * anything.
 *
 * Costs nothing to run: no network, no model, no API key. That is why stage 6 —
 * the first numbers — comes before any LLM work.
 */

import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { migrate, openDb } from "../db/migrate.js";
import { SCORING_DATE } from "../snapshot/build.js";
import { readUniverse } from "../ingest/registry.js";
import {
  RULE_POLICIES,
  type PolicyContext,
  type PolicyInput,
} from "./index.js";

/** Stable per-key pseudo-random in [0,1), so `random` is reproducible across runs. */
function hashUnit(key: string): number {
  const h = createHash("sha256").update(`truthlag:${key}`).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

/**
 * Ranks are computed once over the whole universe, then reused. Note what this does and
 * does not leak: a rank depends on the distribution of a *feature* across the universe,
 * never on any outcome. Every value here was knowable on the scoring date.
 */
function buildRanker(rows: PolicyInput[]): PolicyContext["rank01"] {
  const sorted = new Map<string, number[]>();
  const numericFields: Array<keyof PolicyInput> = [
    "downloads_prior_month",
    "days_since_last_pub",
    "version_count",
    "releases_last_90d",
    "releases_last_365d",
  ];
  for (const f of numericFields) {
    const vals = rows
      .map((r) => r[f])
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    sorted.set(f as string, vals);
  }

  return (field, value) => {
    const vals = sorted.get(field as string);
    if (!vals || vals.length === 0) return 0.5;
    // Fraction of the universe at or below this value.
    let lo = 0;
    let hi = vals.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vals[mid]! <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo / vals.length;
  };
}

async function main(): Promise<void> {
  const db: PGlite = await openDb();
  try {
    await migrate(db);

    // Restricted to current universe members on purpose. `snapshot` is append-only and
    // keyed by package rather than by universe, so it still holds rows for members of
    // an earlier draw: after the scoped-package fix the universe was refrozen and 1,305
    // packages left it while 2,617 joined, leaving snapshot with 4,520 rows against
    // 3,215 members. Scoring the extra rows would not merely add ignorable packages, it
    // would move every rank, because rank01 is a position within the scored population
    // and popularity, age and composite are all defined on it.
    const members = await readUniverse();
    const memberNames = members.map((m) => m.name);

    const snap = await db.query<PolicyInput>(
      `SELECT pkg_name, downloads_prior_month, version_count, days_since_last_pub,
              releases_last_90d, releases_last_365d, first_published_at,
              has_install_hook, has_repo_url, license, reconstructed
         FROM snapshot
        WHERE as_of_date = $1 AND pkg_name = ANY($2::text[])
        ORDER BY pkg_name`,
      [SCORING_DATE, memberNames],
    );
    const rows = snap.rows.map((r) => ({
      ...r,
      downloads_prior_month:
        r.downloads_prior_month === null ? null : Number(r.downloads_prior_month),
    }));

    // A member with no snapshot row would vanish from the denominator, which is exactly
    // what harness rule 1 forbids. Name the gap rather than scoring around it.
    if (rows.length !== members.length) {
      const have = new Set(rows.map((r) => r.pkg_name));
      const missing = memberNames.filter((n) => !have.has(n));
      throw new Error(
        `${missing.length} universe members have no snapshot on ${SCORING_DATE}: ` +
          `${missing.slice(0, 8).join(", ")}`,
      );
    }

    console.log(`truthlag score`);
    console.log(`  scoring date : ${SCORING_DATE}`);
    console.log(`  packages     : ${rows.length}`);
    console.log(`  policies     : ${RULE_POLICIES.map((p) => p.name).join(", ")}\n`);

    const ctx: PolicyContext = { hashUnit, rank01: buildRanker(rows) };

    // The universe hash is what binds a run to the exact evaluation set it scored, so
    // it is read from universe.json every time rather than reused from whatever row the
    // table already had. The previous shape only inserted when the table was empty; a
    // refreeze therefore left run 3 stamped with the hash of the universe it had just
    // replaced, which is the one failure this column exists to prevent.
    const { readFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const u = JSON.parse(await readFile(join(root, "universe", "universe.json"), "utf8"));
    const universeHash = u.universe_hash as string;

    // The frozen manifest and the file the scorer actually read must be the same set.
    if (u.member_count !== members.length) {
      throw new Error(
        `universe.json declares ${u.member_count} members but universe.tsv has ` +
          `${members.length}; the manifest and the member list disagree`,
      );
    }

    await db.query(
      `INSERT INTO universe (universe_hash, scoring_date, window_start, window_end,
                             member_count, case_count, control_count, selection_rule)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        universeHash, SCORING_DATE, "2023-01-01", "2026-09-01",
        u.member_count, u.case_count, u.control_count,
        JSON.stringify(u.selection_rule),
      ],
    );

    const run = await db.query<{ id: string }>(
      `INSERT INTO run (universe_hash, scoring_date, dry_run, notes)
       VALUES ($1, $2, false, 'rule policies, no network, no model')
       RETURNING id`,
      [universeHash, SCORING_DATE],
    );
    const runId = Number(run.rows[0]!.id);
    console.log(`  run id       : ${runId}\n`);

    await db.exec("BEGIN");
    try {
      for (const policy of RULE_POLICIES) {
        let scored = 0;
        let abstained = 0;
        for (const row of rows) {
          // A package we could not reconstruct is not scorable. It is recorded as an
          // error rather than skipped, so it stays in the denominator (rule 1).
          if (!row.reconstructed) {
            await db.query(
              `INSERT INTO policy_score (run_id, pkg_name, as_of_date, policy, score,
                                         abstain, evidence_n, parse_status)
               VALUES ($1,$2,$3,$4,NULL,false,0,'error')`,
              [runId, row.pkg_name, SCORING_DATE, policy.name],
            );
            continue;
          }
          const out = policy.score(row, ctx);
          if (out.abstain) abstained++;
          else scored++;
          await db.query(
            `INSERT INTO policy_score (run_id, pkg_name, as_of_date, policy, score,
                                       abstain, evidence_n, parse_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'ok')`,
            [runId, row.pkg_name, SCORING_DATE, policy.name, out.score, out.abstain, out.evidence_n],
          );
        }
        console.log(
          `  ${policy.name.padEnd(12)} scored ${String(scored).padStart(5)}  ` +
            `abstained ${String(abstained).padStart(4)}`,
        );
      }
      await db.exec("COMMIT");
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }

    const total = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM policy_score WHERE run_id = $1`,
      [runId],
    );
    console.log(`\n  ${total.rows[0]!.n} score rows written for run ${runId}`);
    console.log(`  no outcome table was read during scoring`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
