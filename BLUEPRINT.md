# truthlag — design

**2026-09-05, universe frozen 2026-09-06 · Allen Cai**

This document is the requirements record. Every requirement below is derived from a
publicly observable problem in the npm ecosystem, not from a guess about what would be
fun to build. `FINDINGS.md` records the seven places where measurement corrected the
design, four of which overturned something already written here.

**Current state:** universe frozen at 3,215 packages
(hash `e8c899ee68cef5daad5bef256f9ee650bb7cda838aa616cc6651c212a3bfbd97`).
No policy has been written and no score computed.

---

## 1. The question

**Do dependency risk signals work? Does any of them beat sorting by download count?**

Not another scanner. A ruler for the scanners.

---

## 2. Why this shape

The original plan was a product: decide, under a fixed nightly budget, which packages to
re-verify. Research killed it.

| why it died | evidence |
|---|---|
| no demand language for the core mechanism | four independent search axes for `rescan` / `nightly` / `budget` phrasing returned nothing |
| three of the intended signals already shipped | Dependabot's install-script and provenance alerts closed `completed` on 2026-02-13 |
| cooldowns are already free and default | pnpm 11 defaults `minimumReleaseAge` to 1440 minutes; Yarn and Deno the same |
| health scores are methodologically dead | R² of 9–12% predicting vulnerability counts, **and the sign is backwards** |
| the market has been tried and declined | comparable indie products score zero publicly |

But the same research exposed a gap nobody has filled: **everyone's signals are poor, and
nobody has measured them.**

- scanner false positive rate: **92%**
- malware detector decay over two years: 87.15% → **39.49%**
- Dependabot compatibility score coverage: **3.4%**, `unknown` in 98.5% of cases
- median npm vulnerability disclosure lag: **31.5 months**

A measuring instrument dodges every objection above. It does not need anyone to want it.
Dependabot emits signals; it does not evaluate them. Health scores being methodologically
weak is not an obstacle — it is the hypothesis.

---

## 3. Method: point-in-time reconstruction

**Return to a scoring date D, score each package using only what was knowable that day,
then look at what actually happened.**

**The feasibility insight:** we do not need three years of collected data. An npm
packument returns a package's entire version history with timestamps in a single request,
so "what did this package look like on 2023-01-01" is exactly reconstructible today.

### What cannot be reconstructed, stated plainly

| field | recoverable | note |
|---|---|---|
| version list and publish times | ✅ exact | packument `time` |
| release cadence and gaps | ✅ exact | derived from the above |
| per-version provenance attestation | ✅ | `dist.attestations` |
| daily download counts | ✅ | the downloads API keeps history |
| license, repository, engines | ✅ per version | |
| **maintainer list history** | ❌ **current value only** | the registry keeps no history |
| **when deprecation happened** | ❌ current flag only | flagged, but never timestamped |

**Maintainer change cannot be reconstructed, and it is one of the signals we would most
want to test.** That is a hard boundary of the retrospective arm. It is reported, not
hidden. The prospective arm (§9) begins accumulating it from 2026-09-05.

### Choosing the scoring date: it is boxed in, not picked

The scoring date is not a free parameter. Three measured walls close in on it (F5).

```
        data does not exist          usable            outcomes not yet surfaced
    |--------------------------|----------------|------------------------------|
                          2021-10          D = 2023-01                     2026-09
                                            ^ 15 months clear of the left wall
                                              44 months of observation to the right
```

**Left wall, hard.** The downloads API keeps roughly five rolling years and, past that,
**returns `0` rather than an error**. Without download volume at D there is no universe
filter and no `popularity` baseline, so D cannot precede about 2021-10.

**Left wall, softer but real.** GHSA coverage collapses going backwards: 50 records in
2017 against 2,930 in 2026. Not because software was safer, but because nobody was
cataloguing. A 2017 scoring date has an empty case pool.

**Right wall.** Median disclosure lag is about 31.5 months, so a recent D leaves most
outcomes still buried.

**2023-01-01 satisfies all three.** It is a constraint solution, not a preference, and
"why not a twenty year window" has a measured answer: the data for one does not exist.

**Known cost of this choice.** npm provenance reached GA on 2023-09-26, after D, so **no
package carried an attestation on the scoring date.** The `provenance` policy is
therefore removed from the retrospective arm rather than reported as a 0.5 AUC that
would look like a result and be an artefact. It is tested prospectively only.

---

## 4. Architecture: eight boxes

```
  1  universe      freeze the evaluation set, hash it
       |
  2  ingest        registry packuments, downloads, OSV export
                   autonomous, idempotent, content-hashed
       |
  3  snapshot      reconstruct what was knowable on D
       |
  4  policies      cheap deterministic rules + LLM tier
       |
  5  outcomes      what actually happened after D
       |
  6  harness       score, and force no_answer / abstain into the report
       |
  7  report        static results page + CLI
       :
  8  prospective   seal today's predictions daily, let time verify them
```

