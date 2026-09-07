/**
 * Fetches exact 2022-12 download volume for every universe member.
 *
 * The universe was *selected* using the ecosyste.ms snapshot of 2022-11-09, which is
 * seven weeks before the scoring date (F7). That is fine for selection — it is
 * deliberately pre-D data — but the `popularity` baseline should score on the real
 * figure for the month immediately before D, not on a seven-week-old proxy.
 *
 * So: selection used the snapshot, scoring uses this. Both are pre-D. Neither can see
 * the outcome period.
 *
 * The batch limit of 128 and the sub-3-req/s pacing are measured, not guessed (F1).
 * A package the API has no figure for is recorded with a null payload rather than a
 * zero, because F5 caught npm's own API returning 0 for dates outside its retention
 * window — a missing value dressed as a real one is the exact failure this benchmark
 * exists to measure.
 */

import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { LIMITS, RateLimiter, fetchJson } from "./http.js";

export const SOURCE = "npm_downloads";
export const WINDOW = "2022-12-01:2022-12-31";

/** The point endpoint returns `{ [pkg]: { downloads, package } | null }` for a batch. */
type PointResponse = Record<string, { downloads?: number; package?: string } | null>;

export interface DownloadStats {
  requested: number;
  resolved: number;
  missing: number;
  batches: number;
  batchFailures: number;
}

function encodeName(name: string): string {
  return encodeURIComponent(name);
}

export async function ingestDownloads(
  db: PGlite,
  names: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<DownloadStats> {
  const limiter = new RateLimiter(LIMITS.downloadsIntervalMs);
  const stats: DownloadStats = {
    requested: names.length,
    resolved: 0,
    missing: 0,
    batches: 0,
    batchFailures: 0,
  };

  // Undocumented API limit, found by having 7 of 15 batches fail outright:
  //
  //     {"error":"scoped packages are not currently supported in bulk lookups"}
  //
  // A single scoped name poisons the entire batch of 128, so `@babel/core` took 127
  // innocent packages down with it. Scoped names are therefore fetched one at a time,
  // which works fine on the same endpoint. Splitting the input is not a workaround for
  // a bug of ours; it is the API's actual contract, discovered the hard way.
  const scoped = names.filter((n) => n.startsWith("@"));
  const plain = names.filter((n) => !n.startsWith("@"));
  const groups: string[][] = [];
  for (let i = 0; i < plain.length; i += LIMITS.downloadsMaxBatch) {
    groups.push(plain.slice(i, i + LIMITS.downloadsMaxBatch));
  }
  for (const s of scoped) groups.push([s]);

  let done = 0;
  for (const chunk of groups) {
    stats.batches++;

    const url =
      `https://api.npmjs.org/downloads/point/${WINDOW}/` +
      chunk.map(encodeName).join(",");
    const res = await fetchJson<PointResponse>(url, limiter, {
      minIntervalMs: LIMITS.downloadsIntervalMs,
    });

    if (!res.ok) {
      stats.batchFailures++;
      // The whole batch failed. Every package in it becomes a failure row, so none of
      // them silently disappears from the denominator.
      for (const name of chunk) {
        stats.missing++;
        const hash = createHash("sha256")
          .update(`ERR:${WINDOW}:${res.status ?? "null"}:${res.error}`)
          .digest("hex");
        await db.query(
          `INSERT INTO observation (source, external_id, content_hash, http_status, payload, error)
           VALUES ($1, $2, $3, $4, NULL, $5)
           ON CONFLICT ON CONSTRAINT observation_idempotent DO NOTHING`,
          [SOURCE, name, hash, res.status, res.error],
        );
      }
      done += chunk.length;
      onProgress?.(done, names.length);
      continue;
    }

    for (const name of chunk) {
      // The endpoint returns two different shapes and does not say so. A bulk query
      // gives a dictionary keyed by package name; a single-package query gives the
      // record flat, with no key at all. Reading body[name] against a single response
      // silently yields undefined, which is how 840 packages came back "missing" from
      // 849 batches that had only 11 real failures. The count not adding up is what
      // exposed it.
      const entry =
        chunk.length === 1 && typeof (res.body as any).downloads === "number"
          ? (res.body as unknown as { downloads: number })
          : res.body[name];
      const downloads = entry?.downloads;

      if (typeof downloads !== "number") {
        stats.missing++;
        const hash = createHash("sha256").update(`MISSING:${WINDOW}:${name}`).digest("hex");
        await db.query(
          `INSERT INTO observation (source, external_id, content_hash, http_status, payload, error)
           VALUES ($1, $2, $3, $4, NULL, $5)
           ON CONFLICT ON CONSTRAINT observation_idempotent DO NOTHING`,
          [SOURCE, name, hash, res.status, `no download figure for ${WINDOW}`],
        );
        continue;
      }

      stats.resolved++;
      const payload = { window: WINDOW, downloads };
      const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      await db.query(
        `INSERT INTO observation (source, external_id, content_hash, http_status, payload, error)
         VALUES ($1, $2, $3, $4, $5, NULL)
         ON CONFLICT ON CONSTRAINT observation_idempotent DO NOTHING`,
        [SOURCE, name, hash, res.status, JSON.stringify(payload)],
      );
    }

    done += chunk.length;
    onProgress?.(done, names.length);
  }

  return stats;
}

/** Copies resolved figures onto the snapshot rows the policies read from. */
export async function applyDownloadsToSnapshot(
  db: PGlite,
  asOfDate: string,
): Promise<{ updated: number; stillNull: number }> {
  await db.query(
    `UPDATE snapshot s
        SET downloads_prior_month = (o.payload ->> 'downloads')::bigint
       FROM (
         SELECT DISTINCT ON (external_id) external_id, payload
           FROM observation
          WHERE source = $1 AND payload IS NOT NULL
          ORDER BY external_id, fetched_at DESC
       ) o
      WHERE s.pkg_name = o.external_id AND s.as_of_date = $2`,
    [SOURCE, asOfDate],
  );

  const counts = await db.query<{ updated: string; still_null: string }>(
    `SELECT count(*) FILTER (WHERE downloads_prior_month IS NOT NULL) AS updated,
            count(*) FILTER (WHERE downloads_prior_month IS NULL)     AS still_null
       FROM snapshot WHERE as_of_date = $1`,
    [asOfDate],
  );
  return {
    updated: Number(counts.rows[0]!.updated),
    stillNull: Number(counts.rows[0]!.still_null),
  };
}
