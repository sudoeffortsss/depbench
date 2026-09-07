import { migrate, openDb } from "../src/db/migrate.js";
import { ingestDownloads, applyDownloadsToSnapshot, WINDOW } from "../src/ingest/downloads.js";
import { readUniverse } from "../src/ingest/registry.js";
import { SCORING_DATE } from "../src/snapshot/build.js";

const db = await openDb();
await migrate(db);
const names = (await readUniverse()).map(m => m.name);
console.log(`fetching exact ${WINDOW} downloads for ${names.length} packages`);

const s = await ingestDownloads(db, names, (d, t) => {
  if (d % 512 === 0 || d === t) console.log(`  ${d}/${t}`);
});
console.log(`\n  batches ${s.batches} (failures ${s.batchFailures})`);
console.log(`  resolved ${s.resolved}  missing ${s.missing}   <- missing are rows, not gaps`);

const a = await applyDownloadsToSnapshot(db, SCORING_DATE);
console.log(`\n  snapshot rows with a download figure: ${a.updated}`);
console.log(`  still null: ${a.stillNull}`);

const d = await db.query<{band:string;n:string}>(
  `SELECT CASE WHEN downloads_prior_month IS NULL THEN 'null'
               WHEN downloads_prior_month >= 1000000 THEN '1M+'
               WHEN downloads_prior_month >= 100000 THEN '100K-1M'
               WHEN downloads_prior_month >= 10000 THEN '10K-100K'
               WHEN downloads_prior_month >= 1000 THEN '1K-10K'
               ELSE '<1K' END AS band, count(*) AS n
   FROM snapshot WHERE as_of_date=$1 GROUP BY 1 ORDER BY 1`, [SCORING_DATE]);
console.log(`\n  exact 2022-12 distribution:`);
for (const r of d.rows) console.log(`    ${r.band.padEnd(10)} ${r.n}`);
await db.close();
