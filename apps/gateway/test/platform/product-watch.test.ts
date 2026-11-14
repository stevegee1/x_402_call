import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger";
import { Metrics } from "../../src/metrics";
import { degradedReason, ProductWatch } from "../../src/platform/product-watch";
import { AcmeProduct } from "./fake-product";

const MIN = 60_000;

function setup(opts: { webhook?: boolean; failPosts?: number } = {}) {
  const acme = new AcmeProduct();
  let t = 1_000_000;
  const posts: string[] = [];
  let failures = opts.failPosts ?? 0;
  const metrics = new Metrics();
  const watch = new ProductWatch({
    products: [acme],
    alertAfterMs: 5 * MIN,
    webhookUrl: opts.webhook === false ? undefined : "https://hooks.test/x",
    log: createLogger("silent"),
    metrics,
    now: () => t,
    post: async (_url, body) => {
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
