import { openDb } from "../src/db/migrate.js";
const db = await openDb();
const r = await db.query<any>(
 `SELECT ps.policy, ps.score, s.releases_last_90d,
         (o.pkg_name IS NOT NULL) AS is_case
  FROM policy_score ps
  JOIN snapshot s ON s.pkg_name=ps.pkg_name AND s.as_of_date=ps.as_of_date
  LEFT JOIN outcome o ON o.pkg_name=ps.pkg_name AND o.as_of_date=ps.as_of_date AND o.kind='advisory'
  WHERE ps.run_id=2 AND ps.score IS NOT NULL AND ps.abstain=false AND ps.parse_status='ok'`);

const by = new Map<string, any[]>();
for (const x of r.rows) { const a = by.get(x.policy) ?? []; a.push(x); by.set(x.policy, a); }

console.log("危险前 10% 里到底是些什么包(按比例分摊并列):\n");
console.log("policy        前10%人数   出事的   活跃控制组   已停更控制组");
console.log("-".repeat(70));
for (const [p, rows] of by) {
  const want = Math.round(rows.length * 0.1);
  const ord = [...rows].sort((a,b)=>Number(b.score)-Number(a.score));
  let taken=0, cs=0, act=0, dead=0, i=0;
  while (i<ord.length && taken<want) {
    let e=i; while (e+1<ord.length && Number(ord[e+1].score)===Number(ord[i].score)) e++;
    const blk = ord.slice(i,e+1);
    const sh = Math.min(1,(want-taken)/blk.length);
    cs   += blk.filter(x=>x.is_case).length*sh;
    act  += blk.filter(x=>!x.is_case && x.releases_last_90d>0).length*sh;
    dead += blk.filter(x=>!x.is_case && x.releases_last_90d===0).length*sh;
    taken += blk.length*sh; i=e+1;
  }
  console.log(`${p.padEnd(12)} ${taken.toFixed(0).padStart(7)} ${cs.toFixed(0).padStart(9)} ` +
              `${act.toFixed(0).padStart(11)} ${dead.toFixed(0).padStart(13)}`);
}
const all = [...by.values()][0]!;
console.log(`\n对照:全样本 ${all.length} 个包里,活跃控制组 ` +
  `${all.filter((x:any)=>!x.is_case && x.releases_last_90d>0).length} 个,` +
  `已停更控制组 ${all.filter((x:any)=>!x.is_case && x.releases_last_90d===0).length} 个。`);
await db.close();