### 1 · universe

A benchmark whose question set moves cannot compare runs. The set is frozen once and
identified by a hash of its sorted members; every score and report carries that hash.

**The trap: today's top-N destroys the benchmark.** Packages still on today's leaderboard
are survivors. Many that rotted between 2023 and 2026 have fallen off it, so building the
universe from today's rankings systematically excludes the outcomes we are trying to
predict — and biases every result in the flattering direction.

Measured proof: `request` did **70,489,266** downloads in 2022-12 and is deprecated
today; `left-pad` did 8,844,841 and likewise. Both belong in the universe precisely
because they are the outcome.

**Selection, as of D rather than today.** The candidate pool is the whole registry via
`replicate.npmjs.com/_all_docs` (4,362,870 packages, paginate with `startkey` — `skip` is
rejected). Ranking uses **2022-12** download volume, which contains no post-D information.

**Case-control, not a cohort.** From `FINDINGS.md` F4:

```
in-window GHSA advisories                  4,334
  -> distinct packages affected            1,633
  -> existed before D                      1,101
  -> also active in the year before D         823
  -> also >= 1,000 downloads in 2022-12       643   <- cases

     (this last step read 383 until 2026-09-07. The download lookup batched 128 names
      at a time and npm rejects any batch containing a scoped name outright, so every
      scoped package and its batch-mates were silently dropped. See FINDINGS.md F14.)

controls: ~1,530, matched about 1:4 on download band and pre-D activity
universe:  ~1,900 packages
```

**The cost of this design, which must be stated in the method.** Under case-control the
positive rate is chosen by the designer, not by nature, so `precision@k` is not directly
interpretable. **AUC is the headline metric.** The true base rate cannot be estimated
from this design, and any absolute figure carries that caveat.

**Pre-registration.** The selection rule is committed and pushed *before* outcomes are
pulled. The public git timestamp replaces "trust me" — the same principle as §9.

### 2 · ingest

| source | endpoint | provides |
|---|---|---|
| npm registry | `registry.npmjs.org/<pkg>` | versions, timestamps, provenance |
| npm downloads | `api.npmjs.org/downloads/point/<range>/<pkgs>` | historical volume |
| OSV | bulk export `npm/all.zip` | advisories with affected ranges |

**Idempotency is the `UNIQUE (source, external_id, content_hash)` constraint itself**, not
a check standing next to one. A second ingest over unchanged data inserts zero rows.
`src/db/migrate.test.ts` proves this rather than asserting it.

**Measured limits (F1):** downloads bulk caps at **128** per request and returns 429s
above roughly 3 req/s, so ingestion throttles and backs off exponentially. The registry
itself is generous.

### 3 · snapshot

Reconstructs each package as of D into its own table, so a bug in reconstruction is a
recompute rather than a re-crawl.

---

## 5. Data model

Eight tables, plain SQL migrations, no ORM. See `db/migrations/001_init.sql`.

`observation` is append-only and keeps raw payloads, including failed fetches — that is
what makes `no_answer` computable instead of invisible. Everything downstream derives
from it.

Two schema-level invariants worth calling out:

- `universe_counts_add_up` — a universe whose case and control counts do not sum to its
  member count cannot be inserted
- `score_present_unless_unanswered` — a score row with no score, no abstention, and a
  clean parse status would vanish from every metric unnoticed. The database rejects it.

---

## 6. Policies

**Tier one, deterministic, whole universe, effectively free:**

`random` (the floor) · `popularity` (**the control group that matters**) · `age` ·
`cadence` · `composite` · `budget-triage`

`provenance` is absent by necessity, not oversight: the feature postdates the scoring
date, so there is nothing to measure retrospectively (F5). It runs in the prospective
arm only.

On `budget-triage`, honestly: the original justification was "LLM calls are expensive, so
triage is mandatory." Measurement showed the full LLM sweep costs about ten dollars, so
that argument does not hold and is not used. Its real place here is as a deliberate
experimental condition — *if you could only inspect 5% of packages, what order maximises
return?* — which remains a good question without a manufactured cost story.

**Tier two, language models, same universe:**

Models read what metadata cannot see: README and changelog wording, install script
contents, maintainer handover notices. Output is strict JSON with an explicit abstain:

```json
{ "risk": 0.0, "reason": "", "evidence_quote": "", "abstain": false }
```

Unparseable output, timeouts and refusals all become `no_answer` and stay in the
denominator. **This is the tier that makes the harness rules load-bearing** — rules rarely
fail to parse; models do it constantly.

