/** Anything that can run one parameterised statement and report affected rows (pg.Pool, pg.Client). */
export interface Queryable {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * Deletes AIS position history older than `days`, in batches so a large backlog never holds one
 * long lock or bloats a single transaction. Returns the rows deleted. days <= 0 keeps everything.
 */
export async function pruneHistory(db: Queryable, days: number, opts: { batch?: number; maxBatches?: number } = {}): Promise<number> {
  if (!(days > 0)) return 0;
  const batch = opts.batch ?? 10_000;
  const maxBatches = opts.maxBatches ?? 100;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await db.query(
      `delete from ais_positions where ctid in (select ctid from ais_positions where ts < now() - make_interval(days => $1) limit $2)`,
      [days, batch],
    );
    const n = r.rowCount ?? 0;
    total += n;
    if (n < batch) break;
  }
  return total;
}
