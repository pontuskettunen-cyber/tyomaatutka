"""Koe 2: trips2.txt ja max_delay -sarake HSL:n GTFS:ssä."""
import csv, io, urllib.request, zipfile, collections
urllib.request.urlretrieve("https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip", "/tmp/hsl.zip")
z = zipfile.ZipFile("/tmp/hsl.zip")
def rows(n):
    with z.open(n) as f: yield from csv.DictReader(io.TextIOWrapper(f, "utf-8-sig"))
t2 = rows("trips2.txt"); first = next(t2)
print("TRIPS2 SARAKKEET", list(first.keys())); print("TRIPS2 RIVI", first)
for i, r in enumerate(t2):
    if i < 3: print("TRIPS2 RIVI", r)
c = collections.Counter(); ex = []
for r in rows("trips.txt"):
    c[r.get("max_delay","")] += 1
    if len(ex) < 3 and r.get("max_delay"): ex.append(r)
print("MAX_DELAY JAKAUMA", c.most_common(15)); print("MAX_DELAY ESIM", ex)
print("FEED_INFO", list(rows("feed_info.txt")))
