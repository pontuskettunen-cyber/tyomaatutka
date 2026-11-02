// Työmaatutka – säähavainnot Ilmatieteen laitoksen avoimesta datasta (CC BY 4.0), Helsinki Kaisaniemi (fmisid 100971).
// Miksi: sää vääristää ennen–jälkeen-vertailua (lumipäivänä kaikki on hitaampaa), ja sää aiheuttaa itse katutöitä
// (pakkasen vesijohtovuodot, rankkasateen tulvat). Havainnot tallennetaan 10 min välein samaan tahtiin kuin bussien mittaukset.
// Kutsu: POST /functions/v1/saa-haku  (oletus: viimeiset 3 h)  tai  ?paivat=30  (takautuva haku, enintään 7 vrk kerrallaan).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const FMISID = 100971; // Helsinki Kaisaniemi
const PARAM = "t2m,ri_10min,snow_aws,ws_10min,wawa";
const MAP: Record<string, string> = { t2m: "t2m", ri_10min: "ri", snow_aws: "lumi", ws_10min: "tuuli", wawa: "wawa" };

async function hae(alku: Date, loppu: Date) {
  const u = `https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature&storedquery_id=fmi::observations::weather::simple` +
    `&fmisid=${FMISID}&parameters=${PARAM}&timestep=10&starttime=${alku.toISOString().slice(0, 19)}Z&endtime=${loppu.toISOString().slice(0, 19)}Z`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`FMI ${r.status}`);
  const xml = await r.text();
  const rows = new Map<string, any>();
  const re = /<BsWfs:Time>([^<]+)<\/BsWfs:Time>\s*<BsWfs:ParameterName>([^<]+)<\/BsWfs:ParameterName>\s*<BsWfs:ParameterValue>([^<]+)<\/BsWfs:ParameterValue>/g;
  for (const m of xml.matchAll(re)) {
    const v = Number(m[3]);
    if (!Number.isFinite(v)) continue;
    const t = m[1], k = MAP[m[2]];
    if (!k) continue;
    const row = rows.get(t) ?? { t, asema: FMISID };
    row[k] = k === "lumi" && v < 0 ? 0 : v; // -1 = ei lunta
    rows.set(t, row);
  }
  return [...rows.values()];
}

Deno.serve(async (req) => {
  const paivat = Math.min(60, Number(new URL(req.url).searchParams.get("paivat") ?? 0));
  const loppu = new Date();
  const jaksot: [Date, Date][] = [];
  if (paivat > 0) {
    for (let a = new Date(+loppu - paivat * 864e5); a < loppu; a = new Date(+a + 7 * 864e5)) jaksot.push([a, new Date(Math.min(+a + 7 * 864e5, +loppu))]);
  } else jaksot.push([new Date(+loppu - 3 * 3600e3), loppu]);
  let n = 0;
  try {
    for (const [a, b] of jaksot) {
      const rows = await hae(a, b);
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from("saa_havainto").upsert(rows.slice(i, i + 500));
        if (error) throw error;
      }
      n += rows.length;
    }
    return new Response(JSON.stringify({ havaintoja: n, jaksoja: jaksot.length }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    await db.from("tallennin_loki").insert({ funktio: "saa-haku", rivit: n, virhe: String(e).slice(0, 300) });
    return new Response(JSON.stringify({ virhe: String(e) }), { status: 500 });
  }
});