| policy | model | $/1M in | $/1M out |
|---|---|---|---|
| `llm-flash-lite` | Gemini 3.1 Flash-Lite | 0.25 | 1.50 |
| `llm-haiku` | Claude Haiku 4.5 | 1.00 | 5.00 |
| `llm-sonnet` | Claude Sonnet 5 | 2.00 | 10.00 |

Three tiers turn model choice into a measured axis rather than a defended decision.

---

## 7. Harness

**Rule 1 — anything unanswerable stays in the denominator.** Unreachable packages, 404
advisories, unparseable model output: recorded as `no_answer`, never dropped. A CVSS 9.5
advisory (`GHSA-2xp9-vwfh-vxw4`) currently 404s from both the GitHub and OSV APIs; a user
reported "even our socket.dev scans returned nothing." Excluding records like that is how
a headline number becomes false.

**Rule 2 — abstention is scored apart from error.** Report the abstention rate and how
often abstaining was correct.

**Rule 3 — the headline refuses to compute without rules 1 and 2.** `truthlag score` exits
with an error rather than print a number it cannot support. This is demonstrable: comment
out the reporting and watch it refuse.

> Rule 3 is not our idea. Andrew Nesbitt of ecosyste.ms said it better: treating a missing
> signal as a low score is the most serious available error, because rendered out, `null`
> and `0` look identical. truthlag turns that into an assertion that halts.

**Guardrails, because a headline can be gamed:**

| metric | catches |
|---|---|
| **AUC** | the headline; case-control makes `precision@k` uninterpretable |
| `high_severity_miss_rate` | policies that only catch easy cases |
| `active_package_false_flag_rate` | policies that flag everything |
| `abstain_rate` + `abstain_hit_rate` | how much it declines, and whether declining was right |
| `no_answer_rate` | how much of the denominator is unanswerable |
| `cost_per_correct` | **accuracy per dollar, not accuracy alone** |

---

## 8. Cost control

Universe of 3,215 packages at **2,320 input and 200 output tokens each** — measured on 20
point-in-time tarballs with the README capped at 8,000 characters, not assumed — batch
pricing at 50%, cached rubric prefix at ~0.1× read:

| tier | scope | published cutoff | cost |
|---|---|---|---|
| 0 | rules only, no LLM | n/a | **$0** |
| 1 | Gemini 2.5 Flash-Lite, full universe | 2025-01 | ~$0.50 |
| 2 | Claude Haiku 4.5, full universe | 2025-07 | ~$5.34 |
| 3 | Claude Sonnet 5, full universe | 2026-01 | ~$10.67 |

**All three arms ≈ $16.51. Hard ceiling $50.**

The earlier figure here was ~$20 against a 5,000-token guess and a Gemini 3.x arm that
turned out to publish no training cutoff. Both were corrected: see `FINDINGS.md` F15 for
why the cutoff column is a precondition for running an arm rather than a spec detail.

Cost control is built in, and is itself part of the demonstration:

1. **dry-run by default** — counts tokens, prints the projected spend, exits without
   spending anything
2. **a hard budget gate** — actual spend accumulates from `response.usage`; exceeding the
   ceiling throws rather than warns
3. **spend is persisted per score**, so the report shows accuracy and cost together

---

## 9. The prospective arm

Every backtest carries the same unfixable problem: we already know how the story ended.
Even without cheating, hindsight leaks into feature choice and threshold tuning.

The prospective arm has no such problem. A daily GitHub Action snapshots current state,
runs every policy, writes `predictions/YYYY-MM-DD.jsonl`, commits, and checks whether
earlier predictions have resolved.

**The git history is a public, timestamped, tamper-evident ledger.** Anyone can verify
the prediction preceded the outcome.

Public repositories get unlimited free standard runners, so this costs nothing. Two
caveats: scheduled workflows on public repos are silently disabled after 60 days of
inactivity, and cron has a five-minute floor and defaults to UTC.

**It will not produce a meaningful result for a long time** — low base rate, slow
disclosure. Its near-term value is that it is running, that N days of predictions are
sealed, and that the design demonstrates the overfitting problem is understood. Saying so
plainly is the point.

Side benefit: recording the maintainer list daily begins accumulating the one signal the
retrospective arm cannot reach.

---

## 10. Deliverables

**Ninety seconds** — a static results page on GitHub Pages: the leaderboard, the
guardrails beside it, the prospective counter ticking up. Sortable columns, one toggle.
No live dashboard; research showed standalone dashboards go unread, and a job search is
no time to operate a service.

**Ten minutes** — this document and `FINDINGS.md`, every finding reproducible by command.

**Thirty seconds, live** — the CLI refusing to print a headline it cannot support, then
printing it once the unknowns are reported.

Plus the versioned dataset as JSONL so results can be checked and cited, and a LICENSE,
because an unlicensed public repository cannot legally be used or built on.

---

