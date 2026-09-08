"""Does the control group contain packages that actually had an in-window GHSA?

src/universe/freeze.ts says "Every GHSA-affected package is excluded from controls, not
just the 383 cases", but the exclusion set is Object.keys(caseDownloads), which is the
823 packages that survived the active-in-year-before-D filter. stage 0 found 1,633
distinct GHSA-affected npm packages, so 810 of them were never excluded and could be
drawn as controls. A control with a real in-window advisory is a mislabelled negative.
"""
import json, subprocess, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

WIN_START, WIN_END = "2023-01-01", "2026-09-01"
TOKEN = subprocess.run(["gh","auth","token"], capture_output=True, text=True).stdout.strip()
assert TOKEN

controls = []
with open("universe/universe.tsv") as f:
    next(f)
    for line in f:
        name, role, _band = line.rstrip("\n").split("\t")
        if role == "control":
            controls.append(name)
print(f"检查 {len(controls)} 个对照组成员", file=sys.stderr)

def fetch(name):
    url = ("https://api.github.com/advisories?ecosystem=npm"
           f"&affects={urllib.parse.quote(name, safe='')}&per_page=100")
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {TOKEN}",
        "X-GitHub-Api-Version": "2022-11-28"})
    for a in range(4):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return name, json.loads(r.read()), None
        except Exception as e:
            code = getattr(e, "code", None)
            if code in (403, 429) and a < 3:
                time.sleep(6 * (a + 1)); continue
            if a == 3: return name, None, f"{type(e).__name__}:{code or e}"
            time.sleep(1.5 * (a + 1))

hits, failures, clean = {}, [], 0
with ThreadPoolExecutor(max_workers=5) as ex:
    for i, (name, data, err) in enumerate(ex.map(fetch, controls), 1):
        if err:
            failures.append({"pkg": name, "error": err}); continue
        found = []
        for a in data:
            pub = (a.get("published_at") or "")[:10]
            if not (WIN_START <= pub < WIN_END): continue
            pkgs = {v["package"]["name"] for v in a.get("vulnerabilities", [])
                    if v.get("package", {}).get("ecosystem") == "npm"}
            if name not in pkgs: continue
            found.append({"id": a["ghsa_id"], "published": pub,
                          "severity": a.get("severity"),
                          "summary": (a.get("summary") or "")[:120]})
        if found:
            found.sort(key=lambda h: h["published"])
            hits[name] = found
        else:
            clean += 1
        if i % 200 == 0: print(f"  {i}/{len(controls)}", file=sys.stderr, flush=True)

assert len(hits) + clean + len(failures) == len(controls), "count mismatch"

json.dump({"checked": len(controls), "mislabelled": len(hits),
           "clean": clean, "failures": failures, "hits": hits},
          open("probe/control_leakage_result.json", "w"), indent=1)
print(f"\n对照组 {len(controls)} 个中:")
print(f"  干净(确无窗口内公告)  {clean}")
print(f"  实际有窗口内公告(误标) {len(hits)}   = {len(hits)/len(controls)*100:.1f}%")
print(f"  查询失败                {len(failures)}")
if hits:
    print("\n误标样本(按最早公告日期):")
    for n, v in sorted(hits.items(), key=lambda x: x[1][0]["published"])[:15]:
        print(f"   {v[0]['published']}  {v[0]['severity']:<9} {n:<34} {v[0]['id']}")
