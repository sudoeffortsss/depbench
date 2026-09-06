-- truthlag schema, migration 001
--
-- Design notes that are load-bearing, not decoration:
--
--   * `observation` is append-only. Every network fetch lands here with its raw
--     payload intact. Everything downstream is derived from it, so a bug in the
--     derivation is a re-run, not a re-crawl.
--
--   * Idempotency is the UNIQUE constraint on (source, external_id, content_hash),
--     not a check sitting beside one. Re-running ingest inserts zero rows when
--     nothing upstream changed. The constraint IS the guarantee.
--
--   * `no_answer` and `abstain` are first-class columns, not absences. A policy
--     that could not answer is recorded as such and stays in the denominator.
--     See FINDINGS.md and the harness rules in BLUEPRINT.md section 7.
--
--   * No ORM. Plain SQL migrations, applied in filename order.

BEGIN;

CREATE TABLE schema_migration (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- (1) universe: the frozen evaluation set
-- ---------------------------------------------------------------------------
-- A benchmark whose question set moves cannot compare runs. The universe is
-- frozen once and identified by a hash of its sorted member list; every score
-- and every report carries that hash.
--
-- Case-control design (see BLUEPRINT.md section 4 box 1, and FINDINGS.md F4):
-- roughly 383 cases matched about 1:4 with controls.

CREATE TYPE universe_role AS ENUM ('case', 'control');

CREATE TABLE universe (
  universe_hash   text PRIMARY KEY,
  scoring_date    date        NOT NULL,
  window_start    date        NOT NULL,
  window_end      date        NOT NULL,
  member_count    integer     NOT NULL,
  case_count      integer     NOT NULL,
  control_count   integer     NOT NULL,
  selection_rule  jsonb       NOT NULL,   -- the literal criteria, committed before outcomes
  frozen_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT universe_counts_add_up
    CHECK (member_count = case_count + control_count)
);

CREATE TABLE universe_member (
  universe_hash   text          NOT NULL REFERENCES universe(universe_hash),
  pkg_name        text          NOT NULL,
  role            universe_role NOT NULL,
  match_stratum   text,          -- download band used to match a control to a case
  matched_to      text,          -- case this control was drawn for, null for cases
  PRIMARY KEY (universe_hash, pkg_name)
);

CREATE INDEX universe_member_role_idx ON universe_member (universe_hash, role);

-- ---------------------------------------------------------------------------
-- (2) observation: append-only raw fetches
-- ---------------------------------------------------------------------------

CREATE TABLE observation (
  id            bigserial   PRIMARY KEY,
  source        text        NOT NULL,     -- 'npm_packument' | 'npm_downloads' | 'osv_export'
  external_id   text        NOT NULL,     -- package name, or advisory id
  content_hash  text        NOT NULL,     -- sha256 of the canonical payload
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  http_status   integer,
  payload       jsonb,                    -- null when the fetch failed, see no_answer
  error         text,
  CONSTRAINT observation_idempotent UNIQUE (source, external_id, content_hash)
);

CREATE INDEX observation_lookup_idx ON observation (source, external_id, fetched_at DESC);

-- A failed fetch is data. It is what makes no_answer computable rather than invisible.
CREATE INDEX observation_failures_idx ON observation (source, external_id)
  WHERE payload IS NULL;

-- ---------------------------------------------------------------------------
-- (3) package_version: normalised release history
-- ---------------------------------------------------------------------------

CREATE TABLE package_version (
  pkg_name         text        NOT NULL,
  version          text        NOT NULL,
  published_at     timestamptz NOT NULL,
  has_provenance   boolean     NOT NULL DEFAULT false,
  has_install_hook boolean     NOT NULL DEFAULT false,  -- pre/post install scripts present
  license          text,
  repo_url         text,
  deprecated_note  text,                                -- current state only, no timestamp
  PRIMARY KEY (pkg_name, version)
);

CREATE INDEX package_version_time_idx ON package_version (pkg_name, published_at);

-- ---------------------------------------------------------------------------
-- (4) snapshot: what was knowable about a package on the scoring date
-- ---------------------------------------------------------------------------
-- Deliberately a separate table from package_version so that a bug in the
-- reconstruction is fixed by recomputing this table alone.
--
-- Fields NOT here, because the registry does not retain them (BLUEPRINT.md
-- section 3): historical maintainer lists, deprecation timestamps. That gap is
-- reported, not hidden.

CREATE TABLE snapshot (
  pkg_name              text    NOT NULL,
  as_of_date            date    NOT NULL,
  latest_version        text,
  latest_published_at   timestamptz,
  version_count         integer NOT NULL,
  days_since_last_pub   integer,
  releases_last_90d     integer NOT NULL,
  releases_last_365d    integer NOT NULL,
  first_published_at    timestamptz,
  downloads_prior_month bigint,
  has_provenance        boolean,
  has_install_hook      boolean,
  license               text,
  has_repo_url          boolean,
  reconstructed         boolean NOT NULL DEFAULT true,  -- false when data was insufficient
  PRIMARY KEY (pkg_name, as_of_date)
);

-- ---------------------------------------------------------------------------
-- (5) outcome: what actually happened after the scoring date
-- ---------------------------------------------------------------------------
-- kind = 'advisory'   GHSA published in-window affecting the version live at D.
--                     MAL-* is excluded on purpose; see FINDINGS.md F3.
-- kind = 'deprecated' current deprecation flag. Weak: npm stores no timestamp.
-- kind = 'abandoned'  was actively releasing before D, then stopped entirely.
--                     Tightened after FINDINGS.md F2 showed the loose definition
--                     was flagging packages that were never alive.

CREATE TYPE outcome_kind AS ENUM ('advisory', 'deprecated', 'abandoned');

-- source_id defaults to '' rather than NULL: a primary key cannot contain an
-- expression, and 'deprecated'/'abandoned' outcomes have no source identifier.
CREATE TABLE outcome (
  pkg_name     text         NOT NULL,
  as_of_date   date         NOT NULL,
  kind         outcome_kind NOT NULL,
  occurred_at  date,                        -- null when the source records no date
  source_id    text         NOT NULL DEFAULT '',  -- e.g. GHSA-xxxx-xxxx-xxxx
  source_url   text,
  confidence   text         NOT NULL,       -- 'strong' | 'weak'
  PRIMARY KEY (pkg_name, as_of_date, kind, source_id)
);

CREATE INDEX outcome_kind_idx ON outcome (as_of_date, kind);

-- ---------------------------------------------------------------------------
-- (6) policy_score: one row per package per policy
-- ---------------------------------------------------------------------------
-- parse_status is the mechanism behind harness rule 1. An LLM that returned
-- unparseable text is 'unparseable', not a missing row, so it cannot vanish
-- from the denominator.

CREATE TYPE parse_status AS ENUM ('ok', 'repaired', 'unparseable', 'error', 'timeout');

CREATE TABLE policy_score (
  run_id         bigint       NOT NULL,
  pkg_name       text         NOT NULL,
  as_of_date     date         NOT NULL,
  policy         text         NOT NULL,
  score          double precision,          -- null iff abstain or not answerable
  abstain        boolean      NOT NULL DEFAULT false,
  evidence_n     integer,                   -- how much evidence backed the score
  parse_status   parse_status NOT NULL DEFAULT 'ok',
  model          text,
  input_tokens   integer,
  output_tokens  integer,
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  raw_output     text,                      -- kept so unparseable results are auditable
  PRIMARY KEY (run_id, pkg_name, as_of_date, policy),
  CONSTRAINT score_present_unless_unanswered
    CHECK (score IS NOT NULL OR abstain OR parse_status <> 'ok')
);

CREATE INDEX policy_score_policy_idx ON policy_score (run_id, policy);

-- ---------------------------------------------------------------------------
-- (7) prediction: the prospective arm's sealed ledger
-- ---------------------------------------------------------------------------
-- Written daily, committed to git the same day. The git timestamp is the proof
-- that a prediction preceded its outcome. See BLUEPRINT.md section 9.

CREATE TABLE prediction (
  pkg_name      text          NOT NULL,
  predicted_on  date          NOT NULL,
  policy        text          NOT NULL,
  score         double precision,
  abstain       boolean       NOT NULL DEFAULT false,
  sealed_hash   text          NOT NULL,     -- sha256 over the row's scored inputs
  resolved_at   date,                       -- set when an outcome lands, never edited before
  resolved_kind outcome_kind,
  PRIMARY KEY (pkg_name, predicted_on, policy)
);

CREATE INDEX prediction_unresolved_idx ON prediction (predicted_on)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- (8) run: one scoring run, and what it spent
-- ---------------------------------------------------------------------------

CREATE TABLE run (
  id             bigserial   PRIMARY KEY,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  universe_hash  text        NOT NULL REFERENCES universe(universe_hash),
  scoring_date   date        NOT NULL,
  budget_usd     numeric(12,6),             -- hard ceiling; the runner aborts past it
  spent_usd      numeric(12,6) NOT NULL DEFAULT 0,
  dry_run        boolean     NOT NULL DEFAULT true,
  notes          text
);

ALTER TABLE policy_score
  ADD CONSTRAINT policy_score_run_fk FOREIGN KEY (run_id) REFERENCES run(id);

INSERT INTO schema_migration (filename) VALUES ('001_init.sql');

COMMIT;
