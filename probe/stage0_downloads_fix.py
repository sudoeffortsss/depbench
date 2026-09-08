"""Recompute 2022-12 downloads for the 823 pre-D-active packages, correctly.

probe/stage0_ghsa_pool.py's downloads_at_d() batches 128 names per request. npm's bulk
downloads endpoint rejects any batch containing a scoped name with
{"error":"scoped packages are not currently supported in bulk lookups"} — a dict, so the
`isinstance(d, dict)` guard passes and the loop writes out["error"]=0 while every real
package in that batch gets no entry at all. dls.get(n, 0) then returns 0 and the
>=1000-downloads filter silently drops the whole batch.

Because the name list is sorted, scoped names form a contiguous block at the front, so
the loss is systematic: 0 of 383 cases are scoped while 840 of 1,532 controls are.
src/ingest/downloads.ts already splits scoped names into single lookups; that fix was
never back-ported here, and the case pool was built from the broken path.
"""
import json, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

WINDOW = "2022-12-01:2022-12-31"
MIN_DOWNLOADS = 1000
pool = json.load(open("probe/stage0_ghsa_pool_result.json"))
names = sorted(pool["downloads_at_d"].keys())          # the 823 active-before-D packages
scoped   = [n for n in names if n.startswith("@")]
unscoped = [n for n in names if not n.startswith("@")]
print(f"823 个包中 scoped {len(scoped)}, unscoped {len(unscoped)}")

def get(url):
    for a in range(4):
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                return json.loads(r.read())
        except Exception:
            if a == 3: return None
            time.sleep(1.5 * (a + 1))

out = {}
# Unscoped: bulk is fine, 128 at a time.
for i in range(0, len(unscoped), 128):
    chunk = unscoped[i:i+128]
    q = ",".join(urllib.parse.quote(c, safe="") for c in chunk)
    d = get(f"https://api.npmjs.org/downloads/point/{WINDOW}/{q}")
    if isinstance(d, dict) and "error" not in d:
        for k, v in d.items():
            out[k] = (v or {}).get("downloads", 0) if isinstance(v, dict) else 0
    else:
        print(f"  batch {i} failed: {str(d)[:80]}", file=sys.stderr)
    time.sleep(0.3)
print(f"unscoped 拿到 {len(out)}/{len(unscoped)}")

# Scoped: one request each, the only shape the endpoint accepts.
def one(n):
    d = get(f"https://api.npmjs.org/downloads/point/{WINDOW}/{urllib.parse.quote(n, safe='')}")
    return n, (d or {}).get("downloads", 0) if isinstance(d, dict) else 0
with ThreadPoolExecutor(max_workers=6) as ex:
    for n, v in ex.map(one, scoped):
        out[n] = v
print(f"scoped 拿到 {sum(1 for n in scoped if n in out)}/{len(scoped)}")

assert len(out) >= len(names) * 0.98, f"resolved only {len(out)}/{len(names)}"

alive = sorted(n for n in names if out.get(n, 0) >= MIN_DOWNLOADS)
old_alive = set(pool["alive_packages"])
new = [n for n in alive if n not in old_alive]
lost = [n for n in old_alive if n not in set(alive)]

json.dump({"window": WINDOW, "min_downloads": MIN_DOWNLOADS,
           "downloads": out, "alive_packages": alive,
           "newly_recovered": new, "no_longer_qualifying": lost},
          open("probe/stage0_downloads_fix_result.json", "w"), indent=1)

print(f"\n修复前 alive_at_d = {len(old_alive)}")
print(f"修复后 alive_at_d = {len(alive)}   (+{len(alive)-len(old_alive)})")
print(f"  新找回 {len(new)} 个,其中 scoped {sum(1 for n in new if n.startswith('@'))}")
print(f"  原来在、现在不在的 {len(lost)} 个")
top = sorted(new, key=lambda n: -out[n])[:15]
print("\n找回的包里下载量最高的:")
for n in top:
    print(f"   {out[n]:>12,}  {n}")
