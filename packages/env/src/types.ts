/**
 * Environmental time series (architecture.md §6). A dataset is a set of regions, each a series of
 * fixed-length periods. Each value carries a quality flag. We never invent a value: a missing or
 * implausible input is stored as such, not filled in.
 */

/** ok: usable value. missing: the source published no value. rejected: the source's value failed the checks. */
export type Quality = "ok" | "missing" | "rejected";

/** One cleaned value for one period, as read in one fetch. */
export interface Observation {
  region: string;
  /** Period start, epoch ms UTC, aligned to the dataset's period length. */
  validFrom: number;
  /** Non-null exactly when quality is "ok". */
  value: number | null;
  quality: Quality;
  /** The source's raw value, kept only when quality is "rejected" (for audit). */
  rawValue: string | null;
}

export interface CleanResult {
  observations: Observation[];
  /** Source rows we couldn't place at all (no valid, aligned period start). */
  dropped: number;
  /** Source rows repeating a period already seen in the same fetch; the last one wins. */
  duplicates: number;
}

export interface DatasetSpec {
  /** Stable id stored with every row, e.g. "neso.carbon_intensity". Never rename. */
  id: string;
  unit: string;
  periodMs: number;
  regions: readonly string[];
  /** NESO Data Portal (CKAN) resource that holds the series. */
  resourceId: string;
  /** How many of the newest rows to read per fetch: the whole forward horizon plus some recent past. */
  fetchLimit: number;
  /** Turns raw datastore records into observations. Must not throw on bad records. */
  clean(records: readonly unknown[]): CleanResult;
}

/** A stored version of one value, as returned by point-in-time reads. */
export interface StoredObservation extends Observation {
  ingestedAt: number;
  publishedAt: number | null;
}
