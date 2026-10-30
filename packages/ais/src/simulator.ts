/**
 * Synthetic traffic for local development, CI and the demo fallback.
 * Every record is tagged mode="simulated"; the gateway refuses to sell simulated data on mainnet.
 */
import { REGIONS, KNOT_MPS, type AisEvent, type LonLat, type RegionId } from "@mx/shared";

interface SimVessel {
  mmsi: number;
  name: string;
  shipType: number;
  draughtM: number;
  region: RegionId;
  lon: number;
  lat: number;
  sogKn: number;
  cogDeg: number;
  anchored: boolean;
  /** When set, the vessel stops transmitting at this time (demo for the "went dark" anomaly). */
  darkAt?: number;
}

// Two traffic lanes per region (coarse), as [start, end] lon/lat.
const LANES: Record<RegionId, [LonLat, LonLat][]> = {
  dover: [
    [[1.25, 50.85], [1.95, 51.25]], // NE-bound
    [[2.0, 51.15], [1.1, 50.75]], // SW-bound
  ],
  rotterdam: [
    [[3.35, 52.05], [4.05, 51.98]],
    [[4.05, 51.97], [3.35, 52.0]],
  ],
  panama: [
    [[-79.92, 9.48], [-79.92, 9.3]],
    [[-79.55, 8.75], [-79.57, 8.95]],
  ],
};

const SHIP_TYPES = [70, 71, 79, 80, 81, 60, 52, 30];

function bearingDeg([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
  const y = Math.sin(((lon2 - lon1) * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(((lon2 - lon1) * Math.PI) / 180);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export interface SimulatorOptions {
  vesselsPerRegion?: number;
  regions?: RegionId[];
  seed?: number;
  /** Fraction of vessels that go dark at some point. */
  darkFraction?: number;
}

export class TrafficSimulator {
  private vessels: SimVessel[] = [];
  private rand: () => number;

  constructor(private readonly opts: SimulatorOptions = {}) {
    let s = opts.seed ?? 42;
    // mulberry32: deterministic so tests and demos are reproducible.
    this.rand = () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.seedVessels(Date.now());
  }

  private seedVessels(now: number) {
    const n = this.opts.vesselsPerRegion ?? 60;
    let mmsi = 235_000_000;
    for (const region of this.opts.regions ?? (Object.keys(REGIONS) as RegionId[])) {
      for (let i = 0; i < n; i++) {
        const anchored = i % 5 === 0;
        const v: SimVessel = {
          mmsi: mmsi++,
          name: `SIM ${region.toUpperCase()} ${i}`,
          shipType: SHIP_TYPES[i % SHIP_TYPES.length]!,
          draughtM: Math.round((6 + this.rand() * 10) * 10) / 10,
          region,
          lon: 0,
          lat: 0,
          sogKn: anchored ? 0 : 8 + this.rand() * 12,
          cogDeg: 0,
          anchored,
          darkAt: this.rand() < (this.opts.darkFraction ?? 0.03) ? now + this.rand() * 20 * 60_000 : undefined,
        };
        this.place(v);
        this.vessels.push(v);
      }
    }
  }

  private place(v: SimVessel) {
    const region = REGIONS[v.region];
    if (v.anchored) {
      const poly = region.anchorages[Math.floor(this.rand() * region.anchorages.length)]!.polygon;
      const [minLon, minLat] = poly[0]!;
      const [maxLon, maxLat] = poly[2]!;
      v.lon = minLon + this.rand() * (maxLon - minLon);
      v.lat = minLat + this.rand() * (maxLat - minLat);
      v.cogDeg = this.rand() * 360;
      return;
    }
    const lane = LANES[v.region][Math.floor(this.rand() * 2)]!;
    const t = this.rand();
    v.lon = lane[0][0] + (lane[1][0] - lane[0][0]) * t + (this.rand() - 0.5) * 0.02;
    v.lat = lane[0][1] + (lane[1][1] - lane[0][1]) * t + (this.rand() - 0.5) * 0.02;
    v.cogDeg = bearingDeg(lane[0], lane[1]);
  }

  /** Advances the world by dtMs and returns the events transmitted during the step. */
  step(dtMs: number, now = Date.now()): AisEvent[] {
    const events: AisEvent[] = [];
    for (const v of this.vessels) {
      if (v.darkAt !== undefined && now >= v.darkAt) continue;
      if (!v.anchored) {
        const distM = v.sogKn * KNOT_MPS * (dtMs / 1000);
        const rad = (v.cogDeg * Math.PI) / 180;
        v.lat += (distM * Math.cos(rad)) / 111_320;
        v.lon += (distM * Math.sin(rad)) / (111_320 * Math.cos((v.lat * Math.PI) / 180));
        const bbox = REGIONS[v.region].bbox;
        if (v.lon < bbox[0] || v.lon > bbox[2] || v.lat < bbox[1] || v.lat > bbox[3]) this.place(v);
      }
      // Class A reports every 2-10s underway, ~3 min at anchor. Approximate with a per-step probability.
      const periodMs = v.anchored ? 180_000 : 6_000;
      if (this.rand() < dtMs / periodMs) {
        events.push({
          kind: "position",
          region: v.region,
          data: {
            mmsi: v.mmsi,
            lat: Math.round(v.lat * 1e6) / 1e6,
            lon: Math.round(v.lon * 1e6) / 1e6,
            sog: Math.round(v.sogKn * 10) / 10,
            cog: Math.round(v.cogDeg * 10) / 10,
            heading: Math.round(v.cogDeg),
            navStatus: v.anchored ? 1 : 0,
            ts: now,
            source: "simulator",
            mode: "simulated",
          },
        });
      }
      if (this.rand() < dtMs / 360_000) events.push(this.staticEvent(v, now));
    }
    return events;
  }

  /** Static data for every vessel, used on startup so names/types are known immediately. */
  allStatics(now = Date.now()): AisEvent[] {
    return this.vessels.map((v) => this.staticEvent(v, now));
  }

  private staticEvent(v: SimVessel, now: number): AisEvent {
    return {
      kind: "static",
      data: {
        mmsi: v.mmsi,
        name: v.name,
        shipType: v.shipType,
        draughtM: v.draughtM,
        lengthM: 120 + (v.mmsi % 200),
        destination: v.region === "panama" ? "BALBOA" : v.region === "rotterdam" ? "NLRTM" : "GBDVR",
        ts: now,
        source: "simulator",
      },
    };
  }
}
