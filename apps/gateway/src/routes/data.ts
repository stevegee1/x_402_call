import { inBbox, type BBox, type RegionId } from "@mx/shared";
import { Hono, type Context } from "hono";
import type { AppDeps, AppEnv } from "../context";
import { paid } from "../payments/billing";
import { envelope, type RegionSnapshot } from "../snapshot/engine";

const json = (body: string, etag: string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", etag, "cache-control": "private, no-store" } });

function parseBbox(v: string | undefined): BBox | null | "invalid" {
  if (!v) return null;
  const n = v.split(",").map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return "invalid";
  return n as BBox;
}

export function dataRoutes(d: AppDeps) {
  const r = new Hono<AppEnv>();

  r.get("/v1/:region/vessels", paid("vessels", d), (c) => {
    const s = c.get("snapshot");
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

  const vesselExists = (c: Context<AppEnv>, s: RegionSnapshot) =>
    s.byMmsi.has(Number(c.req.param("mmsi")))
      ? null
      : c.json({ error: "vessel_not_found", detail: "not currently reported in this region; you have not been charged" }, 404);

  r.get("/v1/:region/vessels/:mmsi", paid("vessel", d, vesselExists), (c) => {
    const s = c.get("snapshot");
    const mmsi = Number(c.req.param("mmsi"));
    const v = s.byMmsi.get(mmsi);
    if (!v) return c.json({ error: "vessel_not_found" }, 404); // evicted between precheck and handler: billing refunds/cancels
    const track = d.engine.track(c.req.param("region") as RegionId, mmsi).map((p) => ({ ts: new Date(p.ts).toISOString(), lat: p.lat, lon: p.lon, sog: p.sog ?? null, cog: p.cog ?? null }));
    return json(envelope(s, { ...v, track }), s.etag);
  });

  r.get("/v1/:region/density", paid("density", d), (c) => json(c.get("snapshot").bodies.density, c.get("snapshot").etag));
  r.get("/v1/:region/queue", paid("queue", d), (c) => json(c.get("snapshot").bodies.queue, c.get("snapshot").etag));
  r.get("/v1/:region/anomalies", paid("anomalies", d), (c) => json(c.get("snapshot").bodies.anomalies, c.get("snapshot").etag));

  return r;
}
