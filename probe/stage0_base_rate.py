#!/usr/bin/env python3
"""Stage 0 probe: measure how the "went bad" base rate varies with package popularity.

This decides the stratified-sampling band design. We do NOT know the true 2022-12
download ranking without ranking all 4.36M packages, so instead we take a random
sample of the registry, look up each package's 2022-12 download volume, bucket by
volume, and measure the positive rate per bucket.

Scoring date D = 2023-01-01. A package counts as positive if, as of today:
  - it is deprecated, OR
  - it has an OSV advisory published after D, OR
  - it was actively published before D but has had no release since D (abandoned)

Measured API constraints (2026-09-05, all verified live):
  - replicate.npmjs.com/_all_docs: `skip` is rejected, use `startkey`
  - api.npmjs.org/downloads/point: max bulk size 128, 429s appear above ~3 req/s
  - api.osv.dev/v1/querybatch: batch query works
"""

import json
import random
import string
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

D = datetime(2023, 1, 1, tzinfo=timezone.utc)
SAMPLE_TARGET = 700
DOWNLOAD_WINDOW = "2022-12-01:2022-12-31"
OUT = Path(__file__).parent / "stage0_base_rate_result.json"

# Throttle: measured 429s at 4.9 req/s, so stay well under.
REGISTRY_DELAY = 0.12
DOWNLOADS_DELAY = 0.35
OSV_DELAY = 0.2


