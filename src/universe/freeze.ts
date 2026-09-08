/**
 * Freezes the evaluation universe and writes it to disk with a content hash.
 *
 * This runs, and its output is committed, BEFORE any policy exists. That ordering is
 * the point: the public git timestamp shows the evaluation set was fixed before anyone
 * could see which packages a policy happens to score well. See BLUEPRINT.md section 4.
 *
 * Design (BLUEPRINT.md section 4 box 1, and FINDINGS.md F4):
 *
 *   cases     packages hit by a GHSA published in-window, that were genuinely alive on
 *             the scoring date, established by probe 2. The count is read from the
 *             probe output rather than hardcoded: it was 383 until the scoped-package
 *             bulk-lookup bug in stage 0 was fixed, and is 643 after.
 *   controls  matched roughly 1:4 within download band, drawn from packages that were
 *             alive at the scoring date and were NOT hit by any in-window GHSA.
 *
 * Download volume comes from the ecosyste.ms 2022-11-09 snapshot rather than a crawl.
 * The snapshot predates the scoring date, so selection cannot have seen the outcome
 * period. See FINDINGS.md F7 and DATA_LICENSE.md.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RANKING = join(ROOT, "probe", "npm_ranking_2022-11-09.tsv");
const GHSA_POOL = join(ROOT, "probe", "stage0_ghsa_pool_result.json");
const GHSA_AFFECTED = join(ROOT, "probe", "ghsa_affected_all_result.json");
const OUT_DIR = join(ROOT, "universe");

const SCORING_DATE = "2023-01-01";
const WINDOW_START = "2023-01-01";
const WINDOW_END = "2026-09-01";
const CONTROLS_PER_CASE = 4;
const ALIVE_MIN_DOWNLOADS = 1000;
/** A control must have been releasing before the scoring date, like the cases were. */
const ALIVE_MAX_DAYS_SINCE_RELEASE = 365;
/** Fixed so the draw is reproducible by anyone re-running this file. */
const SEED = 20260906;

type Band = "1K-10K" | "10K-100K" | "100K-1M" | "1M+";
type Scope = "scoped" | "plain";
/**
 * Controls are matched within download band AND scope style.
 *
 * Scope style is a naming convention, not a risk signal anyone would propose, but left
 * unmatched it is the strongest classifier in the dataset. The first draw had 0% scoped
 * cases against 54.8% scoped controls, so "name starts with @" alone scored AUC 0.774,
 * beating every policy under test. Fixing the stage-0 bulk-lookup bug brought cases to
 * 32.8% and cut that to 0.611, still above the best real policy (popularity, 0.529).
 * The residual is a genuine population difference (scoped packages carry fewer
 * downloads, so the >=1000 filter removes 36% of them against 12% of unscoped ones) and
 * it survives band matching: in the 1M+ band cases are 16% scoped and controls 47%.
 * Matching on it removes the artifact rather than leaving every name-aware method to
 * collect it for free.
 */
type Cell = `${Band}|${Scope}`;

const BANDS: Band[] = ["1K-10K", "10K-100K", "100K-1M", "1M+"];
const SCOPES: Scope[] = ["scoped", "plain"];
const CELLS: Cell[] = BANDS.flatMap((b) => SCOPES.map((s) => `${b}|${s}` as Cell));

const scopeOf = (name: string): Scope => (name.startsWith("@") ? "scoped" : "plain");
const cellOf = (name: string, band: Band): Cell => `${band}|${scopeOf(name)}`;

interface RankingRow {
  name: string;
  downloads: number;
  latestReleaseAt: string;
}

const emptyCells = <T,>(): Map<Cell, T[]> => new Map(CELLS.map((c) => [c, [] as T[]]));

function bandOf(downloads: number): Band | null {
  if (downloads >= 1_000_000) return "1M+";
  if (downloads >= 100_000) return "100K-1M";
  if (downloads >= 10_000) return "10K-100K";
  if (downloads >= ALIVE_MIN_DOWNLOADS) return "1K-10K";
  return null;
}

