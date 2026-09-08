/**
 * The prospective arm: seal today's predictions, let time verify them.
 *
 *   npx tsx src/prospective/seal.ts
 *
 * Every backtest carries the same unfixable problem: we already know how the story
 * ended. Even without cheating, hindsight leaks into feature choice and threshold
 * tuning. This arm has no such problem, because the predictions are written before the
 * outcomes exist.
 *
 * The ledger is a file per day under `predictions/`, committed to a public repository.
 * The git timestamp is the proof — not a claim in a README, but a record anyone can
 * check independently.
 *
 * Two honest notes that belong here rather than in a footnote:
 *
 *   - This will not produce a meaningful result for a long time. The base rate is low
 *     and disclosure is slow (a median of 31.5 months, F5). Its near-term value is that
 *     it is running and that the design shows the overfitting problem is understood.
 *
 *   - It quietly repairs the retrospective arm's worst gap. The registry keeps no
 *     history of maintainer lists, so "did the maintainer change" cannot be tested
 *     backwards (BLUEPRINT.md section 3). Recording the list daily starts accumulating
 *     exactly that, from today forward.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, RateLimiter, fetchJson } from "../ingest/http.js";
import { packumentUrl, reduce, readUniverse } from "../ingest/registry.js";
import { buildSnapshot } from "../snapshot/build.js";
import { RULE_POLICIES, type PolicyContext, type PolicyInput } from "../policies/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "predictions");

interface SealedRow {
  pkg: string;
  policy: string;
  score: number | null;
  abstain: boolean;
  evidence_n: number;
  parse_status: "ok" | "error";
}

function hashUnit(key: string): number {
  return createHash("sha256").update(`truthlag:${key}`).digest().readUInt32BE(0) / 2 ** 32;
}

function buildRanker(rows: PolicyInput[]): PolicyContext["rank01"] {
  const sorted = new Map<string, number[]>();
  for (const f of [
    "downloads_prior_month", "days_since_last_pub", "version_count",
    "releases_last_90d", "releases_last_365d",
  ] as Array<keyof PolicyInput>) {
    sorted.set(
      f as string,
      rows.map((r) => r[f]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b),
    );
  }
  return (field, value) => {
    const vals = sorted.get(field as string);
    if (!vals?.length) return 0.5;
    let lo = 0, hi = vals.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vals[mid]! <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo / vals.length;
  };
}

export async function seal(today: string): Promise<{ file: string; rows: number; sealHash: string }> {
  const members = await readUniverse();
  const limiter = new RateLimiter(LIMITS.registryIntervalMs);
  const asOf = new Date(`${today}T00:00:00Z`);

  const inputs: PolicyInput[] = [];
  const maintainers: Record<string, number> = {};
  let failed = 0;

  for (const m of members) {
    const res = await fetchJson<any>(packumentUrl(m.name), limiter, {
      minIntervalMs: LIMITS.registryIntervalMs,
    });
    if (!res.ok) {
      failed++;
      inputs.push({
        pkg_name: m.name, downloads_prior_month: null, version_count: 0,
        days_since_last_pub: null, releases_last_90d: 0, releases_last_365d: 0,
        first_published_at: null, has_install_hook: null, has_repo_url: null,
        license: null, reconstructed: false,
      });
      continue;
    }
    const pk = reduce(res.body);
    // The signal the retrospective arm cannot reach. Start the clock.
    maintainers[m.name] = pk.maintainerCount;
    const snap = buildSnapshot(m.name, pk, asOf);
    inputs.push({
      pkg_name: m.name,
      downloads_prior_month: null, // not fetched daily; policies that need it abstain
      version_count: snap.version_count,
      days_since_last_pub: snap.days_since_last_pub,
      releases_last_90d: snap.releases_last_90d,
      releases_last_365d: snap.releases_last_365d,
      first_published_at: snap.first_published_at,
      has_install_hook: snap.has_install_hook,
      has_repo_url: snap.has_repo_url,
      license: snap.license,
      reconstructed: snap.reconstructed,
    });
  }

  const ctx: PolicyContext = { hashUnit, rank01: buildRanker(inputs) };
  const rows: SealedRow[] = [];
  for (const policy of RULE_POLICIES) {
    for (const input of inputs) {
      if (!input.reconstructed) {
        rows.push({
          pkg: input.pkg_name, policy: policy.name, score: null,
          abstain: false, evidence_n: 0, parse_status: "error",
        });
        continue;
      }
      const out = policy.score(input, ctx);
      rows.push({
        pkg: input.pkg_name, policy: policy.name, score: out.score,
        abstain: out.abstain, evidence_n: out.evidence_n, parse_status: "ok",
      });
    }
  }

  // The seal covers the predictions themselves, so a later edit to the file is
  // detectable independently of git.
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const sealHash = createHash("sha256").update(body).digest("hex");

  const header = JSON.stringify({
    _meta: {
      predicted_on: today,
      universe_members: members.length,
      packuments_failed: failed,
      policies: RULE_POLICIES.map((p) => p.name),
      maintainer_counts: maintainers,
      seal_sha256: sealHash,
      note:
        "Predictions written before outcomes existed. The git commit timestamp on this " +
        "file is the evidence; seal_sha256 covers the prediction lines below it.",
    },
  });

  await mkdir(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${today}.jsonl`);
  await writeFile(file, header + "\n" + body + "\n");
  return { file, rows: rows.length, sealHash };
}

/**
 * The date this run seals, from the environment or the clock, and never from neither.
 *
 * Extracted and exported so it can be tested, because it is the thing that broke. The
 * workflow sets TRUTHLAG_DATE from `github.event.inputs.date`, which exists only for a
 * manual dispatch. On the schedule GitHub sets the variable to the empty string rather
 * than leaving it unset, `??` does not fall back on "", and the run sealed itself to
 * `predictions/.jsonl` with an empty `predicted_on`.
 *
 * The damage was not one bad filename. `main` refuses to overwrite a day that is already
 * sealed, so once `.jsonl` existed every later scheduled run found it, reported "already
 * sealed", and wrote nothing. A ledger whose whole claim is one file per day with a
 * public timestamp had quietly stopped producing days, while the workflow and the guard
 * both reported success.
 */
