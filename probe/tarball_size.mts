/** Measure what the LLM arm would actually be fed, instead of guessing 5000 tokens. */
import { openDb } from "../src/db/migrate.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const sh = promisify(execFile);

const db = await openDb();
// The version that was live on the scoring date, straight from reconstructed history.
const rows = await db.query<any>(
  `SELECT s.pkg_name, s.latest_version, (o.pkg_name IS NOT NULL) AS is_case
   FROM snapshot s
   LEFT JOIN outcome o ON o.pkg_name=s.pkg_name AND o.as_of_date=s.as_of_date AND o.kind='advisory'
   WHERE s.as_of_date='2023-01-01' AND s.latest_version IS NOT NULL
   ORDER BY md5(s.pkg_name) LIMIT 20`);
await db.close();

let okCount = 0, readmeChars = 0, pkgJsonChars = 0, tarBytes = 0;
const fails: string[] = [];
for (const r of rows.rows) {
  const n = r.pkg_name as string;
  const v = r.latest_version as string;
  const base = n.startsWith("@") ? n.split("/")[1] : n;
  const url = `https://registry.npmjs.org/${n}/-/${base}-${v}.tgz`;
  try {
    const { stdout: list } = await sh("bash", ["-c",
      `curl -sfL --max-time 45 '${url}' -o /tmp/tl.tgz && tar -tzf /tmp/tl.tgz`]);
    const files = list.split("\n");
    const rd = files.find((f) => /\/readme(\.|$)/i.test(f));
    const pj = files.find((f) => /^package\/package\.json$/.test(f));
    const grab = async (f?: string) =>
      f ? (await sh("bash", ["-c", `tar -xzOf /tmp/tl.tgz '${f}' | wc -c`])).stdout.trim() : "0";
    const rc = Number(await grab(rd)), pc = Number(await grab(pj));
    const { stdout: sz } = await sh("bash", ["-c", `wc -c < /tmp/tl.tgz`]);
    okCount++; readmeChars += rc; pkgJsonChars += pc; tarBytes += Number(sz.trim());
    console.log(`  ok  ${n}@${v}  readme=${rc}  pkg.json=${pc}  tgz=${Number(sz.trim())}`);
  } catch {
    fails.push(`${n}@${v}`);
    console.log(`  FAIL ${n}@${v}`);
  }
}
console.log(`\n成功 ${okCount}/${rows.rows.length}, 失败: ${fails.join(", ") || "无"}`);
if (okCount) {
  const avgChars = (readmeChars + pkgJsonChars) / okCount;
  console.log(`平均 README ${Math.round(readmeChars/okCount)} 字符, package.json ${Math.round(pkgJsonChars/okCount)} 字符`);
  console.log(`平均喂给模型 ${Math.round(avgChars)} 字符 ≈ ${Math.round(avgChars/4)} token (按 4 字符/token)`);
  console.log(`平均 tarball ${Math.round(tarBytes/okCount/1024)} KB -> 1906 个包约 ${Math.round(tarBytes/okCount*1906/1024/1024)} MB 下载量`);
}
