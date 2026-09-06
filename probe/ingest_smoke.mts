import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/db/migrate.js";
import { ingestPackuments } from "../src/ingest/registry.js";

const db = new PGlite();                    // in-memory
await migrate(db);

// a scoped name, an unscoped name, and one that certainly does not exist
const names = ["chalk", "@playwright/test", "this-package-does-not-exist-truthlag-xyz"];

console.log("first pass");
const a = await ingestPackuments(db, names);
console.log(`  ok ${a.ok} failed ${a.failed} inserted ${a.inserted} unchanged ${a.unchanged}`);

console.log("second pass over identical data");
const b = await ingestPackuments(db, names);
console.log(`  ok ${b.ok} failed ${b.failed} inserted ${b.inserted} unchanged ${b.unchanged}`);

const rows = await db.query<{ external_id: string; http_status: number | null; has: boolean }>(
  `SELECT external_id, http_status, (payload IS NOT NULL) AS has FROM observation ORDER BY external_id`);
console.log("\nrows:");
for (const r of rows.rows) console.log(`  ${r.external_id.padEnd(42)} status=${r.http_status} payload=${r.has}`);

const t = await db.query<{ n: string }>(`SELECT count(*) AS n FROM observation`);
console.log(`\ntotal rows: ${t.rows[0]!.n}  (expect 3: two ok, one failure)`);
console.log(b.inserted === 0 ? "IDEMPOTENT_OK: second pass inserted 0" : `IDEMPOTENT_FAIL: ${b.inserted}`);
await db.close();
