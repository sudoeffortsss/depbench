"""Advisory ids + publication dates for the 383 cases, from the GitHub Advisory API.

Replaces probe/osv_dates.py, which used OSV's /v1/query endpoint and silently
under-reported: six packages (eslint, stylelint, fast-redact, jquery, papaparse, npm)
came back with zero in-window GHSA advisories from OSV while the GitHub Advisory API
returns one for each. Since stratification keys on the EARLIEST in-window advisory per
package, a source that drops advisories does not merely lose packages, it shifts dates.
Both sources are recorded here so the disagreement is measured rather than assumed away.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

WIN_START, WIN_END = "2023-01-01", "2026-09-01"
TOKEN = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
assert TOKEN, "no gh token"

names = json.load(open("probe/stage0_ghsa_pool_result.json"))["alive_packages"]

def fetch(name):
    url = ("https://api.github.com/advisories?ecosystem=npm"
           f"&affects={urllib.parse.quote(name, safe='')}&per_page=100")
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {TOKEN}",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return name, json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) and attempt < 3:
                time.sleep(5 * (attempt + 1)); continue
            return name, None, f"HTTP {e.code}"
        except Exception as e:
            if attempt == 3:
                return name, None, f"{type(e).__name__}: {e}"
            time.sleep(1.5 * (attempt + 1))

import urllib.parse
out, failures = {}, []
with ThreadPoolExecutor(max_workers=5) as ex:
    for i, (name, data, err) in enumerate(ex.map(fetch, names), 1):
        if err:
            failures.append({"pkg": name, "error": err}); continue
        hits = []
        for a in data:
            pub = (a.get("published_at") or "")[:10]
            if not (WIN_START <= pub < WIN_END):
                continue
            # `affects=` matches loosely; keep only advisories that really name this
            # package in the npm ecosystem.
            pkgs = {v["package"]["name"] for v in a.get("vulnerabilities", [])
                    if v.get("package", {}).get("ecosystem") == "npm"}
            if name not in pkgs:
                continue
            hits.append({
                "id": a["ghsa_id"], "published": pub,
                "severity": a.get("severity"),
                "cve": a.get("cve_id"),
                "type": a.get("type"),
                "summary": (a.get("summary") or "")[:200],
                "co_affected": sorted(pkgs - {name})[:8],
            })
        hits.sort(key=lambda h: h["published"])
        out[name] = hits
        if i % 50 == 0:
            print(f"  {i}/{len(names)}", file=sys.stderr, flush=True)

assert len(out) + len(failures) == len(names), \
    f"lost packages: {len(out)}+{len(failures)} != {len(names)}"

json.dump({"queried": len(names), "resolved": len(out), "failures": failures,
           "by_package": out},
          open("probe/ghsa_dates_result.json", "w"), indent=1)
empty = [k for k, v in out.items() if not v]
print(f"queried={len(names)} resolved={len(out)} failed={len(failures)} zero_in_window={len(empty)}")
if empty: print("  zero:", empty[:20])
