// Työmaatutka – tekoälykerros.
// Luvut lasketaan tietokannassa. Kielimalli (Claude) vain
//   ?tila=luokittele  tulkitsee lupien vapaan tekstin: sulkeeko työ kaistan, raitiotien tai pysäkin
//   ?tila=katsaus     kirjoittaa katsauksen HSL:lle ja kaupungille valmiista luvuista, viittaa lupiin
//   POST {tila:"kysy", kysymys, lupa_id?, viesti?}  vastaa kysymykseen tai luonnostelee viestin
// API-avain: Supabasen Edge Function -salaisuus ANTHROPIC_API_KEY (ei koskaan selaimeen).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const AKEY = Deno.env.get("ANTHROPIC_API_KEY");
const MALLI_NOPEA = "claude-haiku-5-5";
const MALLI_KIRJOITUS = "claude-sonnet-5-5";
const PAIVARAJA_KYSY = 300;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

async function claude(model: string, system: string, user: string, max = 1500): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AKEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: max, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.content ?? []).map((c: any) => c.text ?? "").join("");
}
function parseJSON(t: string): any {
  t = t.replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.indexOf("[");
  const start = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  try { return JSON.parse(t.slice(start, end + 1)); } catch { /* katkennut vastaus: pelastetaan valmiit oliot */ }
  if (t[start] === "[") return (t.match(/\{[^{}]*\}/g) ?? []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  throw new Error("vastaus ei ollut JSONia (" + t.length + " merkkiä): " + t.slice(0, 120).replace(/\s+/g, " ") + " … " + t.slice(-80).replace(/\s+/g, " "));
}

/* ---------- apurit (samat säännöt kuin sivulla) ---------- */
const ln = (id: string) => /^\d{4}/.test(id) ? (id.slice(1).replace(/^0+/, "") || id) : id;
const lines = (a: string[] | null) => [...new Set((a ?? []).map(ln))].filter((r) => /^\d{1,3}[A-Z]?$/.test(r));
const DAY = 86400000;
function centroid(g: any): [number, number] | null {
  let sx = 0, sy = 0, n = 0;
  const walk = (c: any) => { if (typeof c[0] === "number") { sx += c[0]; sy += c[1]; n++; } else c.forEach(walk); };
  try { walk(g.coordinates); } catch { /* */ }
  return n ? [sy / n, sx / n] : null;
}
const pvm = (t: string | null) => t ? new Date(t).toLocaleDateString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", year: "numeric" }) : null;
const vaihe = (l: any) => { const now = Date.now(), a = l.alkaa ? +new Date(l.alkaa) : 0, p = l.paattyy ? +new Date(l.paattyy) : 8e15;
  return now < a ? "tulossa" : now > p + DAY ? "paattynyt" : "kaynnissa"; };

async function faktat() {
  const { data, error } = await db.from("v_luvat").select(
    "lupa_id,layer,osoite,tarkoitus,kaupunginosa,alkaa,paattyy,segmentteja,linjat,ohitukset_24h,ajoja_vrk,lisaviive_s,ajoneuvotunnit_24h,indeksi_24h,perustaso_ikkunat,geom,ai_sijainti,ai_vaikutus,ai_sulkee");
  if (error) throw new Error(error.message);
  const luvat = (data ?? []) as any[];
  const { data: mt } = await db.from("lupa_mitta").select("lupa_id,ikkuna,jakso,n,lisa_ajo,lisa_seis,ajoneuvotunnit_vrk").in("ikkuna", ["24h", "7d", "ed7d"]);
  const M: Record<string, any> = {};
  for (const r of mt ?? []) (M[r.lupa_id] ??= {})[`${r.ikkuna}|${r.jakso}`] = r;
  const mm = (id: string, ik: string, j = "kaikki") => { const r = M[id]?.[`${ik}|${j}`]; return r && r.n >= 5 ? r : null; };
  const rnd = (x: number | null | undefined) => x == null ? null : Math.round(x);
  const reitilla = luvat.filter((l) => (l.segmentteja ?? 0) > 0);
  const tiivis = (l: any) => ({
    id: l.lupa_id, osoite: (l.osoite ?? "").split(/,\s*/).slice(0, 2).join(", "), alue: l.kaupunginosa,
    tyo: (l.tarkoitus ?? "").split(/\s(?:LISÄYS|KORJAUS|MUUTOS)\b/)[0].slice(0, 160),
    alkaa: pvm(l.alkaa), paattyy: pvm(l.paattyy), vaihe: vaihe(l), linjat: lines(l.linjat),
    ajoja_vrk: l.ajoja_vrk != null ? Math.round(l.ajoja_vrk) : null,
    mitattu_24h: mm(l.lupa_id, "24h") ? { lisaaika_ajossa_s: rnd(mm(l.lupa_id, "24h").lisa_ajo), lisaseisonta_s: rnd(mm(l.lupa_id, "24h").lisa_seis), havaintoja: mm(l.lupa_id, "24h").n, ajoneuvotunnit_vrk: Math.round((mm(l.lupa_id, "24h").ajoneuvotunnit_vrk ?? 0) * 10) / 10 } : null,
    mitattu_7vrk: mm(l.lupa_id, "7d") ? { lisaaika_ajossa_s: rnd(mm(l.lupa_id, "7d").lisa_ajo), lisaseisonta_s: rnd(mm(l.lupa_id, "7d").lisa_seis), havaintoja: mm(l.lupa_id, "7d").n, ajoneuvotunnit_vrk: Math.round((mm(l.lupa_id, "7d").ajoneuvotunnit_vrk ?? 0) * 10) / 10,
      aamuruuhka_s: rnd(mm(l.lupa_id, "7d", "aamu")?.lisa_ajo), iltaruuhka_s: rnd(mm(l.lupa_id, "7d", "ilta")?.lisa_ajo) } : null,
    edellinen_viikko_lisaaika_ajossa_s: rnd(mm(l.lupa_id, "ed7d")?.lisa_ajo),
    tulkinta: l.ai_sijainti ? { sijainti: l.ai_sijainti, vaikutus: l.ai_vaikutus, sulkee: l.ai_sulkee } : null,
  });
  // kasautumat: alkava työ samalle linjalle, jolla on jo työ 0,3–2,5 km päässä
  const act = reitilla.filter((l) => vaihe(l) !== "paattynyt" && +new Date(l.alkaa) < Date.now() + 14 * DAY);
  const c = act.map((l) => l.geom && centroid(l.geom));
  const kas: any[] = [];
  for (let i = 0; i < act.length; i++) for (let j = 0; j < act.length; j++) {
    const a = act[i], b = act[j];
    if (i === j || vaihe(a) !== "tulossa" || !c[i] || !c[j]) continue;
    if (vaihe(b) === "tulossa" && +new Date(b.alkaa) > +new Date(a.alkaa)) continue;
    const d = Math.hypot((c[i]![0] - c[j]![0]) * 111200, (c[i]![1] - c[j]![1]) * 55800);
    if (d < 300 || d > 2500) continue;
    const yht = lines(a.linjat).filter((r) => lines(b.linjat).includes(r) && !/N$/.test(r));
    if (yht.length) kas.push({ uusi: a.lupa_id, olemassa: b.lupa_id, etaisyys_km: Math.round(d / 100) / 10, yhteiset_linjat: yht });
  }
  return {
    pvm: new Date().toLocaleString("fi-FI", { timeZone: "Europe/Helsinki" }),
    yhteensa: { kaynnissa: luvat.filter((l) => vaihe(l) === "kaynnissa").length, reitilla_kaynnissa: reitilla.filter((l) => vaihe(l) === "kaynnissa").length,
      alkaa_7pv: luvat.filter((l) => vaihe(l) === "tulossa" && +new Date(l.alkaa) < Date.now() + 7 * DAY).length },
    kaynnissa_reitilla: reitilla.filter((l) => vaihe(l) === "kaynnissa")
      .sort((a, b) => (mm(b.lupa_id, "24h")?.ajoneuvotunnit_vrk ?? -1) - (mm(a.lupa_id, "24h")?.ajoneuvotunnit_vrk ?? -1) || (b.ajoja_vrk ?? 0) - (a.ajoja_vrk ?? 0)).slice(0, 40).map(tiivis),
    alkavat_14pv_reitilla: reitilla.filter((l) => vaihe(l) === "tulossa" && +new Date(l.alkaa) < Date.now() + 14 * DAY)
      .sort((a, b) => +new Date(a.alkaa) - +new Date(b.alkaa)).slice(0, 40).map(tiivis),
    kasautumat: kas.slice(0, 15),
    raitiovaunulinjat: "Helsingin raitiovaunulinjat ovat 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13 ja 15. Muut linjat ovat busseja (N-pääte = yöbussi).",
    huom: "lisaaika_ajossa_s = mediaani: paljonko enemmän aikaa bussi/ratikka menettää AJOSSA työmaan pysäkkiväleillä kuin saman linjan muilla väleillä samaan aikaan (per ohitus). lisaseisonta_s = paljonko pidempään seistään pysäkillä. havaintoja = otoskoko; alle 30 havaintoa on epävarma. null = ei vielä riittävästi dataa. Keruu aloitettu 2.11.2026, tarkennettu keruu 2.11. klo 6.35.",
  };
}

/* ---------- 1) lupien tulkinta ---------- */
async function luokittele() {
  const { data: snap } = await db.from("luvat_snapshot").select("snap_date").order("snap_date", { ascending: false }).limit(1);
  const pv = snap?.[0]?.snap_date;
  const { data: valmiit } = await db.from("lupa_ai").select("lupa_id");
  const tehty = new Set((valmiit ?? []).map((r: any) => r.lupa_id));
  const { data: reitti } = await db.from("lupa_segmentit").select("lupa_id");
  const reitilla = new Set((reitti ?? []).map((r: any) => r.lupa_id));
  const { data: luvat } = await db.from("luvat_snapshot").select("lupa_id,layer,osoite,tarkoitus,alkaa,paattyy").eq("snap_date", pv);
  const jono = (luvat ?? []).filter((l: any) => !tehty.has(l.lupa_id) && (!l.paattyy || +new Date(l.paattyy) > Date.now() - DAY))
    .sort((a: any, b: any) => Number(reitilla.has(b.lupa_id)) - Number(reitilla.has(a.lupa_id))).slice(0, 60);
  let n = 0;
  for (let i = 0; i < jono.length; i += 15) {
    const erä = jono.slice(i, i + 15).map((l: any) => ({ id: l.lupa_id, tyyppi: l.layer?.startsWith("Tilapainen") ? "liikennejärjestely" : "kaivuilmoitus",
      osoite: l.osoite, kuvaus: (l.tarkoitus ?? "").split(/\s(?:LISÄYS|KORJAUS|MUUTOS)\b/)[0].slice(0, 500) }));
    const system = `Olet liikenneinsinööri, joka luokittelee Helsingin katulupia. Arvioi jokaisesta luvasta pelkän kuvauksen perusteella, missä työ tehdään ja haittaako se ajoneuvoliikennettä.
Palauta VAIN JSON-taulukko, yksi olio per lupa: {"id","sijainti","vaikutus","sulkee","perustelu"}.
- sijainti: "ajorata" | "kaista" | "raitiotie" | "pysakki" | "jalkakaytava" | "piha" | "muu"
- vaikutus ajoneuvoliikenteelle: "suuri" (kaista/raitiotie suljetaan tai kadun liikenne katkeaa) | "kohtalainen" (kavennus, kääntymisrajoitus, ajoittainen haitta) | "pieni" (lähinnä jalkakäytävä, lyhyt työ) | "ei" (piha, puisto, tontin sisällä)
- sulkee: taulukko arvoista "kaista","raitiotie","pysakki","kaantyminen","koko_katu" sen mukaan mitä kuvaus kertoo; tyhjä jos ei mitään
- perustelu: enintään 18 sanaa suomeksi, vain kuvauksessa mainittuihin seikkoihin nojaten. Jos kuvaus ei kerro, sano "kuvaus ei kerro".`;
    const t = await claude(MALLI_NOPEA, system, JSON.stringify(erä), 6000);
    const arr = parseJSON(t);
    const rivit = (Array.isArray(arr) ? arr : []).filter((r: any) => r?.id).map((r: any) => ({
      lupa_id: String(r.id), sijainti: r.sijainti ?? null, vaikutus: r.vaikutus ?? null,
      sulkee: Array.isArray(r.sulkee) ? r.sulkee : [], perustelu: String(r.perustelu ?? "").slice(0, 300), malli: MALLI_NOPEA }));
    if (rivit.length) { const { error } = await db.from("lupa_ai").upsert(rivit); if (error) throw new Error(error.message); n += rivit.length; }
  }
  return { luokiteltu: n, jonossa: jono.length };
}

/* ---------- 2) katsaus ---------- */
async function katsaus() {
  // estää toistuvat kutsut: uusi katsaus korkeintaan 90 min välein
  const { data: viim } = await db.from("ai_katsaus").select("luotu").order("luotu", { ascending: false }).limit(1);
  if (viim?.[0] && Date.now() - +new Date(viim[0].luotu) < 90 * 60000) return { kirjoitettu: [] as string[], ohitettu: "tuore katsaus on jo olemassa" };
  const f = await faktat();
  const system = `Kirjoitat Työmaatutka-palvelun tilannekatsauksen. Saat JSON-muodossa valmiiksi lasketut luvut Helsingin katutöistä ja niiden vaikutuksesta busseihin ja ratikoihin.
Säännöt:
- Käytä VAIN annettuja lukuja. Älä keksi lukuja, syitä tai tapahtumia. Jos data on vielä ohutta, sano se suoraan.
- Jokainen kohta viittaa yhteen lupaan (lupa_id) tai on yleinen (lupa_id null).
- Kirjoita selkeää yleiskieltä suomeksi, ei jargonia. Linjat matkustajan numeroina (esim. "ratikka 4", "bussi 55").
- Priorisoi: 1) mitattu suuri lisäviive, 2) kasautumat (uusi työ linjalle, jolla on jo työ), 3) alkavat työt vilkkailla linjoilla, joiden tulkinta on "suuri".
Vastaa pelkällä JSONilla ilman johdantoa tai markdownia: {"hsl": K, "kaupunki": K}, jossa K = {"otsikko": max 12 sanaa, "kohdat": [{"teksti": max 30 sanaa, "lupa_id": string|null}] (3–5 kpl), "suositus": max 25 sanaa}.
Käytä ensisijaisesti mitattu_24h-lukuja (lisäaika ajossa erottaa työmaan vaikutuksen pysäkkiruuhkasta).
- "hsl" on HSL:n liikennesuunnittelijalle: mitä linjoille tapahtuu ja mihin pitää varautua (poikkeusreitit, aikataulut, tiedotus).
- "kaupunki" on kaupungin lupakäsittelijälle: mitkä luvat aiheuttavat joukkoliikenteelle eniten haittaa ja missä ajoitusta tai ehtoja kannattaisi tarkistaa.`;
  const t = await claude(MALLI_KIRJOITUS, system, JSON.stringify(f), 6000);
  const k = parseJSON(t);
  const rivit = ["hsl", "kaupunki"].filter((r) => k?.[r]).map((r) => ({ rooli: r, sisalto: k[r], malli: MALLI_KIRJOITUS }));
  if (rivit.length) await db.from("ai_katsaus").insert(rivit);
  return { kirjoitettu: rivit.map((r) => r.rooli) };
}

/* ---------- 2b) viikkokatsaus (maanantaisin) ---------- */
async function viikko() {
  const { data: viim } = await db.from("ai_katsaus").select("luotu").eq("rooli", "viikko").order("luotu", { ascending: false }).limit(1);
  if (viim?.[0] && Date.now() - +new Date(viim[0].luotu) < 6 * DAY) return { kirjoitettu: [] as string[], ohitettu: "viikkokatsaus on jo kirjoitettu" };
  const f = await faktat();
  const system = `Kirjoitat Työmaatutkan viikkokatsauksen HSL:n ja Helsingin kaupungin yhteiseen viikkopalaveriin. Saat valmiiksi lasketut luvut (mitattu_7vrk = viimeiset 7 vrk, edellinen_viikko_* = sitä edeltävä viikko).
Säännöt: käytä VAIN annettuja lukuja; mainitse otoskoko kun se on alle 30; älä keksi syitä. Suomeksi, selkeää yleiskieltä, linjat matkustajan numeroina.
Vastaa pelkällä JSONilla ilman johdantoa: {"otsikko": max 12 sanaa, "kohdat": [{"teksti": max 45 sanaa, "lupa_id": string|null}] (4–6 kpl: viikon suurimmat vaikutukset, mikä pahentui ja mikä helpotti edelliseen viikkoon verrattuna, ensi viikolla alkavat kasautumat), "suositus": max 35 sanaa, "tiivis": yksi lause max 20 sanaa}.`;
  const t = await claude(MALLI_KIRJOITUS, system, JSON.stringify(f), 6000);
  const k = parseJSON(t);
  if (k?.otsikko) await db.from("ai_katsaus").insert({ rooli: "viikko", sisalto: k, malli: MALLI_KIRJOITUS });
  return { kirjoitettu: k?.otsikko ? ["viikko"] : [] };
}

/* ---------- 2c) aikatauluagentti ---------- */
// Säännöt valitsevat ehdokkaat (linja-suunta-jakso, jossa huonoin 10 % vuoroista menettää työmailla > 2 min).
// Agentti kirjoittaa jokaiselle perustellun ehdotuksen suunnittelijan päätettäväksi. Mitään ei muuteta automaattisesti.
async function aikataulu() {
  const { data: viim } = await db.from("ai_suositus").select("luotu").order("luotu", { ascending: false }).limit(1);
  if (viim?.[0] && Date.now() - +new Date(viim[0].luotu) < 3 * 3600_000) return { kirjoitettu: 0, ohitettu: "tuore ajo alle 3 h sitten" };
  const { data: ehd } = await db.from("aikataulu_ehdokkaat").select("*").order("p90", { ascending: false }).limit(8);
  if (!ehd?.length) return { kirjoitettu: 0, ohitettu: "ei ehdokkaita" };
  const { data: snap } = await db.from("luvat_snapshot").select("snap_date").order("snap_date", { ascending: false }).limit(1);
  const JAKSO: Record<string, string> = { aamu: "aamuruuhka 7–9", paiva: "päivä 9–15", ilta: "iltaruuhka 15–18" };
  const tapaukset: any[] = [];
  for (const e of ehd) {
    const { data: nauha } = await db.from("linja_nauha").select("lupa_id,jarjestys,lisa,n").eq("route", e.route).eq("dir", e.dir).order("jarjestys");
    const ids = (nauha ?? []).map((r: any) => r.lupa_id);
    const { data: lv } = ids.length ? await db.from("luvat_snapshot").select("lupa_id,osoite,tarkoitus,alkaa,paattyy").eq("snap_date", snap?.[0]?.snap_date).in("lupa_id", ids) : { data: [] };
    const L = Object.fromEntries((lv ?? []).map((r: any) => [r.lupa_id, r]));
    const { data: muut } = await db.from("linja_tila").select("jakso,vuoroja,med,p90").eq("route", e.route).eq("dir", e.dir).eq("ikkuna", "7d");
    const varmuus = e.paivia >= 3 && e.vuoroja >= 40 ? "vahva" : "alustava";
    tapaukset.push({
      linja: ln(e.route), route: e.route, suunta: e.dir, jakso: e.jakso, jakso_nimi: JAKSO[e.jakso] ?? e.jakso,
      vuoroja: e.vuoroja, mittauspaivia: e.paivia, mediaani_s: Math.round(e.med), huonoin_10pros_s: Math.round(e.p90),
      ehdotettu_lisaaika_min: Math.max(0.5, Math.round(e.p90 / 30) / 2), varmuus,
      muut_jaksot: (muut ?? []).filter((m: any) => m.jakso !== e.jakso).map((m: any) => ({ jakso: m.jakso, vuoroja: m.vuoroja, mediaani_s: Math.round(m.med), p90_s: Math.round(m.p90) })),
      tyomaat_reitin_jarjestyksessa: (nauha ?? []).map((r: any) => ({ lupa_id: r.lupa_id, osoite: (L[r.lupa_id]?.osoite ?? "").split(/,\s*/)[0],
        tyo: (L[r.lupa_id]?.tarkoitus ?? "").split(/\s(?:LISÄYS|KORJAUS|MUUTOS)\b/)[0].slice(0, 90), paattyy: pvm(L[r.lupa_id]?.paattyy ?? null),
        lisaaika_s: Math.round(r.lisa), havaintoja: r.n })),
    });
  }
  const system = `Olet HSL:n aikataulu- ja liikennesuunnittelun avustaja. Saat linjasuunnat, joissa katutyöt hidastavat vuoroja selvästi tietyllä kellonajan jaksolla. Luvut on mitattu toteutuneista vuoroista: mediaani = tavallinen vuoro, huonoin_10pros = joka kymmenes vuoro menettää vähintään näin paljon työmaiden kohdalla.
Kirjoita jokaiselle tapaukselle ehdotus suunnittelijan päätettäväksi. Säännöt:
- Käytä VAIN annettuja lukuja ja tietoja. Älä keksi syitä, pysäkkien nimiä tai päivämääriä.
- Ehdota yhtä pääasiallista toimenpidettä: (a) aikataulun ajoajan väljennys jaksolle (käytä ehdotettu_lisaaika_min), (b) yhteydenotto kaupunkiin tai urakoitsijaan, jos yksi työmaa aiheuttaa yli puolet lisäajasta, tai (c) seuranta ilman muutosta, jos varmuus on alustava ja vaikutus rajautuu yhteen päivään.
- Mainitse, milloin vaikutus todennäköisesti päättyy (suurimman työmaan päättymispäivä), jotta väljennys osataan purkaa.
- Kerro varmuus rehellisesti. Jos varmuus on alustava, sano montako päivää lisää tarvitaan.
- Suomeksi, selkeästi, ilman markdownia. Linjat matkustajan numeroina.
Vastaa pelkällä JSON-taulukolla, yksi olio per tapaus samassa järjestyksessä:
[{"route": string, "suunta": number, "jakso": string, "otsikko": max 10 sanaa, "ehdotus": max 30 sanaa, "perustelu": max 45 sanaa, "toimenpiteet": [max 3 lyhyttä kohtaa], "purku": max 20 sanaa}]`;
  const t = await claude(MALLI_KIRJOITUS, system, JSON.stringify(tapaukset), 6000);
  const arr = parseJSON(t);
  const rivit = (Array.isArray(arr) ? arr : []).map((x: any, i: number) => {
    const tap = tapaukset.find((c) => c.route === x.route && String(c.suunta) === String(x.suunta) && c.jakso === x.jakso) ?? tapaukset[i];
    if (!tap) return null;
    return { route: tap.route, dir: tap.suunta, jakso: tap.jakso, varmuus: tap.varmuus, malli: MALLI_KIRJOITUS,
      sisalto: { otsikko: x.otsikko, ehdotus: x.ehdotus, perustelu: x.perustelu, toimenpiteet: x.toimenpiteet ?? [], purku: x.purku },
      perusteet: { vuoroja: tap.vuoroja, mittauspaivia: tap.mittauspaivia, mediaani_s: tap.mediaani_s, huonoin_10pros_s: tap.huonoin_10pros_s,
        ehdotettu_lisaaika_min: tap.ehdotettu_lisaaika_min, tyomaat: tap.tyomaat_reitin_jarjestyksessa.slice(0, 6) } };
  }).filter(Boolean);
  if (rivit.length) await db.from("ai_suositus").insert(rivit);
  return { kirjoitettu: rivit.length };
}

/* ---------- 3) kysy / viestiluonnos ---------- */
async function kysy(body: any) {
  const kysymys = String(body?.kysymys ?? "").slice(0, 500).trim();
  const lupaId = body?.lupa_id ? String(body.lupa_id).slice(0, 40) : null;
  const viesti = body?.viesti === "urakoitsija" || body?.viesti === "hsl" ? body.viesti : null;
  if (!kysymys && !viesti) return { virhe: "Kysymys puuttuu." };
  const pv = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
  const { count } = await db.from("ai_kysely").select("id", { count: "exact", head: true }).eq("pv", pv);
  if ((count ?? 0) >= PAIVARAJA_KYSY) return { virhe: "Päivän kysymyskiintiö on täynnä. Kokeile huomenna uudelleen." };
  await db.from("ai_kysely").insert({ tyyppi: viesti ? "viesti" : "kysy" });

  const f = await faktat();
  let lupa: any = null;
  if (lupaId) {
    const { data } = await db.from("v_luvat").select("lupa_id,osoite,tarkoitus,alkaa,paattyy,linjat,ajoja_vrk,lisaviive_s,ajoneuvotunnit_24h,ai_sijainti,ai_vaikutus,ai_sulkee").eq("lupa_id", lupaId).limit(1);
    lupa = data?.[0] ?? null;
    if (lupa) { const { data: lj } = await db.from("lupa_linjat").select("route,dir,ohitukset_24h,lisaviive_s").eq("lupa_id", lupaId); lupa.linjat_mitattu = (lj ?? []).map((r: any) => ({ linja: ln(r.route), suunta: r.dir, ohitukset_24h: r.ohitukset_24h, lisaviive_s: r.lisaviive_s != null ? Math.round(r.lisaviive_s) : null })).filter((r: any) => /^\d{1,3}[A-Z]?$/.test(r.linja)); lupa.linjat = lines(lupa.linjat); }
  }
  let system: string, user: string;
  if (viesti) {
    system = `Luonnostelet lyhyen, asiallisen viestin suomeksi. Käytä VAIN annettuja lukuja ja lupatietoja. Älä keksi nimiä, puhelinnumeroita tai sopimusehtoja; jätä niille hakasulkeissa paikka, esim. [vastaanottaja]. Max 150 sanaa. Loppuun rivi: "Luvut: Työmaatutka, mitattu HSL:n avoimesta datasta."`;
    user = viesti === "urakoitsija"
      ? `Kirjoita viesti luvan ${lupaId} urakoitsijalle kaupungin puolesta: pyydä harkitsemaan työvaiheiden ajoittamista ruuhka-aikojen (klo 7–9 ja 15–18) ulkopuolelle tai muuta joukkoliikennettä vähemmän haittaavaa järjestelyä, perustellen mitatulla vaikutuksella. Lupa: ${JSON.stringify(lupa)}`
      : `Kirjoita viesti HSL:n liikennesuunnittelulle luvan ${lupaId} vaikutuksesta: mitkä linjat, kuinka paljon, mihin varautua (poikkeusreitti, aikataulu, matkustajatiedotus). Lupa: ${JSON.stringify(lupa)}`;
  } else {
    system = `Olet Työmaatutka-palvelun avustaja. Vastaat kysymyksiin Helsingin katutöiden vaikutuksesta busseihin ja ratikoihin.
- Käytä VAIN annettua dataa. Jos vastausta ei löydy datasta, sano se ja kerro mitä data sisältää.
- Vastaa suomeksi, selkeästi, enintään 120 sanaa, ilman markdown-muotoilua (ei tähtiä tai otsikoita; lyhyt luettelo viivoilla on ok). Mainitse luvut ja osoitteet. Viittaa lupiin muodossa [lupa_id].
- Älä anna oikeudellisia tai turvallisuusneuvoja.`;
    user = `Data: ${JSON.stringify({ ...f, valittu_lupa: lupa })}\n\nKysymys: ${kysymys}`;
  }
  const vastaus = (await claude(viesti ? MALLI_KIRJOITUS : MALLI_NOPEA, system, user, 4000)).trim();
  if (!vastaus) return { virhe: "Vastausta ei saatu, kokeile uudelleen." };
  return { vastaus, malli: viesti ? MALLI_KIRJOITUS : MALLI_NOPEA };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  let body: any = {};
  try { if (req.method === "POST") body = await req.json(); } catch { /* tyhjä */ }
  const tila = url.searchParams.get("tila") ?? body?.tila ?? "tila";
  if (tila === "tila") return json({ ok: true, avain: !!AKEY });
  if (!AKEY) return json({ ok: false, virhe: "Tekoälykerros odottaa API-avainta (ANTHROPIC_API_KEY)." }, 200);
  try {
    if (tila === "luokittele") { const r = await luokittele(); await db.from("tallennin_loki").insert({ funktio: "tekoaly-luokittele", rivit: r.luokiteltu }); return json({ ok: true, ...r }); }
    if (tila === "katsaus") { const r = await katsaus(); await db.from("tallennin_loki").insert({ funktio: "tekoaly-katsaus", rivit: r.kirjoitettu.length }); return json({ ok: true, ...r }); }
    if (tila === "aikataulu") { const r = await aikataulu(); await db.from("tallennin_loki").insert({ funktio: "tekoaly-aikataulu", rivit: r.kirjoitettu, virhe: (r as any).ohitettu ?? null }); return json({ ok: true, ...r }); }
    if (tila === "viikko") { const r = await viikko(); await db.from("tallennin_loki").insert({ funktio: "tekoaly-viikko", rivit: r.kirjoitettu.length }); return json({ ok: true, ...r }); }
    if (tila === "kysy") return json({ ok: true, ...(await kysy(body)) });
    return json({ ok: false, virhe: "tuntematon tila" }, 400);
  } catch (e) {
    await db.from("tallennin_loki").insert({ funktio: "tekoaly-" + tila, rivit: 0, virhe: String((e as Error).message).slice(0, 300) });
    return json({ ok: false, virhe: "Tekoälykutsu epäonnistui." }, 200);
  }
});
