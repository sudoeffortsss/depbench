/**
 * Point-in-time README and package.json, taken from the published tarball.
 *
 * The model arms need what a human would have read about a package on the scoring date.
 * Nothing else in the pipeline has it:
 *
 *   - A packument's `readme` field holds at most the *current* release's text, which is
 *     three and a half years of edits away from what we want, and for many packages it
 *     is empty regardless (minimist's is zero bytes, checked).
 *   - unpkg and jsDelivr serve by version but guess at the filename, and README casing
 *     and extension vary (`readme.markdown`, `README.md`, `Readme.rst`).
 *
 * The tarball for the version that was live on D is exact by construction: it is the
 * artifact that existed. Feeding a 2026 README to a model scoring 2023 would be
 * straightforward leakage, and the kind that is invisible in the output.
 *
 * Tar is parsed here rather than shelled out to, because 3,215 packages times two
 * subprocesses is slower than 200 lines of header arithmetic, and because a spawn
 * failure is harder to distinguish from an empty file than a parse failure is.
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { PGlite } from "@electric-sql/pglite";
import { LIMITS, RateLimiter, fetchBytes } from "./http.js";

export const SOURCE = "npm_tarball";

/** Caps applied before a model ever sees the text. Long tails are not informative and
 *  one 162 KB README in a sample of twenty doubles the mean. */
export const README_CHAR_CAP = 8000;
export const PACKAGE_JSON_CHAR_CAP = 3000;

export interface TarballText {
  pkg_name: string;
  version: string;
  readme: string | null;
  readme_path: string | null;
  package_json: string | null;
  tarball_bytes: number;
}

export interface TarballStats {
  requested: number;
  fetched: number;
  failed: number;
  withReadme: number;
  withoutReadme: number;
  inserted: number;
  unchanged: number;
  bytes: number;
}

/** `@scope/name` publishes to `/@scope/name/-/name-<version>.tgz`. */
export function tarballUrl(name: string, version: string): string {
  const base = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

interface TarEntry {
  path: string;
  data: Uint8Array;
}

/**
 * Minimal ustar reader: enough for npm tarballs, and explicit about what it ignores.
 *
 * Returns entries rather than a map because npm packages are not required to put files
 * under `package/`, and a caller that matches on the suffix is more robust than one that
 * assumes the prefix.
 */
export function readTar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  const dec = new TextDecoder();
  let off = 0;
  let longName: string | null = null;

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // Two consecutive zero blocks end the archive; one is enough to stop reading.
    if (header.every((b) => b === 0)) break;

    const str = (start: number, len: number): string => {
      const raw = header.subarray(start, start + len);
      const nul = raw.indexOf(0);
      return dec.decode(nul === -1 ? raw : raw.subarray(0, nul)).trim();
    };

    const name = str(0, 100);
    const sizeOctal = str(124, 12);
    const size = parseInt(sizeOctal, 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = str(345, 155);

    if (!Number.isFinite(size) || size < 0) break;

    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);

    // GNU long name: the next entry's path is this entry's contents.
    if (typeflag === "L") {
      longName = dec.decode(data).replace(/\0+$/, "");
    } else if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      const path = longName ?? (prefix ? `${prefix}/${name}` : name);
      longName = null;
      out.push({ path, data });
    } else {
      // Directories, symlinks, pax headers: not needed, and skipping them silently is
      // correct rather than lossy.
      longName = typeflag === "L" ? longName : null;
    }

    off = dataEnd + ((512 - (size % 512)) % 512);
  }
  return out;
}

/** README under any of the spellings npm packages actually use, at the archive root. */
function findReadme(entries: TarEntry[]): TarEntry | undefined {
  const candidates = entries.filter((e) => {
    const parts = e.path.split("/");
    // Root of the package directory only: a README inside `test/fixtures/` is not the
    // package's own.
    if (parts.length > 2) return false;
    return /^readme(\.[a-z0-9]+)?$/i.test(parts[parts.length - 1] ?? "");
  });
  // A single extension only, which is what excludes translations: `README.zh.md` and
  // `README.ja.md` do not match, so a package shipping a longer Chinese README still
  // yields its English one. Among genuine candidates (`README` beside `README.md`) the
  // larger is the real document.
  return candidates.sort((a, b) => b.data.length - a.data.length)[0];
}

