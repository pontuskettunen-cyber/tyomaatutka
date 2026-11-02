"""Koe: onko HSL:n GTFS:ssä autokierrot (block_id), ja mitä kääntöajat ovat esim. linjoilla 7, 55, 500."""
import csv, io, urllib.request, zipfile, collections, datetime
URL = "https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip"
urllib.request.urlretrieve(URL, "/tmp/hsl.zip")
z = zipfile.ZipFile("/tmp/hsl.zip")
def rows(n):
    with z.open(n) as f: yield from csv.DictReader(io.TextIOWrapper(f, "utf-8-sig"))
print("TIEDOSTOT", z.namelist())
tr = list(rows("trips.txt"))
print("TRIPS SARAKKEET", list(tr[0].keys()), "rivejä", len(tr))
nb = sum(1 for t in tr if t.get("block_id"))
print("block_id täytetty", nb, "/", len(tr))
routes = {r["route_id"]: r["route_short_name"] for r in rows("routes.txt")}
# arkipäivä: tiistai 7+ pv päästä
cal = {c["service_id"]: c for c in rows("calendar.txt")}
d = datetime.date.today() + datetime.timedelta(days=7)
while d.weekday() != 1: d += datetime.timedelta(days=1)
ds = d.strftime("%Y%m%d")
act = {s for s,c in cal.items() if c["start_date"] <= ds <= c["end_date"] and c["tuesday"] == "1"}
for c in rows("calendar_dates.txt"):
    if c["date"] == ds:
        (act.add if c["exception_type"] == "1" else act.discard)(c["service_id"])
want = {"7","55","500","4","23"}
tsel = {t["trip_id"]: t for t in tr if t["service_id"] in act and routes.get(t["route_id"]) in want}
print("valittu päivä", ds, "vuoroja", len(tsel))
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
    if t.get("block_id"): blocks[t["block_id"]].append((sec(first[tid][1]), sec(last[tid][1]), routes[t["route_id"]], t["direction_id"]))
lay = collections.defaultdict(list); nblk = collections.Counter(); mixed = 0
for b, L in blocks.items():
    L.sort()
    if len({x[2] for x in L}) > 1: mixed += 1
    for a, c in zip(L, L[1:]):
        if a[2] == c[2]: lay[(a[2], a[3])].append((c[0]-a[1])/60)
    for x in L: nblk[x[2]] += 0
for r in sorted(want):
    vs = [k for k in tsel.values() if routes[k["route_id"]] == r]
    bl = {k.get("block_id") for k in vs if k.get("block_id")}
    print(f"LINJA {r}: vuoroja {len(vs)}, autokiertoja {len(bl)}")
    for dr in ("0","1"):
        x = sorted(lay.get((r,dr), []))
        if x: print(f"  suunta {dr}: kääntöaika min {x[0]:.0f} min, mediaani {x[len(x)//2]:.0f} min, 10% {x[len(x)//10]:.0f} min, n={len(x)}")
print("kiertoja, joissa useampi linja:", mixed, "/", len(blocks))
print("ESIMERKKI", list(blocks.items())[:2])
