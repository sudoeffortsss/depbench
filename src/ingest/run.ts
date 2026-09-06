/**
 * CLI entry point for stage 3 ingest.
 *
 *   npx tsx src/ingest/run.ts
 *
 * Safe to re-run. Unchanged upstream data inserts zero rows, which is asserted by
 * `src/db/migrate.test.ts` rather than merely claimed here.
 */

import { migrate, openDb } from "../db/migrate.js";
import { ingestPackuments, readUniverse } from "./registry.js";

async function main(): Promise<void> {
  const db = await openDb();
  try {
    await migrate(db);

    const members = await readUniverse();
    console.log(`truthlag ingest`);
    console.log(`  universe: ${members.length} packages`);

    const before = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM observation WHERE source = 'npm_packument'`,
    );
    console.log(`  existing packument observations: ${before.rows[0]!.n}`);

    const started = Date.now();
    let lastLog = 0;

    const stats = await ingestPackuments(
      db,
      members.map((m) => m.name),
      (done, total, s) => {
        if (done - lastLog >= 100 || done === total) {
          lastLog = done;
          const elapsed = (Date.now() - started) / 1000;
          const rate = done / elapsed;
          const eta = (total - done) / rate;
          console.log(
            `  ${done}/${total}  ok ${s.ok} fail ${s.failed}  ` +
              `new ${s.inserted} unchanged ${s.unchanged}  ` +
              `${rate.toFixed(1)}/s  eta ${Math.round(eta)}s`,
          );
        }
      },
    );

    console.log(`\n=== ingest complete ===`);
    console.log(`  attempted : ${stats.attempted}`);
    console.log(`  fetched   : ${stats.ok}`);
    console.log(`  failed    : ${stats.failed}   <- these are rows, not gaps`);
    console.log(`  inserted  : ${stats.inserted}`);
    console.log(`  unchanged : ${stats.unchanged}`);
    console.log(`  raw stored: ${(stats.rawBytes / 1e6).toFixed(0)} MB uncompressed`);

    const after = await db.query<{ n: string; failed: string }>(
      `SELECT count(*) AS n,
              count(*) FILTER (WHERE payload IS NULL) AS failed
       FROM observation WHERE source = 'npm_packument'`,
    );
    console.log(`\n  observation rows now: ${after.rows[0]!.n} (${after.rows[0]!.failed} failures)`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
