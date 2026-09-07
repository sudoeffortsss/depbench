# truthlag

**Do npm dependency risk signals actually predict anything?**

Everyone ranks packages by something: downloads, staleness, release cadence, provenance,
an aggregate health score. Almost nobody has measured whether those signals beat sorting
by download count.

truthlag is not another scanner. It is a ruler for the scanners.

It reconstructs what was knowable about a package on **2023-01-01**, scores it with
several competing policies using only information available that day, and then checks
what actually happened over the following three and a half years.

---

## Status

**Design and method are fixed. Data has not been collected yet. There are no results.**

```
policy          AUC   scored abstain no_ans  top10% falseflag
popularity    0.539    99.4%   0.1%   0.5%   15.1%  30.0%
random        0.512    99.5%   0.0%   0.5%    9.9%  48.2%
cadence       0.471    98.1%   1.5%   0.5%    8.6%   0.0%
composite     0.461    99.5%   0.0%   0.5%    7.6%   8.4%
age           0.451    99.5%   0.0%   0.5%    8.6%   0.0%

policies beating popularity: none
```

**Nothing beats download count, and download count barely beats chance.** The three
policies built from actual health signals all land below chance — and the raw features
say why:

```
              n     days stale   downloads    has repo
controls   1,523           99    8,786,204         93%
cases        383           81   22,439,167         98%
```

Packages that received an advisory were **fresher**, **2.6x more downloaded**, and more
likely to be developed in public. "Stale means risky" points the wrong way here, not
because staleness is safe but because staleness is invisible: a vulnerability has to be
*found*, and nobody audits a package nobody uses.

