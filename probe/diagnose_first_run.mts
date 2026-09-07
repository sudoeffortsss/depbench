import { openDb } from "../src/db/migrate.js";
const db = await openDb();
const SD = "2023-01-01";

console.log("=== 1. 每个策略的分数分布(看有没有大规模并列)===");
for (const p of ["random","popularity","age","cadence","composite"]) {
  const r = await db.query<{n:string;distinct:string;min:number;max:number;p50:number;p90:number}>(
    `SELECT count(*) n, count(DISTINCT score) distinct,
            min(score) min, max(score) max,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY score) p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY score) p90
     FROM policy_score WHERE run_id=1 AND policy=$1 AND score IS NOT NULL`, [p]);
  const x = r.rows[0]!;
  console.log(`  ${p.padEnd(11)} n=${x.n}  distinct=${String(x.distinct).padStart(5)}  ` +
    `min=${Number(x.min).toFixed(3)} p50=${Number(x.p50).toFixed(3)} p90=${Number(x.p90).toFixed(3)} max=${Number(x.max).toFixed(3)}`);
  // 最大并列组
  const t = await db.query<{score:number;n:string}>(
    `SELECT score, count(*) n FROM policy_score WHERE run_id=1 AND policy=$1 AND score IS NOT NULL
     GROUP BY score ORDER BY count(*) DESC LIMIT 2`, [p]);
  const parts = t.rows.map(v => `${Number(v.score).toFixed(3)}×${v.n}`).join("  ");
  console.log(`  ${" ".repeat(11)} 最大并列: ${parts}`);
}

console.log("\n=== 2. cadence 矛盾:top decile 实际包含多少个包 ===");
const cad = await db.query<{score:number;n:string;cases:string}>(
  `SELECT ps.score, count(*) n, count(*) FILTER (WHERE o.pkg_name IS NOT NULL) cases
   FROM policy_score ps
   LEFT JOIN outcome o ON o.pkg_name=ps.pkg_name AND o.as_of_date=ps.as_of_date AND o.kind='advisory'
   WHERE ps.run_id=1 AND ps.policy='cadence' AND ps.score IS NOT NULL
   GROUP BY ps.score ORDER BY ps.score DESC LIMIT 6`);
console.log("  分数由高到低:");
for (const r of cad.rows) console.log(`    score=${Number(r.score).toFixed(3)}  包数=${String(r.n).padStart(4)}  其中案例=${r.cases}`);

console.log("\n=== 3. 方向核对:案例组 vs 对照组的原始特征均值 ===");
const f = await db.query<any>(
  `SELECT (o.pkg_name IS NOT NULL) AS is_case, count(*) n,
          round(avg(s.days_since_last_pub)) days_stale,
          round(avg(s.releases_last_90d)::numeric,2) rel90,
          round(avg(s.releases_last_365d)::numeric,2) rel365,
          round(avg(s.downloads_prior_month)) dl,
          round(100.0*avg(CASE WHEN s.has_repo_url THEN 1 ELSE 0 END)) repo_pct
   FROM snapshot s
   LEFT JOIN outcome o ON o.pkg_name=s.pkg_name AND o.as_of_date=s.as_of_date AND o.kind='advisory'
   WHERE s.as_of_date=$1 AND s.reconstructed GROUP BY 1 ORDER BY 1`, [SD]);
console.log("  is_case  n     停更天数  近90天发布  近365天发布   月下载        有repo%");
for (const r of f.rows) console.log(
  `  ${String(r.is_case).padEnd(7)} ${String(r.n).padStart(4)}  ${String(r.days_stale).padStart(7)}  ` +
  `${String(r.rel90).padStart(9)}  ${String(r.rel365).padStart(10)}  ${String(r.dl).padStart(11)}  ${String(r.repo_pct).padStart(6)}`);
await db.close();
