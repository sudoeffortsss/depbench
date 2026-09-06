#!/usr/bin/env python3
"""Stage 0 probe 3: is the 2026 GHSA surge real disclosure, or back-filled history?

2026 alone holds 40% of every GHSA record in the npm corpus (2,930 of 7,317). That
matters because the case pool is selected on `published` falling inside the observation
window. If GitHub started importing older vulnerabilities in 2026, then `published` is an
import date rather than an event date, and the window filter is quietly pulling
2019-vintage vulnerabilities in as though they were new — which would corrupt every case.

The decisive evidence is free and already in the export: **CVE identifiers carry their
year**. A GHSA published in 2026 that aliases CVE-2019-xxxxx was almost certainly
back-filled. One that aliases CVE-2026-xxxxx is a genuine new disclosure.

Cross-checked against `database_specific.nvd_published_at`, which records when NVD
published, independent of when GitHub ingested it.
"""

import collections
import json
import re
import zipfile
from pathlib import Path

OSV_ZIP = "/tmp/osv_npm.zip"
OUT = Path(__file__).parent / "stage0_backfill_check_result.json"
CVE_YEAR = re.compile(r"CVE-(\d{4})-")


def main() -> None:
    z = zipfile.ZipFile(OSV_ZIP)

    # published year -> Counter of CVE alias years
    lag = collections.defaultdict(collections.Counter)
    # published year -> how many records had no CVE alias at all
    no_cve = collections.Counter()
    total = collections.Counter()
    # published year -> Counter of nvd_published year
    nvd = collections.defaultdict(collections.Counter)
    examples: dict[str, list] = collections.defaultdict(list)

    for name in z.namelist():
        if not name.endswith(".json"):
            continue
        try:
            d = json.loads(z.read(name))
        except Exception:
            continue
        vid = d.get("id", "")
        if not vid.startswith("GHSA-"):
            continue
        pub = (d.get("published") or "")[:4]
        if not pub:
            continue
        total[pub] += 1

        years = {
            m.group(1)
            for a in (d.get("aliases") or [])
            if (m := CVE_YEAR.search(a))
        }
        if years:
            # the oldest CVE year is the honest signal: back-fill shows up as an old alias
            oldest = min(years)
            lag[pub][oldest] += 1
            gap = int(pub) - int(oldest)
            if gap >= 2 and len(examples[pub]) < 5:
                examples[pub].append(
                    {"id": vid, "published": pub, "oldest_cve_year": oldest, "gap": gap}
                )
        else:
            no_cve[pub] += 1

        nvd_pub = ((d.get("database_specific") or {}).get("nvd_published_at") or "")[:4]
        if nvd_pub:
            nvd[pub][nvd_pub] += 1

    years_sorted = sorted(total)
    print("=== GHSA published year vs oldest CVE alias year ===")
    print(f"{'pub':<6} {'total':>6} {'no CVE':>7} {'same yr':>8} {'1 yr old':>9} {'2+ yr old':>10} {'%backfill':>10}")
    summary = {}
    for y in years_sorted:
        c = lag[y]
        same = c.get(y, 0)
        prev = c.get(str(int(y) - 1), 0)
        older = sum(v for k, v in c.items() if int(k) <= int(y) - 2)
        with_cve = sum(c.values())
        pct = (older / with_cve * 100) if with_cve else 0.0
        summary[y] = {
            "total": total[y],
            "no_cve_alias": no_cve[y],
            "cve_same_year": same,
            "cve_one_year_old": prev,
            "cve_two_plus_years_old": older,
            "pct_two_plus_years_old": round(pct, 1),
        }
        print(
            f"{y:<6} {total[y]:>6} {no_cve[y]:>7} {same:>8} {prev:>9} {older:>10} {pct:>9.1f}%"
        )

    print("\n=== cross-check: NVD publication year for 2026-published GHSAs ===")
    for k, v in sorted(nvd.get("2026", {}).items()):
        print(f"  nvd_published {k}: {v}")

    print("\n=== examples of 2+ year gaps in 2026 (if any) ===")
    for e in examples.get("2026", []):
        print(f"  {e['id']}  published {e['published']}  oldest CVE {e['oldest_cve_year']}  gap {e['gap']}y")
    if not examples.get("2026"):
        print("  none")

    verdict_pct = summary.get("2026", {}).get("pct_two_plus_years_old", 0)
    print("\n=== verdict ===")
    if verdict_pct >= 25:
        print(f"  BACK-FILL LIKELY: {verdict_pct}% of 2026 GHSAs alias a CVE 2+ years older.")
        print("  `published` is an import date. The window filter must switch to CVE year")
        print("  or nvd_published_at, and the case pool must be rebuilt.")
    else:
        print(f"  GENUINE DISCLOSURE: only {verdict_pct}% of 2026 GHSAs alias a CVE 2+ years older.")
        print("  `published` tracks the event closely enough to use as the window filter.")

    OUT.write_text(
        json.dumps(
            {
                "probe_date": "2026-09-05",
                "question": "is the 2026 GHSA surge back-filled history or real disclosure",
                "method": "CVE aliases carry their year; compare to GHSA published year",
                "by_published_year": summary,
                "nvd_published_year_for_2026": dict(nvd.get("2026", {})),
                "examples_2026_large_gap": examples.get("2026", []),
                "pct_2026_two_plus_years_old": verdict_pct,
            },
            indent=1,
        )
    )
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
