/**
 * Prints what running the model arms would cost, then exits without calling anything.
 *
 *   npx tsx src/policies/estimate.ts
 *
 * This command exists because the arms are built and unrun. Spending money is a decision
 * with a number attached; the number belongs in front of whoever makes it, not buried in
 * a config file.
 */

import { readUniverse } from "../ingest/registry.js";
import { MODEL_ARMS, estimateCost, assertStratifiable } from "./llm.js";
import { CONDITIONS } from "./prompts.js";

async function main(): Promise<void> {
  const members = await readUniverse();
  // Every package is asked every condition, so the billable unit is a call, not a
  // package. Pricing per package understated this run five-fold.
  const n = members.length * CONDITIONS.length;

  console.log(`truthlag estimate`);
  console.log(`  universe: ${members.length} packages x ${CONDITIONS.length} conditions = ${n} calls`);
  console.log(`  ~2,613 input and ~103 output tokens per call`);
  console.log(`  (the provider's own usageMetadata over ten real calls, output`);
  console.log(`   including thoughtsTokenCount, which bills at the output rate)\n`);
  console.log(
    `  ${"policy".padEnd(16)} ${"model".padEnd(24)} ${"cutoff".padStart(8)} ` +
      `${"cases".padStart(9)} ${"list".padStart(8)} ${"batched".padStart(8)}`,
  );
  console.log(`  ${"-".repeat(86)}`);

  let totalBatched = 0;
  for (const arm of MODEL_ARMS) {
    const e = estimateCost(arm, n);
    totalBatched += e.usdBatched;
    // Refuse to price an arm that could not be interpreted if it ran.
    assertStratifiable(arm);
    const split = `${arm.caseSplit.preCutoff}/${arm.caseSplit.postCutoff}`;
    console.log(
      `  ${e.policy.padEnd(16)} ${e.model.padEnd(24)} ${arm.trainingCutoff.padStart(8)} ` +
        `${split.padStart(9)} ` +
        `${("$" + e.usdListPrice.toFixed(2)).padStart(8)} ` +
        `${("$" + e.usdBatched.toFixed(2)).padStart(8)}`,
    );
  }
  console.log(`  ${"-".repeat(60)}`);
  console.log(`  ${"all three arms, batched".padEnd(42)} ${("$" + totalBatched.toFixed(2)).padStart(17)}`);

  console.log(`
  Nothing was called and nothing was spent. Token counts are estimates until a real
  count_tokens pass is run; treat these as an order of magnitude, not an invoice.

  The rule policies already answered the project's headline question for $0. These arms
  answer a different one — whether reading a package's prose beats reading its metadata —
  and that question is worth what it costs only if someone decides so deliberately.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
