#!/usr/bin/env python3
"""Stage 2: extract an npm download ranking as of 2022-11-09 from the ecosyste.ms dump.

Why this file exists rather than a crawler: see FINDINGS.md F7. Enumerating 4.36M
packages against npm's downloads API would have been ~34,000 requests against a free
public service, and measurement showed we were already exhausting its rate limit while
merely probing it. ecosyste.ms publishes the same information as an open data release
that was frozen on 2022-11-09, before our 2023-01-01 scoring date, which makes it both
kinder and epistemically stronger: the ranking provably could not have seen the outcome
period.

Data licence: CC BY-SA 4.0, (c) 2022 Andrew Nesbitt / ecosyste.ms. See DATA_LICENSE.md.

The dump is a 9.15 GB pg_dump custom archive. We stream the `packages` COPY block through
pg_restore and keep only npm rows and only the columns we need, so peak memory stays
small.
"""

import csv
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

DUMP = os.environ.get(
    "TRUTHLAG_ECO_DUMP",
    "/private/tmp/claude-502/-Users-projects-Documents-Claude/"
    "1fbc2f1b-5c47-41b6-b4d3-d7ca590e0067/scratchpad/eco2022.pgdmp",
)
PG_RESTORE = "/opt/homebrew/opt/libpq/bin/pg_restore"
OUT_DIR = Path(__file__).parent
RANKING = OUT_DIR / "npm_ranking_2022-11-09.tsv"
SUMMARY = OUT_DIR / "stage2_extract_ranking_result.json"

# Column order comes from the COPY header in the dump; asserted at runtime rather
# than assumed, because a silently shifted column would corrupt everything downstream.
EXPECTED_COLUMNS = [
    "id", "registry_id", "name", "ecosystem", "description", "keywords", "homepage",
    "licenses", "repository_url", "normalized_licenses", "versions_count",
    "latest_release_published_at", "latest_release_number", "keywords_array", "language",
    "status", "last_synced_at", "created_at", "updated_at", "metadata", "repo_metadata",
    "repo_metadata_updated_at", "dependent_packages_count", "downloads",
    "downloads_period", "dependent_repos_count", "rankings",
]

KEEP = ["name", "downloads", "downloads_period", "versions_count",
        "latest_release_published_at", "dependent_packages_count",
        "dependent_repos_count", "status"]


def unescape(field: str) -> str:
    """Postgres COPY text format escapes. \\N means NULL."""
    if field == "\\N":
        return ""
    return (
        field.replace("\\t", "\t")
        .replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\\\", "\\")
    )


def main() -> None:
    if not Path(DUMP).exists():
        sys.exit(f"dump not found: {DUMP}")

    proc = subprocess.Popen(
        [PG_RESTORE, "--data-only", "-t", "packages", "-f", "-", DUMP],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=1024 * 1024,
    )

    in_copy = False
    total = npm = 0
    period_counts = Counter()
    band_counts = Counter()
    kept_idx: list[int] = []

    def band(dl: int) -> str:
        if dl >= 1_000_000:
            return "1M+"
        if dl >= 100_000:
            return "100K-1M"
        if dl >= 10_000:
            return "10K-100K"
        if dl >= 1_000:
            return "1K-10K"
        return "<1K"

    with open(RANKING, "w", newline="") as out:
        w = csv.writer(out, delimiter="\t", lineterminator="\n")
        w.writerow(KEEP)

        for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace")

            if not in_copy:
                if line.startswith("COPY public.packages "):
                    cols = line[line.index("(") + 1 : line.rindex(")")]
                    cols = [c.strip().strip('"') for c in cols.split(",")]
                    if cols != EXPECTED_COLUMNS:
                        sys.exit(
                            "COPY column order differs from expectation; refusing to "
                            f"parse.\n got: {cols}\nwant: {EXPECTED_COLUMNS}"
                        )
                    kept_idx = [cols.index(k) for k in KEEP]
                    in_copy = True
                    print(f"  column layout verified, {len(cols)} columns", flush=True)
                continue

            if line.startswith("\\."):
                break

            total += 1
            parts = line.rstrip("\n").split("\t")
            if len(parts) != len(EXPECTED_COLUMNS):
                continue
            if parts[EXPECTED_COLUMNS.index("ecosystem")] != "npm":
                continue

            npm += 1
            row = [unescape(parts[i]) for i in kept_idx]
            w.writerow(row)

            period_counts[row[KEEP.index("downloads_period")] or "(null)"] += 1
            dl_raw = row[KEEP.index("downloads")]
            band_counts[band(int(dl_raw)) if dl_raw.isdigit() else "(null)"] += 1

            if total % 2_000_000 == 0:
                print(f"  scanned {total:,} rows, npm {npm:,}", flush=True)

    proc.stdout.close()
    proc.wait()

    print(f"\n=== scanned {total:,} package rows, kept {npm:,} npm rows ===")
    print("\ndownloads_period values:")
    for k, v in period_counts.most_common():
        print(f"  {k:<16} {v:>9,}")
    print("\nnpm packages by 2022-11 download volume:")
    for b in ["1M+", "100K-1M", "10K-100K", "1K-10K", "<1K", "(null)"]:
        if band_counts.get(b):
            print(f"  {b:<10} {band_counts[b]:>9,}")

    SUMMARY.write_text(
        json.dumps(
            {
                "probe_date": "2026-09-06",
                "source": "ecosyste.ms open data release packages-2022-11-09",
                "source_licence": "CC BY-SA 4.0, (c) 2022 Andrew Nesbitt",
                "source_frozen_at": "2022-11-09T10:46:31Z (S3 Last-Modified)",
                "total_rows_scanned": total,
                "npm_rows": npm,
                "downloads_period": dict(period_counts),
                "bands": dict(band_counts),
                "output": str(RANKING.name),
            },
            indent=1,
        )
    )
    size = RANKING.stat().st_size / 1e6
    print(f"\nwrote {RANKING.name} ({size:.0f} MB) and {SUMMARY.name}")


if __name__ == "__main__":
    main()
