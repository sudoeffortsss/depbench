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

**Retrospective arm complete. Model arms built and deliberately unrun.**

```
policy          AUC           95% CI  scored abstain no_ans  top10% falseflag
popularity    0.529   [0.503, 0.553]   99.5%   0.2%   0.3%   12.6%  32.8%
random        0.504   [0.479, 0.529]   99.7%   0.0%   0.3%    9.5%  47.5%
cadence       0.402   [0.381, 0.424]   98.6%   1.1%   0.3%    5.9%     n/a*
composite     0.372   [0.348, 0.394]   99.7%   0.0%   0.3%    5.3%   8.1%
age           0.357   [0.334, 0.380]   99.7%   0.0%   0.3%    5.6%     n/a*

policies beating popularity: none
* falseflag cannot be anything but 0 for a staleness-ranked policy. See F12.
```

**Nothing beats download count, and download count barely beats chance** — 0.529 against
a 0.504 floor, with an interval whose lower bound is 0.503. The three policies built from
actual health signals land far *below* chance, and the raw features say why:

```
              n   days stale   rel/90d   versions      downloads   repo   install hook
controls  2,572        110.9     14.63      138.8      8,141,850    92%           1.6%
cases       643         65.5     17.63      229.9     15,400,220    97%           6.2%
```

Packages that received an advisory were **fresher by 45 days**, shipped **more often**,
had **1.7x the version history**, were **1.9x more downloaded**, and were more likely to
be developed in public. Every health signal points the wrong way. The one exception is
the install hook, at 6.2% against 1.6% — the only input here that is a risk marker rather
than a health marker.

"Stale means risky" is inverted against this ground truth, not because staleness is safe
but because staleness is *invisible*: a vulnerability has to be **found**, and nobody
audits a package nobody uses. Inverted, `age` scores 0.643, the best number in the
benchmark.

> These figures replace an earlier run on 383 cases. A bug in the case-pool probe had
> silently dropped every scoped package, including `ajv`, `axios` and `body-parser`. The
> repaired set is 68% larger and the effect is roughly twice the size. What the broken
> sample removed was biased toward the conventional wisdom. See **[F14](FINDINGS.md)**.

**[Full results page →](https://sudoeffortsss.github.io/truthlag/)**

Everything above cost nothing to produce. No model was called.

| stage | state |
|---|---|
| API feasibility, ground truth, scoring date | ✅ F1–F7 |
| schema and migrations | ✅ 10 tables |
| universe frozen | ✅ 3,215 packages, hash `00ecc34b2137ea` |
| ingest and reconstruction | ✅ 3,204 of 3,215, F8 |
| rule policies and harness | ✅ 42 tests, F11–F14 |
| **first numbers** | ✅ **above, $0** |
| model arms | ⏸ built and registered, cutoffs verified (F15), **deliberately unrun** |
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
preceding year. That yields **643 cases**. Match each roughly 1:4 with controls at the
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

| policy | model | published cutoff | cases pre/post | batched |
|---|---|---|---|---|
| `llm-flash-lite` | Gemini 2.5 Flash-Lite | 2025-01 | 312 / 331 | $0.50 |
| `llm-haiku` | Claude Haiku 4.5 | 2025-07 | 377 / 266 | $5.34 |
| `llm-sonnet` | Claude Sonnet 5 | 2026-01 | 457 / 186 | $10.67 |

Three model tiers turn "which model" into an axis the benchmark measures rather than a
decision someone has to defend: **how much accuracy does four times the price buy?**
Every score carries its own token count and dollar cost, so the report can show accuracy
and cost per correct answer side by side.

**The cutoff column is a hard requirement, not documentation.** Every case in the
evaluation set carries a GHSA publication date, and a model trained past that date may be
recalling the advisory rather than predicting it. The only defence is to split the cases
at the model's cutoff and compare the strata, so `assertStratifiable()` refuses to price
or run an arm whose cutoff is unpublished, or whose split leaves a stratum too small to
tell its own AUC from chance.

That requirement cost us the obvious choice. `gemini-3.1-flash-lite` was registered here
first; its model card states no cutoff at all. Nor do the newer 3.x cards help, because
where they do give a date they immediately hedge it — *"March 2026 … in others they may
experience the model's knowledge is limited to January 2025"* — which is not a boundary
anything can be split on. Gemini 2.5 Flash-Lite is the newest Gemini that publishes an
unhedged date, and it happens to split this set 312/331, the most balanced of the three.

Anthropic's own documentation disagrees with itself on Haiku 4.5, publishing *"Reliable
knowledge cutoff | Feb 2025"* and *"Training data cutoff | Jul 2025"* on the same page.
That is registered as an experiment rather than routed around: score both boundaries and
see which one performance actually steps at.

---

## Known limitations, stated first rather than last

**Advisories measure scrutiny, not danger.** 37% of our positives are packages doing over
a million downloads a month, against 5.2% of the eligible npm population they were drawn
from. A vulnerability has to be *found* to become an advisory, and nobody is looking at a
package with three downloads a month. This bias sits underneath everything here and
sampling cannot fix it. (`FINDINGS.md` F4)

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
