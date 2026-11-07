import type { AsOfQuery, EnvCache, StoredObservation } from "@mx/env";
import type { Country } from "./source";

export interface HistoryStore {
  asOf(q: AsOfQuery): Promise<StoredObservation[]>;
  revisions(dataset: string, region: string, validFrom: number): Promise<StoredObservation[]>;
}

export type ReadPath = "memory" | "store";

/**
 * Point-in-time reads for Grid. The recent window is answered from the in-memory cache; anything
 * older goes to Postgres. Both give the same answer for the same question (tested), so where a read
 * is served from never changes what the buyer gets.
 */
export class GridHistory {
  readonly reads: Record<ReadPath, number> = { memory: 0, store: 0 };

  constructor(
    private readonly cache: EnvCache,
    private readonly store: HistoryStore,
  ) {}

  get dataset(): string {
    return this.cache.dataset;
  }

  status() {
    const w = this.cache.ready ? new Date(this.cache.windowStart()).toISOString() : null;
    return { window_start: w, cached_versions: this.cache.size, position: this.cache.position, reads: this.reads };
  }

  async history(country: Country, from: number, to: number, asOf?: number): Promise<{ rows: StoredObservation[]; path: ReadPath }> {
    if (this.cache.covers(from)) {
      this.reads.memory++;
      return { rows: this.cache.asOf(country, from, to, asOf), path: "memory" };
    }
    this.reads.store++;
    return { rows: await this.store.asOf({ dataset: this.dataset, region: country, from, to, asOf }), path: "store" };
  }

  async revisions(country: Country, period: number): Promise<{ rows: StoredObservation[]; path: ReadPath }> {
    if (this.cache.covers(period)) {
      this.reads.memory++;
      return { rows: this.cache.revisions(country, period), path: "memory" };
    }
    this.reads.store++;
    return { rows: await this.store.revisions(this.dataset, country, period), path: "store" };
  }
}
