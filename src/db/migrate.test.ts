/**
 * Proofs, not smoke tests.
 *
 * The claim in BLUEPRINT.md is that idempotency is the UNIQUE constraint itself,
 * not a check sitting beside one. That claim is only worth making if it is
 * demonstrated, so these tests demonstrate it: re-running ingest inserts zero
 * rows, and the second insert is refused by the database rather than by
 * application logic that could be forgotten.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite(); // in-memory, fresh per test run
  await migrate(db);
});

afterAll(async () => {
  await db.close();
});

describe("migration", () => {
  it("creates every table the design calls for", async () => {
    const res = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = res.rows.map((r) => r.table_name);
    for (const t of [
      "universe",
      "universe_member",
      "observation",
      "package_version",
      "snapshot",
      "outcome",
      "policy_score",
      "prediction",
      "run",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("is idempotent: a second run applies nothing", async () => {
    const applied = await migrate(db);
    expect(applied).toEqual([]);
  });
});

describe("observation idempotency is enforced by the constraint", () => {
  const row = {
    source: "npm_packument",
    external_id: "chalk",
    content_hash: "sha256:deadbeef",
  };

  it("accepts the first insert", async () => {
    await db.query(
      `INSERT INTO observation (source, external_id, content_hash, payload)
       VALUES ($1, $2, $3, $4)`,
      [row.source, row.external_id, row.content_hash, JSON.stringify({ v: 1 })],
    );
    const c = await db.query<{ n: string }>(`SELECT count(*) AS n FROM observation`);
    expect(Number(c.rows[0]!.n)).toBe(1);
  });

  it("refuses an identical re-fetch at the database level", async () => {
    await expect(
      db.query(
        `INSERT INTO observation (source, external_id, content_hash, payload)
         VALUES ($1, $2, $3, $4)`,
        [row.source, row.external_id, row.content_hash, JSON.stringify({ v: 1 })],
      ),
    ).rejects.toThrow(/observation_idempotent|duplicate key/i);
  });

  it("re-running ingest over unchanged data inserts zero rows", async () => {
    const before = await db.query<{ n: string }>(`SELECT count(*) AS n FROM observation`);
    const res = await db.query(
      `INSERT INTO observation (source, external_id, content_hash, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT observation_idempotent DO NOTHING`,
      [row.source, row.external_id, row.content_hash, JSON.stringify({ v: 1 })],
    );
    const after = await db.query<{ n: string }>(`SELECT count(*) AS n FROM observation`);
    expect(res.affectedRows).toBe(0);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("treats changed content as a new observation, not an overwrite", async () => {
    await db.query(
      `INSERT INTO observation (source, external_id, content_hash, payload)
       VALUES ($1, $2, $3, $4)`,
      [row.source, row.external_id, "sha256:cafebabe", JSON.stringify({ v: 2 })],
    );
    const c = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM observation WHERE external_id = 'chalk'`,
    );
    expect(Number(c.rows[0]!.n)).toBe(2);
  });

  it("keeps failed fetches as rows, so no_answer stays computable", async () => {
    await db.query(
      `INSERT INTO observation (source, external_id, content_hash, http_status, payload, error)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      ["npm_packument", "does-not-exist", "sha256:none", 404, "not found"],
    );
    const c = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM observation WHERE payload IS NULL`,
    );
    expect(Number(c.rows[0]!.n)).toBe(1);
  });
});

describe("harness invariants are enforced by the schema", () => {
  beforeAll(async () => {
    await db.query(
      `INSERT INTO universe (universe_hash, scoring_date, window_start, window_end,
                             member_count, case_count, control_count, selection_rule)
       VALUES ('h1', '2023-01-01', '2023-01-01', '2026-09-01', 5, 1, 4, '{}'::jsonb)`,
    );
    await db.query(
      `INSERT INTO run (id, universe_hash, scoring_date, dry_run)
       VALUES (1, 'h1', '2023-01-01', true)`,
    );
  });

  it("rejects a universe whose counts do not add up", async () => {
    await expect(
      db.query(
        `INSERT INTO universe (universe_hash, scoring_date, window_start, window_end,
                               member_count, case_count, control_count, selection_rule)
         VALUES ('bad', '2023-01-01', '2023-01-01', '2026-09-01', 9, 1, 4, '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/universe_counts_add_up/i);
  });

  it("rejects a score row that is silently empty", async () => {
    // No score, not abstaining, and parse_status 'ok' would be a row that
    // disappears from every metric without anyone noticing. The schema forbids it.
    await expect(
      db.query(
        `INSERT INTO policy_score (run_id, pkg_name, as_of_date, policy, score, abstain, parse_status)
         VALUES (1, 'chalk', '2023-01-01', 'popularity', NULL, false, 'ok')`,
      ),
    ).rejects.toThrow(/score_present_unless_unanswered/i);
  });

  it("accepts an explicit abstention with no score", async () => {
    await db.query(
      `INSERT INTO policy_score (run_id, pkg_name, as_of_date, policy, score, abstain, evidence_n, parse_status)
       VALUES (1, 'chalk', '2023-01-01', 'llm-haiku', NULL, true, 2, 'ok')`,
    );
    const r = await db.query<{ abstain: boolean }>(
      `SELECT abstain FROM policy_score WHERE policy = 'llm-haiku'`,
    );
    expect(r.rows[0]!.abstain).toBe(true);
  });

  it("accepts a probe row, which answers a different question and has no score", async () => {
    // Added after this constraint killed the first paid run on its first package. The
    // reidentify and recall probes parse cleanly, do not abstain, and have no risk score
    // to give, which the original rule had no way to express.
    await db.query(
      `INSERT INTO policy_score (run_id, pkg_name, as_of_date, policy, score, abstain, parse_status, raw_output)
       VALUES (1, 'chalk', '2023-01-01', 'llm-x:reidentify', NULL, false, 'ok', '{"identified":false}')`,
    );
    const r = await db.query<{ raw_output: string }>(
      `SELECT raw_output FROM policy_score WHERE policy = 'llm-x:reidentify'`,
    );
    expect(r.rows[0]!.raw_output).toContain("identified");
  });

  it("still rejects a probe row that carries no answer either", async () => {
    // The exemption is not a blanket one: a probe with neither a score nor an output is
    // as empty as the score row above, and just as invisible downstream.
    await expect(
      db.query(
        `INSERT INTO policy_score (run_id, pkg_name, as_of_date, policy, score, abstain, parse_status, raw_output)
         VALUES (1, 'chalk', '2023-01-01', 'llm-x:recall', NULL, false, 'ok', NULL)`,
      ),
    ).rejects.toThrow(/score_present_unless_unanswered/i);
  });

  it("does not let an ordinary policy claim the probe exemption by naming itself", async () => {
    // The exemption matches two specific suffixes rather than a wildcard, so a policy
    // cannot opt out of harness rule 1 by choosing a convenient name.
    await expect(
      db.query(
        `INSERT INTO policy_score (run_id, pkg_name, as_of_date, policy, score, abstain, parse_status, raw_output)
         VALUES (1, 'chalk', '2023-01-01', 'reidentify-ish', NULL, false, 'ok', 'anything')`,
      ),
    ).rejects.toThrow(/score_present_unless_unanswered/i);
  });

  it("accepts an unparseable model output and keeps the raw text", async () => {
    await db.query(
      `INSERT INTO policy_score (run_id, pkg_name, as_of_date, policy, score, abstain, parse_status, raw_output)
       VALUES (1, 'chalk', '2023-01-01', 'llm-flash-lite', NULL, false, 'unparseable', 'I think maybe...')`,
    );
    const r = await db.query<{ parse_status: string; raw_output: string }>(
      `SELECT parse_status, raw_output FROM policy_score WHERE policy = 'llm-flash-lite'`,
    );
    expect(r.rows[0]!.parse_status).toBe("unparseable");
    expect(r.rows[0]!.raw_output).toContain("maybe");
  });
});
