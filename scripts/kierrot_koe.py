"""Koe 3: autokierrot (trips2.txt block_id) ja kääntöajat; max_delay vs. laskettu kääntöaika."""
import csv, io, urllib.request, zipfile, collections, datetime
urllib.request.urlretrieve("https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip", "/tmp/hsl.zip")
z = zipfile.ZipFile("/tmp/hsl.zip")
def rows(n):
    with z.open(n) as f: yield from csv.DictReader(io.TextIOWrapper(f, "utf-8-sig"))
routes = {r["route_id"]: r["route_short_name"] for r in rows("routes.txt")}
cal = {c["service_id"]: c for c in rows("calendar.txt")}
d = datetime.date.today() + datetime.timedelta(days=7)
while d.weekday() != 1: d += datetime.timedelta(days=1)
ds = d.strftime("%Y%m%d")
act = {s for s,c in cal.items() if c["start_date"] <= ds <= c["end_date"] and c["tuesday"] == "1"}
for c in rows("calendar_dates.txt"):
    if c["date"] == ds: (act.add if c["exception_type"] == "1" else act.discard)(c["service_id"])
want = {"7","55","500","4","23","1","6","75"}
tsel = {t["trip_id"]: t for t in rows("trips2.txt") if t["service_id"] in act and routes.get(t["route_id"]) in want}
print("päivä", ds, "vuoroja", len(tsel), "block_id:llä", sum(1 for t in tsel.values() if t["block_id"]))
first, last = {}, {}
for st in rows("stop_times.txt"):
    tid = st["trip_id"]
    if tid not in tsel: continue
    sq = int(st["stop_sequence"])
    if tid not in first or sq < first[tid][0]: first[tid] = (sq, st["departure_time"])
    if tid not in last or sq > last[tid][0]: last[tid] = (sq, st["arrival_time"])
sec = lambda h: sum(int(x)*m for x,m in zip(h.split(":"), (3600,60,1)))
blocks = collections.defaultdict(list)
for tid, t in tsel.items():
    if tid in first: blocks[(t["route_id"], t["block_id"])].append((sec(first[tid][1]), sec(last[tid][1]), routes[t["route_id"]], t["direction_id"], t["max_delay"]))
lay = collections.defaultdict(list); pair = collections.defaultdict(list); autot = collections.Counter()
for (rid,b), L in blocks.items():
    L.sort(); autot[routes[rid]] += 1
    for a, c in zip(L, L[1:]):
        k = (c[0]-a[1])/60
        if 0 <= k < 90: lay[(a[2], a[3])].append(k); pair[a[4]].append(k)
for r in sorted(want, key=lambda x:(len(x),x)):
    print(f"LINJA {r}: autokiertoja {autot[r]}")
    for dr in ("0","1"):
        x = sorted(lay.get((r,dr), []))
        if x: print(f"  suunnan {dr} jälkeen kääntöaika: min {x[0]:.0f}, 10% {x[len(x)//10]:.0f}, mediaani {x[len(x)//2]:.0f} min (n={len(x)})")
print("MAX_DELAY vs seuraava kääntöaika (mediaani):", {k: round(sorted(v)[len(v)//2],1) for k,v in sorted(pair.items())})
