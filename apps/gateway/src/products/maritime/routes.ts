import { inBbox, REGIONS, type BBox, type RegionId } from "@mx/shared";
import type { ProductContext, ProductRoutes } from "../../platform/product";
import type { MaritimeProduct } from "./index";
import { envelope, type RegionSnapshot } from "./snapshot/engine";

const json = (body: string, etag: string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", etag, "cache-control": "private, no-store" } });

function parseBbox(v: string | undefined): BBox | null | "invalid" {
  if (!v) return null;
  const n = v.split(",").map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return "invalid";
  return n as BBox;
}

export function maritimeRoutes(r: ProductRoutes<RegionSnapshot>, p: MaritimeProduct) {
  r.free(
    "/regions",
    (c) =>
      c.json({
        data: p.status().scopes.map((s) => {
          const id = s.scope as RegionId;
          return {
            ...s,
            id,
            bbox: REGIONS[id].bbox,
            anchorages: REGIONS[id].anchorages.map((a) => ({ id: a.id, name: a.name })),
            endpoints: p.resources.map((e) => ({
              id: e.id,
              path: `/v1/${p.id}${e.path.replace(":region", id)}`,
              price_usdc: e.pricing.priceUsd,
              price_credits_gbp: e.pricing.creditsGbpMicros / 1e6,
              description: e.summary,
            })),
          };
        }),
      }),
    { legacyPaths: ["/v1/regions"], summary: "Regions covered, with live status, anchorages and the paid endpoints for each" },
  );

  r.paid("maritime.vessels", (c, s) => {
    const category = c.req.query("category");
    const minSpeed = c.req.query("min_speed_kn");
    const bbox = parseBbox(c.req.query("bbox"));
    if (bbox === "invalid") return c.json({ error: "bbox must be minLon,minLat,maxLon,maxLat" }, 400);
    // Unfiltered: serve the pre-serialised body (the 250ms snapshot), zero work on the hot path.
    if (!category && !minSpeed && !bbox) return json(s.bodies.vessels, s.etag);
    const min = minSpeed ? Number(minSpeed) : undefined;
    const data = s.vessels.filter(
      (v) => (!category || v.category === category) && (min === undefined || (v.sog ?? 0) >= min) && (!bbox || inBbox(v.lon, v.lat, bbox)),
    );
    return json(envelope(s, data, { count: data.length }), s.etag);
  });

  const vesselExists = (c: ProductContext, s: RegionSnapshot) =>
    s.byMmsi.has(Number(c.req.param("mmsi")))
      ? null
      : c.json({ error: "vessel_not_found", detail: "not currently reported in this region; you have not been charged" }, 404);

  r.paid(
    "maritime.vessel",
    (c, s) => {
      const mmsi = Number(c.req.param("mmsi"));
      const v = s.byMmsi.get(mmsi);
      if (!v) return c.json({ error: "vessel_not_found" }, 404); // evicted between precheck and handler: billing refunds/cancels
      const track = p.engine.track(s.region, mmsi).map((x) => ({ ts: new Date(x.ts).toISOString(), lat: x.lat, lon: x.lon, sog: x.sog ?? null, cog: x.cog ?? null }));
      return json(envelope(s, { ...v, track }), s.etag);
    },
    { precheck: vesselExists },
  );

  r.paid("maritime.density", (_c, s) => json(s.bodies.density, s.etag));
  r.paid("maritime.queue", (_c, s) => json(s.bodies.queue, s.etag));
  r.paid("maritime.anomalies", (_c, s) => json(s.bodies.anomalies, s.etag));

  r.admin("PUT", "/conditions/panama-draught", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const value = Number(body.value_m);
    if (!(value > 5 && value < 20)) return c.json({ error: "value_m must be a plausible draught in metres" }, 400);
    const source = String(body.source ?? "").slice(0, 300);
    if (!source) return c.json({ error: "source is required (e.g. ACP advisory number)" }, 400);
    await p.setPanamaDraught(value, source);
    return c.json({ ok: true });
  });
}
