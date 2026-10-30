import { cellToLatLng, latLngToCell } from "h3-js";
import { REGIONS, distanceToBboxEdgeM, shipCategory, type RegionId, type VesselStatic } from "@mx/shared";
import type { RegionState, VesselRecord } from "./state";

/** Reported positions older than this are not "current". */
export const ACTIVE_WITHIN_MS = 15 * 60_000;
const H3_RES = 7; // ~5 km² cells

export interface VesselView {
  mmsi: number;
  name: string | null;
  imo: number | null;
  category: string;
  ship_type: number | null;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  nav_status: number | null;
  draught_m: number | null;
  length_m: number | null;
  destination: string | null;
  last_report: string;
  age_s: number;
}

export function vesselView(rec: VesselRecord, st: VesselStatic | undefined, now: number): VesselView {
  const p = rec.last;
  return {
    mmsi: p.mmsi,
    name: st?.name ?? null,
    imo: st?.imo ?? null,
    category: shipCategory(st?.shipType),
    ship_type: st?.shipType ?? null,
    lat: p.lat,
    lon: p.lon,
    sog: p.sog ?? null,
    cog: p.cog ?? null,
    heading: p.heading ?? null,
    nav_status: p.navStatus ?? null,
    draught_m: st?.draughtM ?? null,
    length_m: st?.lengthM ?? null,
    destination: st?.destination ?? null,
    last_report: new Date(p.ts).toISOString(),
    age_s: Math.round((now - p.ts) / 1000),
  };
}

export function activeVessels(rs: RegionState, statics: Map<number, VesselStatic>, now: number): VesselView[] {
  const out: VesselView[] = [];
  for (const rec of rs.vessels.values()) {
    if (now - rec.last.ts <= ACTIVE_WITHIN_MS) out.push(vesselView(rec, statics.get(rec.last.mmsi), now));
  }
  return out.sort((a, b) => a.mmsi - b.mmsi);
}

export interface DensityCell {
  h3: string;
  lat: number;
  lon: number;
  vessels: number;
  moving: number;
  stationary: number;
}

export function density(vessels: VesselView[]): DensityCell[] {
  const cells = new Map<string, DensityCell>();
  for (const v of vessels) {
    const h3 = latLngToCell(v.lat, v.lon, H3_RES);
    let c = cells.get(h3);
    if (!c) {
      const [lat, lon] = cellToLatLng(h3);
      cells.set(h3, (c = { h3, lat: round(lat, 5), lon: round(lon, 5), vessels: 0, moving: 0, stationary: 0 }));
    }
    c.vessels++;
    if ((v.sog ?? 0) >= 1) c.moving++;
    else c.stationary++;
  }
  return [...cells.values()].sort((a, b) => b.vessels - a.vessels);
}

export interface QueueReport {
  anchorages: {
    id: string;
    name: string;
    waiting: number;
    wait_hours: { median: number | null; p90: number | null; max: number | null };
    exceeding_draught_limit: number | null;
    vessels: { mmsi: number; name: string | null; draught_m: number | null; waiting_hours: number }[];
  }[];
  draught_limit: { value_m: number; source: string; updated_at: string } | null;
}

export function queue(
  region: RegionId,
  rs: RegionState,
  statics: Map<number, VesselStatic>,
  now: number,
  draughtLimit: QueueReport["draught_limit"],
): QueueReport {
  const anchorages = REGIONS[region].anchorages.map((a) => {
    const waiting = [...rs.vessels.values()].filter(
      (r) => r.anchorageId === a.id && r.anchoredSince !== undefined && now - r.last.ts <= ACTIVE_WITHIN_MS,
    );
    const hours = waiting.map((r) => (now - r.anchoredSince!) / 3_600_000).sort((x, y) => x - y);
    const vessels = waiting
      .map((r) => {
        const st = statics.get(r.last.mmsi);
        return { mmsi: r.last.mmsi, name: st?.name ?? null, draught_m: st?.draughtM ?? null, waiting_hours: round((now - r.anchoredSince!) / 3_600_000, 2) };
      })
      .sort((x, y) => y.waiting_hours - x.waiting_hours);
    return {
      id: a.id,
      name: a.name,
      waiting: waiting.length,
      wait_hours: { median: pct(hours, 0.5), p90: pct(hours, 0.9), max: hours.length ? round(hours.at(-1)!, 2) : null },
      exceeding_draught_limit: draughtLimit ? vessels.filter((v) => (v.draught_m ?? 0) > draughtLimit.value_m).length : null,
      vessels,
    };
  });
  return { anchorages, draught_limit: draughtLimit };
}

export interface Anomaly {
  type: "ais_gap" | "position_jump" | "loitering";
  mmsi: number;
  name: string | null;
  lat: number;
  lon: number;
  detail: string;
  since: string;
}

const GAP_MIN_MS = 10 * 60_000;
const GAP_MAX_MS = 30 * 60_000;
const JUMP_KN = 50;
const LOITER_MS = 2 * 3_600_000;
const EDGE_BUFFER_M = 3_000;

export function anomalies(region: RegionId, rs: RegionState, statics: Map<number, VesselStatic>, now: number): Anomaly[] {
  const bbox = REGIONS[region].bbox;
  const out: Anomaly[] = [];
  for (const rec of rs.vessels.values()) {
    const p = rec.last;
    const name = statics.get(p.mmsi)?.name ?? null;
    const silentMs = now - p.ts;
    // A moving vessel that stops transmitting well inside our coverage is "going dark",
    // not simply leaving the region.
    if (silentMs >= GAP_MIN_MS && silentMs <= GAP_MAX_MS && (p.sog ?? 0) >= 3 && distanceToBboxEdgeM(p.lon, p.lat, bbox) > EDGE_BUFFER_M) {
      out.push({ type: "ais_gap", mmsi: p.mmsi, name, lat: p.lat, lon: p.lon, detail: `no report for ${Math.round(silentMs / 60_000)} min while underway at ${p.sog} kn`, since: new Date(p.ts).toISOString() });
    }
    if (rec.impliedKn !== undefined && rec.impliedKn > JUMP_KN && silentMs <= GAP_MIN_MS) {
      out.push({ type: "position_jump", mmsi: p.mmsi, name, lat: p.lat, lon: p.lon, detail: `implied speed ${Math.round(rec.impliedKn)} kn between reports (possible spoofing/GNSS interference)`, since: new Date(p.ts).toISOString() });
    }
    if (rec.slowSince !== undefined && p.ts - rec.slowSince >= LOITER_MS && silentMs <= GAP_MIN_MS) {
      out.push({ type: "loitering", mmsi: p.mmsi, name, lat: p.lat, lon: p.lon, detail: `stationary outside designated anchorages for ${round((p.ts - rec.slowSince) / 3_600_000, 1)} h`, since: new Date(rec.slowSince).toISOString() });
    }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

function pct(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!, 2);
}

function round(v: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
