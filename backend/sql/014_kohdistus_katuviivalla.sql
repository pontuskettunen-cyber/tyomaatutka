-- 014: Luvan ja pysäkkivälin yhdistäminen katuviivalla suoran janan sijaan.
-- Ongelma: pikavuorot ohittavat pysäkkejä, joten pysäkkiväli voi olla yli kilometrin pitkä.
-- Suora jana pysäkistä toiseen oikaisee korttelien yli ja osui sivukatujen töihin
-- (esim. Kivelänkatu 1c-5 liitettiin Mannerheimintien linjoihin 431B ja 40).
-- Nyt etäisyys lasketaan pysäkkivälin todellisesta katuviivasta (vali_viiva), kun se on olemassa,
-- ja suoraa janaa käytetään vain varalla.
create or replace function paivita_lupasegmentit() returns text
language plpgsql security definer set search_path = public as $$
begin
  create temp table _pari on commit drop as
  select p.from_stop, p.to_stop, pa.lat alat, pa.lon alon, pb.lat blat, pb.lon blon
  from (select distinct from_stop, to_stop from segment_2h) p
  join pysakit pa on pa.stop = p.from_stop join pysakit pb on pb.stop = p.to_stop
  where abs(pa.lat-pb.lat) < 0.02 and abs(pa.lon-pb.lon) < 0.04;
  create temp table _parikey on commit drop as
  select distinct from_stop, to_stop, floor(la/0.004)::int ky, floor(lo/0.004)::int kx
  from _pari, lateral (values (alat,alon),(blat,blon),((alat+blat)/2,(alon+blon)/2)) v(la,lo);
  create index on _parikey (ky, kx);

  create temp table _lupa on commit drop as
  select distinct on (lupa_id) lupa_id, geom, alkaa, paattyy
  from luvat_snapshot where snap_date > current_date - 45
  order by lupa_id, snap_date desc;

  create temp table _vert on commit drop as
  select distinct l.lupa_id, (m[2])::float8 lat, (m[1])::float8 lon
  from _lupa l, regexp_matches(l.geom->>'coordinates', '\[(-?\d+\.\d+),\s*(-?\d+\.\d+)\]', 'g') m
  where (l.paattyy is null or l.paattyy >= now() - interval '14 days') and l.alkaa < now() + interval '60 days';

  -- 1) ehdokkaat kuten ennen, mutta väljällä rajalla suoraan janaan (katu voi kaartaa janasta sivuun)
  create temp table _ehd on commit drop as
  select v.lupa_id, v.lat, v.lon, p.from_stop, p.to_stop, etaisyys_janaan(v.lat, v.lon, p.alat, p.alon, p.blat, p.blon) d_jana
  from _vert v
  join _parikey k on k.ky between floor(v.lat/0.004)::int-1 and floor(v.lat/0.004)::int+1
                 and k.kx between floor(v.lon/0.004)::int-1 and floor(v.lon/0.004)::int+1
  join _pari p on p.from_stop = k.from_stop and p.to_stop = k.to_stop
  where etaisyys_janaan(v.lat, v.lon, p.alat, p.alon, p.blat, p.blon) < 150;

  -- 2) katuviivan osajanat vain ehdokkaiden pysäkkiväleille
  create temp table _jana on commit drop as
  select vv.from_stop, vv.to_stop, (a.v->>0)::float8 alat, (a.v->>1)::float8 alon, (b.v->>0)::float8 blat, (b.v->>1)::float8 blon
  from vali_viiva vv
  join (select distinct from_stop, to_stop from _ehd) e on e.from_stop = vv.from_stop and e.to_stop = vv.to_stop
  cross join lateral jsonb_array_elements(vv.coords) with ordinality a(v, i)
  cross join lateral (select vv.coords->(a.i::int) v) b
  where jsonb_array_length(vv.coords) > 1 and a.i < jsonb_array_length(vv.coords);
  create index on _jana (from_stop, to_stop);

  -- 3) etäisyys: katuviivasta jos se on, muuten suorasta janasta
  delete from lupa_segmentit;
  insert into lupa_segmentit (lupa_id, from_stop, to_stop, etaisyys_m)
  select lupa_id, from_stop, to_stop, min(d) from (
    select e.lupa_id, e.from_stop, e.to_stop,
      coalesce((select min(etaisyys_janaan(e.lat, e.lon, j.alat, j.alon, j.blat, j.blon)) from _jana j where j.from_stop = e.from_stop and j.to_stop = e.to_stop), e.d_jana) d
    from _ehd e) x
  where d < 40
  group by lupa_id, from_stop, to_stop;

  return 'lupia '||(select count(distinct lupa_id) from lupa_segmentit)||', pareja '||(select count(*) from lupa_segmentit);
end $$;
revoke execute on function paivita_lupasegmentit() from public, anon, authenticated;
