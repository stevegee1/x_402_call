/**
 * Environmental time series (architecture.md §6). A dataset is a set of regions, each a series of
 * fixed-length periods. "Region" is the series key within a dataset: a place for carbon intensity
 * (england, london), a quantity for the others (wind, wind_capacity, gas). Each value carries a quality flag. We never invent a value: a missing or
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
  /**
   * Source rows not stored: no valid, aligned period start; every copy of a period repeated with
   * different values; or every row of a fetch refused whole (mixed forecast runs).
   */
  dropped: number;
  /** Extra copies of a period repeated with the same values in one fetch (one copy is kept). */
  duplicates: number;
}

export interface DatasetSpec {
  /** Stable id stored with every row, e.g. "neso.carbon_intensity". Never rename. */
  id: string;
  unit: string;
  periodMs: number;
  regions: readonly string[];
  /** Where it comes from: the NESO Data Portal (default) or the Environment Agency API. */
  source?: "neso" | "ea" | "elexon";
  /** With a source that gives no publish time, fetch at most this often (default: every check). */
  minFetchIntervalMs?: number;
  /** The source's resource: a NESO (CKAN) resource id, or an EA API path. */
  resourceId: string;
  /** True when a fetch with no rows is normal (no flood warnings in force), so it isn't flagged. */
  emptyIsNormal?: boolean;
  /** CKAN datastore sort that puts the newest periods first, e.g. "datetime desc". */
  sort: string;
  /** How many of the newest rows to read per fetch: the whole forward horizon plus some recent past. */
  fetchLimit: number;
  /**
   * True when the resource holds only the current forecast run, so each fetch reads all of it.
   * A fetch that fills `fetchLimit` then means the horizon was cut, and the poller warns.
   */
  wholeResource: boolean;
  /** Turns raw datastore records into observations. Must not throw on bad records. */
  clean(records: readonly unknown[]): CleanResult;
}

/** A stored version of one value, as returned by point-in-time reads. */
export interface StoredObservation extends Observation {
  ingestedAt: number;
  publishedAt: number | null;
}
