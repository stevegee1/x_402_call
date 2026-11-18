import { EnvCache, EnvHistory, floodSeries, type ChangeRow } from "@mx/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SitesProduct, asOfParam } from "../../../src/products/sites";
import { SITE_INPUTS, type InputKey, type SiteInputSource } from "../../../src/products/sites/inputs";
import { ADMIN_TOKEN, BASE_URL, createTestEnv, type TestEnv } from "../../helpers";
import { MultiFakeStore } from "../trading/fixtures";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const P = 30 * MIN;
const T0 = Date.parse("2026-11-18T12:10:00Z");
const CUR = Date.parse("2026-11-18T12:00:00Z");
const D = Date.parse("2026-11-18T00:00:00Z");
/** ingest's last flood fetch, and its 15-minute period. */
const FLOOD_AT = T0 - 5 * MIN;
const FP = Math.floor(FLOOD_AT / (15 * MIN)) * 15 * MIN;
const S = `${BASE_URL}/v1/sites`;
const iso = (t: number) => new Date(t).toISOString();

type R = ChangeRow & { dataset: string };
function rows(): R[] {
  const out: R[] = [];
  const add = (dataset: string, region: string, validFrom: number, value: number | null, ingestedAt: number) =>
    out.push({ dataset, seq: out.length + 1, region, validFrom, value, quality: value === null ? "missing" : "ok", rawValue: null, ingestedAt, publishedAt: null });
  // Regional carbon: a first forecast at T0-2h (10 higher), revised at T0-1h; London 50 lower.
  for (let t = CUR - 2 * H; t <= CUR + 24 * H; t += P) {
    const v = 200 + (t - CUR) / P; // rises through the day: the cleanest period is the current one
    add("neso.regional_carbon_intensity", "south_england", t, v + 10, T0 - 2 * H);
    add("neso.regional_carbon_intensity", "south_england", t, v, T0 - H);
    add("neso.regional_carbon_intensity", "london", t, v - 50, T0 - H);
  }
  add("elexon.system_prices", "ssp", CUR, 85.5, T0 - 5 * MIN);
  add("elexon.system_prices", "sbp", CUR, 91.25, T0 - 5 * MIN);
  add("elexon.market_index", "apx", CUR - P, 78.1, T0 - 20 * MIN);
  // Flood: an alert in force on one Slough area, one "no longer in force", and a warning that was only in an older fetch.
  add("ea.flood_warnings", floodSeries("061FWF23Mdnhead"), FP, 3, FLOOD_AT);
  add("ea.flood_warnings", floodSeries("061WAF23Slough"), FP, 4, FLOOD_AT);
  add("ea.flood_warnings", floodSeries("061FWF23XMhead"), FP - 15 * MIN, 2, FLOOD_AT - 15 * MIN);
  // Rivers: Thames at Taplow, now and 24 h ago.
  add("ea.river_levels", "st_2603th_masd", CUR, 1.5, T0 - 8 * MIN);
  add("ea.river_levels", "st_2603th_masd", CUR - DAY, 1.2, T0 - DAY);
  // Water and heat, sampled today.
  for (const [q, c] of [["q30", 2], ["q50", 3], ["q70", 3], ["q95", 3]] as const) add("ea.water_availability", `equinix_ld4.${q}`, D, c, T0 - 3 * H);
  add("ea.water_reliability", "equinix_ld4", D, 0, T0 - 3 * H);
  for (const q of ["q30", "q50", "q70", "q95"]) add("ea.water_availability", `telehouse_north.${q}`, D, null, T0 - 3 * H);
  add("ea.water_reliability", "telehouse_north", D, null, T0 - 3 * H);
  add("desnz.heat_networks", "equinix_ld4.operational_2km", D, 0, T0 - 3 * H);
  add("desnz.heat_networks", "equinix_ld4.construction_2km", D, 0, T0 - 3 * H);
  add("desnz.heat_networks", "equinix_ld4.planned_2km", D, 1, T0 - 3 * H);
  add("desnz.heat_network_distance", "equinix_ld4", D, 11_410, T0 - 3 * H);
  return out;
}

