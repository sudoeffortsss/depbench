# FINDINGS

Things this project assumed, tested, and had to change. Newest first.

Every entry follows the same shape: what we believed, what we ran, what came back,
what changed. Everything here was measured. Nothing here was reasoned into
existence. The probe scripts are in `probe/` and run with a fixed seed.

All four findings below predate the first line of schema. That is deliberate: the
cheapest time to discover that your ground truth is wrong is before you have built
anything on top of it.

---

## F4 · The base rate runs backwards: advisories concentrate in the most popular packages

**2026-09-05** · probe: `probe/stage0_ghsa_pool.py`

**Assumed.** Head packages are the best maintained, so the positive rate would be
lowest there and highest in the long tail, where abandonment actually happens. The
design had four download-ranked bands of 1,250 packages each, weighted accordingly.

**Ran.** Took every in-window `GHSA-*` advisory, resolved it to the npm packages it
affects, and filtered down to packages that were genuinely alive on the scoring date.

**Came back.**

```
in-window GHSA advisories                       4,334
  -> distinct packages affected                 1,633
  -> existed before D (2023-01-01)              1,101   (67%)
  -> also released in the year before D           823   (50%)
  -> also >= 1,000 downloads in 2022-12           383   <- usable positives

positives by 2022-12 download volume:
  1,000 - 10,000            42    11%
  10,000 - 100,000          76    20%
  100,000 - 1,000,000       92    24%
  1,000,000+               173    45%
```

**45% of positives are in packages doing over a million downloads a month.** The
assumption was not merely wrong. It was inverted.

**Why, once you see it.** A vulnerability has to be *found* before it can become an
advisory. A package pulling a million downloads a month has security researchers
reading it, bug bounties pointing at it, and scanners hitting it daily. A package
pulling three downloads a month has nobody looking at all. It may be riddled with
holes. It will never get a GHSA.

> **`GHSA-*` is not a measure of how dangerous a package is. It is a measure of how
> closely it was watched.**

That is an observation bias sitting underneath the entire benchmark, and no amount of
sampling fixes it. It can only be declared.

**Changed.**

- Band weights inverted; the universe is weighted toward high-download packages,
  because that is where verifiable outcomes exist at all
- Switched from a cohort to a **case-control design: 383 cases matched roughly 1:4
  with controls, for a universe of about 1,900 packages** rather than 5,000
- **Headline metric changed from `precision@k` to AUC.** Under case-control sampling
  the positive rate is set by the design, not by nature, so precision at a fixed
  budget is not interpretable without reweighting to a base rate we cannot estimate
- LLM cost fell from roughly $24 to under $10, the universe being a quarter the size
- This bias leads the LIMITATIONS section, stated plainly: **we can only evaluate
  signals against outcomes somebody bothered to look for**

---

## F3 · Ground truth is 97% malware advisories, and that would have broken the benchmark

**2026-09-05** · probe: OSV bulk export analysis

**Assumed.** Public OSV advisories give usable ground truth for "this package went bad."

**Ran.** Pulled the full npm export
(`osv-vulnerabilities.storage.googleapis.com/npm/all.zip`, 225 MB, 228,684 records)
and grouped by advisory ID prefix and publication year.

**Came back.**

```
MAL     221,365   (96.8%)
GHSA      7,317   ( 3.2%)
EEF/GSD       2

2025 alone:   MAL = 191,420    GHSA = 632
```

`MAL-*` and `GHSA-*` are not the same phenomenon:

| | `MAL-*` | `GHSA-*` |
|---|---|---|
| what it is | a package an attacker published **to be** malicious | a flaw found in a legitimate package |
| example | `Malicious code in cxp-jquery (npm)` | `Hono allows bypass of CSRF Middleware` |
| existed on the scoring date | mostly no, published later | yes |
| did it "go bad"? | no, it was born bad | **yes, and this is what we predict** |

**Why this would have broken the benchmark.** At thirty times the volume, `MAL-*`
drowns the real signal. Worse, most `MAL-*` packages did not exist on 2023-01-01, so
they cannot take part in a point-in-time backtest at all. Any policy that learned
"packages published in 2025 with no downloads are bad" would have scored beautifully
and measured nothing.

