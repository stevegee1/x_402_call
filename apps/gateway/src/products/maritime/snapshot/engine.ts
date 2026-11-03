import { REGIONS, type DataMode, type RegionId, type VesselPosition } from "@mx/shared";
import { activeVessels, anomalies, density, queue, type QueueReport, type VesselView } from "./derive";
import type { WorldState } from "./state";

export interface RegionSnapshot {
  region: RegionId;
  seq: number;
  builtAt: number;
  sourceTs: number;
  mode: DataMode;
  stale: boolean;
  vessels: VesselView[];
  byMmsi: Map<number, VesselView>;
  /** Pre-serialised unfiltered response bodies: the hot path is a pointer read + write. */
  bodies: Record<"vessels" | "density" | "queue" | "anomalies", string>;
  etag: string;
}

export type DraughtLimits = Partial<Record<RegionId, QueueReport["draught_limit"]>>;

export function envelope(s: Pick<RegionSnapshot, "region" | "seq" | "builtAt" | "sourceTs" | "mode" | "stale">, data: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    region: s.region,
    mode: s.mode,
    snapshot_seq: s.seq,
    snapshot_ts: new Date(s.builtAt).toISOString(),
    source_ts: s.sourceTs ? new Date(s.sourceTs).toISOString() : null,
    degraded: s.stale,
    ...extra,
    data,
  });
}

/**
 * Rebuilds an immutable snapshot per region every `intervalMs` (default 250ms) and swaps the
 * pointer atomically. Request handlers only ever read the current snapshot.
 */
export class SnapshotEngine {
  private snapshots = new Map<RegionId, RegionSnapshot>();
  private seq = 0;
  private timer?: NodeJS.Timeout;
  private lastEvict = 0;
  draughtLimits: DraughtLimits = {};
  lastBuildMs = 0;

  constructor(
    private readonly world: WorldState,
    private readonly intervalMs = 250,
  ) {
    this.buildAll();
  }

  start() {
    this.timer = setInterval(() => this.buildAll(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  get(region: RegionId): RegionSnapshot {
    return this.snapshots.get(region)!;
  }

  /** Recent track for a vessel (copy; never exposes mutable state). */
  track(region: RegionId, mmsi: number): VesselPosition[] {
    return [...(this.world.regions.get(region)?.vessels.get(mmsi)?.track ?? [])];
  }

  buildAll(now = Date.now()) {
    const t0 = performance.now();
    if (now - this.lastEvict > 10_000) {
      this.world.evict(now);
      this.lastEvict = now;
    }
    const seq = ++this.seq;
    for (const [id, rs] of this.world.regions) {
      const vessels = activeVessels(rs, this.world.statics, now);
      let mode: DataMode = "live";
      for (const rec of rs.vessels.values()) {
        if (rec.last.mode !== "live") {
          mode = rec.last.mode;
          break;
        }
      }
      const meta = { region: id, seq, builtAt: now, sourceTs: rs.lastSourceTs, mode, stale: now - rs.lastMessageAt > REGIONS[id].staleAfterMs };
      const q = queue(id, rs, this.world.statics, now, this.draughtLimits[id] ?? null);
      const a = anomalies(id, rs, this.world.statics, now);
      this.snapshots.set(id, {
        ...meta,
        vessels,
        byMmsi: new Map(vessels.map((v) => [v.mmsi, v])),
        bodies: {
          vessels: envelope(meta, vessels, { count: vessels.length }),
          density: envelope(meta, density(vessels), { h3_resolution: 7 }),
          queue: envelope(meta, q),
          anomalies: envelope(meta, a, { count: a.length }),
        },
        etag: `"${id}-${seq}"`,
      });
    }
    this.lastBuildMs = performance.now() - t0;
  }
}
