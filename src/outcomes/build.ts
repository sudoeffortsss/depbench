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
 * The advisory id and publication date for each package that qualified as a case.
 *
 * This function used to claim in a comment that ids and dates were "re-derived here
 * from the same source file", while the code actually wrote `{id: "", published: ""}`
 * for every package. The result was that `outcome.occurred_at` was NULL for all 383
 * cases and `source_id` was the literal string "GHSA", so nothing downstream could ask
 * when a package was hit. Anything that stratifies on disclosure date, the LLM arm's
 * training-cutoff split above all, was impossible.
 *
 * Dates now come from `probe/ghsa_affected_all_result.json`, paginated from the GitHub
 * Advisory API by `probe/ghsa_affected_all.py`. That source found 4,334 in-window
 * advisories, matching stage 0's independent count from the OSV bulk export exactly.
 * It is preferred over OSV's /v1/query endpoint, which was measured against it and
 * disagreed: OSV returned nothing at all for six packages that do have in-window
 * advisories (eslint, fast-redact, jquery, npm, papaparse, stylelint), and named a
 * later first advisory for five more, worst of them nx at 2026-07-31 against a true
 * 2025-09-25. Cases are the intersection with the universe's own case list, so cases
 * and outcomes cannot disagree about who was hit.
 */
async function ghsaByPackage(): Promise<Map<string, { id: string; published: string }>> {
  const [poolRaw, affectedRaw] = await Promise.all([
    readFile(join(ROOT, "probe", "stage0_ghsa_pool_result.json"), "utf8"),
    readFile(join(ROOT, "probe", "ghsa_affected_all_result.json"), "utf8"),
  ]);
  const pool = JSON.parse(poolRaw) as { alive_packages: string[] };
  const affected = (
    JSON.parse(affectedRaw) as { affected: Record<string, { first: string; id: string }> }
  ).affected;

  const out = new Map<string, { id: string; published: string }>();
  const undated: string[] = [];
  for (const name of pool.alive_packages) {
    const hit = affected[name];
    if (!hit) {
      undated.push(name);
      continue;
    }
    out.set(name, { id: hit.id, published: hit.first });
  }
  // A case with no advisory in the authoritative list is a contradiction, not a gap.
  if (undated.length > 0) {
    throw new Error(
      `${undated.length} case packages carry no in-window advisory in ` +
        `ghsa_affected_all_result.json, so the case list and the outcome source ` +
        `disagree: ${undated.slice(0, 8).join(", ")}`,
    );
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
        const hit = hits.get(name)!;
        await db.query(
          `INSERT INTO outcome (pkg_name, as_of_date, kind, occurred_at, source_id, source_url, confidence)
           VALUES ($1,$2,'advisory',$3,$4,$5,'strong')
           ON CONFLICT DO NOTHING`,
          [
            name,
            SCORING_DATE,
            hit.published,
            hit.id,
            `https://github.com/advisories/${hit.id}`,
          ],
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