**Changed.** Ground truth is `GHSA-*` only, and the exclusion is stated loudly in the
method, because anyone reproducing this without the filter gets a completely different
and meaningless result. In-window (2023-01-01 to 2026-09-01) that leaves **4,334
advisories affecting 1,633 distinct packages**, an order of magnitude smaller than the
raw count and the right size for a case-control design.

`MAL-*` is kept, not discarded. "Can you spot a malicious package before it gets
flagged" is a legitimate benchmark. It is a different question and does not belong in
this one.

---

## F2 · "Abandoned" captured dead toys, not failures

**2026-09-05** · probe: `probe/stage0_base_rate.py` (seed 20260905)

**Assumed.** A package that stops publishing after the scoring date has gone bad, so
"no releases since D" is a usable outcome.

**Ran.** Sampled 700 packages across the registry, kept the 367 that existed before
2023-01-01, and measured the positive rate by 2022-12 download volume.

**Came back.**

```
bucket        n   positive   rate     dep   adv  aband
1-10        210        206  98.1%       6     0    206
10-100       98         86  87.8%       3     0     86
100-1K       38         21  55.3%       0     0     21
1K-10K       13          7  53.8%       0     0      7
10K-100K      3          1  33.3%       0     0      1
```

**313 of 322 positives (97.2%) rested on `abandoned` alone.** The packages it flagged
look like this:

```
rf-access-control     3 downloads/month     abandoned
rf-amazons3-upload    7 downloads/month     abandoned
rf-api-websocket      3 downloads/month     abandoned
```

Three downloads a month. These are not packages that went bad. **They are packages
that were never alive** — published once years ago and never touched again. A 98%
positive rate is not a finding, it is a definition eating itself: any policy that
learned "low downloads means bad" would have looked excellent and proved nothing.

**Also came back.** The sample is 84% packages under 100 monthly downloads, and none
at all above 100K. **A uniform random sample of npm is almost entirely dead weight.**

**Changed.**

- The universe is restricted to packages that were **alive at D**: at least 1,000
  downloads in 2022-12 **and** at least one release in the 12 months before D
- `abandoned` is tightened to "was actively releasing (3 or more releases in the year
  before D), then stopped completely" — stopping is only a signal if it was going
- Random sampling replaced by case-control on the GHSA pool (see F3)

**A flaw in our own probe, recorded because it would otherwise repeat.** Sampling used
two random letters as a CouchDB `startkey`, which returns runs of *consecutive*
packages — a block of `rf-*` packages all published by one author. That is
alphabetical cluster sampling wearing a random sampling costume. Future sampling must
decorrelate by taking few packages from many windows.

---

## F1 · The registry APIs allow the design, with two constraints worth building around

**2026-09-05** · probe: direct API measurement

**Assumed.** Historical reconstruction is possible and rate limits are the main risk.

**Ran.** Live probes against the replication endpoint, the registry, the downloads
API, and OSV.

**Came back.**

| finding | detail |
|---|---|
| `replicate.npmjs.com/_all_docs` works | reports **4,362,870** packages, so the candidate pool can be the entire registry, with no survivorship bias |
| `skip` is rejected | returns `"Bad Request"`; pagination must use `startkey` |
| the registry is generous | 30 sequential requests, 0 failures, 8 s, no rate-limit headers |
| **the downloads API caps bulk at 128** | 256 returns `400 exceeded max bulk size of 128` |
| **the downloads API throttles** | 40 sequential batches at 4.9 req/s returned **two 429s** |
| OSV has a batch endpoint | `/v1/querybatch` works; the bulk export is better still |

**Survivorship bias, demonstrated rather than asserted.** `request` did **70,489,266**
downloads in 2022-12 and is deprecated today. `left-pad` did 8,844,841 and is likewise
deprecated. Both would be absent from a universe built off today's top-N. **The
universe must be ranked as of the scoring date, not as of today.**

**Changed.** Downloads ingestion is capped at 128 per request, throttled below
3 req/s, with exponential backoff on 429. OSV uses the bulk export rather than
per-package queries.
