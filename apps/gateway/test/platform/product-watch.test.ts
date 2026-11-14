import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger";
import { Metrics } from "../../src/metrics";
import { degradedReason, ProductWatch } from "../../src/platform/product-watch";
import { AcmeProduct } from "./fake-product";

const MIN = 60_000;

function setup(opts: { webhook?: boolean; failPosts?: number; products?: AcmeProduct[]; slowPost?: () => Promise<void>; instance?: string } = {}) {
  const acme = new AcmeProduct();
  let t = 1_000_000;
  const posts: string[] = [];
  let failures = opts.failPosts ?? 0;
  const metrics = new Metrics();
  const watch = new ProductWatch({
    products: [acme, ...(opts.products ?? [])],
    alertAfterMs: 5 * MIN,
    instance: opts.instance,
    webhookUrl: opts.webhook === false ? undefined : "https://hooks.test/x",
    log: createLogger("silent"),
    metrics,
    now: () => t,
    post: async (_url, body) => {
      await opts.slowPost?.();
      if (failures > 0) {
        failures--;
        throw new Error("webhook down");
      }
      posts.push((body as { text: string }).text);
    },
  });
  return { acme, watch, posts, metrics, advance: (ms: number) => (t += ms) };
}

describe("degradedReason", () => {
  it("is null for a ready product with a fresh scope", () => expect(degradedReason(new AcmeProduct())).toBeNull());
  it("flags a product whose feed is down", () => {
    const a = new AcmeProduct();
    a.ready = false;
    expect(degradedReason(a)).toBe("not_ready");
  });
  it("flags a ready product with no fresh scope (every call would 503)", () => {
    const a = new AcmeProduct();
    a.fresh = false;
    expect(degradedReason(a)).toBe("no_fresh_scope");
  });
});

describe("ProductWatch", () => {
  it("alerts once a product stays degraded past the threshold, once per incident, then on recovery", async () => {
    const { acme, watch, posts, metrics, advance } = setup();
    acme.ready = false;
    await watch.tick();
    advance(4 * MIN);
    await watch.tick();
    expect(posts).toEqual([]); // a blip under 5 min stays quiet
    advance(MIN);
    await watch.tick();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/acme.*degraded for 5 min \(not_ready\)/);
    advance(10 * MIN);
    await watch.tick();
    expect(posts).toHaveLength(1); // not repeated while it lasts
    expect(metrics.render()).toMatch(/product_degraded\{product="acme"\} 1/);

    acme.ready = true;
    await watch.tick();
    expect(posts[1]).toMatch(/acme.*recovered/);
    expect(metrics.render()).toMatch(/product_degraded\{product="acme"\} 0/);
  });

  it("a short outage that recovers before the threshold sends nothing, and the clock restarts", async () => {
    const { acme, watch, posts, advance } = setup();
    acme.fresh = false;
    await watch.tick();
    advance(4 * MIN);
    acme.fresh = true;
    await watch.tick();
    acme.fresh = false;
    await watch.tick();
    advance(4 * MIN);
    await watch.tick();
    expect(posts).toEqual([]);
  });

  it("retries a failed webhook on the next tick without logging the incident twice", async () => {
    const { acme, watch, posts, metrics, advance } = setup({ failPosts: 2 });
    acme.ready = false;
    await watch.tick();
    advance(5 * MIN);
    await watch.tick();
    await watch.tick();
    expect(posts).toEqual([]);
    await watch.tick();
    expect(posts).toHaveLength(1);
    expect(metrics.render()).toMatch(/product_alert_webhook_failed_total 2/);
    expect(metrics.render()).toMatch(/product_degraded_alerts_total\{product="acme"\} 1/);
  });

  it("with no webhook configured, still counts the alert (log and metric are the floor)", async () => {
    const { acme, watch, metrics, advance } = setup({ webhook: false });
    acme.ready = false;
    await watch.tick();
    advance(5 * MIN);
    await watch.tick();
    expect(metrics.render()).toMatch(/product_degraded_alerts_total\{product="acme"\} 1/);
  });
});

describe("ProductWatch never takes the gateway down, and never loses or doubles an alert", () => {
  it("a product whose status() throws is degraded (status_error); the others are still watched", async () => {
    const broken = new AcmeProduct();
    broken.status = () => {
      throw new Error("status bug");
    };
    expect(degradedReason(broken)).toBe("status_error");
    const other = new AcmeProduct();
    other.ready = false;
    Object.defineProperty(other, "id", { value: "other" });
    const { watch, metrics, advance } = setup({ products: [broken, other] });
    await watch.tick();
    advance(5 * MIN);
    await expect(watch.tick()).resolves.toBeUndefined();
    expect(metrics.render()).toMatch(/product_degraded_alerts_total\{product="other"\} 1/);
  });

  it("start() swallows a failing tick instead of leaving an unhandled rejection (which exits Node)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { watch, metrics } = setup();
      (watch as unknown as { check: () => Promise<void> }).check = async () => {
        throw new Error("boom");
      };
      watch.start(60_000);
      await new Promise((r) => setTimeout(r, 20));
      watch.stop();
      expect(unhandled).toEqual([]);
      expect(metrics.render()).toMatch(/product_watch_errors_total 1/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("retries a recovery notice whose webhook failed", async () => {
    const { acme, watch, posts, advance } = setup();
    acme.ready = false;
    await watch.tick();
    advance(5 * MIN);
    await watch.tick();
    expect(posts).toHaveLength(1);
    acme.ready = true;
    // The recovery post fails once...
    const w = watch as unknown as { post: (u: string, b: unknown) => Promise<void> };
    const real = w.post;
    let fail = true;
    w.post = async (u, b) => {
      if (fail) {
        fail = false;
        throw new Error("webhook down");
      }
      return real(u, b);
    };
    await watch.tick();
    expect(posts).toHaveLength(1);
    await watch.tick(); // ...and is retried
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatch(/recovered after 5 min/);
    await watch.tick();
    expect(posts).toHaveLength(2); // and only once
  });

  it("two overlapping ticks post an alert once (a slow webhook can't double it)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { acme, watch, posts, advance } = setup({ slowPost: () => gate });
    acme.ready = false;
    await watch.tick();
    advance(5 * MIN);
    const a = watch.tick();
    const b = watch.tick(); // starts while the first is still posting
    release();
    await Promise.all([a, b]);
    expect(posts).toHaveLength(1);
  });

  it("names the replica and reports short durations in seconds", async () => {
    const { acme, watch, posts, advance } = setup({ instance: "staging/1a2b3c4d" });
    (watch as unknown as { o: { alertAfterMs: number } }).o.alertAfterMs = 20_000;
    acme.ready = false;
    await watch.tick();
    advance(20_000);
    await watch.tick();
    expect(posts[0]).toMatch(/degraded for 20 s on staging\/1a2b3c4d/);
  });
});

