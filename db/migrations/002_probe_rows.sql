-- The scoring constraint did not anticipate rows that are not scores.
--
-- 001 wrote:
--
--   CHECK (score IS NOT NULL OR abstain OR parse_status <> 'ok')
--
-- and the intent behind it is still right: a policy that answered must have produced a
-- number, and a NULL score has to be explained by either an abstention or a failure.
-- That is harness rule 1 expressed in the schema rather than in a code path anyone
-- could forget.
--
-- The model arms then added two conditions that answer a different question. The
-- re-identification probe asks which package this is; the recall probe asks whether the
-- model remembers an advisory. Both parse cleanly, neither abstains, and neither has a
-- risk score to give. Under the old constraint every one of those rows was rejected,
-- and the pilot died on the first package it reached.
--
-- The fix keeps the guarantee where it means something and exempts the probes by name.
-- Naming them is deliberate: a wildcard on the policy column would let any future
-- policy opt out of the rule by choosing its own name.

BEGIN;

ALTER TABLE policy_score DROP CONSTRAINT score_present_unless_unanswered;

ALTER TABLE policy_score ADD CONSTRAINT score_present_unless_unanswered
  CHECK (
    score IS NOT NULL
    OR abstain
    OR parse_status <> 'ok'
    -- Probe conditions carry their answer in raw_output, which must therefore be
    -- present: a probe row with neither a score nor an answer is still a bug.
    OR (
      (policy LIKE '%:reidentify' OR policy LIKE '%:recall')
      AND raw_output IS NOT NULL
    )
  );

-- Migrations record themselves, which is what makes `migrate` idempotent. Leaving this
-- out made the file re-apply on every run: the test asserting a second run applies
-- nothing caught it immediately.
INSERT INTO schema_migration (filename) VALUES ('002_probe_rows.sql');

COMMIT;
