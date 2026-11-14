import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import type { Product } from "./product";

/**
 * A product is degraded when it can't sell: it says it isn't ready (its feed is down), or it has
 * scopes and none of them is fresh (every call would be refused with 503, uncharged). Freshness, not
 * readiness, is what gates each sale (billing.ts resolveForSale); this is the operator's view of it.
 */
export function degradedReason(p: Product): string | null {
  const s = p.status();
  if (!s.ready) return "not_ready";
  if (s.scopes.length > 0 && s.scopes.every((x) => !x.fresh)) return "no_fresh_scope";
  return null;
}

export interface ProductWatchOptions {
  products: readonly Product[];
  /** Alert once a product has been degraded this long (covers a bad deploy as well as an outage). */
  alertAfterMs: number;
  /** Optional incoming webhook (Slack-style `{ text }`); the log line is written either way. */
  webhookUrl?: string;
  log: Logger;
  metrics: Metrics;
  now?: () => number;
  post?: (url: string, body: unknown) => Promise<void>;
}

const postJson = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`webhook answered ${res.status}`);
};

/**
 * Replaces the deploy-time readiness gate as the signal that a product is down (wrong NATS_URL,
 * upstream outage, a product that never becomes ready). /readyz no longer fails on a product, so a
 * bad deploy goes live: this tells the operator within alertAfterMs, once per incident, and again
 * when it recovers. A webhook that fails is retried on the next tick.
 */
export class ProductWatch {
  private readonly since = new Map<string, number>();
  private readonly alerted = new Map<string, boolean>(); // product -> alert delivered
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly post: (url: string, body: unknown) => Promise<void>;

  constructor(private readonly o: ProductWatchOptions) {
    this.now = o.now ?? Date.now;
    this.post = o.post ?? postJson;
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    const now = this.now();
    for (const p of this.o.products) {
      const reason = degradedReason(p);
      this.o.metrics.set("product_degraded", reason ? 1 : 0, { product: p.id });
      if (reason) {
        const since = this.since.get(p.id) ?? now;
        this.since.set(p.id, since);
        const forMs = now - since;
        if (forMs >= this.o.alertAfterMs && this.alerted.get(p.id) !== true) {
          if (!this.alerted.has(p.id)) {
            this.o.log.error({ product: p.id, reason, degraded_s: Math.round(forMs / 1000) }, "product degraded: calls are refused uncharged");
            this.o.metrics.inc("product_degraded_alerts_total", { product: p.id });
          }
          this.alerted.set(p.id, await this.notify(`:warning: ${p.displayName} (${p.id}) degraded for ${Math.round(forMs / 60_000)} min (${reason}): calls are refused, uncharged. Check /status.`));
        }
      } else if (this.since.has(p.id)) {
        if (this.alerted.has(p.id)) {
          this.o.log.info({ product: p.id }, "product recovered");
          await this.notify(`:white_check_mark: ${p.displayName} (${p.id}) recovered.`);
        }
        this.since.delete(p.id);
        this.alerted.delete(p.id);
      }
    }
  }

  /** true once delivered (or there is nowhere to deliver). */
  private async notify(text: string): Promise<boolean> {
    if (!this.o.webhookUrl) return true;
    try {
      await this.post(this.o.webhookUrl, { text });
      return true;
    } catch (e) {
      this.o.metrics.inc("product_alert_webhook_failed_total");
      this.o.log.warn({ err: e }, "product alert webhook failed; retrying next tick");
      return false;
    }
  }
}