function findPackageJson(entries: TarEntry[]): TarEntry | undefined {
  return entries.find((e) => {
    const parts = e.path.split("/");
    return parts.length <= 2 && parts[parts.length - 1] === "package.json";
  });
}

/**
 * Truncates to a character budget without producing text Postgres will refuse.
 *
 * `String.prototype.slice` cuts by UTF-16 code unit, so capping a README at 8,000
 * characters can land between the two halves of an emoji and leave a lone surrogate.
 * That is not merely odd text: `jsonb` rejects it, and the ingest died 1,595 packages in
 * on expo-splash-screen, whose README carries an emoji at exactly the cap.
 *
 * NUL is stripped for the same reason. Postgres `text` cannot hold `\u0000` at all, and
 * a package is free to ship one.
 */
export function safeTruncate(s: string, cap: number): string {
  let out = s.length > cap ? s.slice(0, cap) : s;
  // A high surrogate at the end has lost its pair to the cut.
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  // Anything else unpaired, plus NUL. Both are rejected by the database, and both are
  // the package's content rather than our error, so they are dropped rather than thrown.
  return out
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, "")
    .replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, "$1")
    .replace(/\u0000/g, "");
}

export function extractText(buf: Uint8Array, pkg: string, version: string): TarballText {
  const entries = readTar(gunzipSync(buf));
  const dec = new TextDecoder("utf-8", { fatal: false });
  const readme = findReadme(entries);
  const pj = findPackageJson(entries);
  return {
    pkg_name: pkg,
    version,
    readme: readme ? safeTruncate(dec.decode(readme.data), README_CHAR_CAP) : null,
    readme_path: readme?.path ?? null,
    package_json: pj ? safeTruncate(dec.decode(pj.data), PACKAGE_JSON_CHAR_CAP) : null,
    tarball_bytes: buf.length,
  };
}

export async function ingestTarballs(
  db: PGlite,
  targets: Array<{ name: string; version: string }>,
  onProgress?: (done: number, total: number, s: TarballStats) => void,
): Promise<TarballStats> {
  const limiter = new RateLimiter(LIMITS.registryIntervalMs);
  const stats: TarballStats = {
    requested: targets.length, fetched: 0, failed: 0,
    withReadme: 0, withoutReadme: 0, inserted: 0, unchanged: 0, bytes: 0,
  };

  for (let i = 0; i < targets.length; i++) {
    const { name, version } = targets[i]!;
    const res = await fetchBytes(tarballUrl(name, version), limiter, {
      minIntervalMs: LIMITS.registryIntervalMs,
    });

    let payload: TarballText | null = null;
    let error: string | null = null;
    let status: number | null = res.status;

    if (!res.ok) {
      error = res.error;
      stats.failed++;
    } else {
      try {
        payload = extractText(res.body, name, version);
        stats.fetched++;
        stats.bytes += res.body.length;
        if (payload.readme) stats.withReadme++;
        else stats.withoutReadme++;
      } catch (e) {
        // A tarball that will not decompress or parse is a failure with a reason, not a
        // package with no text.
        error = `extract failed: ${String(e).slice(0, 160)}`;
        stats.failed++;
      }
    }

    const canonical = JSON.stringify(payload ?? { error });
    const hash = createHash("sha256").update(canonical).digest("hex");
    const before = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM observation
        WHERE source = $1 AND external_id = $2 AND content_hash = $3`,
      [SOURCE, name, hash],
    );
    if (Number(before.rows[0]!.n) > 0) {
      stats.unchanged++;
    } else {
      await db.query(
        `INSERT INTO observation (source, external_id, content_hash, http_status, payload, error)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [SOURCE, name, hash, status, payload ? JSON.stringify(payload) : null, error],
      );
      stats.inserted++;
    }

    onProgress?.(i + 1, targets.length, stats);
  }

  return stats;
}
