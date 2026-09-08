"""The complete set of npm packages hit by an in-window GHSA, from the GitHub Advisory API.

src/universe/freeze.ts intends to exclude every GHSA-affected package from the control
pool but excludes only the 823 that survived stage 0's active-before-D filter. Checking
the current 1,532 controls found 0 mislabelled, so the bug is latent rather than
manifest; the redraw needs 2,572 controls, so it is fixed here rather than re-checked
after the fact. Paginating the advisory list is also authoritative and current, unlike
the OSV bulk export snapshot stage 0 used.
"""
import json, subprocess, sys, time, urllib.request

WIN_START, WIN_END = "2023-01-01", "2026-09-01"
TOKEN = subprocess.run(["gh","auth","token"], capture_output=True, text=True).stdout.strip()
assert TOKEN

def page(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {TOKEN}",
        "X-GitHub-Api-Version": "2022-11-28"})
    for a in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read()), r.headers.get("Link", "")
        except Exception as e:
            if a == 4: raise
            time.sleep(3 * (a + 1))

affected, advisories, n_pages = {}, 0, 0
url = ("https://api.github.com/advisories?ecosystem=npm&type=reviewed"
       f"&published=%3E%3D{WIN_START}&per_page=100&sort=published&direction=asc")
while url:
    data, link = page(url)
    n_pages += 1
    for a in data:
        pub = (a.get("published_at") or "")[:10]
        if not (WIN_START <= pub < WIN_END):
            continue
        advisories += 1
        for v in a.get("vulnerabilities", []):
            p = v.get("package") or {}
            if p.get("ecosystem") != "npm":
                continue
            name = p.get("name")
            if not name:
                continue
            prev = affected.get(name)
            if prev is None or pub < prev["first"]:
                affected[name] = {"first": pub, "id": a["ghsa_id"]}
    nxt = ""
    for part in link.split(","):
        if 'rel="next"' in part:
            nxt = part[part.find("<")+1:part.find(">")]
    url = nxt
    if n_pages % 10 == 0:
        print(f"  page {n_pages}, advisories {advisories}, packages {len(affected)}",
              file=sys.stderr, flush=True)

json.dump({"window": [WIN_START, WIN_END], "pages": n_pages,
           "in_window_advisories": advisories,
           "distinct_affected_packages": len(affected),
           "affected": affected},
          open("probe/ghsa_affected_all_result.json", "w"), indent=1)
scoped = sum(1 for n in affected if n.startswith("@"))
print(f"\n分页 {n_pages} 次, 窗口内公告 {advisories} 条")
print(f"受影响的 npm 包 {len(affected)} 个, 其中 scoped {scoped} ({scoped/len(affected)*100:.1f}%)")
print(f"对比 stage-0 从 OSV 导出算出来的: 1633 个")
