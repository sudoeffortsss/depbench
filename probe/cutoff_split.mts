/** Cases either side of each model arm's published training cutoff.
 *  Keyed on the earliest in-window advisory per package, which is the date a model
 *  could first have read about it. Feeds ModelArm.caseSplit in src/policies/llm.ts. */
import { openDb } from "../src/db/migrate.js";
const db = await openDb();
const r = await db.query<any>(
  `SELECT pkg_name, occurred_at FROM outcome
   WHERE kind='advisory' AND as_of_date='2023-01-01' AND occurred_at IS NOT NULL`);
const dates = r.rows.map((x: any) => new Date(x.occurred_at).toISOString().slice(0, 10));
console.log(`cases with a dated advisory: ${dates.length}`);
const CUTS: Array<[string, string]> = [
  ["2025-01-01", "gemini-2.5-flash-lite  (published, unhedged)"],
  ["2025-02-01", "claude-haiku-4-5       (\"reliable knowledge cutoff\")"],
  ["2025-07-01", "claude-haiku-4-5       (\"training data cutoff\")"],
  ["2026-01-01", "claude-sonnet-5        (both rows agree)"],
  ["2026-03-01", "gemini-3.x             (hedged, not usable)"],
];
console.log(`\n${"cutoff".padEnd(12)} ${"pre".padStart(4)} ${"post".padStart(5)}   arm`);
for (const [cut, label] of CUTS) {
  const pre = dates.filter((d) => d < cut).length;
  console.log(`${cut.padEnd(12)} ${String(pre).padStart(4)} ` +
              `${String(dates.length - pre).padStart(5)}   ${label}`);
}
await db.close();
