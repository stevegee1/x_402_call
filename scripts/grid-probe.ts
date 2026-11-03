/**
 * Read-only check of the grid product's data path against the live NESO Data Portal: parses the
 * country forecast with our adapter, applies the freshness rules and computes the signals.
 *
 *   pnpm grid:probe            # exits 1 if any country would be stale (paid calls would 503)
 */
import { GridFeed } from "../apps/gateway/src/products/grid/feed";
import { cleanestWindow, current } from "../apps/gateway/src/products/grid/signals";
import { COUNTRIES, NesoGridSource, SOURCE } from "../apps/gateway/src/products/grid/source";

const feed = new GridFeed(new NesoGridSource(process.env.GRID_SOURCE_URL ?? "https://api.neso.energy"), { warn: (o: unknown) => console.error("warn", o), info: () => {} });
await feed.poll();
console.log(`${SOURCE.name}: ${JSON.stringify(feed.health())}`);
for (const c of COUNTRIES) {
  const s = feed.state(c);
  const now = Date.now();
  const cur = current(feed.data(), c, now);
  const w = cleanestWindow(feed.data(), c, now, 2, 24);
  console.log(`${s.fresh ? "ok  " : "STALE"} ${c.padEnd(8)} reason=${s.reason} until=${s.horizonEnd ? new Date(s.horizonEnd).toISOString() : "-"} now=${cur?.intensity ?? "-"} best2h=${w ? `${w.from} ${w.mean_intensity} (${w.saving_pct}% vs now)` : "-"}`);
  if (!s.fresh) process.exitCode = 1;
}
