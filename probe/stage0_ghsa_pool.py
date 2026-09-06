#!/usr/bin/env python3
"""Stage 0 probe 2: size the usable positive pool.

Probe 1 taught us two things the hard way:
  - a uniform random sample of npm is ~84% zombie packages with <100 monthly
    downloads, so "no releases since D" captures dead toys, not real failures
  - advisories never show up in a random sample, so we need case-control

Then the OSV bulk export taught us the bigger one:
  228,684 npm advisory records, but 221,365 of them are MAL-* (packages an
  attacker published to BE malicious) and only 7,317 are GHSA-* (real flaws in
  legitimate packages). MAL-* is a different phenomenon: those packages mostly
  did not exist at D, they were never legitimate, and at 30x the volume they
  would drown the real signal. This benchmark uses GHSA-* only.

This probe answers three questions that pin down the universe:
  1. how many distinct packages do in-window GHSA advisories affect
  2. how many of those existed before D
  3. how many of those had real usage at D (>= 1,000 downloads in 2022-12)
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

D = datetime(2023, 1, 1, tzinfo=timezone.utc)
WINDOW_START, WINDOW_END = "2023-01-01", "2026-09-01"
DOWNLOAD_WINDOW = "2022-12-01:2022-12-31"
ALIVE_MIN_DOWNLOADS = 1000
OSV_ZIP = "/tmp/osv_npm.zip"
OUT = Path(__file__).parent / "stage0_ghsa_pool_result.json"

REGISTRY_DELAY = 0.10
DOWNLOADS_DELAY = 0.35


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


def collect_ghsa_packages():
    """Distinct npm packages hit by GHSA advisories published in the window."""
    z = zipfile.ZipFile(OSV_ZIP)
    pkgs, advs, per_year = {}, 0, {}
    for n in z.namelist():
        if not n.endswith(".json"):
            continue
        try:
            d = json.loads(z.read(n))
        except Exception:
            continue
        vid = d.get("id", "")
        if not vid.startswith("GHSA-"):
            continue  # MAL-* excluded on purpose, see module docstring
        pub = (d.get("published") or "")[:10]
        if not (WINDOW_START <= pub < WINDOW_END):
            continue
        advs += 1
        per_year[pub[:4]] = per_year.get(pub[:4], 0) + 1
        for a in d.get("affected", []):
            p = a.get("package", {})
            if p.get("ecosystem") != "npm":
                continue
            name = p.get("name")
            if not name:
                continue
            prev = pkgs.get(name)
            if prev is None or pub < prev["first_advisory"]:
                pkgs[name] = {"first_advisory": pub, "id": vid}
    return pkgs, advs, per_year


def existed_before_d(name):
    """First publish time and whether any release predates D."""
    d = get(f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='')}")
    time.sleep(REGISTRY_DELAY)
    if not isinstance(d, dict):
        return None
    times = d.get("time", {}) or {}
    stamps = []
    for v, ts in times.items():
        if v in ("created", "modified"):
            continue
        try:
            stamps.append(datetime.fromisoformat(ts.replace("Z", "+00:00")))
        except Exception:
            pass
    if not stamps:
        return None
    first = min(stamps)
    before = [s for s in stamps if s < D]
    recent_before = [s for s in before if (D - s).days <= 365]
    return {
        "first_publish": first.isoformat(),
        "existed_before_d": bool(before),
        "releases_before_d": len(before),
        "releases_in_year_before_d": len(recent_before),
    }


def downloads_at_d(names):
    out = {}
    for i in range(0, len(names), 128):
        chunk = names[i : i + 128]
        q = ",".join(urllib.parse.quote(c, safe="") for c in chunk)
        d = get(f"https://api.npmjs.org/downloads/point/{DOWNLOAD_WINDOW}/{q}")
        time.sleep(DOWNLOADS_DELAY)
        if isinstance(d, dict):
            for k, v in d.items():
                out[k] = (v or {}).get("downloads", 0) if isinstance(v, dict) else 0
        if (i // 128) % 5 == 0:
            print(f"  downloads {min(i+128, len(names))}/{len(names)}", flush=True)
    return out


def main():
    print("== reading OSV bulk export, GHSA only ==", flush=True)
    pkgs, advs, per_year = collect_ghsa_packages()
    names = sorted(pkgs)
    print(f"  in-window GHSA advisories: {advs}")
    print(f"  distinct npm packages affected: {len(names)}")
    print(f"  by year: {dict(sorted(per_year.items()))}", flush=True)

    # Scoped names (@scope/pkg) are fine for the registry but must be encoded.
    print(f"\n== checking which existed before D ({len(names)} packages) ==", flush=True)
    facts = {}
    for i, n in enumerate(names, 1):
        f = existed_before_d(n)
        if f:
            facts[n] = f
        if i % 100 == 0:
            print(f"  packument {i}/{len(names)}", flush=True)

    pre_d = [n for n, f in facts.items() if f["existed_before_d"]]
    active_pre_d = [n for n in pre_d if facts[n]["releases_in_year_before_d"] >= 1]
    print(f"\n  existed before D: {len(pre_d)}")
    print(f"  and released at least once in the year before D: {len(active_pre_d)}", flush=True)

    print(f"\n== 2022-12 downloads for {len(active_pre_d)} packages ==", flush=True)
    dls = downloads_at_d(active_pre_d)
    alive = [n for n in active_pre_d if dls.get(n, 0) >= ALIVE_MIN_DOWNLOADS]
    print(f"\n  and had >= {ALIVE_MIN_DOWNLOADS} downloads in 2022-12: {len(alive)}", flush=True)

    tiers = [(1000, 10_000), (10_000, 100_000), (100_000, 1_000_000), (1_000_000, 10**12)]
    print("\n=== usable positive pool by 2022-12 download volume ===", flush=True)
    for lo, hi in tiers:
        c = sum(1 for n in alive if lo <= dls.get(n, 0) < hi)
        label = f"{lo:,}-{hi:,}" if hi < 10**12 else f"{lo:,}+"
        print(f"  {label:<22} {c:>5}", flush=True)

    OUT.write_text(
        json.dumps(
            {
                "probe_date": "2026-09-05",
                "window": [WINDOW_START, WINDOW_END],
                "ghsa_only": True,
                "mal_excluded_reason": "MAL-* are attacker-published packages, a different phenomenon, and 30x the volume",
                "in_window_ghsa_advisories": advs,
                "ghsa_by_year": per_year,
                "distinct_packages_affected": len(names),
                "existed_before_d": len(pre_d),
                "active_in_year_before_d": len(active_pre_d),
                "alive_at_d": len(alive),
                "alive_packages": sorted(alive),
                "downloads_at_d": {n: dls.get(n, 0) for n in active_pre_d},
            },
            indent=1,
        )
    )
    print(f"\nwrote {OUT}", flush=True)


if __name__ == "__main__":
    main()
