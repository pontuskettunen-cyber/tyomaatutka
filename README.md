# Työmaatutka · live

Live-näkymä konseptiin, joka mittaa Helsingin katutöiden vaikutusta bussien ja ratikoiden kulkuun.

- Data: HSL HFP v2 (MQTT), Helsingin kaupungin avoin WFS (kaivu- ja liikennejärjestelyluvat), Fintraffic Digitraffic.
- Keruu: Supabase Edge Functions + pg_cron (minuutin välein), koosteet julkisina näkyminä. Raakadata on RLS:n takana.
- Sivu: staattinen HTML, hakee koostenäkymät 20 s välein.

Vain koostettua joukkoliikenne- ja lupadataa, ei henkilötietoja.
