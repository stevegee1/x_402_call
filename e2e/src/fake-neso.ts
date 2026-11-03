import { createServer } from "node:http";
import { freePort } from "./proc";

const PERIOD_MS = 30 * 60_000;
/** Deterministic, clock-relative England series: a 5-hour cycle 200, 190, …, 110 (Scotland 20, Wales 300). */
export const fakeEngland = (start: number) => 200 - (Math.floor(start / PERIOD_MS) % 10) * 10;

/**
 * Stands in for the NESO Data Portal's datastore_search so e2e runs are hermetic. Serves a rolling
 * forecast from 2 h ago to 48 h ahead in the dataset's own shape (naive UTC timestamps, newest first).
 */
export async function startFakeNeso() {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/api/3/action/datastore_search") return void res.writeHead(404).end();
    const now = Date.now();
    const cur = now - (now % PERIOD_MS);
    const records = [];
    for (let t = cur + 48 * 3_600_000 - PERIOD_MS; t >= cur - 2 * 3_600_000; t -= PERIOD_MS) {
      records.push({ _id: t / 1000, datetime: new Date(t).toISOString().slice(0, 19), England: fakeEngland(t), Scotland: 20, Wales: 300 });
    }
    const limit = Number(u.searchParams.get("limit") ?? 100);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, result: { records: records.slice(0, limit) } }));
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)) };
}