**[Full results page →](https://sudoeffortsss.github.io/truthlag/)**

Everything above cost nothing to produce. No model was called.

| stage | state |
|---|---|
| API feasibility, ground truth, scoring date | ✅ F1–F7 |
| schema and migrations | ✅ 10 tables |
| universe frozen | ✅ 1,915 packages, hash `e8c899ee68cef5` |
| ingest and reconstruction | ✅ 1,906 of 1,915, F8 |
| rule policies and harness | ✅ 38 tests, F11 |
| **first numbers** | ✅ **above, $0** |
| model arms | ⏸ built and registered, **deliberately unrun** |
| prospective arm | ✅ sealing daily |

`npm run estimate` prints what running the model arms would cost ($20.30 batched across
all three) and exits without calling anything. Spending is a decision with a number
attached; the project does not make it quietly.

Read [`FINDINGS.md`](./FINDINGS.md) first — it is the most useful thing in here.

---

## The three rules that make this a benchmark and not a dashboard

**1. Anything unanswerable stays in the denominator.**
A package that could not be fetched, an advisory that 404s, a model response that will
not parse — each is recorded as `no_answer`, never dropped. There is precedent for why
this matters: a CVSS 9.5 advisory (`GHSA-2xp9-vwfh-vxw4`) returns 404 from both the
GitHub and OSV APIs today. Silently excluding records like that is how "94% of packages
are healthy" becomes a lie.

**2. Abstention is scored separately from being wrong.**
A policy may decline to answer and say how much evidence it had. We report the
abstention rate *and* how often abstention was the right call.

**3. The headline metric refuses to compute if 1 and 2 are missing.**
`truthlag score` exits with an error rather than print a number it cannot stand behind.

> The idea behind rule 3 is not ours. Andrew Nesbitt, who runs ecosyste.ms, put it
> better: treating a missing signal as a low score is the most serious error you can
> make, because rendered out, `null` and `0` look identical. truthlag turns that
> sentence into an assertion that halts the program.

---

## Method in one paragraph

Take the 4,334 `GHSA-*` advisories published between 2023-01-01 and 2026-09-01, resolve
them to the npm packages they affect, and keep the ones that were genuinely alive on the
scoring date — at least 1,000 downloads that month and at least one release in the
preceding year. That yields **383 cases**. Match each roughly 1:4 with controls at the
same download volume and activity level. Reconstruct every package's state as of
2023-01-01 from registry data that still exists today. Score with competing policies,
including two that must be beaten for any of this to matter: `random` and `popularity`.
Compare against what actually happened.

Malware advisories (`MAL-*`) are excluded on purpose. They are 96.8% of the npm advisory
corpus and a completely different phenomenon. See `FINDINGS.md` F3.

---

## Policies under test

Cheap deterministic policies score every package:

| policy | what it uses |
|---|---|
| `random` | nothing — the floor. A signal that cannot beat this is noise |
| `popularity` | download rank alone — **the control group that matters** |
| `age` | days since last publish |
| `cadence` | change in release rhythm |
| `composite` | a weighted blend, in the style of an aggregate health score |

`provenance` is missing on purpose: npm provenance reached GA in September 2023, after
the scoring date, so no package had an attestation to measure. It runs in the
prospective arm only. See `FINDINGS.md` F5.

Then language models read what the metadata cannot see — README and changelog wording,
install script contents, maintainer handover notices — and return a structured judgement
with an explicit abstain option:

| policy | model |
|---|---|
| `llm-flash-lite` | Gemini 3.1 Flash-Lite |
| `llm-haiku` | Claude Haiku 4.5 |
| `llm-sonnet` | Claude Sonnet 5 |

Three model tiers turn "which model" into an axis the benchmark measures rather than a
decision someone has to defend: **how much accuracy does four times the price buy?**
Every score carries its own token count and dollar cost, so the report can show accuracy
and cost per correct answer side by side.

---

## Known limitations, stated first rather than last

**Advisories measure scrutiny, not danger.** 45% of our positives are packages doing over
a million downloads a month. A vulnerability has to be *found* to become an advisory, and
nobody is looking at a package with three downloads a month. This bias sits underneath
everything here and sampling cannot fix it. (`FINDINGS.md` F4)

**Ground truth arrives late.** Median disclosure lag for npm vulnerabilities is about
31.5 months, so recent events are badly under-observed. The scoring date is set three and
a half years back for exactly this reason, and the residual bias is still real.

**Maintainer changes cannot be reconstructed.** The registry keeps only the current
maintainer list, with no history. That is one of the signals we would most want to test,
and the retrospective arm simply cannot test it. The prospective arm starts accumulating
it from 2026-09-05 onward.

**Case-control changes what the numbers mean.** The positive rate is set by the design,
not by nature, so `precision@k` is not directly interpretable and AUC is the headline
instead.

**The universe is not npm.** It is packages with real usage and real advisories. Nothing
here extrapolates to the 4.3 million package registry as a whole.

---

## Two arms

**Retrospective** produces the numbers, and carries the unavoidable problem of every
backtest: we already know how the story ended.

**Prospective** answers that. Every day, a GitHub Action snapshots the current state,
runs every policy, writes the predictions to `predictions/YYYY-MM-DD.jsonl`, and commits
them. The git history is a public, timestamped, tamper-evident ledger showing the
predictions were made before the outcomes existed.

It will not produce a meaningful result for a long time — the base rate is low and
disclosure is slow. It is running anyway, and saying so is the point.

---

## Reproducing this

The database is [PGlite](https://github.com/electric-sql/pglite): real Postgres compiled
to WASM, running in-process. No Docker, no server, nothing to install beyond npm
packages. That is a deliberate choice — a benchmark nobody can re-run is a blog post.

```bash
npm install
npm run migrate     # creates the schema
npm test            # 11 proofs, including that re-running ingest inserts zero rows
```

The probes behind every finding are in `probe/`, run with a fixed seed, and write their
raw results next to them as JSON.

---

## Documents

- **[`FINDINGS.md`](./FINDINGS.md)** — what we assumed, tested, and had to change. Start here.
- **[`BLUEPRINT.md`](./BLUEPRINT.md)** — the full design, including what we deliberately are not doing.

---

## Author

**Allen Cai** · [LinkedIn](https://www.linkedin.com/in/cheng-cai-woodmont/) · [GitHub](https://github.com/sudoeffortsss)

**Code Apache-2.0. Data CC BY-SA 4.0** — see [`DATA_LICENSE.md`](./DATA_LICENSE.md).
The share-alike term is inherited from [ecosyste.ms](https://ecosyste.ms), whose
historical open data release (© 2022 Andrew Nesbitt) is what makes point-in-time
reconstruction possible at all.

Corrections and refutations are welcome and will be credited — that is rather the point
of publishing the method before the results.