/** Deterministic PRNG so the control draw is reproducible without a seeded library. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadCases(): Promise<{ names: string[]; downloads: Record<string, number> }> {
  const pool = JSON.parse(await readFile(GHSA_POOL, "utf8")) as {
    alive_packages: string[];
    downloads_at_d: Record<string, number>;
  };
  return { names: pool.alive_packages, downloads: pool.downloads_at_d };
}

/** Streams the 138 MB ranking rather than loading it whole. */
async function loadEligibleControls(
  excluded: Set<string>,
  cutoff: Date,
): Promise<Map<Cell, RankingRow[]>> {
  const byCell = emptyCells<RankingRow>();

  const rl = createInterface({
    input: createReadStream(RANKING, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let header: string[] | null = null;
  let iName = -1;
  let iDownloads = -1;
  let iLatest = -1;

  for await (const line of rl) {
    const parts = line.split("\t");
    if (!header) {
      header = parts;
      iName = header.indexOf("name");
      iDownloads = header.indexOf("downloads");
      iLatest = header.indexOf("latest_release_published_at");
      if (iName < 0 || iDownloads < 0 || iLatest < 0) {
        throw new Error(`ranking file is missing expected columns: ${header.join(",")}`);
      }
      continue;
    }

    const name = parts[iName];
    if (!name || excluded.has(name)) continue;

    const dl = Number(parts[iDownloads]);
    if (!Number.isFinite(dl)) continue;
    const band = bandOf(dl);
    if (!band) continue;

    // Alive at the scoring date means it was still shipping, not merely popular.
    const latestRaw = parts[iLatest];
    if (!latestRaw) continue;
    const latest = new Date(latestRaw.replace(" ", "T") + "Z");
    if (Number.isNaN(latest.getTime())) continue;
    const daysSince = (cutoff.getTime() - latest.getTime()) / 86_400_000;
    if (daysSince < 0 || daysSince > ALIVE_MAX_DAYS_SINCE_RELEASE) continue;

    byCell.get(cellOf(name, band))!.push({ name, downloads: dl, latestReleaseAt: latestRaw });
  }

  return byCell;
}

export async function freeze(): Promise<void> {
  console.log("truthlag universe freeze");
  console.log(`  scoring date : ${SCORING_DATE}`);
  console.log(`  window       : ${WINDOW_START} .. ${WINDOW_END}`);

  const { names: caseNames, downloads: caseDownloads } = await loadCases();
  console.log(`  cases        : ${caseNames.length}`);

  // Every GHSA-affected package is excluded from controls, not just the cases: a
  // package that had an in-window advisory is not a clean control even if it failed the
  // alive-at-D filter for some other reason.
  //
  // This used to read `new Set(Object.keys(caseDownloads))`, which is only the packages
  // that survived stage 0's active-before-D filter, so several hundred GHSA-affected
  // packages were never excluded and could be drawn as controls. Auditing the 1,532
  // controls of the previous draw against the GitHub Advisory API found 0 mislabelled,
  // so the bug never fired, but the redraw needs far more controls and the margin is
  // not worth keeping. The complete set is paginated from the advisory API itself
  // (probe/ghsa_affected_all.py), which found 4,334 in-window advisories, matching
  // stage 0's independent count from the OSV bulk export exactly.
  const affectedFile = JSON.parse(await readFile(GHSA_AFFECTED, "utf8")) as {
    in_window_advisories: number;
    affected: Record<string, { first: string; id: string }>;
  };
  const ghsaAffected = new Set(Object.keys(affectedFile.affected));
  for (const n of Object.keys(caseDownloads)) ghsaAffected.add(n);
  for (const n of caseNames) ghsaAffected.add(n);
  console.log(
    `  excluded from controls: ${ghsaAffected.size} GHSA-affected packages ` +
      `(${affectedFile.in_window_advisories} in-window advisories)`,
  );

  const cutoff = new Date(`${SCORING_DATE}T00:00:00Z`);
  console.log("  streaming ranking...");
  const eligible = await loadEligibleControls(ghsaAffected, cutoff);

  const caseCells = emptyCells<string>();
  const bandByName = new Map<string, Band>();
  for (const n of caseNames) {
    const b = bandOf(caseDownloads[n] ?? 0);
    if (!b) continue;
    bandByName.set(n, b);
    caseCells.get(cellOf(n, b))!.push(n);
  }

  const rng = mulberry32(SEED);
  const members: Array<{
    pkg_name: string;
    role: "case" | "control";
    band: Band;
  }> = [];

  console.log("\n  band       scope    cases  need  available  drawn");
  const bandStats: Record<string, unknown> = {};
  let short = 0;

  for (const cell of CELLS) {
    const [band, scope] = cell.split("|") as [Band, Scope];
    const cases = caseCells.get(cell)!;
    const pool = eligible.get(cell)!;
    const need = cases.length * CONTROLS_PER_CASE;

    for (const n of cases) members.push({ pkg_name: n, role: "case", band });

    // Fisher-Yates on a copy, then take the first `need`. Deterministic under SEED.
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const drawn = shuffled.slice(0, Math.min(need, shuffled.length));
    for (const c of drawn) members.push({ pkg_name: c.name, role: "control", band });

    if (drawn.length < need) short += need - drawn.length;
    console.log(
      `  ${band.padEnd(10)} ${scope.padEnd(8)} ${String(cases.length).padStart(5)} ` +
        `${String(need).padStart(5)} ${String(pool.length).padStart(10)} ` +
        `${String(drawn.length).padStart(6)}` +
        (drawn.length < need ? "   <- SHORT" : ""),
    );
    bandStats[cell] = {
      cases: cases.length,
      controls_needed: need,
      controls_available: pool.length,
      controls_drawn: drawn.length,
    };
  }
  // A short cell means the matched ratio is not what the manifest claims. Say so.
  if (short > 0) console.log(`\n  WARNING: ${short} controls short of the matched ratio`);

  members.sort((a, b) => a.pkg_name.localeCompare(b.pkg_name));
  const caseCount = members.filter((m) => m.role === "case").length;
  const controlCount = members.length - caseCount;

  const canonical = members.map((m) => `${m.pkg_name}\t${m.role}\t${m.band}`).join("\n");
  const hash = createHash("sha256").update(canonical).digest("hex");

  const selectionRule = {
    scoring_date: SCORING_DATE,
    window: [WINDOW_START, WINDOW_END],
    ground_truth: "GHSA-* only; MAL-* excluded, see FINDINGS.md F3",
    case_definition:
      "affected by a GHSA published in-window, existed before D, released in the year " +
      "before D, and >= 1000 downloads in 2022-12",
    control_definition:
      "no in-window GHSA, >= 1000 downloads in the 2022-11-09 ecosyste.ms snapshot, " +
      "and a release within 365 days before D",
    matching: `${CONTROLS_PER_CASE}:1 within download band and scope style (scoped @org/name vs plain), the latter added because it was the strongest classifier in the dataset when left unmatched`,
    bands: BANDS,
    cells: CELLS,
    ranking_source:
      "ecosyste.ms open data release packages-2022-11-09 (CC BY-SA 4.0, " +
      "(c) 2022 Andrew Nesbitt), frozen 2022-11-09T10:46:31Z, before the scoring date",
    seed: SEED,
    excluded_from_controls: ghsaAffected.size,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, "universe.tsv"),
    "pkg_name\trole\tband\n" + canonical + "\n",
  );
  await writeFile(
    join(OUT_DIR, "universe.json"),
    JSON.stringify(
      {
        universe_hash: hash,
        frozen_at_utc_date: SCORING_DATE,
        member_count: members.length,
        case_count: caseCount,
        control_count: controlCount,
        bands: bandStats,
        selection_rule: selectionRule,
      },
      null,
      1,
    ) + "\n",
  );

  console.log(`\n  members : ${members.length}  (${caseCount} cases, ${controlCount} controls)`);
  console.log(`  hash    : ${hash}`);
  console.log(`\n  wrote universe/universe.tsv and universe/universe.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  freeze().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