describe("site intelligence", () => {
  let env: TestEnv;
  let store: MultiFakeStore;
  let ingest: Map<InputKey, number | null>;
  let ingestAsOf: (key: InputKey, at: number) => number | null;

  async function build() {
    const sources = new Map<InputKey, SiteInputSource>();
    for (const i of SITE_INPUTS) {
      const cache = new EnvCache(store, { dataset: i.spec.id, regions: i.series, windowMs: i.memoryMs });
      await cache.refresh();
      sources.set(i.key, {
        cache,
        history: new EnvHistory(cache, store),
        ingestLastSuccessAt: () => (ingest.has(i.key) ? ingest.get(i.key)! : i.key === "flood" ? FLOOD_AT : T0 - 2 * MIN),
        ingestSuccessAsOf: async (at) => ingestAsOf(i.key, at),
      });
    }
    return new SitesProduct(sources, Date.now);
  }

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    store = new MultiFakeStore(rows());
    ingest = new Map();
    ingestAsOf = (_k, at) => at - 5 * MIN;
    env = await createTestEnv({}, { products: [await build()] });
  });
  afterEach(() => vi.useRealTimers());

  async function creditsKey(netGbp = 5) {
    const signup = await (await env.fetch(`${BASE_URL}/v1/credits/accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "Ops Ltd", email: "o@b.test", country: "GB" }) })).json();
    await env.fetch(`${BASE_URL}/admin/credits/${signup.account_id}/topup`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ net_gbp: netGbp, reference: "t" }) });
    return signup.api_key as string;
  }
  const balance = async (key: string) => (await (await env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${key}` } })).json()).balance_gbp as number;
  const get = (key: string, url: string) => env.fetch(url, { headers: { authorization: `Bearer ${key}` } });

  it("lists our sites free, with endpoints and prices", async () => {
    const body = await (await env.fetch(`${S}/list`)).json();
    expect(body.data).toHaveLength(7);
    expect(body.fresh).toBe(true);
    const ld4 = body.data.find((s: { id: string }) => s.id === "equinix_ld4");
    expect(ld4.endpoints.map((e: { path: string; price_usdc: string }) => [e.path, e.price_usdc])).toEqual([
      ["/v1/sites/equinix_ld4/report", "0.052"],
      ["/v1/sites/equinix_ld4/flood", "0.012"],
    ]);
  });

  it("a report has every section, from memory, with every licence line, charged once", async () => {
    const key = await creditsKey();
    const before = await balance(key);
    const res = await get(key, `${S}/equinix_ld4/report`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.site).toMatchObject({ id: "equinix_ld4", cluster: "slough", grid_region: "south_england" });
    expect(b.carbon).toMatchObject({ region: "south_england", now: { from: iso(CUR), value: 200 }, next_24h: { min: 200, max: 248, cleanest_period: iso(CUR) } });
    expect(b.prices).toMatchObject({ system_sell: { value: 85.5 }, system_buy: { value: 91.25 }, market_index: { from: iso(CUR - P), value: 78.1 } });
    expect(b.flood).toMatchObject({ observed_at: iso(FLOOD_AT), areas_watched: 4, in_force: [{ area: "061FWF23Mdnhead", severity: 3, level: "flood alert" }], most_severe: "flood alert" });
    expect(b.rivers.gauges[0]).toMatchObject({ gauge: "st_2603th_masd", level_m: 1.5, change_24h_m: 0.3 });
    expect(b.water).toMatchObject({ assessed: true, by_flow: { q30: { class: 2, label: "restricted" }, q95: { class: 3, label: "not available" } }, available_pct_of_time_at_least: 0 });
    expect(b.heat).toEqual({ within_2km: { operational: 0, under_construction: 0, planned: 1 }, nearest_live_network_m: 11_410, known_at: iso(T0 - 3 * H) });
    expect(b.sources.map((s: { attribution: string }) => s.attribution).join(" | ")).toMatch(/National Energy SO.*Elexon.*Environment Agency flood.*Environment Agency information.*Open Government Licence/);
    expect(store.calls).toEqual([]); // the whole report was a memory read
    expect(await balance(key)).toBeCloseTo(before - 0.042, 6);
  });

  it("says plainly when the EA does not assess water at a site, instead of guessing", async () => {
    const b = await (await get(await creditsKey(), `${S}/telehouse_north/report`)).json();
    expect(b.water).toMatchObject({ assessed: false });
    expect(b.carbon.region).toBe("london");
  });

  it("flood: alerts in force now, river levels, at the cheaper price", async () => {
    const key = await creditsKey();
    const before = await balance(key);
    const b = await (await get(key, `${S}/equinix_ld5/flood`)).json();
    expect(b.flood.in_force).toEqual([{ area: "061FWF23Mdnhead", severity: 3, level: "flood alert" }]);
    expect(b.rivers.gauges.map((g: { gauge: string }) => g.gauge)).toEqual(["st_2603th_masd", "st_2609th_masd", "st_2698th_masd"]);
    expect(b.carbon).toBeUndefined();
    expect(await balance(key)).toBeCloseTo(before - 0.01, 6);
  });

  it("an unknown site is 404 and not charged", async () => {
    const key = await creditsKey();
    const before = await balance(key);
    const r = await get(key, `${S}/my_garage/report`);
    expect(r.status).toBe(404);
    expect((await r.json()).sites).toContain("colt_hayes");
    expect(await balance(key)).toBe(before);
  });

  it("a stale input stops only the resources that read it: heat down blocks reports, not flood", async () => {
    ingest.set("heat", T0 - 31 * H);
    const key = await creditsKey();
    const before = await balance(key);
    const report = await get(key, `${S}/equinix_ld4/report`);
    expect(report.status).toBe(503);
    expect((await report.json()).error).toBe("data_stale");
    expect(await balance(key)).toBe(before);
    expect((await get(key, `${S}/equinix_ld4/flood`)).status).toBe(200);
    const list = await (await env.fetch(`${S}/list`)).json();
    expect(list.stale_inputs).toEqual([{ input: "heat", reason: "ingest has not fetched recently" }]);
  });

  it("as_of: the report as it stood then (no look-ahead)", async () => {
    ingestAsOf = (k, at) => (k === "flood" ? at - 40 * MIN : at - 5 * MIN); // the flood fetch before then: no alert yet
    const at = T0 - 90 * MIN;
    const b = await (await get(await creditsKey(), `${S}/equinix_ld4/report?as_of=${iso(at)}`)).json();
    expect(b.at).toBe(iso(at));
    expect(b.carbon.now).toMatchObject({ from: iso(CUR - 90 * MIN), value: 197 + 10 }); // 10:30, the first forecast: the only one known at 10:40
    expect(b.flood.in_force).toEqual([]);
    expect(b.prices).toBeNull(); // no price was known yet
    expect(b.heat.known_at).toBe(iso(T0 - 3 * H)); // recorded at 09:10, before as_of: known then
  });

  it("as_of must be a past instant with a zone, checked before any charge", async () => {
    const key = await creditsKey();
    const before = await balance(key);
    for (const q of ["2026-11-18T09:00:00", iso(T0 + H), "yesterday"]) expect((await get(key, `${S}/equinix_ld4/report?as_of=${q}`)).status, q).toBe(400);
    expect(await balance(key)).toBe(before);
    expect(asOfParam(undefined, T0)).toBeUndefined();
    expect(asOfParam(iso(T0 - H), T0)).toBe(T0 - H);
  });

  it("an old as_of reads Postgres; a store outage then is 503 and refunded", async () => {
    const key = await creditsKey();
    const before = await balance(key);
    store.down = true;
    const r = await get(key, `${S}/equinix_ld4/report?as_of=${iso(T0 - 5 * DAY)}`);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("history_unavailable");
    expect(await balance(key)).toBe(before);
  });

  it("nothing recorded at as_of: 404 no_history, not charged", async () => {
    const key = await creditsKey();
    const before = await balance(key);
    ingestAsOf = () => null;
    const r = await get(key, `${S}/equinix_ld4/report?as_of=${iso(T0 - 5 * DAY)}`);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("no_history");
    expect(await balance(key)).toBe(before);
  });

  it("the home page offers it, and every page carries the EA and OGL licence lines", async () => {
    const home = await (await env.fetch(`${BASE_URL}/`, { headers: { accept: "text/html" } })).text();
    expect(home).toContain("Data-centre site intelligence");
    expect(home).toContain("not for safety-critical use");
    expect(home).toContain("Open Government Licence v3.0");
    const docs = await (await env.fetch(`${BASE_URL}/docs`, { headers: { accept: "text/html" } })).text();
    expect(docs).toContain("/v1/sites/{site}/report");
    expect(docs).toContain("Contains Environment Agency information");
  });

  it("the catalog reads every input it needs from the version store", () => {
    expect(SITE_INPUTS.map((i) => i.spec.id)).toEqual([
      "neso.regional_carbon_intensity",
      "elexon.system_prices",
      "elexon.market_index",
      "ea.flood_warnings",
      "ea.river_levels",
      "ea.water_availability",
      "ea.water_reliability",
      "desnz.heat_networks",
      "desnz.heat_network_distance",
    ]);
  });
});
