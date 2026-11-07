import pg from "pg";
import type { Observation, Quality, StoredObservation } from "./types";

export interface VersionWrite {
  dataset: string;
  unit: string;
  /** Our clock when the fetch completed: the as-of key for every row written. */
  ingestedAt: number;
  /** The source's own publish time, if it gave one. Ignored (stored as null) if later than ingestedAt. */
  publishedAt: number | null;
  observations: readonly Observation[];
  /** Rows the cleaner couldn't place, for the fetch log. */
  dropped: number;
}

export interface FetchFailure {
  dataset: string;
  fetchedAt: number;
  publishedAt: number | null;
  error: string;
}

export interface AsOfQuery {
  dataset: string;
  region: string;
  /** Inclusive period start, epoch ms. */
  from: number;
  /** Exclusive period start, epoch ms. */
  to: number;
  /** Knowledge time, epoch ms: only versions ingested at or before it. Omit for the latest. */
  asOf?: number;
  /** Row cap; at most MAX_ROWS. */
  limit?: number;
}

export interface FetchRecord {
  fetchedAt: number;
  publishedAt: number | null;
  ok: boolean;
  rowsSeen: number;
  rowsChanged: number;
  rowsDropped: number;
  error: string | null;
}

export const MAX_ROWS = 10_000;

/** Errors from the database are often long; the fetch log keeps a readable prefix. */
const clip = (s: string) => (s.length > 500 ? `${s.slice(0, 500)}…` : s);

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Append-only version store for environmental data (architecture.md §6.3), on Postgres.
 * Safe with several writers: each write takes a per-dataset transaction lock, then appends only the
 * values that differ from the latest stored version.
 */
