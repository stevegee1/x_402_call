import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { TrafficSimulator } from "@mx/ais";
import { SUBJECTS, type AisEvent } from "@mx/shared";
import { connect, JSONCodec } from "nats";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger";
import { Metrics } from "../../src/metrics";
import { natsFeed } from "../../src/products/maritime/feed";
import { WorldState } from "../../src/products/maritime/snapshot/state";

// A real nats-server binary (CI installs a pinned release). Skipping is allowed only off CI.
const BIN = process.env.NATS_SERVER_BIN;
if (!BIN && process.env.CI) throw new Error("NATS_SERVER_BIN must be set in CI");

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const procs: ChildProcess[] = [];
function startNats(port: number) {
  const p = spawn(BIN!, ["-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
  procs.push(p);
  return p;
}
const stop = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null || p.signalCode !== null ? r() : (p.once("exit", () => r()), p.kill("SIGKILL"))));

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(async () => {
  await Promise.all(procs.splice(0).map(stop));
});

describe.skipIf(!BIN)("AIS bus feed (real NATS)", () => {
  it("starts without NATS, connects when it appears, applies events, and tracks drops and recovery", async () => {
    const port = await freePort();
    const world = new WorldState();
    const metrics = new Metrics();
    // NATS isn't running yet: the gateway must come up anyway (no throw, no await on the bus).
    const feed = natsFeed(`nats://127.0.0.1:${port}`, world, createLogger("silent"), metrics);
    expect(feed.connected()).toBe(false);

    let server = startNats(port);
    await until(feed.connected);

    // Publish what ingest publishes; the world state must pick it up.
    const pub = await connect({ servers: `nats://127.0.0.1:${port}` });
    const jc = JSONCodec<AisEvent>();
    const pos = new TrafficSimulator({ vesselsPerRegion: 1 }).step(1_000).find((e): e is Extract<AisEvent, { kind: "position" }> => e.kind === "position")!;
    pub.publish(SUBJECTS.position(pos.region), jc.encode(pos));
    await until(() => (world.regions.get(pos.region)?.messages ?? 0) > 0);
    await pub.close();

    // The bus drops: connected() must say so (maritime goes not-ready; regions go stale).
    await stop(server);
    await until(() => !feed.connected());

    // ...and recover on its own when the bus is back.
    server = startNats(port);
    await until(feed.connected, 15_000);
    await feed.close();
    expect(feed.connected()).toBe(false);
  }, 40_000);

  it("closing before the first connection doesn't hang or leak a connection", async () => {
    const feed = natsFeed(`nats://127.0.0.1:${await freePort()}`, new WorldState(), createLogger("silent"), new Metrics());
    await feed.close();
    expect(feed.connected()).toBe(false);
  });
});
