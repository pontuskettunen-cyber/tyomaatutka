// Työmaatutka – pysäkkivälikooste koko HSL-alueelta (bussit ja ratikat).
// Kuuntelee lähtötapahtumia (DEP) ~110 s. Kun sama ajoneuvo lähtee kahdelta peräkkäiseltä
// pysäkiltä saman vuoron aikana, syntyy pysäkkiväli: ajoaika ja aikataulupoikkeaman muutos.
// Tallennetaan vain koosteina kahden tunnin ikkunoihin, ei yksittäisiä ajoneuvoja.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import mqtt from "npm:mqtt@5";

const BROKER = "wss://mqtt.hsl.fi:443/";
const LISTEN_MS = 110_000;
const BUCKET_MS = 2 * 3600_000;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Prev = { t: number; stop: number; dl: number | null; trip: string };
type Agg = { bucket: string; from_stop: number; to_stop: number; route: string; dir: number; mode: string;
  n: number; sum_tt: number; sum_tt2: number; min_tt: number; max_tt: number; sum_ddl: number; n_ddl: number };

async function run() {
  const last = new Map<string, Prev>();
  const agg = new Map<string, Agg>();
  let msgs = 0, pairs = 0;
  let lastError: string | null = null;

  const client = mqtt.connect(BROKER, { reconnectPeriod: 2000, connectTimeout: 10_000 });
  client.on("connect", () => client.subscribe(["/hfp/v2/journey/ongoing/dep/bus/#", "/hfp/v2/journey/ongoing/dep/tram/#"], { qos: 0 }));
  client.on("message", (topic: string, msg: Uint8Array) => {
    msgs++;
    try {
      const p = JSON.parse(new TextDecoder().decode(msg))?.DEP;
      if (!p || p.stop == null || !p.tst || p.oper == null || p.veh == null || !p.route) return;
      const mode = topic.split("/")[6] ?? "bus";
      const key = `${p.oper}/${p.veh}`;
      const t = Date.parse(p.tst), stop = Number(p.stop), dl = typeof p.dl === "number" ? p.dl : null;
      const trip = `${p.route}|${p.dir}|${p.oday}|${p.start}`;
      const prev = last.get(key);
      last.set(key, { t, stop, dl, trip });
      if (!prev || prev.trip !== trip || prev.stop === stop) return;
      const tt = (t - prev.t) / 1000;
      if (tt < 5 || tt > 1200) return;
      const bucket = new Date(Math.floor(t / BUCKET_MS) * BUCKET_MS).toISOString();
      const k = `${bucket}|${prev.stop}|${stop}|${p.route}|${p.dir}`;
      const a = agg.get(k) ?? { bucket, from_stop: prev.stop, to_stop: stop, route: String(p.route), dir: Number(p.dir), mode,
        n: 0, sum_tt: 0, sum_tt2: 0, min_tt: tt, max_tt: tt, sum_ddl: 0, n_ddl: 0 };
      a.n++; a.sum_tt += tt; a.sum_tt2 += tt * tt; a.min_tt = Math.min(a.min_tt, tt); a.max_tt = Math.max(a.max_tt, tt);
      // dl: negatiivinen = myöhässä. Muutos (dl_nyt - dl_ennen) < 0 = aikaa menetetty tällä välillä.
      if (dl != null && prev.dl != null && Math.abs(dl - prev.dl) < 900) { a.sum_ddl += dl - prev.dl; a.n_ddl++; }
      agg.set(k, a);
      pairs++;
    } catch { /* ohitetaan */ }
  });
  client.on("error", (e: Error) => { lastError = e.message; });
  await new Promise((r) => setTimeout(r, LISTEN_MS));
  client.end(true);

  const rows = [...agg.values()];
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await db.rpc("seg_add2", { rows: rows.slice(i, i + 1000) });
    if (error) lastError = error.message;
  }
  await db.from("tallennin_loki").insert({ funktio: "hfp-segmentit", rivit: rows.length,
    virhe: lastError ?? `viestejä ${msgs}, pysäkkivälejä ${pairs}` });
}

Deno.serve(() => {
  // @ts-ignore EdgeRuntime on Supabasen ajoympäristön globaali
  EdgeRuntime.waitUntil(run());
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
});
