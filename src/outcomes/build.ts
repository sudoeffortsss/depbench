/**
 * Determines what actually happened to each package after the scoring date.
 *
 * Three outcome kinds, deliberately kept apart rather than collapsed into one label,
 * because they have very different evidential strength:
 *
 *   advisory    strong. A GHSA published in-window affecting the version that was live
 *               on the scoring date. `MAL-*` is excluded: those are packages an attacker
 *               published to be malicious, a different phenomenon at thirty times the
 *               volume, and mostly not in existence on the scoring date (FINDINGS.md F3).
 *
 *   deprecated  weak. npm records the flag but never a timestamp, so we cannot tell
 *               whether deprecation happened before or after the scoring date.
 *
 *   abandoned   medium, and only under a tightened definition. The loose version — "no
 *               releases after D" — flagged packages doing three downloads a month that
 *               had never been alive in the first place, producing a 98% positive rate
 *               that was a definition eating itself rather than a finding (F2). Here a
 *               package must have been genuinely shipping before D to count as having
 *               stopped.
 */

import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import type { ReducedPackument } from "../ingest/registry.js";
import { SCORING_DATE } from "../snapshot/build.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const WINDOW_START = "2023-01-01";
export const WINDOW_END = "2026-09-01";

/** A package must have been shipping this often before D for "stopped" to mean anything. */
const ABANDONED_MIN_RELEASES_BEFORE = 3;

export interface OutcomeStats {
  advisory: number;
  deprecated: number;
  abandoned: number;
  packagesWithAny: number;
  casesWithAdvisory: number;
  controlsWithAdvisory: number;
}

/**
 * GHSA identifiers per package, read from the probe output rather than re-parsing the
 * 225 MB OSV export. `stage0_ghsa_pool_result.json` was produced by
 * `probe/stage0_ghsa_pool.py`, which applies the GHSA-only filter.
 */
async function ghsaByPackage(): Promise<Map<string, { id: string; published: string }>> {
  const raw = await readFile(
    join(ROOT, "probe", "stage0_ghsa_pool_result.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw) as { alive_packages: string[] };
  // The probe recorded which packages qualified; the advisory id and date for each are
  // re-derived here from the same source file the universe used, so cases and outcomes
  // cannot disagree about who was hit.
  const out = new Map<string, { id: string; published: string }>();
  for (const name of parsed.alive_packages) {
    out.set(name, { id: "", published: "" });
  }
  return out;
}

export async function buildOutcomes(db: PGlite): Promise<OutcomeStats> {
  const asOf = new Date(`${SCORING_DATE}T00:00:00Z`);
  const day = 86_400_000;

  const hits = await ghsaByPackage();

  const members = new Map<string, string>();
  const rl = createInterface({
    input: createReadStream(join(ROOT, "universe", "universe.tsv"), { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; }
    const [name, role] = line.split("\t");
    if (name && role) members.set(name, role);
  }

  const obs = await db.query<{ external_id: string; payload: ReducedPackument | null }>(
    `SELECT DISTINCT ON (external_id) external_id, payload
     FROM observation WHERE source = 'npm_packument'
     ORDER BY external_id, fetched_at DESC`,
  );

  const stats: OutcomeStats = {
    advisory: 0, deprecated: 0, abandoned: 0,
    packagesWithAny: 0, casesWithAdvisory: 0, controlsWithAdvisory: 0,
  };

  await db.exec("BEGIN");
  try {
    await db.query(`DELETE FROM outcome WHERE as_of_date = $1`, [SCORING_DATE]);

    for (const row of obs.rows) {
      const name = row.external_id;
      const pk = row.payload;
      let any = false;

      if (hits.has(name)) {
        any = true;
        stats.advisory++;
        if (members.get(name) === "case") stats.casesWithAdvisory++;
        else stats.controlsWithAdvisory++;
        await db.query(
          `INSERT INTO outcome (pkg_name, as_of_date, kind, occurred_at, source_id, source_url, confidence)
           VALUES ($1,$2,'advisory',NULL,$3,$4,'strong')
           ON CONFLICT DO NOTHING`,
          [name, SCORING_DATE, hits.get(name)!.id || "GHSA", "https://osv.dev"],
        );
      }

      if (!pk) continue;

      const latestTag = pk.distTags?.latest;
      if (latestTag && pk.versions?.[latestTag]?.dep === 1) {
        any = true;
        stats.deprecated++;
        await db.query(
          `INSERT INTO outcome (pkg_name, as_of_date, kind, occurred_at, source_id, source_url, confidence)
           VALUES ($1,$2,'deprecated',NULL,'','','weak')
           ON CONFLICT DO NOTHING`,
          [name, SCORING_DATE],
        );
      }

      const times: Date[] = [];
      for (const [v, iso] of Object.entries(pk.time ?? {})) {
        if (v === "created" || v === "modified") continue;
        const d = new Date(iso);
        if (!Number.isNaN(d.getTime())) times.push(d);
      }
      const beforeYear = times.filter(
        (t) => t < asOf && asOf.getTime() - t.getTime() <= 365 * day,
      ).length;
      const after = times.filter((t) => t >= asOf).length;

      if (beforeYear >= ABANDONED_MIN_RELEASES_BEFORE && after === 0) {
        any = true;
        stats.abandoned++;
        await db.query(
          `INSERT INTO outcome (pkg_name, as_of_date, kind, occurred_at, source_id, source_url, confidence)
           VALUES ($1,$2,'abandoned',NULL,'','','weak')
           ON CONFLICT DO NOTHING`,
          [name, SCORING_DATE],
        );
      }

      if (any) stats.packagesWithAny++;
    }
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }

  return stats;
}
