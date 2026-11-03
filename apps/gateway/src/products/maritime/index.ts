import { isRegionId, REGIONS, REGION_IDS } from "@mx/shared";
import type { Metrics } from "../../metrics";
import type { Product, ProductContext, ProductRoutes, ProductStatus, Resolution } from "../../platform/product";
import type { Store } from "../../store/types";
import { MARITIME_RESOURCES } from "./resources";
import { maritimeRoutes } from "./routes";
import type { RegionSnapshot, SnapshotEngine } from "./snapshot/engine";

export const PANAMA_DRAUGHT_CONDITION = "panama.draught_limit";

export interface MaritimeOptions {
  engine: SnapshotEngine;
  /** Operator reference data (Panama draught limit) persists through the platform store. */
  store: Pick<Store, "getCondition" | "setCondition">;
  /** Health of the AIS feed connection (NATS). Simulator mode is always connected. */
  feedConnected: () => boolean;
  snapshotIntervalMs: number;
}

/** Live AIS data and derived signals for the Dover Strait, Rotterdam and the Panama Canal. */
export class MaritimeProduct implements Product<RegionSnapshot> {
  readonly id = "maritime";
  readonly displayName = "Maritime";
  readonly description = "Live AIS vessel data and derived signals (density, anchorage queues, anomalies) for the Dover Strait, Port of Rotterdam and Panama Canal.";
  readonly resources = MARITIME_RESOURCES;
  readonly engine: SnapshotEngine;

  constructor(private readonly o: MaritimeOptions) {
    this.engine = o.engine;
  }

  /** Restores operator-maintained conditions at boot. */
  async load(): Promise<void> {
    const draught = await this.o.store.getCondition(PANAMA_DRAUGHT_CONDITION);
    if (draught) {
      this.engine.draughtLimits.panama = { value_m: (draught.value as { value_m: number }).value_m, source: draught.source, updated_at: draught.updatedAt.toISOString() };
    }
  }

  async setPanamaDraught(valueM: number, source: string): Promise<void> {
    await this.o.store.setCondition(PANAMA_DRAUGHT_CONDITION, { value_m: valueM }, source);
    this.engine.draughtLimits.panama = { value_m: valueM, source, updated_at: new Date().toISOString() };
  }

  resolve(c: ProductContext): Resolution<RegionSnapshot> | Response {
    const region = c.req.param("region") ?? "";
    if (!isRegionId(region)) return c.json({ error: "unknown_region", regions: REGION_IDS }, 404);
    const snap = this.engine.get(region);
    return { scope: { scope: region, fresh: !snap.stale, mode: snap.mode, sourceTs: snap.sourceTs || null }, state: snap };
  }

  routes(r: ProductRoutes<RegionSnapshot>): void {
    maritimeRoutes(r, this);
  }

  status(): ProductStatus {
    return {
      ready: this.o.feedConnected(),
      scopes: REGION_IDS.map((id) => {
        const s = this.engine.get(id);
        return {
          scope: id,
          name: REGIONS[id].name,
          status: REGIONS[id].status,
          fresh: !s.stale,
          stale: s.stale,
          mode: s.mode,
          vessels: s.vessels.length,
          sourceTs: s.sourceTs || null,
          source_ts: s.sourceTs ? new Date(s.sourceTs).toISOString() : null,
          data_age_s: s.sourceTs ? Math.round((Date.now() - s.sourceTs) / 1000) : null,
        };
      }),
      detail: { snapshot_build_ms: Math.round(this.engine.lastBuildMs * 100) / 100, snapshot_interval_ms: this.o.snapshotIntervalMs, feed_connected: this.o.feedConnected() },
    };
  }

  collectMetrics(m: Metrics): void {
    for (const id of REGION_IDS) {
      const s = this.engine.get(id);
      m.set("region_vessels", s.vessels.length, { product: this.id, region: id });
      m.set("region_stale", s.stale ? 1 : 0, { product: this.id, region: id });
      m.set("region_data_age_seconds", s.sourceTs ? (Date.now() - s.sourceTs) / 1000 : -1, { product: this.id, region: id });
    }
    m.set("snapshot_build_ms", this.engine.lastBuildMs, { product: this.id });
  }
}
