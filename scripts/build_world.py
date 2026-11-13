"""Build shared/world-110m.json (country outlines + centroids) from Natural Earth 1:110m admin-0 countries.
Natural Earth data is in the PUBLIC DOMAIN (https://www.naturalearthdata.com/about/terms-of-use/). Run:  python scripts/build_world.py
Output (compact): {"source":..., "countries":[{"name","iso2","iso3","continent","c":[lon,lat],"bbox":[w,s,e,n],"polys":[[ [ [lon,lat],... ], ...rings ], ...]}]}"""
import json, urllib.request, sys, os
URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"
raw = json.load(urllib.request.urlopen(URL, timeout=60))

def ring_clean(r):
    out = []
    for x, y in r:
        p = [round(x, 1), round(y, 1)]
        if not out or out[-1] != p: out.append(p)
    return out if len(out) >= 4 else None

def area_centroid(r):
    a = cx = cy = 0.0
    for i in range(len(r) - 1):
        x0, y0 = r[i]; x1, y1 = r[i + 1]; k = x0 * y1 - x1 * y0
        a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k
    a *= 0.5
    return (abs(a), [cx / (6 * a), cy / (6 * a)]) if a else (0, r[0])

countries = []
for f in raw["features"]:
    p = f["properties"]; g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    cleaned = []
    for poly in polys:
        rings = [ring_clean(r) for r in poly]
        rings = [r for r in rings if r]
        if rings: cleaned.append(rings)
    if not cleaned: continue
    best = max(cleaned, key=lambda pl: area_centroid(pl[0])[0])
    c = area_centroid(best[0])[1]
    xs = [pt[0] for pl in cleaned for pt in pl[0]]; ys = [pt[1] for pl in cleaned for pt in pl[0]]
    iso2 = p.get("ISO_A2_EH") or p.get("ISO_A2"); iso3 = p.get("ADM0_A3") or p.get("ISO_A3")
    countries.append({"name": p.get("NAME_LONG") or p["NAME"], "short": p["NAME"], "iso2": iso2 if iso2 != "-99" else None, "iso3": iso3, "continent": p.get("CONTINENT"), "c": [round(c[0], 2), round(c[1], 2)], "bbox": [min(xs), min(ys), max(xs), max(ys)], "polys": cleaned})
out = {"source": "Natural Earth 1:110m Admin 0 - Countries (public domain), simplified to 0.1 degree", "countries": countries}
dest = os.path.join(os.path.dirname(__file__), "..", "shared", "world-110m.json")
json.dump(out, open(dest, "w", encoding="utf8"), separators=(",", ":"), ensure_ascii=False)
print(len(countries), "countries,", os.path.getsize(dest) // 1024, "KB")
