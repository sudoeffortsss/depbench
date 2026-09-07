# FINDINGS

Things this project assumed, tested, and had to change. Newest first.

Every entry follows the same shape: what we believed, what we ran, what came back,
what changed. Everything here was measured. Nothing here was reasoned into
existence. The probe scripts are in `probe/` and run with a fixed seed.

Every finding below predates the first policy score. That is deliberate: the cheapest
time to discover that your ground truth is wrong is before you have built anything on
top of it. Four of the seven overturned an assumption we had already written into the
design.

---

## F11 · First numbers, and two of our own guardrails were broken

**2026-09-06** · stage 5 and 6, rule policies only, zero cost

**The result.** Five deterministic policies, 1,915 packages, 383 cases.

```
policy          AUC   scored abstain no_ans  top10% falseflag
popularity    0.539    99.4%   0.1%   0.5%   15.1%  30.0%
random        0.512    99.5%   0.0%   0.5%    9.9%  48.2%
cadence       0.471    98.1%   1.5%   0.5%    8.6%   0.0%
composite     0.461    99.5%   0.0%   0.5%    7.6%   8.4%
age           0.451    99.5%   0.0%   0.5%    8.6%   0.0%

policies beating popularity: none
```

**Nothing beats download count, and download count barely beats chance.** 0.539 against
a 0.512 floor. The three policies built from actual health signals — staleness, cadence
collapse, an aggregate blend — all land *below* chance.

**The direction is inverted, and cleanly so.** Comparing raw features between the groups:

```
              n     days stale   rel/90d      downloads    has repo
controls   1,523           99      13.79      8,786,204         93%
cases        383           81      11.70     22,439,167         98%
```

Packages that received an advisory were **fresher** (81 days versus 99 since last
publish), **2.6x more downloaded**, and **more likely to have a public repository**.

This is F4 arriving in the metrics rather than in the sampling. A vulnerability has to
be *found*. Active, popular, publicly developed packages get audited; quiet ones do not.
**"Stale means risky", the intuition the entire category is built on, points the wrong
way against this ground truth** — not because staleness is safe, but because staleness
is invisible.

**Before publishing any of that, three suspicions were checked. Two were our own bugs.**

**Bug one: "top decile" was not a decile.** `cadence` reported 32.1% case recall in its
riskiest tenth, which looked like a real signal hiding under a bad AUC. It was not. 704
of cadence's 1,878 scores sit at exactly 1.000, so `score >= quantile(0.9)` landed inside
that tie block and silently selected the top **37.5%**. Against a 37.5% slice, 32.1% is
worse than chance. Fixed to take a fixed-size slice; the number fell to 8.6% and the
"finding" evaporated.

**Bug two, introduced while fixing bug one.** The first fix broke ties by package name.
In the unit test where a policy flags everything identically, alphabetical order put
every `case*` ahead of every `ctl*`, and the guardrail reported a **0% false flag rate
for a policy that flags literally everything**. The test caught it within a minute. Ties
are now shared proportionally: a policy whose scores are one flat block gets the
universe's own composition back, which is the honest answer for a policy that expressed
no preference.

**A third suspicion was not a bug, and saying so matters.** `composite` scores span only
0.005 to 0.767 with a median of 0.19, which looked like a crushed signal. AUC depends
only on ordering, so the compression changes nothing: 0.461 is 0.461 either way.
Rescaling would have made the table prettier and the conclusion identical. It was not
done.

**What this episode is really about.** Every AUC in the table above was correct from the
first run. Both bugs were in the numbers we would have used to *explain* the AUCs, and
one of them manufactured a signal that was not there. A benchmark that only checks its
headline is not checking the part most likely to mislead it.

---

## F10 · Two undocumented API shapes, caught because the arithmetic did not add up

**2026-09-06** · stage 4, fetching exact 2022-12 download volume

**Assumed.** The npm downloads point endpoint takes up to 128 package names and returns a
dictionary keyed by name. One code path handles every case.

**Ran.** Fetched the December 2022 figure for all 1,915 universe members.

**Came back, twice.**

**First: a scoped package poisons the entire batch.**

```
15 batches, 7 failed outright, 896 packages with no figure
{"error":"scoped packages are not currently supported in bulk lookups"}
```

One `@babel/core` in a batch of 128 takes 127 innocent packages down with it. Not
documented anywhere we could find. Scoped names now go one at a time, which works fine
on the same endpoint.

**Second, and the more instructive one: the endpoint returns two different shapes.**

After splitting scoped names out, the numbers still refused to reconcile:

```
849 batches, only 11 failures
...yet 840 packages still had no figure
```

**Eleven failures cannot produce 840 missing values.** The arithmetic was the entire
clue. A bulk query returns `{ "chalk": {...}, "express": {...} }`; a single-package
query returns the record *flat*, `{"downloads": 169508056, "package": "@babel/core"}`,
with no key at all. Reading `body[name]` against a single response yields `undefined`
silently, forever, for every scoped package.

