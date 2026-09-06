/**
 * Reconstructs what was knowable about each package on the scoring date.
 *
 * This reads only from `observation`, never from the network, which is the point of
 * keeping raw fetches append-only: a bug in reconstruction is a recompute, not a
 * re-crawl. Run it as many times as the logic changes.
 *
 * Everything here is derived from the packument `time` map, which records the publish
 * timestamp of every version. That is what makes the whole point-in-time design possible
 * from data that still exists today (BLUEPRINT.md section 3).
 *
 * Two fields are deliberately absent because the registry does not retain them:
 * historical maintainer lists, and when a deprecation happened. Their absence is
 * reported rather than guessed at.
 */

import type { PGlite } from "@electric-sql/pglite";
import type { ReducedPackument } from "../ingest/registry.js";

export const SCORING_DATE = "2023-01-01";

export interface SnapshotRow {
  pkg_name: string;
  as_of_date: string;
  latest_version: string | null;
  latest_published_at: string | null;
  version_count: number;
  days_since_last_pub: number | null;
  releases_last_90d: number;
  releases_last_365d: number;
  first_published_at: string | null;
  has_provenance: boolean;
  has_install_hook: boolean;
  license: string | null;
  has_repo_url: boolean;
  reconstructed: boolean;
}

/** `time` also carries `created` and `modified`, which are not versions. */
function versionTimes(pk: ReducedPackument): Array<{ version: string; at: Date }> {
  const out: Array<{ version: string; at: Date }> = [];
  for (const [version, iso] of Object.entries(pk.time ?? {})) {
    if (version === "created" || version === "modified") continue;
    const at = new Date(iso);
    if (!Number.isNaN(at.getTime())) out.push({ version, at });
  }
  out.sort((a, b) => a.at.getTime() - b.at.getTime());
  return out;
}

export function buildSnapshot(
  name: string,
  pk: ReducedPackument | null,
  asOf: Date,
): SnapshotRow {
  const base: SnapshotRow = {
    pkg_name: name,
    as_of_date: SCORING_DATE,
    latest_version: null,
    latest_published_at: null,
    version_count: 0,
    days_since_last_pub: null,
    releases_last_90d: 0,
    releases_last_365d: 0,
    first_published_at: null,
    has_provenance: false,
    has_install_hook: false,
    license: null,
    has_repo_url: false,
    // False means we could not rebuild this package's state. It is a row either way,
    // so the count of unreconstructable packages is visible rather than implied.
    reconstructed: false,
  };

  if (!pk) return base;

  const times = versionTimes(pk).filter((t) => t.at < asOf);
  if (times.length === 0) return base;

  const latest = times[times.length - 1]!;
  const first = times[0]!;
  const day = 86_400_000;
  const meta = pk.versions?.[latest.version];

  return {
    ...base,
    latest_version: latest.version,
    latest_published_at: latest.at.toISOString(),
    version_count: times.length,
    days_since_last_pub: Math.floor((asOf.getTime() - latest.at.getTime()) / day),
    releases_last_90d: times.filter((t) => asOf.getTime() - t.at.getTime() <= 90 * day).length,
    releases_last_365d: times.filter((t) => asOf.getTime() - t.at.getTime() <= 365 * day).length,
    first_published_at: first.at.toISOString(),
    // Expected to be false for every package: npm provenance reached GA on 2023-09-26,
    // after the scoring date. Recorded so the claim is checkable rather than asserted.
    has_provenance: Boolean(meta?.att),
    has_install_hook: Boolean(meta?.hook),
    license: meta?.lic ?? null,
    has_repo_url: Boolean(meta?.repo),
    reconstructed: true,
  };
}

export interface BuildStats {
  total: number;
  reconstructed: number;
  noObservation: number;
  fetchFailed: number;
  noVersionsBeforeD: number;
  withProvenance: number;
  withInstallHook: number;
}

export async function buildAllSnapshots(db: PGlite): Promise<BuildStats> {
  const asOf = new Date(`${SCORING_DATE}T00:00:00Z`);

  // Latest observation per package, failures included so they become rows too.
  const obs = await db.query<{
    external_id: string;
    payload: ReducedPackument | null;
  }>(
    `SELECT DISTINCT ON (external_id) external_id, payload
     FROM observation
     WHERE source = 'npm_packument'
     ORDER BY external_id, fetched_at DESC`,
  );

  const stats: BuildStats = {
    total: 0,
    reconstructed: 0,
    noObservation: 0,
    fetchFailed: 0,
    noVersionsBeforeD: 0,
    withProvenance: 0,
    withInstallHook: 0,
  };

  await db.exec("BEGIN");
  try {
    await db.query(`DELETE FROM snapshot WHERE as_of_date = $1`, [SCORING_DATE]);

    for (const row of obs.rows) {
      stats.total++;
      const pk = row.payload;
      if (!pk) stats.fetchFailed++;

      const snap = buildSnapshot(row.external_id, pk, asOf);
      if (snap.reconstructed) {
        stats.reconstructed++;
        if (snap.has_provenance) stats.withProvenance++;
        if (snap.has_install_hook) stats.withInstallHook++;
      } else if (pk) {
        stats.noVersionsBeforeD++;
      }

      await db.query(
        `INSERT INTO snapshot (
           pkg_name, as_of_date, latest_version, latest_published_at, version_count,
           days_since_last_pub, releases_last_90d, releases_last_365d,
           first_published_at, has_provenance, has_install_hook, license,
           has_repo_url, reconstructed
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          snap.pkg_name, snap.as_of_date, snap.latest_version, snap.latest_published_at,
          snap.version_count, snap.days_since_last_pub, snap.releases_last_90d,
          snap.releases_last_365d, snap.first_published_at, snap.has_provenance,
          snap.has_install_hook, snap.license, snap.has_repo_url, snap.reconstructed,
        ],
      );
    }
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }

  return stats;
}
