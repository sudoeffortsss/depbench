"""Backfill advisory ids + publication dates for the 383 cases, via the OSV query API.

Why this exists: src/outcomes/build.ts ghsaByPackage() has a comment claiming ids and
dates are "re-derived here from the same source file", but the code writes
{id: "", published: ""} for every package, so outcome.occurred_at is NULL for all 383
cases and source_id is the literal string "GHSA". Cutoff stratification for the LLM arm
is impossible without real dates, so they are fetched here from the authoritative source.
"""
import json, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

WIN_START, WIN_END = "2023-01-01", "2026-09-01"
pool = json.load(open("probe/stage0_ghsa_pool_result.json"))
names = pool["alive_packages"]

def query(name):
    body = json.dumps({"package": {"name": name, "ecosystem": "npm"}}).encode()
    req = urllib.request.Request("https://api.osv.dev/v1/query", data=body,
                                 headers={"content-type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return name, json.loads(r.read()), None
        except Exception as e:
            if attempt == 3:
                return name, None, f"{type(e).__name__}: {e}"
            time.sleep(1.5 * (attempt + 1))

out, failures = {}, []
with ThreadPoolExecutor(max_workers=6) as ex:
    for i, (name, data, err) in enumerate(ex.map(query, names), 1):
        if err:
            failures.append({"pkg": name, "error": err}); continue
        hits = []
        for v in data.get("vulns", []):
            vid = v.get("id", "")
            pub = (v.get("published") or "")[:10]
            if not vid.startswith("GHSA-"):      # same GHSA-only filter as stage 0
                continue
            if not (WIN_START <= pub < WIN_END): # same window as stage 0
                continue
            aliases = v.get("aliases", [])
            hits.append({
                "id": vid, "published": pub, "aliases": aliases,
                "has_mal_alias": any(a.startswith("MAL-") for a in aliases),
                "summary": (v.get("summary") or "")[:200],
                "withdrawn": v.get("withdrawn") is not None,
            })
        hits.sort(key=lambda h: h["published"])
        out[name] = hits
        if i % 50 == 0:
            print(f"  {i}/{len(names)}", file=sys.stderr, flush=True)

# Arithmetic check, per FINDINGS F10: silence is not success.
assert len(out) + len(failures) == len(names), \
    f"lost packages: {len(out)}+{len(failures)} != {len(names)}"

json.dump({"queried": len(names), "resolved": len(out), "failures": failures,
           "by_package": out},
          open("probe/osv_dates_result.json", "w"), indent=1)
empty = [k for k, v in out.items() if not v]
print(f"queried={len(names)} resolved={len(out)} failed={len(failures)} "
      f"resolved_but_zero_in_window_ghsa={len(empty)}")
