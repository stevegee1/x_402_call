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

/**
 * Subscribes to the ingest bus and applies events to the in-memory world state.
 *
 * Returns at once and connects in the background, retrying forever: a NATS outage (or NATS not up
 * yet on a first deploy) must never stop the gateway, which also sells Grid and runs payments.
 * While the bus is down, connected() is false (maritime reports not ready) and regions go stale,
 * so billing stops charging for them; nothing is served as fresh that isn't.
 */
export function natsFeed(url: string, world: WorldState, log: Logger, metrics: Metrics, dial: typeof connect = connect): Feed {
  const jc = JSONCodec<AisEvent>();
  let nc: NatsConnection | undefined;
  let up = false;
  let closing = false;

  const ready = (async () => {
    // waitOnFirstConnect: keep retrying the first connection instead of failing it.
    const conn = await dial({ servers: url, name: "gateway", reconnect: true, maxReconnectAttempts: -1, waitOnFirstConnect: true, reconnectTimeWait: 2_000 });
    if (closing) {
      await conn.close();
      return;
    }
    nc = conn;
    up = true;
    metrics.set("feed_connected", 1);
    log.info({ url }, "subscribed to AIS bus");
    for (const subject of [SUBJECTS.positionWildcard, SUBJECTS.static]) {
      const sub = conn.subscribe(subject);
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
    for await (const st of conn.status()) {
      if (st.type === "disconnect") {
        up = false;
        metrics.set("feed_connected", 0);
        log.warn({ url }, "AIS bus disconnected; reconnecting");
      } else if (st.type === "reconnect") {
        up = true;
        metrics.set("feed_connected", 1);
        log.info({ url }, "AIS bus reconnected");
      }
    }
  })().catch((e) => {
    up = false;
    log.error({ err: e }, "AIS bus connection ended");
  });
  metrics.set("feed_connected", 0);

  return {
    connected: () => up && !!nc && !nc.isClosed() && !nc.isDraining(),
    close: async () => {
      closing = true;
      up = false;
      if (nc && !nc.isClosed()) await nc.drain();
      void ready;
    },
  };
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
