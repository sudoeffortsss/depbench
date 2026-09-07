import { openDb } from "../src/db/migrate.js";
const db = await openDb();
const e = await db.query<{ error: string; http_status: number|null; n: string }>(
  `SELECT error, http_status, count(*) AS n FROM observation
   WHERE source='npm_downloads' AND payload IS NULL
   GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 6`);
console.log("failure reasons:");
for (const r of e.rows) console.log(`  ${r.n.padStart(4)}  status=${r.http_status}  ${String(r.error).slice(0,110)}`);
await db.close();