```
before   resolved 1,019   missing 896
after    resolved 1,904   missing  11
```

**Changed.** Both shapes handled explicitly. The remaining 11 overlap almost entirely
with the 9 packuments that genuinely could not be fetched; they stay as rows.

**Why this belongs in FINDINGS rather than a commit message.** Had 840 packages been
accepted as "just missing", `popularity` — the baseline every other policy has to beat —
would have been computed on 56% of the universe while looking entirely healthy. Nothing
would have errored. The leaderboard would have printed. **The only symptom was two
numbers that could not both be true**, which is precisely the class of failure this
benchmark was built to measure, arriving uninvited in our own ingest.

Also worth recording: 52 packages that cleared the 1,000-download threshold in the
2022-11-09 selection snapshot were below it by December. Seven weeks of drift, which is
why the exact figure is fetched rather than the snapshot value reused (F7).

---

## F9 · We checked npm and GitHub for the name, and forgot that research exists

**2026-09-06** · direct verification, prompted by an outside tip

**Assumed.** The project was called `depbench`. Availability had been checked: the npm
name was free and no repository of that name existed under the account. That felt like
diligence.

**Ran.** Verified two claims that a name collision existed, rather than taking them on
trust, and then searched the plain term.

**Came back.** Both claims were true, and understated.