export class PgEnvStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string, poolMax = 4) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolMax });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** True when migration 004 has run. The gateway owns migrations, so this service only checks. */
  async schemaReady(): Promise<boolean> {
    const r = await this.pool.query<{ ok: boolean }>(
      "select to_regclass('public.env_observation') is not null and to_regclass('public.env_fetch') is not null as ok",
    );
    return r.rows[0]?.ok === true;
  }

  /** Cheap round trip, for readiness. */
  async ping(): Promise<void> {
    await this.pool.query("select 1");
  }

  /** True when env_observation is a TimescaleDB hypertable (reported on /status). */
  async hypertable(): Promise<boolean> {
    try {
      const r = await this.pool.query<{ n: number }>(
        "select count(*)::int as n from timescaledb_information.hypertables where hypertable_name = 'env_observation'",
      );
      return (r.rows[0]?.n ?? 0) > 0;
    } catch {
      return false; // extension not installed
    }
  }

  /**
   * Appends the values that changed since the latest stored version, and logs the fetch, in one
   * transaction. Returns how many rows were appended.
   */
  async writeVersion(w: VersionWrite): Promise<number> {
    const publishedAt = w.publishedAt !== null && w.publishedAt <= w.ingestedAt ? w.publishedAt : null;
    const obs = w.observations;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Serialises writers of one dataset, so two replicas can't both append the same change.
      await client.query("select pg_advisory_xact_lock(hashtextextended('env_observation:' || $1, 0))", [w.dataset]);
      const res = await client.query(
        `with n as (
           select * from unnest($1::text[], $2::timestamptz[], $3::float8[], $4::text[], $5::text[])
             as n(region, valid_from, value, quality, raw_value)
         ),
         latest as (
           select distinct on (o.region, o.valid_from) o.region, o.valid_from, o.value, o.quality, o.raw_value
           from env_observation o
           join n on o.region = n.region and o.valid_from = n.valid_from
           where o.dataset = $6
           order by o.region, o.valid_from, o.ingested_at desc
         )
         insert into env_observation (dataset, region, valid_from, ingested_at, published_at, value, unit, quality, raw_value)
         select $6, n.region, n.valid_from, $7, $8, n.value, $9, n.quality, n.raw_value
         from n
         left join latest l on l.region = n.region and l.valid_from = n.valid_from
         where l.region is null
            or l.value is distinct from n.value
            or l.quality is distinct from n.quality
            or l.raw_value is distinct from n.raw_value
         on conflict do nothing`,
        [
          obs.map((o) => o.region),
          obs.map((o) => iso(o.validFrom)),
          obs.map((o) => o.value),
          obs.map((o) => o.quality),
          obs.map((o) => o.rawValue),
          w.dataset,
          iso(w.ingestedAt),
          publishedAt === null ? null : iso(publishedAt),
          w.unit,
        ],
      );
      const changed = res.rowCount ?? 0;
      await client.query(
        `insert into env_fetch (dataset, fetched_at, published_at, ok, rows_seen, rows_changed, rows_dropped)
         values ($1, $2, $3, true, $4, $5, $6)`,
        [w.dataset, iso(w.ingestedAt), publishedAt === null ? null : iso(publishedAt), obs.length, changed, w.dropped],
      );
      await client.query("commit");
      return changed;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Logs a failed fetch. The caller treats this as best effort: it may fail for the same reason. */
  async recordFailure(f: FetchFailure): Promise<void> {
    await this.pool.query(
      "insert into env_fetch (dataset, fetched_at, published_at, ok, error) values ($1, $2, $3, false, $4)",
      [f.dataset, iso(f.fetchedAt), f.publishedAt === null ? null : iso(f.publishedAt), clip(f.error) || "unknown error"],
    );
  }

  /**
   * For each period in [from, to), the version that was current at `asOf` (or now, if omitted).
   * Periods first seen after `asOf` are absent, as they were unknown then.
   */
  async asOf(q: AsOfQuery): Promise<StoredObservation[]> {
    if (!(q.from < q.to)) throw new RangeError("from must be before to");
    const limit = Math.min(q.limit ?? MAX_ROWS, MAX_ROWS);
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    const r = await this.pool.query<{
      valid_from: Date;
      ingested_at: Date;
      published_at: Date | null;
      value: number | null;
      quality: Quality;
      raw_value: string | null;
    }>(
      `select distinct on (valid_from) valid_from, ingested_at, published_at, value, quality, raw_value
       from env_observation
       where dataset = $1 and region = $2 and valid_from >= $3 and valid_from < $4
         and ($5::timestamptz is null or ingested_at <= $5)
       order by valid_from, ingested_at desc
       limit $6`,
      [q.dataset, q.region, iso(q.from), iso(q.to), q.asOf === undefined ? null : iso(q.asOf), limit],
    );
    return r.rows.map((row) => ({
      region: q.region,
      validFrom: row.valid_from.getTime(),
      value: row.value,
      quality: row.quality,
      rawValue: row.raw_value,
      ingestedAt: row.ingested_at.getTime(),
      publishedAt: row.published_at?.getTime() ?? null,
    }));
  }

  /** The newest successful fetch at or before `at` (or ever): how fresh our knowledge was then. */
  async lastSuccess(dataset: string, at?: number): Promise<FetchRecord | null> {
    const r = await this.pool.query<{
      fetched_at: Date;
      published_at: Date | null;
      ok: boolean;
      rows_seen: number;
      rows_changed: number;
      rows_dropped: number;
      error: string | null;
    }>(
      `select fetched_at, published_at, ok, rows_seen, rows_changed, rows_dropped, error
       from env_fetch
       where dataset = $1 and ok and ($2::timestamptz is null or fetched_at <= $2)
       order by fetched_at desc
       limit 1`,
      [dataset, at === undefined ? null : iso(at)],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      fetchedAt: row.fetched_at.getTime(),
      publishedAt: row.published_at?.getTime() ?? null,
      ok: row.ok,
      rowsSeen: row.rows_seen,
      rowsChanged: row.rows_changed,
      rowsDropped: row.rows_dropped,
      error: row.error,
    };
  }
}
