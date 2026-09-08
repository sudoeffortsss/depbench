import { openDb } from "../src/db/migrate.js";
import { auc } from "../src/harness/metrics.js";

const db = await openDb();
const run = await db.query<{id:string}>(`SELECT id FROM run ORDER BY id DESC LIMIT 1`);
const runId = Number(run.rows[0]!.id);

const raw = await db.query<any>(
  `SELECT ps.policy, ps.score, (o.pkg_name IS NOT NULL) AS is_case
   FROM policy_score ps
   LEFT JOIN outcome o ON o.pkg_name=ps.pkg_name AND o.as_of_date=ps.as_of_date AND o.kind='advisory'
   WHERE ps.run_id=$1 AND ps.score IS NOT NULL AND ps.abstain=false AND ps.parse_status='ok'`,
  [runId]);

const byPolicy = new Map<string,{cases:number[];ctrls:number[]}>();
for (const r of raw.rows) {
  const e = byPolicy.get(r.policy) ?? {cases:[],ctrls:[]};
  (r.is_case ? e.cases : e.ctrls).push(Number(r.score));
  byPolicy.set(r.policy, e);
}

// 固定种子的 bootstrap,可复现
let seed = 20260906;
const rnd = () => { seed = (seed*1664525+1013904223)>>>0; return seed/2**32; };
const pick = <T,>(a:T[]) => a[Math.floor(rnd()*a.length)]!;

console.log(`policy        AUC     95% 置信区间      比抛硬币好吗   翻过来用会怎样`);
console.log(`${"-".repeat(78)}`);
const out: any[] = [];
for (const [p,{cases,ctrls}] of byPolicy) {
  const point = auc(cases, ctrls);
  const boots: number[] = [];
  for (let b=0;b<2000;b++){
    const c = Array.from({length:cases.length}, () => pick(cases));
    const k = Array.from({length:ctrls.length}, () => pick(ctrls));
    boots.push(auc(c,k));
  }
  boots.sort((a,b)=>a-b);
  const lo = boots[Math.floor(0.025*boots.length)]!;
  const hi = boots[Math.floor(0.975*boots.length)]!;
  const crosses = lo <= 0.5 && hi >= 0.5;
  out.push({p, point, lo, hi, crosses});
  console.log(
    `${p.padEnd(12)} ${point.toFixed(3)}   [${lo.toFixed(3)}, ${hi.toFixed(3)}]   ` +
    `${crosses ? "不能确定    " : (point>0.5?"是,略好    ":"不,反着的  ")}   ${(1-point).toFixed(3)}`);
}
console.log(`\n区间跨过 0.500 就意味着:跟抛硬币的差别,在这个样本量下分不出来。`);
await db.close();