| paper | arXiv | date | benchmark | scope |
|---|---|---|---|---|
| DepRepair | [2607.17957](https://arxiv.org/abs/2607.17957) | 2026-07 | **DepBench** | 95 real dependency-update instances |
| Update from Hell | [2608.30300](https://arxiv.org/abs/2608.30300) | **2026-08-31** | **DEPBENCH** | 203 tasks |

The second was submitted **six days before this repository existed**, and its 203 tasks
include **68 npm/yarn** ones. Not an unrelated field: the same ecosystem, a different
question. Searching the bare term returns both papers as the top three results.

A second candidate died the same way. `foretrace` is an operating security company with
a product line and a LinkedIn page, which is worse than an academic collision: same
sector, and a reader searching the name finds someone else's business.

**Changed.** Renamed to **truthlag**, after the thing three separate findings circle:
the median 31.5-month lag between a vulnerability existing and anybody publishing it
(F4, F5, F6). Verified across four surfaces this time rather than two: npm registry,
GitHub search across all of GitHub rather than one account, academic literature, and
operating companies. Zero hits on every one.

**The lesson is F7's, wearing a different face.** F7 said: before building a crawler,
look for the dataset. This one says: before claiming a name, look where names actually
live. Both are the same failure — checking the surfaces that are easy to check and
calling it done.

**Also changed: `*bench` is abandoned as a suffix.** SWE-bench, MTEB, LiveBench,
DepBench, PostTrainBench, LongCLI-Bench. New ones land monthly. Any name ending in
`bench` is a collision waiting for its turn.

---

## F8 · A consistency check fired, and the exception turned out to have a name

**2026-09-06** · stage 3 ingest and snapshot reconstruction

**Assumed.** npm provenance reached GA on 2023-09-26 and entered public beta in April
2023, both after our 2023-01-01 scoring date, so **no package** can carry an attestation
in a correct reconstruction. The snapshot builder asserts exactly that, on the reasoning
that if this is wrong then every other reconstructed field is suspect too.

**Ran.** Ingested packuments for all 1,915 universe members and rebuilt point-in-time
state.

**Came back.** The assertion fired. One package.

```
sigstore  v0.2.0  published 2022-12-08T16:18:41Z  attestation present
  32 of its 40 versions carry attestations
  earliest: 0.2.0 @ 2022-12-08, then 0.3.0 @ 2023-01-05, 0.4.0 @ 2023-01-11
```

`sigstore` is the signing infrastructure npm provenance is built on. **Its own team was
using its own mechanism four months before the public beta and nine months before GA.**
Textbook dogfooding, and it is the one package on the registry for which a pre-GA
attestation is not an anomaly.

**Changed.**

- The assertion is refined rather than removed: **one** pre-GA attestation is expected
  and named; two would still halt the run. Deleting the check because it fired would have
  thrown away the only thing standing between us and a silently wrong reconstruction
- F5's claim is made exact. "No package carried an attestation on the scoring date" was
  very nearly true and is now precisely true with one named exception. The `provenance`
  policy still cannot run retrospectively: a signal present on exactly one of 1,915
  packages has no discriminative power

**Why this is recorded at all.** The check cost nothing and caught something on its first
real run. That it turned out to be a true fact about the ecosystem rather than a bug is
the good case; the point is that a reconstruction producing 1,915 plausible rows would
have looked identical either way.

**Stage 3 results, for the record.**

```
ingest       1,915 attempted, 1,906 fetched, 9 failed
             failures stored as rows with a null payload, so they enter no_answer
             2,668 MB of raw packuments kept, gzipped, content-addressed
snapshot     1,906 reconstructed, 0 with no versions before D
             58 packages shipping an install hook on the scoring date
outcomes     383 advisory (strong), all on cases, zero on controls
             130 deprecated (weak), 89 abandoned under the tightened F2 definition
staleness    758 packages published within 30 days of D, 727 within a year, 2 beyond
```

The `controls_with_advisory = 0` check matters as much as the provenance one: it is what
proves the universe and the outcome join agree about who was hit.

---

## F7 · We rate-limited ourselves, then found the data already existed

**2026-09-06** · probe: direct rate measurement, then a search for prior art

**Assumed.** Filling the control bands needs a download ranking of the whole registry, so
we would enumerate all 4,362,870 packages against the npm downloads API. Roughly 34,000
batched requests.

**Ran.** Measured the sustainable request rate before committing to a three-hour job.

**Came back — first, a lesson about our own conduct.**

```
concurrency 1    8.2 req/s     0 x 429      <- first pass, looked fine
concurrency 3   44.3 req/s     6 x 429
concurrency 5   85.7 req/s    24 x 429      <- "fast" because every request was rejected
```

Then a sustained test, and the real picture:

```
concurrency 1   429 on 52/60 then 58/60   succeeded 10/120
```

The clean first result was the token bucket's initial allowance, not a sustainable rate.
**By probing aggressively we exhausted it and spent the rest of the test being refused.**
The plan had been to run 34,000 requests against a free public API overnight. We were
about to be a bad citizen at scale, and the only reason we found out is that we measured
first.

**Then the actual finding.** The right question was never "how fast may we hammer npm."
It was "has somebody already published this?" They had.
[ecosyste.ms](https://ecosyste.ms) publishes open data releases of its package database,
including **`packages-2022-11-09`**, an 8.91 GB dump whose S3 `Last-Modified` still reads
`Wed, 09 Nov 2022 10:46:31 GMT`.

That is strictly better than what we were going to build:

| | our exhaustive crawl | the ecosyste.ms snapshot |
|---|---|---|
| requests to npm | ~34,000 | **0** |
| time | ~3.5 hours | one download |
| look-ahead bias | none, if done carefully | **none, structurally** — the file was frozen before the scoring date |
| survivorship bias | none | none; the snapshot contains packages that have since died |
| verifiable | by trusting our code | **by an S3 timestamp anyone can check** |

**Changed.**

- Exhaustive crawling is abandoned. The universe is ranked from the 2022-11-09 snapshot
- The snapshot's own `Last-Modified` becomes part of the method's evidence: the ranking
  provably could not have seen the outcome period
- **Licensing was corrected before any data entered the repository.** The ecosyste.ms
  release is CC BY-SA 4.0, which propagates to anything derived from it. Code stays
  Apache-2.0; published datasets are CC BY-SA 4.0 with attribution. See `DATA_LICENSE.md`
- A standing rule, recorded because it nearly cost us three hours and some goodwill:
  **before building a crawler, look for the dataset**

**The residual cost, stated rather than hidden.** The snapshot is dated 2022-11-09 and the
scoring date is 2023-01-01, a gap of seven weeks. Download volumes shift in that time.
The snapshot is therefore used to *rank and select* candidates; the exact download figure
attached to each selected package is fetched from npm for the true 2022-12 window. That
is a few thousand requests, not thirty-four thousand.

---

## F6 · The 2026 advisory surge is real, but the early years are back-fill, and that is a fourth wall

**2026-09-05** · probe: `probe/stage0_backfill_check.py`

**The blocker.** 2026 alone holds 40% of every GHSA record in the npm corpus (2,930 of
7,317). Cases are selected on `published` falling inside the observation window, so if
GitHub had started importing older vulnerabilities in 2026, `published` would be an
import date rather than an event date and the window filter would be quietly pulling
2019-vintage vulnerabilities in as new ones. **The universe could not be frozen until this
was resolved.**

**Ran.** CVE identifiers carry their year, and that is free evidence sitting in the export
already. For every GHSA, compare its publication year against the oldest CVE it aliases.
A 2026 advisory aliasing `CVE-2019-xxxxx` is a back-fill. One aliasing `CVE-2026-xxxxx`
is a genuine new disclosure. Cross-checked against `database_specific.nvd_published_at`,
which is NVD's own date and independent of GitHub's ingestion.

**Came back.**

```
pub     total  no CVE  same yr  1 yr old  2+ yr old   % back-fill
2017       50       4       13         5         28        60.9%
2018      305      13       97       158         37        12.7%
2019      365      94       89        26        155        57.2%
2020      934     634      127        27        146        48.7%
2021      597      54      325       189         25         4.6%
2022      668      49      357        92        170        27.5%
2023      400      39      278        37         44        12.2%
2024      436      38      359        26         13         3.3%
2025      632      59      526        44          3         0.5%
2026     2930     424     2428        73          5         0.2%
```

**The blocker clears.** Of 2,930 advisories published in 2026, **five** alias a CVE two or
more years older. 0.2%. NVD agrees independently: 1,909 of them have an
`nvd_published_at` in 2026 and exactly one in 2025. Two separate sources say the same
thing. `published` tracks the event closely enough to use as the window filter, and the
case pool is sound.

**But the same table exposes a wall we had not found.** Read the early years:

- 2017: **60.9%** of advisories alias a CVE two or more years older
- 2019: **57.2%**
- 2020: **48.7%**, and 634 of that year's 934 records carry **no CVE alias at all** (68%)
- 2022: **27.5%**

**The GitHub Advisory Database was back-filling history at scale through about 2022.** In
those years `published` is an import date, not an event date. The 2020 shape — two thirds
of records with no CVE alias — looks nothing like 2026's 14%.

**Changed.**

- **A fourth constraint on the scoring date, and a harder one than we had.** F5 argued
  early dates were unusable because advisory counts were small. The real reason is worse:
  **in those years the dates themselves are not trustworthy.** A pre-2021 scoring date
  would filter on an import timestamp while believing it was filtering on an event
- **This makes 2023-01-01 a stronger choice, not a weaker one.** Back-fill has fallen to
  12.2% by 2023 and under 3.3% from 2024 on. The window sits almost entirely in the
  regime where publication tracks disclosure
- The blocker on freezing the universe is lifted

---

## F5 · The scoring date is boxed in on both sides, and one signal cannot be tested at all

**2026-09-05** · probe: direct API measurement, prompted by the question "why not use a
twenty year window?"

**Assumed.** The scoring date is a free parameter, and a longer observation window is
strictly better because more outcomes have had time to surface.

**Ran.** Walked the downloads API backwards to find where history ends, plotted GHSA
publication counts by year across the whole corpus, and checked when npm provenance
attestations actually became available.

**Came back — three separate walls.**

**(a) A signal we planned to test did not exist on the scoring date.**
npm provenance entered public beta in April 2023 and reached general availability on
2023-09-26. Our scoring date is 2023-01-01. **On that day, no npm package carried a
provenance attestation.** The `provenance` policy is not weak in the retrospective arm,
it is identically zero — there is no information there to be right or wrong about.

**(b) Download history stops, and stops silently.**

```
2021-03-01 .. 2021-09-01   express: 0 downloads
2021-10-01                 express: 18,061,497
2021-11-01                 express: 17,656,232
```

express did not have zero downloads in 2021. **The API returns `0` rather than an error
once you ask past roughly 2021-10** — a rolling window of about five years. A caller who
does not know this will compute a popularity ranking out of zeros and never see a
failure.

This is exactly the failure mode harness rule 1 exists to catch, found in our own
upstream data source: **a missing value rendered as a real one.** `null` and `0` look
identical, and here the API itself is the one doing the conflating.

**(c) Advisory coverage collapses going backwards, and it is not because software was
safer.**

```
2017     50
2018    305
2019    365
2020    934
2021    597
2022    668
2023    400
2024    436
2025    632
2026  2,930   <- 40% of all GHSA records, in one year
```

Pick a scoring date in 2017 and the case pool is empty, not because packages were sound
but because **nobody was cataloguing**. This is F4's scrutiny bias in its most extreme
form, expressed over time rather than over popularity.

**Changed.**

- **The scoring date is not a free parameter.** It is boxed in: no earlier than the
  download history boundary and the point where advisory cataloguing becomes meaningful,
  no later than the disclosure lag allows. 2023-01-01 sits 15 months clear of the left
  wall with 44 months of observation to the right. That is a constraint satisfied, not
  a preference
- **The `provenance` policy is removed from the retrospective arm** and tested only
  prospectively. Reporting AUC 0.5 for a signal that could not exist would have been
  a fabricated result, not a null one
- Ingestion asserts that a zero download figure at a date inside the supported window is
  genuinely zero, and treats out-of-window dates as `no_answer` rather than as zero

**Left open, and promoted to a blocker for the next stage.** 2026 alone accounts for 40%
of all GHSA records. Two possibilities with very different consequences: either
disclosure genuinely spiked, or GitHub began back-filling older vulnerabilities in 2026.
If it is back-filling, `published` dates are not event dates, and our in-window filter is
silently importing old vulnerabilities as new ones — which would corrupt the case pool.
**This must be resolved before the universe is frozen**, by checking whether the affected
version ranges of 2026 advisories point at old releases.

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
