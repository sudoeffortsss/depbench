/**
 * Rebuilds snapshots and outcomes from data already in `observation`.
 *
 *   npx tsx src/snapshot/run.ts
 *
 * Touches the network zero times. That is the payoff of keeping raw fetches append-only:
 * every change to the reconstruction logic is a recompute.
 */

import { migrate, openDb } from "../db/migrate.js";
import { buildAllSnapshots, SCORING_DATE } from "./build.js";
import { buildOutcomes } from "../outcomes/build.js";

async function main(): Promise<void> {
  const db = await openDb();
  try {
    await migrate(db);

    console.log(`truthlag snapshot + outcomes`);
    console.log(`  scoring date: ${SCORING_DATE}\n`);

    const s = await buildAllSnapshots(db);
    console.log(`=== snapshot ===`);
    console.log(`  packages processed  : ${s.total}`);
    console.log(`  reconstructed       : ${s.reconstructed}`);
    console.log(`  fetch failed        : ${s.fetchFailed}   <- rows, not gaps`);
    console.log(`  no versions before D: ${s.noVersionsBeforeD}`);
    console.log(`  with provenance     : ${s.withProvenance}   <- expected 0, see F5`);
    console.log(`  with install hook   : ${s.withInstallHook}`);

    const o = await buildOutcomes(db);
    console.log(`\n=== outcomes ===`);
    console.log(`  advisory (strong)   : ${o.advisory}`);
    console.log(`    of which cases    : ${o.casesWithAdvisory}`);
    console.log(`    of which controls : ${o.controlsWithAdvisory}   <- must be 0`);
    console.log(`  deprecated (weak)   : ${o.deprecated}`);
    console.log(`  abandoned (weak)    : ${o.abandoned}`);
    console.log(`  packages with any   : ${o.packagesWithAny}`);

    // Sanity checks that would otherwise fail silently much later.
    const problems: string[] = [];
    if (o.controlsWithAdvisory > 0) {
      problems.push(
        `${o.controlsWithAdvisory} controls carry an advisory; controls are defined as ` +
          `having none, so either the universe or the outcome join is wrong`,
      );
    }
    // Exactly one package legitimately carries an attestation before provenance
    // shipped: `sigstore`, the signing infrastructure npm provenance is built on.
    // Its team used their own mechanism four months before the public beta. Anything
    // beyond that one package means the reconstruction is wrong. See FINDINGS.md F8.
    const PRE_GA_PROVENANCE_EXPECTED = 1;
    if (s.withProvenance > PRE_GA_PROVENANCE_EXPECTED) {
      problems.push(
        `${s.withProvenance} packages show provenance on ${SCORING_DATE}. Only ` +
          `sigstore itself is expected; npm provenance reached GA on 2023-09-26. ` +
          `Investigate before trusting any snapshot field`,
      );
    }
    if (problems.length > 0) {
      console.log(`\n!! consistency problems:`);
      for (const p of problems) console.log(`   - ${p}`);
      process.exitCode = 1;
    } else {
      console.log(`\n  consistency checks passed`);
    }

    const dist = await db.query<{ band: string; n: string }>(
      `SELECT CASE
                WHEN days_since_last_pub IS NULL THEN 'unknown'
                WHEN days_since_last_pub < 30 THEN '<30d'
                WHEN days_since_last_pub < 90 THEN '30-90d'
                WHEN days_since_last_pub < 365 THEN '90-365d'
                ELSE '>365d' END AS band,
              count(*) AS n
       FROM snapshot WHERE as_of_date = $1 GROUP BY 1 ORDER BY 1`,
      [SCORING_DATE],
    );
    console.log(`\n  staleness on the scoring date:`);
    for (const r of dist.rows) console.log(`    ${r.band.padEnd(9)} ${r.n}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
