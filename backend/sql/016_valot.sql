-- 016: Liikennevaloetuisuus pysäkkiväleittäin (HSL HFP: TLR = pyyntö, TLA = vastaus ACK/NAK)
-- Erottaa valojen ja työmaan vaikutuksen: verrataan ajoaikaa niillä ohituksilla, joilla etuisuus evättiin, niihin joilla ei.
alter table seg_havainto add column if not exists valo_pyynto smallint, add column if not exists valo_ok smallint, add column if not exists valo_ei smallint;

create or replace view v_vali_valot with (security_invoker = false) as
select from_stop, to_stop,
  count(*) filter (where valo_pyynto is not null) n,
  count(*) filter (where valo_pyynto > 0) n_valo,
  sum(valo_pyynto) pyynnot, sum(valo_ok) myonnetty, sum(valo_ei) evatty,
  round(avg(ddl_ajo) filter (where valo_pyynto > 0 and coalesce(valo_ei,0) = 0)::numeric, 1) viive_ei_evatty,
  round(avg(ddl_ajo) filter (where valo_ei > 0)::numeric, 1) viive_evatty,
  count(*) filter (where valo_ei > 0) n_evatty,
  round(avg(ddl_ajo) filter (where valo_pyynto = 0)::numeric, 1) viive_ei_valoja
from seg_havainto
where t > now() - interval '7 days' and valo_pyynto is not null
group by from_stop, to_stop;
grant select on v_vali_valot to anon, authenticated;
