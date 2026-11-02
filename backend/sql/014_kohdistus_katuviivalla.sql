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

  -- janat: katuviivan peräkkäiset pisteparit, tai varalla suora jana pysäkistä toiseen
  create temp table _jana on commit drop as
  select p.from_stop, p.to_stop,
         (c.v->>0)::float8 alat, (c.v->>1)::float8 alon, (n.v->>0)::float8 blat, (n.v->>1)::float8 blon
  from _pari p
  join vali_viiva vv on vv.from_stop = p.from_stop and vv.to_stop = p.to_stop and jsonb_array_length(vv.coords) > 1
  cross join lateral jsonb_array_elements(vv.coords) with ordinality c(v, i)
  join lateral (select x.v from jsonb_array_elements(vv.coords) with ordinality x(v, j) where x.j = c.i + 1) n on true
  union all
  select p.from_stop, p.to_stop, p.alat, p.alon, p.blat, p.blon
  from _pari p
  where not exists (select 1 from vali_viiva vv where vv.from_stop = p.from_stop and vv.to_stop = p.to_stop and jsonb_array_length(vv.coords) > 1);

  -- ruudukkoindeksi: janan päät ja keskipiste (janat ovat lyhyitä, joten tämä riittää)
  create temp table _janakey on commit drop as
  select distinct j.from_stop, j.to_stop, j.alat, j.alon, j.blat, j.blon, floor(la/0.004)::int ky, floor(lo/0.004)::int kx
  from _jana j, lateral (values (alat,alon),(blat,blon),((alat+blat)/2,(alon+blon)/2)) v(la,lo);
  create index on _janakey (ky, kx);

  create temp table _lupa on commit drop as
  select distinct on (lupa_id) lupa_id, geom, alkaa, paattyy
  from luvat_snapshot where snap_date > current_date - 45
  order by lupa_id, snap_date desc;

  create temp table _vert on commit drop as
  select l.lupa_id, (m[2])::float8 lat, (m[1])::float8 lon
  from _lupa l, regexp_matches(l.geom->>'coordinates', '\[(-?\d+\.\d+),\s*(-?\d+\.\d+)\]', 'g') m
  where (l.paattyy is null or l.paattyy >= now() - interval '14 days') and l.alkaa < now() + interval '60 days';

  delete from lupa_segmentit;
  insert into lupa_segmentit (lupa_id, from_stop, to_stop, etaisyys_m)
  select v.lupa_id, k.from_stop, k.to_stop, min(etaisyys_janaan(v.lat, v.lon, k.alat, k.alon, k.blat, k.blon))
  from _vert v
  join _janakey k on k.ky between floor(v.lat/0.004)::int-1 and floor(v.lat/0.004)::int+1
                 and k.kx between floor(v.lon/0.004)::int-1 and floor(v.lon/0.004)::int+1
  where etaisyys_janaan(v.lat, v.lon, k.alat, k.alon, k.blat, k.blon) < 40
  group by v.lupa_id, k.from_stop, k.to_stop;

  return 'lupia '||(select count(distinct lupa_id) from lupa_segmentit)||', pareja '||(select count(*) from lupa_segmentit);
end $$;
revoke execute on function paivita_lupasegmentit() from public, anon, authenticated;
