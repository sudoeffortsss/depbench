/**
 * Fetches a packument for every universe member and records it.
 *
 * Storage is split, and the split was measured rather than guessed. A 40-package sample
 * spread across the universe gave:
 *
 *     full packument   avg 737 KB   ->  1,915 packages = 1,446 MB
 *     gzipped          avg 116 KB   ->                 =   227 MB
 *     reduced record   avg  35 KB   ->                 =    69 MB
 *     largest single: @playwright/test at 9.5 MB
 *
 * 1.4 GB of JSONB inside an in-process WASM Postgres would make every later query
 * miserable, so:
 *
 *   - the **reduced** record goes in `observation.payload`: the `time` map, dist-tags,
 *     and the handful of per-version fields any policy could use
 *   - the **complete** packument is gzipped to a content-addressed file under `raw/`
 *
 * Both are kept. The promise that a change in derivation logic is a recompute rather
 * than a re-crawl still holds, and the database stays small enough to be pleasant.
 *
 * Idempotency is the UNIQUE constraint on (source, external_id, content_hash). A second
 * run over unchanged upstream data inserts zero rows. The constraint is the guarantee;
 * there is no check beside it that could be forgotten.
 *
 * A failed fetch is written as a row with a null payload. That is what makes
 * `no_answer` computable instead of invisible, which is harness rule 1.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { PGlite } from "@electric-sql/pglite";
import { LIMITS, RateLimiter, fetchJson } from "./http.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAW_DIR = join(ROOT, "raw", "packument");

export const SOURCE = "npm_packument";

/** Only the fields a policy could legitimately use. Everything else is in the raw file. */
export interface ReducedVersion {
  dep: 0 | 1;
  lic?: string;
  repo?: string;
  hook: boolean;
  att: boolean;
}

export interface ReducedPackument {
  name: string;
  time: Record<string, string>;
  distTags: Record<string, string>;
  versions: Record<string, ReducedVersion>;
  maintainerCount: number;
}

export function reduce(body: any): ReducedPackument {
  const versions = body.versions ?? {};
  const out: Record<string, ReducedVersion> = {};
  for (const [ver, m] of Object.entries<any>(versions)) {
    const repo = typeof m?.repository === "object" ? m.repository?.url : m?.repository;
    out[ver] = {
      dep: m?.deprecated ? 1 : 0,
      lic: typeof m?.license === "string" ? m.license : undefined,
      repo: typeof repo === "string" ? repo : undefined,
      hook: Boolean(
        m?.scripts && (m.scripts.preinstall || m.scripts.install || m.scripts.postinstall),
      ),
      att: Boolean(m?.dist?.attestations),
    };
  }
  return {
    name: String(body.name ?? ""),
    time: (body.time ?? {}) as Record<string, string>,
    distTags: (body["dist-tags"] ?? {}) as Record<string, string>,
    versions: out,
    // Current value only. The registry keeps no history, which is why maintainer
    // change is untestable retrospectively (BLUEPRINT.md section 3).
    maintainerCount: Array.isArray(body.maintainers) ? body.maintainers.length : 0,
  };
}

/** Scoped names need the slash percent-encoded; unscoped names must be left alone. */
export function packumentUrl(name: string): string {
  return `https://registry.npmjs.org/${name.startsWith("@") ? name.replace("/", "%2f") : name}`;
}

async function storeRaw(hash: string, raw: string): Promise<string> {
  const dir = join(RAW_DIR, hash.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${hash}.json.gz`);
  await writeFile(path, gzipSync(Buffer.from(raw, "utf8")));
  return path;
}

export interface IngestStats {
  attempted: number;
  ok: number;
  failed: number;
  inserted: number;
  unchanged: number;
  rawBytes: number;
}

export async function ingestPackuments(
  db: PGlite,
  names: string[],
  onProgress?: (done: number, total: number, stats: IngestStats) => void,
): Promise<IngestStats> {
  const limiter = new RateLimiter(LIMITS.registryIntervalMs);
  const stats: IngestStats = {
    attempted: 0,
    ok: 0,
    failed: 0,
    inserted: 0,
    unchanged: 0,
    rawBytes: 0,
  };

  for (const name of names) {
    stats.attempted++;
    const res = await fetchJson<any>(packumentUrl(name), limiter, {
      minIntervalMs: LIMITS.registryIntervalMs,
    });

    if (!res.ok) {
      stats.failed++;
      // A failure is a row. It carries a hash of its own error text so that a
      // repeated identical failure stays idempotent rather than piling up.
      const hash = createHash("sha256")
        .update(`ERR:${res.status ?? "null"}:${res.error}`)
        .digest("hex");
      const r = await db.query(
        `INSERT INTO observation (source, external_id, content_hash, http_status, payload, error)
         VALUES ($1, $2, $3, $4, NULL, $5)
         ON CONFLICT ON CONSTRAINT observation_idempotent DO NOTHING`,
        [SOURCE, name, hash, res.status, res.error],
      );
      if (r.affectedRows) stats.inserted++;
      else stats.unchanged++;
      onProgress?.(stats.attempted, names.length, stats);
      continue;
    }

    stats.ok++;
    const hash = createHash("sha256").update(res.raw).digest("hex");

    // Skip the disk write and the JSON reduction when we have seen this exact bytes
    // before. The constraint would reject the insert anyway; this just avoids the work.
    const seen = await db.query<{ n: number }>(
      `SELECT 1 AS n FROM observation
       WHERE source = $1 AND external_id = $2 AND content_hash = $3 LIMIT 1`,
      [SOURCE, name, hash],
    );
    if (seen.rows.length > 0) {
      stats.unchanged++;
      onProgress?.(stats.attempted, names.length, stats);
      continue;
    }

    await storeRaw(hash, res.raw);
    stats.rawBytes += Buffer.byteLength(res.raw);

    const r = await db.query(
      `INSERT INTO observation (source, external_id, content_hash, http_status, payload, error)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT ON CONSTRAINT observation_idempotent DO NOTHING`,
      [SOURCE, name, hash, res.status, JSON.stringify(reduce(res.body))],
    );
    if (r.affectedRows) stats.inserted++;
    else stats.unchanged++;

    onProgress?.(stats.attempted, names.length, stats);
  }

  return stats;
}

export async function readUniverse(): Promise<Array<{ name: string; role: string; band: string }>> {
  const tsv = await readFile(join(ROOT, "universe", "universe.tsv"), "utf8");
  return tsv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [name, role, band] = line.split("\t");
      return { name: name!, role: role!, band: band! };
    });
}
