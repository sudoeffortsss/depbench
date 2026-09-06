# Data licensing and attribution

The code in this repository is Apache-2.0 (see `LICENSE`). **Data is licensed
separately**, because some of it is derived from sources with share-alike terms.

## Derived data: CC BY-SA 4.0

Any dataset published by this project — the frozen universe, per-package snapshots,
policy scores, and the prospective prediction ledger — is licensed
**[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)**.

That is not a preference. It is required by the licence of one of our upstream sources,
and it propagates to anything derived from it.

## Upstream sources and their terms

| source | what we take | licence | attribution |
|---|---|---|---|
| **[ecosyste.ms](https://ecosyste.ms) open data release** `packages-2022-11-09` | package list and download volumes as of 2022-11-09, used to rank the universe as of the scoring date | **CC BY-SA 4.0** | © 2022 [Andrew Nesbitt](https://github.com/andrew) |
| **[OSV](https://osv.dev)** npm bulk export | `GHSA-*` advisories, affected version ranges, publication dates | CC BY-4.0 (per OSV terms) | OSV / open source security contributors |
| **npm registry** `registry.npmjs.org`, `api.npmjs.org` | packuments and download counts | public API, factual data | npm, Inc. |

## Why the 2022-11-09 snapshot specifically

The scoring date is 2023-01-01. A snapshot taken on 2022-11-09 **predates it**, so
ranking the universe from it cannot leak information from after the scoring date. The
file's S3 `Last-Modified` header still reads `Wed, 09 Nov 2022 10:46:31 GMT`, which is
independently checkable evidence that the data was fixed before the period we evaluate.

Using today's download figures instead would have been look-ahead bias of the most
flattering kind: a package that died would show low volume now, and `popularity` would
appear to predict death.

## Attribution, plainly

This benchmark would be materially worse without ecosyste.ms. Andrew Nesbitt publishes
the historical snapshots that make point-in-time reconstruction possible at all, and a
line of his — that treating a missing signal as a low score is the most serious available
error, because rendered out `null` and `0` look identical — is the reason harness rule 3
exists. Both debts are acknowledged deliberately rather than buried in a footnote.
