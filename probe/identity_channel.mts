/** Is the forecast signal in the text, or in the model recognising the package?
 *
 *  forecast-blind scoring only 0.033 below forecast-named looks like the text carries it,
 *  but the blind condition is nominal: the model still names the package 57.8% of the
 *  time. So the near-equality could equally mean blinding failed. Splitting the blinded
 *  results by whether the model actually re-identified THAT package separates the two. */
import { openDb } from "../src/db/migrate.js";
import { readUniverse } from "../src/ingest/registry.js";
import { auc, aucInterval } from "../src/harness/metrics.js";

const db = await openDb();
const names = (await readUniverse()).map((m) => m.name);

const rid = await db.query<any>(
  `SELECT pkg_name, raw_output FROM policy_score
    WHERE run_id=5 AND policy='llm-flash-lite:reidentify' AND parse_status='ok'
      AND pkg_name = ANY($1::text[])`, [names]);
const identified = new Set<string>();
for (const r of rid.rows) {
  try {
    const o = JSON.parse(r.raw_output);
    if (o.identified && String(o.package ?? "").trim().toLowerCase() === r.pkg_name.toLowerCase())
      identified.add(r.pkg_name);
  } catch { /* counted as not identified */ }
}
console.log(`模型认出了 ${identified.size} 个包(共 ${rid.rows.length} 个有效回答)\n`);

for (const pol of ["llm-flash-lite:forecast-blind", "llm-flash-lite:forecast-named"]) {
  const r = await db.query<any>(
    `SELECT ps.pkg_name, ps.score, (o.pkg_name IS NOT NULL) is_case
       FROM policy_score ps
       LEFT JOIN outcome o ON o.pkg_name=ps.pkg_name AND o.as_of_date=ps.as_of_date AND o.kind='advisory'
      WHERE ps.run_id=5 AND ps.policy=$1 AND ps.score IS NOT NULL
        AND NOT ps.abstain AND ps.parse_status='ok' AND ps.pkg_name = ANY($2::text[])`,
    [pol, names]);
  console.log(`=== ${pol} ===`);
  for (const [label, keep] of [
    ["模型认出来的包", (n: string) => identified.has(n)],
    ["模型没认出来的包", (n: string) => !identified.has(n)],
  ] as [string, (n: string) => boolean][]) {
    const g = r.rows.filter((x: any) => keep(x.pkg_name));
    const c = g.filter((x: any) => x.is_case).map((x: any) => Number(x.score));
    const k = g.filter((x: any) => !x.is_case).map((x: any) => Number(x.score));
    if (c.length < 30 || k.length < 30) { console.log(`  ${label}: 样本不足`); continue; }
    const a = auc(c, k), ci = aucInterval(c, k);
    console.log(`  ${label.padEnd(18)} AUC ${a.toFixed(3)}  [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]  ` +
                `n=${g.length}(出事 ${c.length})`);
  }
  console.log();
}
await db.close();
