-- Työmaatutka 013: ennakkoarvio suunnitellulle katutyölle
-- 1) Pysäkkivälien liikennemäärät arkipäivänä vuorokaudenjaksoittain (päivitetään tunneittain)
-- 2) RPC ennakko_valit(pts): annetun työalueen (pisteet [lat,lon]) alle 40 m päässä kulkevat pysäkkivälit linjoittain

create table if not exists vali_kuormitus (
  from_stop int, to_stop int, route text, dir smallint, mode text, jakso text, ohit_vrk real,
  primary key (from_stop, to_stop, route, dir, jakso));
alter table vali_kuormitus enable row level security;

create or replace function paivita_kuormitus() returns text
language plpgsql security definer set search_path = public as $$
begin
  -- 2 h jaksot alkavat Helsingin parittomilla tunneilla: 7–9 aamu, 9–15 päivä (3 jaksoa), 15–17 ilta, muut 7 jaksoa
  create temp table _b on commit drop as
  select s.*, case extract(hour from s.bucket at time zone 'Europe/Helsinki')::int
      when 7 then 'aamu' when 9 then 'paiva' when 11 then 'paiva' when 13 then 'paiva' when 15 then 'ilta' else 'muu' end jakso
  from segment_2h s
  where s.bucket > now() - interval '8 days' and s.bucket < now() - interval '2 hours'
    and extract(isodow from s.bucket at time zone 'Europe/Helsinki') < 6;
  create temp table _bn on commit drop as
  select jakso, count(distinct bucket) b from _b group by jakso;

  delete from vali_kuormitus;
  insert into vali_kuormitus
  select x.from_stop, x.to_stop, x.route, x.dir, max(x.mode), x.jakso,
    sum(x.n)::real / bn.b * case x.jakso when 'aamu' then 1 when 'paiva' then 3 when 'ilta' then 1 else 7 end
  from _b x join _bn bn using (jakso)
  group by x.from_stop, x.to_stop, x.route, x.dir, x.jakso, bn.b;
  return 'rivejä '||(select count(*) from vali_kuormitus);
end $$;
revoke execute on function paivita_kuormitus() from public, anon, authenticated;

create or replace function ennakko_valit(pts jsonb)
returns table (from_stop int, to_stop int, route text, dir smallint, mode text, jakso text, ohit_vrk real,
               from_nimi text, to_nimi text, from_lat float8, from_lon float8, to_lat float8, to_lon float8, viiva jsonb)
language sql stable security definer set search_path = public as $$
  with p as (select (e->>0)::float8 lat, (e->>1)::float8 lon from (select e from jsonb_array_elements(pts) e limit 400) z),
  bb as (select min(lat)-0.004 la0, max(lat)+0.004 la1, min(lon)-0.008 lo0, max(lon)+0.008 lo1 from p),
  ps as (select s.stop, s.lat, s.lon from pysakit s, bb where s.lat between la0 and la1 and s.lon between lo0 and lo1),
  pari as (select distinct k.from_stop, k.to_stop, a.lat alat, a.lon alon, b.lat blat, b.lon blon
           from vali_kuormitus k join ps a on a.stop = k.from_stop join pysakit b on b.stop = k.to_stop
           where abs(a.lat-b.lat) < 0.02 and abs(a.lon-b.lon) < 0.04),
  osuu as (select pr.from_stop, pr.to_stop, pr.alat, pr.alon, pr.blat, pr.blon from pari pr
           where exists (select 1 from p where etaisyys_janaan(p.lat, p.lon, pr.alat, pr.alon, pr.blat, pr.blon) < 40))
  select k.from_stop, k.to_stop, k.route, k.dir, k.mode, k.jakso, k.ohit_vrk,
    na.nimi, nb.nimi, o.alat, o.alon, o.blat, o.blon, vv.coords
  from osuu o join vali_kuormitus k on k.from_stop = o.from_stop and k.to_stop = o.to_stop
  left join pysakki_nimet na on na.stop = o.from_stop left join pysakki_nimet nb on nb.stop = o.to_stop
  left join vali_viiva vv on vv.from_stop = o.from_stop and vv.to_stop = o.to_stop;
$$;
grant execute on function ennakko_valit(jsonb) to anon, authenticated;

select cron.schedule('kuormitus-tunti', '41 * * * *', $$select paivita_kuormitus()$$);
select paivita_kuormitus();