export function resolveSealDate(envValue: string | undefined, now: Date): string {
  const fromEnv = (envValue ?? "").trim();
  const today = fromEnv !== "" ? fromEnv : now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error(
      `TRUTHLAG_DATE must be YYYY-MM-DD, got ${JSON.stringify(envValue)}. ` +
        `Refusing to seal an unnamed day.`,
    );
  }
  return today;
}

async function main(): Promise<void> {
  // Date comes from the environment so a scheduled run and a manual one agree, and so
  // this file contains no hidden clock.
  //
  // Trimmed and length-checked rather than passed straight to `??`, because the workflow
  // sets TRUTHLAG_DATE from `github.event.inputs.date`, which exists only for a manual
  // dispatch. On the schedule GitHub sets the variable to the empty string rather than
  // leaving it unset, `??` does not fall back on "", and the run sealed itself to
  // `predictions/.jsonl` with an empty `predicted_on`.
  //
  // The damage was not one bad filename. The guard below refuses to overwrite a day that
  // is already sealed, so once `.jsonl` existed every later scheduled run found it,
  // reported "already sealed", and wrote nothing. A daily ledger whose whole claim is one
  // file per day with a public timestamp had quietly stopped producing days, while both
  // the workflow and the guard reported success.
  const today = resolveSealDate(process.env.TRUTHLAG_DATE, new Date());
  console.log(`truthlag seal  ${today}`);

  const existing = await readdir(OUT_DIR).catch(() => [] as string[]);
  if (existing.includes(`${today}.jsonl`)) {
    console.log(`  ${today}.jsonl already sealed; refusing to overwrite a sealed day`);
    return;
  }

  const { file, rows, sealHash } = await seal(today);
  console.log(`  sealed ${rows} predictions`);
  console.log(`  seal   ${sealHash.slice(0, 32)}...`);
  console.log(`  wrote  ${file.replace(ROOT + "/", "")}`);
  console.log(`  days sealed so far: ${existing.filter((f) => f.endsWith(".jsonl")).length + 1}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
