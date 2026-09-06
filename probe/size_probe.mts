import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { RateLimiter, fetchJson, LIMITS } from "../src/ingest/http.js";

const tsv = await readFile("universe/universe.tsv", "utf8");
const names = tsv.trim().split("\n").slice(1).map(l => l.split("\t")[0]!);
const step = Math.floor(names.length / 40);
const sample = Array.from({ length: 40 }, (_, i) => names[i * step]!).filter(Boolean);

const limiter = new RateLimiter(LIMITS.registryIntervalMs);
let full = 0, gz = 0, ok = 0, fail = 0, maxRaw = 0, maxName = "";
let redTotal = 0;

for (const n of sample) {
  const url = `https://registry.npmjs.org/${n.startsWith("@") ? n.replace("/", "%2f") : n}`;
  const r = await fetchJson<any>(url, limiter, { minIntervalMs: LIMITS.registryIntervalMs });
  if (!r.ok) { fail++; console.log(`  FAIL ${n}: ${r.error.slice(0, 60)}`); continue; }
  ok++;
  const bytes = Buffer.byteLength(r.raw);
  full += bytes; gz += gzipSync(Buffer.from(r.raw)).length;
  if (bytes > maxRaw) { maxRaw = bytes; maxName = n; }
  const v = r.body.versions ?? {};
  const red = {
    name: r.body.name, time: r.body.time, distTags: r.body["dist-tags"],
    versions: Object.fromEntries(Object.entries<any>(v).map(([ver, m]) => [ver, {
      dep: m.deprecated ? 1 : 0, lic: m.license,
      repo: typeof m.repository === "object" ? m.repository?.url : m.repository,
      hook: !!(m.scripts && (m.scripts.preinstall || m.scripts.install || m.scripts.postinstall)),
      att: !!m.dist?.attestations,
    }])),
  };
  redTotal += Buffer.byteLength(JSON.stringify(red));
}

const mb = (b: number) => (b / 1e6).toFixed(0);
console.log(`\n  sampled ${sample.length}, ok ${ok}, fail ${fail}`);
console.log(`  full    avg ${(full/ok/1024).toFixed(0)} KB  ->  1915 pkgs = ${mb(full/ok*1915)} MB`);
console.log(`  gzip    avg ${(gz/ok/1024).toFixed(0)} KB  ->             = ${mb(gz/ok*1915)} MB`);
console.log(`  reduced avg ${(redTotal/ok/1024).toFixed(0)} KB  ->             = ${mb(redTotal/ok*1915)} MB`);
console.log(`  largest: ${maxName} at ${(maxRaw/1e6).toFixed(1)} MB`);
