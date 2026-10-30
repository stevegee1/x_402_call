import { REGIONS, haversineM, inPolygon, type AisEvent, type DataMode, type RegionId, type VesselPosition, type VesselStatic } from "@mx/shared";

const TRACK_POINTS = 20;
/** Vessels not heard from for this long are evicted from memory. */
export const EVICT_AFTER_MS = 30 * 60_000;

export interface VesselRecord {
  last: VesselPosition;
  track: VesselPosition[];
  /** When the vessel became stationary inside an anchorage (for wait-time stats). */
  anchoredSince?: number;
  anchorageId?: string;
  /** When the vessel became slow (<1kn) outside any anchorage (loitering). */
  slowSince?: number;
  /** Implied speed (kn) between the last two reports, for jump detection. */
  impliedKn?: number;
}

export interface RegionState {
  id: RegionId;
  vessels: Map<number, VesselRecord>;
  lastMessageAt: number;
  lastSourceTs: number;
  modes: Set<DataMode>;
  messages: number;
}

/** Mutable world state fed by the bus. Only the snapshot builder reads it. */
export class WorldState {
  readonly regions = new Map<RegionId, RegionState>();
  readonly statics = new Map<number, VesselStatic>();

  constructor() {
    for (const id of Object.keys(REGIONS) as RegionId[]) {
      this.regions.set(id, { id, vessels: new Map(), lastMessageAt: 0, lastSourceTs: 0, modes: new Set(), messages: 0 });
    }
  }

  apply(e: AisEvent, now = Date.now()) {
    if (e.kind === "static") {
      const prev = this.statics.get(e.data.mmsi);
      // Type 24 arrives in two halves; merge rather than overwrite.
      this.statics.set(e.data.mmsi, { ...prev, ...stripUndefined(e.data), mmsi: e.data.mmsi, ts: e.data.ts, source: e.data.source });
      return;
    }
    const rs = this.regions.get(e.region);
    if (!rs) return;
    const p = e.data;
    rs.lastMessageAt = now;
    rs.lastSourceTs = Math.max(rs.lastSourceTs, p.ts);
    rs.modes.add(p.mode);
    rs.messages++;

    let rec = rs.vessels.get(p.mmsi);
    if (!rec) {
      rec = { last: p, track: [p] };
      rs.vessels.set(p.mmsi, rec);
    } else {
      if (p.ts < rec.last.ts) return; // out-of-order duplicate from a slower receiver
      const dtH = (p.ts - rec.last.ts) / 3_600_000;
      if (dtH > 0) rec.impliedKn = haversineM(rec.last.lat, rec.last.lon, p.lat, p.lon) / 1852 / dtH;
      rec.last = p;
      rec.track.push(p);
      if (rec.track.length > TRACK_POINTS) rec.track.shift();
    }
    this.updateDwell(e.region, rec, p);
  }

  private updateDwell(region: RegionId, rec: VesselRecord, p: VesselPosition) {
    const stationary = p.navStatus === 1 || (p.sog ?? 99) < 1;
    const anchorage = REGIONS[region].anchorages.find((a) => inPolygon(p.lon, p.lat, a.polygon));
    if (stationary && anchorage) {
      if (rec.anchorageId !== anchorage.id) {
        rec.anchorageId = anchorage.id;
        rec.anchoredSince = p.ts;
      }
      rec.slowSince = undefined;
      return;
    }
    rec.anchorageId = undefined;
    rec.anchoredSince = undefined;
    if (stationary) rec.slowSince ??= p.ts;
    else rec.slowSince = undefined;
  }

  evict(now = Date.now()) {
    for (const rs of this.regions.values()) {
      for (const [mmsi, rec] of rs.vessels) if (now - rec.last.ts > EVICT_AFTER_MS) rs.vessels.delete(mmsi);
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
