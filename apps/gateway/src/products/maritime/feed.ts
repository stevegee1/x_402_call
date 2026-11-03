import { TrafficSimulator } from "@mx/ais";
import { SUBJECTS, type AisEvent } from "@mx/shared";
import { connect, JSONCodec, type NatsConnection } from "nats";
import type { Logger } from "../../logger";
import type { Metrics } from "../../metrics";
import type { WorldState } from "./snapshot/state";

export interface Feed {
  connected(): boolean;
  close(): Promise<void>;
}

/** Subscribes to the ingest bus and applies events to the in-memory world state. */
export async function natsFeed(url: string, world: WorldState, log: Logger, metrics: Metrics): Promise<Feed> {
  const nc: NatsConnection = await connect({ servers: url, name: "gateway", reconnect: true, maxReconnectAttempts: -1 });
  const jc = JSONCodec<AisEvent>();
  for (const subject of [SUBJECTS.positionWildcard, SUBJECTS.static]) {
    const sub = nc.subscribe(subject);
    void (async () => {
      for await (const m of sub) {
        try {
          world.apply(jc.decode(m.data));
          metrics.inc("feed_messages_total", { subject: subject === SUBJECTS.static ? "static" : "position" });
        } catch (e) {
          metrics.inc("feed_decode_errors_total");
          log.debug({ err: e }, "bad bus message");
        }
      }
    })();
  }
  void (async () => {
    for await (const s of nc.status()) log.info({ type: s.type }, "nats status");
  })();
  log.info({ url }, "subscribed to AIS bus");
  return { connected: () => !nc.isClosed() && !nc.isDraining(), close: () => nc.drain() };
}

/** In-process synthetic traffic (dev/demo). Data is tagged mode=simulated. */
export function simulatorFeed(world: WorldState): Feed {
  const sim = new TrafficSimulator({ vesselsPerRegion: 60 });
  for (const e of sim.allStatics()) world.apply(e);
  // Warm up so every region has data immediately.
  for (let i = 0; i < 30; i++) for (const e of sim.step(1_000)) world.apply(e);
  const timer = setInterval(() => {
    for (const e of sim.step(500)) world.apply(e);
  }, 500);
  timer.unref();
  return { connected: () => true, close: async () => clearInterval(timer) };
}
