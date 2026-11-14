import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import type { Product, ProductStatus } from "./product";

const STATUS_ERROR = "status_error";

/**
 * A product's status, never throwing: a product bug must not take a route (or the gateway) down.
 * Every kernel caller goes through here (enforced by test/platform/boundaries.test.ts). On a throw it
 * reports the product unready with no scopes, and marks it so degradedReason can say why.
 */
export function statusOf(p: Product): ProductStatus {
  try {
    return p.status();
  } catch (e) {
    return { ready: false, scopes: [], detail: { [STATUS_ERROR]: (e as Error)?.message ?? String(e) } };
  }
}

/**
 * A product is degraded when it can't sell: its status can't be read, it says it isn't ready (its
 * feed is down), or it has scopes and none of them is fresh (every call is refused, uncharged).
 * Freshness, not readiness, gates each sale (billing.ts resolveForSale); this is the operator's view.
 * One stale scope among fresh ones (Panama's sparse coverage) is not a product outage.
 */
export function degradedReason(p: Product): "status_error" | "not_ready" | "no_fresh_scope" | null {
  const s = statusOf(p);
  if (s.detail && STATUS_ERROR in s.detail) return "status_error";
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
  /** Names this process in alerts: each replica watches (and alerts) on its own. */
  instance?: string;
  log: Logger;
  metrics: Metrics;
  now?: () => number;
  post?: (url: string, body: unknown) => Promise<void>;
}

const postJson = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`webhook answered ${res.status}`);
};

const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

interface Incident {
  since: number;
  reason: string;
  /** The degraded alert: not yet due, logged but its webhook still to deliver, or delivered. */
  alert: "pending" | "undelivered" | "delivered";
}

/**
 * Replaces the deploy-time readiness gate as the signal that a product is down (wrong NATS_URL,
 * upstream outage, a product that never becomes ready). /readyz no longer fails on a product, so a
 * bad deploy goes live: this tells the operator within alertAfterMs, once per incident, and again
 * when it recovers. Webhook posts that fail are retried on later ticks, the recovery included.
 *
 * State is per process and in memory: each replica alerts on its own (the message names it), and
 * a restart during a long outage alerts again alertAfterMs after boot.
 */
export class ProductWatch {
  private readonly incidents = new Map<string, Incident>();
  /** Recovery notices whose webhook hasn't been delivered yet, with the incident they close. */
  private readonly recoveries = new Map<string, { text: string; incident: Incident }>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly now: () => number;
  private readonly post: (url: string, body: unknown) => Promise<void>;

  constructor(private readonly o: ProductWatchOptions) {
    this.now = o.now ?? Date.now;
    this.post = o.post ?? postJson;
  }

  start(intervalMs = 30_000) {
    const run = () =>
      this.tick().catch((e) => {
        // Never an unhandled rejection: that would exit the process and take payments down with it.
        this.o.metrics.inc("product_watch_errors_total");
        this.o.log.error({ err: e }, "product watch tick failed");
      });
    void run(); // the gauges exist from boot, not 30 s later
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return; // a slow webhook must not let two ticks post the same alert
    this.running = true;
    try {
      for (const p of this.o.products) await this.check(p);
    } finally {
      this.running = false;
    }
  }

  private async check(p: Product) {
    const now = this.now();
    const reason = degradedReason(p);
    this.o.metrics.set("product_degraded", reason ? 1 : 0, { product: p.id });
    const where = this.o.instance ? ` on ${this.o.instance}` : "";

    if (reason) {
      // Degraded again before its recovery notice went out: the warning the operator got is still
      // open, so this is the same incident, not a new (unreported) one.
      const unsent = this.recoveries.get(p.id);
      if (unsent) {
        this.recoveries.delete(p.id);
        this.incidents.set(p.id, unsent.incident);
      }
      const inc = this.incidents.get(p.id) ?? { since: now, alert: "pending", reason };
      inc.reason = reason;
      this.incidents.set(p.id, inc);
      const forMs = now - inc.since;
      if (inc.alert === "pending" && forMs >= this.o.alertAfterMs) {
        this.o.log.error({ product: p.id, reason, degraded_s: Math.round(forMs / 1000) }, "product degraded: it is not selling");
        this.o.metrics.inc("product_degraded_alerts_total", { product: p.id });
        inc.alert = "undelivered";
      }
      if (inc.alert === "undelivered") {
        const what =
          reason === "status_error"
            ? "its status can't be read (a product bug); sales are still gated by data freshness"
            : "it can't sell: calls get 503 once its data is past its age limit, never charged";
        const text = `:warning: ${p.displayName} (${p.id}) degraded for ${duration(forMs)}${where} (${reason}): ${what}. Check /status.`;
        if (await this.notify(text)) inc.alert = "delivered";
      }
      return;
    }

    const inc = this.incidents.get(p.id);
    if (inc) {
      this.incidents.delete(p.id);
      // A blip shorter than the threshold was never reported, so it needs no recovery notice.
      if (inc.alert !== "pending") {
        this.o.log.info({ product: p.id, degraded_s: Math.round((now - inc.since) / 1000) }, "product recovered");
        // Names the reason too: if the webhook was down for the whole incident, this is all they get.
        this.recoveries.set(p.id, { text: `:white_check_mark: ${p.displayName} (${p.id}) recovered${where} after ${duration(now - inc.since)} (was ${inc.reason}).`, incident: inc });
      }
    }
    const notice = this.recoveries.get(p.id);
    if (notice && (await this.notify(notice.text))) this.recoveries.delete(p.id);
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
