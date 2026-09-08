/**
 * Runs a model arm over the universe.
 *
 *   npx tsx src/policies/llm-run.ts                 dry run: prints the bill, spends nothing
 *   npx tsx src/policies/llm-run.ts --run           spends money
 *   npx tsx src/policies/llm-run.ts --run --limit 100   a pilot first
 *
 * Dry run is the default and that is not a convenience. Deciding to spend is a decision
 * with a number attached, and a benchmark should not make it quietly on someone\'s behalf.
 *
 * The run is resumable. Rows already written for the run id are skipped, so an
 * interruption costs nothing to recover from and cannot double-charge.
 */

import { migrate, openDb } from "../db/migrate.js";
import { readUniverse } from "../ingest/registry.js";
import { SCORING_DATE } from "../snapshot/build.js";
import { BudgetGate, MODEL_ARMS, assertStratifiable, estimateCost } from "./llm.js";
import { CONDITIONS } from "./prompts.js";
import { buildContent, type PackageText } from "./llm-input.js";
import { alreadyScored, apiKey, makeLimiter, scoreOne } from "./gemini.js";

/** The project ceiling. The gate throws at it rather than warning. */
const BUDGET_CEILING_USD = 50;

async function main(): Promise<void> {
  const argv = process.argv;
  const wet = argv.includes("--run");
  const limitArg = argv.indexOf("--limit");
  const limit = limitArg > -1 ? Number(argv[limitArg + 1]) : Infinity;
  const armName = argv.includes("--arm") ? argv[argv.indexOf("--arm") + 1] : "llm-flash-lite";

  const arm = MODEL_ARMS.find((a) => a.policy === armName);
  if (!arm) throw new Error("unknown arm " + armName + "; have " + MODEL_ARMS.map((a) => a.policy).join(", "));
  // Refuses before anything else if the arm could not be interpreted even if it ran.
  assertStratifiable(arm);

  const db = await openDb();
  try {
    await migrate(db);
    const members = await readUniverse();
    const names = members.map((m) => m.name);

    const rows = await db.query<{ external_id: string; payload: PackageText }>(
      `SELECT DISTINCT ON (external_id) external_id, payload FROM observation
        WHERE source = \'npm_tarball\' AND payload IS NOT NULL AND external_id = ANY($1::text[])
        ORDER BY external_id, fetched_at DESC`,
      [names],
    );
    const texts = rows.rows.map((r) => r.payload);

    // Harness rule 1 starts here, not at scoring: a member with no text is a member
    // that will be scored as unanswerable, not one quietly dropped from the run.
    const have = new Set(texts.map((t) => t.pkg_name));
    const missing = names.filter((n) => !have.has(n));

    // Deterministic order, so a pilot and its continuation cover a prefix rather than a
    // random resample. Sorted by name, which is independent of case status.
    const ordered = [...texts].sort((a, b) => a.pkg_name.localeCompare(b.pkg_name));
    const targets = ordered.slice(0, limit === Infinity ? undefined : limit);

    console.log("truthlag " + (wet ? "run" : "dry run"));
    console.log("  arm          : " + arm.policy + "  (" + arm.model + ")");
    console.log("  cutoff       : " + arm.trainingCutoff + "  splits cases " +
      arm.caseSplit.preCutoff + "/" + arm.caseSplit.postCutoff);
    console.log("  members      : " + members.length);
    console.log("  with text    : " + texts.length + "   (no text: " + missing.length + ")");
    console.log("  scoring      : " + targets.length);
    console.log("  conditions   : " + CONDITIONS.length);

    // Rows already paid for, so a dry run against --resume prices the work that remains
    // rather than the work in total. Without this the estimate for adding one condition
    // to a finished five-condition run read $17.33 when the actual spend was $3.
    const resumeArgDry = argv.indexOf("--resume");
    const doneAlready = resumeArgDry > -1
      ? await alreadyScored(db, Number(argv[resumeArgDry + 1]))
      : new Set<string>();

    // Real token counts for the material that will actually be sent, rather than the
    // estimator\'s average.
    let chars = 0;
    let skipped = 0;
    let emptyEvidence = 0;
    let residualLeaks = 0;
    let plannedCalls = 0;
    for (const t of targets) {
      for (const spec of CONDITIONS) {
        const built = buildContent(t, spec);
        if (spec.key === "practitioner-named" && built.evidenceEmpty) emptyEvidence++;
        if (spec.blinded && built.residual.length > 0) residualLeaks++;
        if (doneAlready.has(arm.policy + ":" + spec.key + " " + t.pkg_name)) {
          skipped++;
          continue;
        }
        plannedCalls++;
        chars += built.content.length + spec.prompt.length;
      }
    }
    const inTok = Math.round(chars / 4);
    const outTok = plannedCalls * 200;
    const usd = (inTok / 1e6) * arm.inputPerMTok + (outTok / 1e6) * arm.outputPerMTok;

    console.log("\n  calls        : " + plannedCalls +
      (skipped > 0 ? "   (" + skipped + " already scored, not repriced)" : ""));
    console.log("  input tokens : " + inTok.toLocaleString() + "   (measured, not averaged)");
    console.log("  output tokens: " + outTok.toLocaleString() + "   (assumed 200/call)");
    console.log("  projected    : $" + usd.toFixed(2) + "   at list price, sync endpoint");
    console.log("  ceiling      : $" + BUDGET_CEILING_USD.toFixed(2));
    console.log("\n  packages with no evidence at all: " + emptyEvidence +
      "   <- the abstention test group");
    console.log("  blinded inputs still naming the package: " + residualLeaks);

    if (!wet) {
      console.log("\n  Nothing was called and nothing was spent.");
      console.log("  Re-run with --run to spend. The re-identification probe is part of");
      console.log("  this run: without it the blind condition is an assumption, not a control.");
      return;
    }

    const key = apiKey();
    const gate = new BudgetGate(BUDGET_CEILING_USD);
    const limiter = makeLimiter();

    // A pilot and the full run are the same run, or the pilot's spend is thrown away.
    // Without this every invocation opened a new run id and re-paid for every package
    // the pilot had already scored.
    const resumeArg = argv.indexOf("--resume");
    let runId: number;
    if (resumeArg > -1) {
      runId = Number(argv[resumeArg + 1]);
      const check = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM run WHERE id = $1`,
        [runId],
      );
      if (Number(check.rows[0]!.n) === 0) throw new Error("no run " + runId + " to resume");
    } else {
      const run = await db.query<{ id: string }>(
        `INSERT INTO run (universe_hash, scoring_date, dry_run, notes)
         SELECT universe_hash, $1, false, $2 FROM universe ORDER BY frozen_at DESC LIMIT 1
         RETURNING id`,
        [SCORING_DATE, "model arm " + arm.policy + " (" + arm.model + "), cutoff " + arm.trainingCutoff],
      );
      runId = Number(run.rows[0]!.id);
    }
    const done = await alreadyScored(db, runId);
    console.log("\n  run id       : " + runId);
    console.log("  already done : " + done.size + " rows\n");

    let n = 0;
    const total = targets.length * CONDITIONS.length;
    for (const t of targets) {
      for (const spec of CONDITIONS) {
        n++;
        const policy = arm.policy + ":" + spec.key;
        if (done.has(policy + " " + t.pkg_name)) continue;
        const built = buildContent(t, spec);
        const row = await scoreOne(arm, spec, t.pkg_name, built.content, limiter, key, gate);
        await db.query(
          `INSERT INTO policy_score (run_id, pkg_name, as_of_date, policy, score, abstain,
                                     evidence_n, parse_status, model, input_tokens,
                                     output_tokens, cost_usd, raw_output)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT DO NOTHING`,
          [runId, t.pkg_name, SCORING_DATE, policy, row.score, row.abstain,
           built.evidenceEmpty ? 0 : 1, row.parse_status, arm.model,
           row.inputTokens, row.outputTokens, row.usd, row.raw_output],
        );
        if (n % 200 === 0 || n === total) {
          console.log("  " + n + "/" + total + "  spent $" + gate.spentUsd.toFixed(3) +
            "  remaining $" + gate.remainingUsd.toFixed(2));
        }
      }
    }

    console.log("\n=== arm complete ===");
    console.log("  spent        : $" + gate.spentUsd.toFixed(4));
    const summary = await db.query<any>(
      `SELECT policy, count(*) n,
              count(*) FILTER (WHERE parse_status = \'ok\' AND NOT abstain AND score IS NOT NULL) scored,
              count(*) FILTER (WHERE abstain) abstained,
              count(*) FILTER (WHERE parse_status <> \'ok\') failed
         FROM policy_score WHERE run_id = $1 GROUP BY policy ORDER BY policy`,
      [runId],
    );
    console.log("\n  policy                              n  scored abstain failed");
    for (const s of summary.rows) {
      console.log("  " + String(s.policy).padEnd(34) + String(s.n).padStart(5) +
        String(s.scored).padStart(8) + String(s.abstained).padStart(8) +
        String(s.failed).padStart(7));
    }
    console.log("\nLLM_RUN_DONE run=" + runId);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