## 11. Publication

Public from the start, because pre-registration only means something if the timestamps
are public.

Three risks and what we do about them:

**Naming products invites a fight.** We evaluate *signal types*, not vendor products.
"Popularity-dominated ranking achieves X" rather than "vendor Y is bad." This is also the
more honest claim, since proprietary scoring cannot be replicated anyway.

**Naming packages harms people.** 60% of maintainers are unpaid and nearly six in ten have
considered quitting. Aggregate metrics and methodology are published; package names stay
in the dataset because reproducibility requires it and the data is already public. **No
"risky packages" leaderboard.** This is retrospective analysis, not a prediction service.

**Being wrong in public.** LIMITATIONS leads rather than trails. Naming your own weakest
point first is the best available defence, and it is more persuasive than any number.

Release in three stages: public repo without promotion; then a LinkedIn post once there
are findings; then wider only if the result is genuinely surprising and defensible.

---

## 12. Build order

| stage | work | state |
|---|---|---|
| 0 | measure API limits and base rates | ✅ F1 to F4 |
| 1 | schema, migrations, idempotency proofs | ✅ 10 tables |
| 2 | freeze the universe, commit the rule first | ✅ 3,215 packages, hash `00ecc34b2137ea` |
| 3 | ingest and snapshot reconstruction | ✅ 3,204 of 3,215, F8 |
| 4 | `random` and `popularity` baselines | ✅ shipped with all five rule policies |
| 5 | outcomes, harness, guardrails | ✅ F11–F14 fixed six defects in our own code |
| **6** | **first numbers, rules only, $0** | ✅ **nothing beats download count** |
| 7 | remaining rule policies | ✅ folded into stage 4 |
| 8 | cost control and the LLM policy interface | ✅ built, **deliberately unrun** |
| 9 | the three model arms | ⏸ **registered, not executed** — see below |
| 10 | results page and CLI | ✅ |
| 11 | prospective arm | ✅ running daily |

**The model arms are built and left unrun on purpose.** The interface, the cost gate, and
the dry-run estimator all exist and are tested; what has not happened is a paid
execution. `truthlag estimate` prints the projected spend for each arm and exits without
calling anything. Running them is a decision with a dollar figure attached, and the
project should not make that decision quietly on someone's behalf.

Everything reported so far cost nothing to produce.

Stack: TypeScript throughout, Node 22+, PGlite, plain SQL migrations, Vercel AI SDK for
multi-provider access, vitest.

---

## 13. Non-goals

Not a live dashboard. Not a SaaS. Not a competitor to Dependabot, Socket or Snyk — we
evaluate the *kinds of signal* they emit. Not a predictor of the next supply chain
attack. Not a risky-package leaderboard. Not a claim about npm as a whole; the universe
is packages with real usage and real advisories.

---

## 14. Open questions

1. The tightened `abandoned` threshold, once the control group's distribution is visible
2. Which variables controls are matched on beyond download band
3. Whether to add the GitHub API for archived status — one more source, one more limit
4. Whether the prospective arm shares the retrospective universe (leaning yes)
5. ~~Why in-window GHSA counts jump in 2026~~ — **promoted to a blocker on stage 2,
   see below**

## 14a. Resolved: the 2026 surge is real disclosure, not back-fill

2026 holds 40% of every GHSA record, which threatened the case pool: if those were
back-filled older vulnerabilities, `published` would be an import date and the window
filter would import old vulnerabilities as new.

**Resolved (F6).** CVE identifiers carry their year. Of 2,930 advisories published in
2026, **five** alias a CVE two or more years older — 0.2%. NVD agrees independently.
`published` is usable as the window filter.

**But the same check found a fourth wall on the scoring date.** The Advisory Database was
back-filling at scale through about 2022: 60.9% of 2017 records alias an older CVE, 57.2%
in 2019, and 68% of 2020 records carry no CVE alias at all. **In those years the dates
themselves are untrustworthy**, which is a harder constraint than the thin counts noted in
F5. Back-fill falls to 12.2% by 2023 and under 3.3% from 2024, so the chosen window sits
almost entirely in the regime where publication tracks disclosure.

**The universe can now be frozen.**

---

## 15. Relation to prior art

The shape of a benchmark — a model asked for one structured judgement, deterministic
scoring, parse failures counted separately, guardrails beside the headline — is ordinary
evaluation engineering, visible in any public benchmark repository.

Two structural properties distinguish this one:

**Ground truth is real history, not hand labelling.** No expert annotation budget caps the
sample size, and the "synthetic cases drift from real distributions" problem does not
arise. The cost is right-censoring, which hand-labelled benchmarks do not have.

**There are trivial baselines.** The question is not "which model is best" but **"is any
of this worth using at all"** — which is the question more likely to produce an
uncomfortable answer.
