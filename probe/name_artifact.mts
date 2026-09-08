/** How much discrimination does the package name's leading "@" alone provide?
 *  Measured on the old universe (backed up) and the new one, so the scope-matching
 *  decision in src/universe/freeze.ts rests on a number rather than an impression. */
import { readFile } from "node:fs/promises";
import { auc } from "../src/harness/metrics.js";

async function score(path: string, label: string) {
  const tsv = await readFile(path, "utf8");
  const rows = tsv.trim().split("\n").slice(1).map((l) => l.split("\t"));
  // "unscoped means riskier": 1 for a plain name, 0 for @org/name.
  const s = (n: string) => (n.startsWith("@") ? 0 : 1);
  const cases = rows.filter((r) => r[1] === "case").map((r) => s(r[0]!));
  const ctrls = rows.filter((r) => r[1] === "control").map((r) => s(r[0]!));
  const scCase = cases.filter((x) => x === 0).length / cases.length;
  const scCtrl = ctrls.filter((x) => x === 0).length / ctrls.length;
  console.log(
    `${label.padEnd(10)} cases ${String(cases.length).padStart(4)} (scoped ${(scCase*100).toFixed(1)}%)  ` +
    `controls ${String(ctrls.length).padStart(4)} (scoped ${(scCtrl*100).toFixed(1)}%)  ` +
    `AUC of "no @ prefix" = ${auc(cases, ctrls).toFixed(3)}`);
}
await score("_backup/20260907-000401/universe.tsv", "修复前");
await score("universe/universe.tsv", "修复后");
console.log(`\n参照:修复后最好的真实策略 popularity = 0.529`);
