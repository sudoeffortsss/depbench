/**
 * CLI entry point for point-in-time text ingest.
 *
 *   npx tsx src/ingest/tarball-run.ts          all universe members
 *   npx tsx src/ingest/tarball-run.ts --limit 5   smoke test
 *
 * Safe to re-run: unchanged content inserts zero rows.
 */

import { migrate, openDb } from "../db/migrate.js";
import { readUniverse } from "./registry.js";
import { SCORING_DATE } from "../snapshot/build.js";
import { ingestTarballs } from "./tarball.js";

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

  const db = await openDb();
  try {
    await migrate(db);
    const members = await readUniverse();
    const names = members.map((m) => m.name);

    // The version that was live on the scoring date, from the reconstruction rather than
    // from dist-tags, which move.
    const rows = await db.query<{ pkg_name: string; latest_version: string }>(
      `SELECT pkg_name, latest_version FROM snapshot
        WHERE as_of_date = $1 AND latest_version IS NOT NULL
          AND pkg_name = ANY($2::text[])
        ORDER BY pkg_name`,
      [SCORING_DATE, names],
    );

    // Skip what is already stored. The insert is idempotent either way, but refetching
    // 1,595 tarballs to learn nothing is a quarter of an hour and 200 MB of someone
    // else's bandwidth.
    const stored = await db.query<{ external_id: string }>(
      `SELECT DISTINCT external_id FROM observation
        WHERE source = 'npm_tarball' AND payload IS NOT NULL`,
    );
    const have = new Set(stored.rows.map((r) => r.external_id));

    const targets = rows.rows
      .map((r) => ({ name: r.pkg_name, version: r.latest_version }))
      .filter((t) => !have.has(t.name))
      .slice(0, limit === Infinity ? undefined : limit);

    console.log(`truthlag tarball text`);
    console.log(`  scoring date : ${SCORING_DATE}`);
    console.log(`  members      : ${members.length}`);
    console.log(`  with a version on D: ${rows.rows.length}`);
    console.log(`  already stored: ${have.size}`);
    console.log(`  fetching     : ${targets.length}\n`);

    const started = Date.now();
    let last = 0;
    const stats = await ingestTarballs(db, targets, (done, total, s) => {
      if (done - last >= 100 || done === total) {
        last = done;
        const rate = done / ((Date.now() - started) / 1000);
        console.log(
          `  ${done}/${total}  ok ${s.fetched} fail ${s.failed}  ` +
            `readme ${s.withReadme} none ${s.withoutReadme}  ` +
            `${rate.toFixed(1)}/s  eta ${Math.round((total - done) / rate)}s`,
        );
      }
    });

    console.log(`\n=== tarball text complete ===`);
    console.log(`  requested    : ${stats.requested}`);
    console.log(`  fetched      : ${stats.fetched}`);
    console.log(`  failed       : ${stats.failed}   <- rows, not gaps`);
    console.log(`  with README  : ${stats.withReadme}`);
    console.log(`  no README    : ${stats.withoutReadme}   <- a real property, not an error`);
    console.log(`  inserted     : ${stats.inserted}`);
    console.log(`  unchanged    : ${stats.unchanged}`);
    console.log(`  downloaded   : ${(stats.bytes / 1e6).toFixed(0)} MB`);

    if (stats.fetched + stats.failed !== stats.requested) {
      throw new Error(
        `accounting does not close: ${stats.fetched} + ${stats.failed} != ${stats.requested}`,
      );
    }
    console.log(`TARBALL_DONE`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
