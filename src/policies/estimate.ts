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
import { MODEL_ARMS, estimateCost } from "./llm.js";

async function main(): Promise<void> {
  const members = await readUniverse();
  const n = members.length;

  console.log(`truthlag estimate`);
  console.log(`  universe: ${n} packages`);
  console.log(`  assuming ~5,000 input and ~300 output tokens per package\n`);
  console.log(
    `  ${"policy".padEnd(16)} ${"model".padEnd(24)} ${"list".padStart(8)} ${"batched".padStart(8)}`,
  );
  console.log(`  ${"-".repeat(60)}`);

  let totalBatched = 0;
  for (const arm of MODEL_ARMS) {
    const e = estimateCost(arm, n);
    totalBatched += e.usdBatched;
    console.log(
      `  ${e.policy.padEnd(16)} ${e.model.padEnd(24)} ` +
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
