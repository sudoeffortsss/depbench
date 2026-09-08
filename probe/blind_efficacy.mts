/** How well does blinding actually work on the real corpus?
 *
 *  An adversarial review argued the blind arm is nominal because a README names its own
 *  package everywhere. This measures it rather than settling the argument by assertion:
 *  occurrences before, residual after, and how much of each document is left. */
import { openDb } from "../src/db/migrate.js";
import { buildContent } from "../src/policies/llm-input.js";
import { CONDITIONS } from "../src/policies/prompts.js";

const db = await openDb();
const r = await db.query<any>(
  `SELECT DISTINCT ON (external_id) external_id, payload FROM observation
    WHERE source='npm_tarball' AND payload IS NOT NULL
    ORDER BY external_id, fetched_at DESC`);
await db.close();

const blindSpec = CONDITIONS.find((c) => c.key === "practitioner-blind")!;
const namedSpec = CONDITIONS.find((c) => c.key === "practitioner-named")!;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let n = 0, leaked = 0, totalBefore = 0, shrink: number[] = [];
const worst: Array<{ pkg: string; before: number; residual: string[] }> = [];

for (const row of r.rows) {
  const t = row.payload;
  if (!t.readme && !t.package_json) continue;
  n++;
  const named = buildContent(t, namedSpec);
  const blinded = buildContent(t, blindSpec);
  const before = (named.content.match(new RegExp(esc(t.pkg_name), "gi")) ?? []).length;
  totalBefore += before;
  shrink.push(blinded.content.length / Math.max(1, named.content.length));
  if (blinded.residual.length > 0) {
    leaked++;
    worst.push({ pkg: t.pkg_name, before, residual: blinded.residual });
  }
}

const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
console.log(`语料 ${n} 个包(已拉到的部分)`);
console.log(`  遮蔽前包名平均出现 ${(totalBefore / n).toFixed(1)} 次`);
console.log(`  遮蔽后仍有可识别串的: ${leaked} 个 = ${(leaked / n * 100).toFixed(1)}%`);
console.log(`  文本长度保留中位数: ${(med(shrink) * 100).toFixed(0)}%`);
if (worst.length) {
  console.log(`\n  漏掉的例子(最多 8 个):`);
  for (const w of worst.slice(0, 8)) {
    console.log(`    ${w.pkg}  出现 ${w.before} 次,残留 ${JSON.stringify(w.residual)}`);
  }
}
