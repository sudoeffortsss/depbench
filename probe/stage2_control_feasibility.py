#!/usr/bin/env python3
"""Stage 2 probe: can random sampling fill the control bands, especially the top one?

Cases (383) are concentrated in high-download packages: 173 of them sit above a million
monthly downloads. Matching 1:4 needs 692 controls in that band, and packages that
popular are rare. Before committing to a sampling strategy we measure the yield.

Samples package names broadly, fetches 2022-12 download volume in batches of 128, and
reports how many land in each band. That number decides whether random sampling can fill
the controls or whether the ranking has to be built exhaustively.

Sampling is decorrelated deliberately: FINDINGS.md F2 records that taking 60 consecutive
packages from a two-letter startkey returned a block of packages by one author. Here we
take a few names from many windows instead.
"""

import json
import random
import string
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

TARGET_NAMES = 25_000
PER_WINDOW = 8               # few per window, many windows: see F2
DOWNLOAD_WINDOW = "2022-12-01:2022-12-31"
OUT = Path(__file__).parent / "stage2_control_feasibility_result.json"

REGISTRY_DELAY = 0.05
DOWNLOADS_DELAY = 0.34       # measured 429s above ~4.9 req/s, see F1

BANDS = [
    ("1K-10K", 1_000, 10_000),
    ("10K-100K", 10_000, 100_000),
    ("100K-1M", 100_000, 1_000_000),
    ("1M+", 1_000_000, 10**15),
]


def get(url, timeout=25, retries=4):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2**attempt)
                continue
            return None
        except Exception:
            if attempt < retries - 1:
                time.sleep(1 + attempt)
                continue
            return None
    return None


def sample_names(target: int) -> list[str]:
    names, seen = [], set()
    alphabet = string.ascii_lowercase + string.digits
    rng = random.Random(20260905)
    windows = 0
    while len(names) < target:
        key = "".join(rng.choice(alphabet) for _ in range(3))
        d = get(f'https://replicate.npmjs.com/_all_docs?limit={PER_WINDOW}&startkey="{key}"')
        time.sleep(REGISTRY_DELAY)
        windows += 1
        if not isinstance(d, dict):
            continue
        for row in d.get("rows", []):
            if not isinstance(row, dict):
                continue
            pid = row.get("id", "")
            if pid and not pid.startswith("_") and pid not in seen and len(pid) < 60:
                seen.add(pid)
                names.append(pid)
        if windows % 200 == 0:
            print(f"  names {len(names)}/{target} from {windows} windows", flush=True)
    return names[:target]


def band_of(dl: int) -> str | None:
    for label, lo, hi in BANDS:
        if lo <= dl < hi:
            return label
    return None


def main() -> None:
    print(f"== sampling {TARGET_NAMES} package names ==", flush=True)
    names = sample_names(TARGET_NAMES)

    print(f"\n== fetching 2022-12 downloads for {len(names)} ==", flush=True)
    band_counts = Counter()
    band_members: dict[str, list] = {b[0]: [] for b in BANDS}
    below = 0
    checked = 0

    for i in range(0, len(names), 128):
        chunk = names[i : i + 128]
        q = ",".join(urllib.parse.quote(c, safe="") for c in chunk)
        d = get(f"https://api.npmjs.org/downloads/point/{DOWNLOAD_WINDOW}/{q}")
        time.sleep(DOWNLOADS_DELAY)
        if isinstance(d, dict):
            for k, v in d.items():
                dl = (v or {}).get("downloads", 0) if isinstance(v, dict) else 0
                checked += 1
                b = band_of(dl)
                if b:
                    band_counts[b] += 1
                    if len(band_members[b]) < 3000:
                        band_members[b].append({"name": k, "downloads": dl})
                else:
                    below += 1
        if (i // 128) % 20 == 0:
            print(
                f"  downloads {min(i+128, len(names))}/{len(names)}  "
                f"yield so far: {dict(band_counts)}",
                flush=True,
            )

    need = {"1K-10K": 168, "10K-100K": 304, "100K-1M": 368, "1M+": 692}

    print(f"\n=== yield from {checked} sampled packages ===")
    print(f"{'band':<12} {'found':>7} {'rate':>9} {'needed':>7} {'sample to fill':>16}")
    projections = {}
    for label, _, _ in BANDS:
        found = band_counts[label]
        rate = found / checked if checked else 0
        required = int(need[label] / rate) if rate > 0 else None
        projections[label] = {
            "found": found,
            "rate": rate,
            "needed": need[label],
            "sample_required": required,
        }
        req_s = f"{required:,}" if required else "IMPOSSIBLE"
        print(f"{label:<12} {found:>7} {rate*100:>8.3f}% {need[label]:>7} {req_s:>16}")
    print(f"{'below 1K':<12} {below:>7} {below/checked*100:>8.1f}%")

    worst = max(
        (p for p in projections.values() if p["sample_required"]),
        key=lambda p: p["sample_required"],
        default=None,
    )
    print("\n=== verdict ===")
    if worst is None:
        print("  A band yielded nothing. Random sampling cannot fill the controls.")
    else:
        n = worst["sample_required"]
        reqs = n / 128
        mins = reqs / 3 / 60
        print(f"  Bottleneck band needs a sample of about {n:,} packages.")
        print(f"  That is ~{reqs:,.0f} download requests, ~{mins:.0f} minutes at 3 req/s.")
        if n > 2_000_000:
            print("  Too large. Build the ranking exhaustively, or relax the matching ratio.")
        else:
            print("  Feasible. Proceed with random sampling for controls.")

    OUT.write_text(
        json.dumps(
            {
                "probe_date": "2026-09-05",
                "sampled": checked,
                "band_counts": dict(band_counts),
                "below_threshold": below,
                "projections": projections,
                "members": band_members,
            },
            indent=1,
        )
    )
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