def get(url, timeout=25, retries=4, data=None):
    """GET/POST with exponential backoff on 429 and 5xx."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data)
            if data:
                req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=timeout) as r:
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


def sample_package_names(target):
    """Random-ish sample across the registry via startkey jumps."""
    names, seen = [], set()
    alphabet = string.ascii_lowercase + string.digits
    rng = random.Random(20260905)  # fixed seed so the probe is reproducible
    while len(names) < target:
        key = "".join(rng.choice(alphabet) for _ in range(2))
        url = f'https://replicate.npmjs.com/_all_docs?limit=60&startkey="{key}"'
        d = get(url)
        time.sleep(REGISTRY_DELAY)
        if not isinstance(d, dict):
            continue
        for row in d.get("rows", []):
            if not isinstance(row, dict):
                continue
            pid = row.get("id", "")
            if (
                pid
                and not pid.startswith("_")
                and "/" not in pid
                and pid.isascii()
                and len(pid) < 60
                and pid not in seen
            ):
                seen.add(pid)
                names.append(pid)
        print(f"  sampled {len(names)}/{target}", flush=True)
    return names[:target]


def fetch_downloads(names):
    """2022-12 download totals, 128 per request."""
    out = {}
    for i in range(0, len(names), 128):
        chunk = names[i : i + 128]
        url = f"https://api.npmjs.org/downloads/point/{DOWNLOAD_WINDOW}/{','.join(chunk)}"
        d = get(url)
        time.sleep(DOWNLOADS_DELAY)
        if isinstance(d, dict):
            for k, v in d.items():
                out[k] = (v or {}).get("downloads", 0) if isinstance(v, dict) else 0
        print(f"  downloads {min(i+128, len(names))}/{len(names)}", flush=True)
    return out


def fetch_packument_facts(name):
    """Deprecated status, last publish before/after D."""
    d = get(f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='')}")
    time.sleep(REGISTRY_DELAY)
    if not isinstance(d, dict):
        return None
    times = d.get("time", {}) or {}
    versions = d.get("versions", {}) or {}
    latest = (d.get("dist-tags") or {}).get("latest", "")
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
    before_d = [s for s in stamps if s < D]
    after_d = [s for s in stamps if s >= D]
    return {
        "deprecated": bool(versions.get(latest, {}).get("deprecated")),
        "releases_before_d": len(before_d),
        "releases_after_d": len(after_d),
        "last_before_d": max(before_d).isoformat() if before_d else None,
    }


def fetch_osv(names):
    """Advisories per package, batched."""
    out = {}
    for i in range(0, len(names), 100):
        chunk = names[i : i + 100]
        body = json.dumps(
            {"queries": [{"package": {"name": n, "ecosystem": "npm"}} for n in chunk]}
        ).encode()
        d = get("https://api.osv.dev/v1/querybatch", data=body)
        time.sleep(OSV_DELAY)
        results = (d or {}).get("results", [])
        for n, r in zip(chunk, results):
            out[n] = (r or {}).get("vulns", []) or []
        print(f"  osv {min(i+100, len(names))}/{len(names)}", flush=True)
    return out


def bucket_of(dl):
    if dl <= 0:
        return "0"
    for hi, label in [
        (10, "1-10"),
        (100, "10-100"),
        (1_000, "100-1K"),
        (10_000, "1K-10K"),
        (100_000, "10K-100K"),
        (1_000_000, "100K-1M"),
    ]:
        if dl < hi:
            return label
    return "1M+"


def main():
    print("== sampling package names ==", flush=True)
    names = sample_package_names(SAMPLE_TARGET)

    print("== fetching 2022-12 downloads ==", flush=True)
    dls = fetch_downloads(names)

    # Only packages that existed and had some presence before D are meaningful.
    print("== fetching packuments ==", flush=True)
    facts = {}
    for i, n in enumerate(names, 1):
        f = fetch_packument_facts(n)
        if f:
            facts[n] = f
        if i % 50 == 0:
            print(f"  packument {i}/{len(names)}", flush=True)

    eligible = [n for n, f in facts.items() if f["releases_before_d"] > 0]
    print(f"== {len(eligible)} packages existed before D ==", flush=True)

    print("== fetching OSV advisories ==", flush=True)
    osv = fetch_osv(eligible)

    rows, by_bucket = [], defaultdict(lambda: {"n": 0, "pos": 0, "dep": 0, "adv": 0, "aband": 0})
    for n in eligible:
        f, dl = facts[n], dls.get(n, 0)
        adv_after_d = [
            v
            for v in osv.get(n, [])
            if (v.get("published") or "") >= "2023-01-01"
        ]
        abandoned = f["releases_after_d"] == 0
        positive = f["deprecated"] or bool(adv_after_d) or abandoned
        b = bucket_of(dl)
        s = by_bucket[b]
        s["n"] += 1
        s["pos"] += int(positive)
        s["dep"] += int(f["deprecated"])
        s["adv"] += int(bool(adv_after_d))
        s["aband"] += int(abandoned)
        rows.append(
            {
                "name": n,
                "downloads_2022_12": dl,
                "bucket": b,
                "deprecated": f["deprecated"],
                "advisory_after_d": len(adv_after_d),
                "abandoned": abandoned,
                "positive": positive,
            }
        )

    order = ["0", "1-10", "10-100", "100-1K", "1K-10K", "10K-100K", "100K-1M", "1M+"]
    print("\n=== base rate by 2022-12 download bucket ===", flush=True)
    print(f"{'bucket':<10} {'n':>5} {'positive':>9} {'rate':>7}  {'dep':>5} {'adv':>5} {'aband':>6}")
    for b in order:
        s = by_bucket.get(b)
        if not s or s["n"] == 0:
            continue
        print(
            f"{b:<10} {s['n']:>5} {s['pos']:>9} {s['pos']/s['n']*100:>6.1f}%  "
            f"{s['dep']:>5} {s['adv']:>5} {s['aband']:>6}",
            flush=True,
        )

    OUT.write_text(
        json.dumps(
            {
                "probe_date": "2026-09-05",
                "scoring_date": D.isoformat(),
                "download_window": DOWNLOAD_WINDOW,
                "sampled": len(names),
                "eligible_before_d": len(eligible),
                "by_bucket": {k: dict(v) for k, v in by_bucket.items()},
                "rows": rows,
            },
            indent=1,
        )
    )
    print(f"\nwrote {OUT}", flush=True)


if __name__ == "__main__":
    import urllib.parse

    main()
