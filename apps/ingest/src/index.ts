import { createServer } from "node:http";
import { Deduper, TrafficSimulator } from "@mx/ais";
import { REGION_IDS, SUBJECTS, type AisEvent } from "@mx/shared";
import { connect, JSONCodec } from "nats";
import pg from "pg";
import { pino } from "pino";
import { z } from "zod";
import { aisstreamSource } from "./sources/aisstream";
import { tcpNmeaSource, udpNmeaSource } from "./sources/nmea";
import type { Source } from "./sources/types";

const cfg = z
  .object({
    NATS_URL: z.string().default("nats://localhost:4222"),
    DATABASE_URL: z.string().optional(),
    INGEST_SOURCES: z.string().default("simulator"), // comma list: simulator,udp,tcp,aisstream
    UDP_HOST: z.string().default("0.0.0.0"),
    UDP_PORT: z.coerce.number().default(10110),
    TCP_HOST: z.string().optional(),
    TCP_PORT: z.coerce.number().optional(),
    RECEIVER_ID: z.string().default("rx-kent-01"),
    AISSTREAM_API_KEY: z.string().optional(),
    HEALTH_PORT: z.coerce.number().default(8090),
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env);

const log = pino({ level: cfg.LOG_LEVEL, base: { service: "ingest" } });
const nc = await connect({ servers: cfg.NATS_URL, name: "ingest", reconnect: true, maxReconnectAttempts: -1 });
const jc = JSONCodec<AisEvent>();
const dedupe = new Deduper();
const counters = { published: 0, duplicates: 0, historyWritten: 0, historyErrors: 0 };
const lastEventAt: Record<string, number> = {};

// Position history: batched inserts, bounded buffer (drops oldest under DB outage rather than OOM).
const pool = cfg.DATABASE_URL ? new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 4 }) : undefined;
let history: AisEvent[] = [];
async function flushHistory() {
  if (!pool || history.length === 0) return;
  const batch = history.splice(0, 2_000);
  const rows = batch.flatMap((e) => (e.kind === "position" ? [e] : []));
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((e, i) => {
    const p = e.data;
    values.push(new Date(p.ts), p.mmsi, e.region, p.lat, p.lon, p.sog ?? null, p.cog ?? null, p.heading ?? null, p.navStatus ?? null, p.source, p.mode);
    const o = i * 11;
    return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`;
  });
  try {
    await pool.query(`insert into ais_positions (ts, mmsi, region, lat, lon, sog, cog, heading, nav_status, source, mode) values ${tuples.join(",")}`, values);
    counters.historyWritten += rows.length;
  } catch (e) {
    counters.historyErrors++;
    log.warn({ err: e }, "history write failed");
  }
}
setInterval(() => void flushHistory(), 1_000).unref();

function emit(e: AisEvent) {
  if (dedupe.isDuplicate(e)) {
    counters.duplicates++;
    return;
  }
  const subject = e.kind === "position" ? SUBJECTS.position(e.region) : SUBJECTS.static;
  nc.publish(subject, jc.encode(e));
  counters.published++;
  if (e.kind === "position") {
    lastEventAt[e.region] = Date.now();
    if (pool) {
      history.push(e);
      if (history.length > 50_000) history = history.slice(-50_000);
    }
  }
}

function simulatorSource(): Source {
  const sim = new TrafficSimulator({ vesselsPerRegion: 60 });
  let timer: NodeJS.Timeout | undefined;
  return {
    name: "simulator",
    stats: () => ({}),
    start(out) {
      for (const e of sim.allStatics()) out(e);
      timer = setInterval(() => sim.step(500).forEach(out), 500);
    },
    stop: async () => clearInterval(timer),
  };
}

const sources: Source[] = [];
for (const s of cfg.INGEST_SOURCES.split(",").map((x) => x.trim()).filter(Boolean)) {
  if (s === "simulator") sources.push(simulatorSource());
  else if (s === "udp") sources.push(udpNmeaSource({ host: cfg.UDP_HOST, port: cfg.UDP_PORT, receiverId: cfg.RECEIVER_ID }));
  else if (s === "tcp") {
    if (!cfg.TCP_HOST || !cfg.TCP_PORT) throw new Error("TCP_HOST and TCP_PORT required for tcp source");
    sources.push(tcpNmeaSource({ host: cfg.TCP_HOST, port: cfg.TCP_PORT, receiverId: cfg.RECEIVER_ID, log: (m) => log.info(m) }));
  } else if (s === "aisstream") {
    if (!cfg.AISSTREAM_API_KEY) throw new Error("AISSTREAM_API_KEY required for aisstream source");
    sources.push(aisstreamSource({ apiKey: cfg.AISSTREAM_API_KEY, regions: REGION_IDS, log: (m) => log.info(m) }));
  } else throw new Error(`unknown source ${s}`);
}
for (const s of sources) {
  s.start(emit);
  log.info({ source: s.name }, "source started");
}

// Health: per-source decode stats and per-region last-event age, for alerting on receiver outages.
createServer((req, res) => {
  const now = Date.now();
  const body = JSON.stringify({
    ok: !nc.isClosed(),
    counters,
    sources: Object.fromEntries(sources.map((s) => [s.name, s.stats()])),
    region_last_event_age_s: Object.fromEntries(REGION_IDS.map((r) => [r, lastEventAt[r] ? Math.round((now - lastEventAt[r]!) / 1000) : null])),
  });
  res.writeHead(req.url === "/healthz" && nc.isClosed() ? 503 : 200, { "content-type": "application/json" }).end(body);
}).listen(cfg.HEALTH_PORT);

async function shutdown() {
  for (const s of sources) await s.stop();
  await flushHistory();
  await nc.drain();
  await pool?.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
log.info({ sources: sources.map((s) => s.name), nats: cfg.NATS_URL, history: Boolean(pool) }, "ingest running");
