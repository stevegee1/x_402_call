import type { Decision, Policy } from "./policy";

/** Sliding-window counter. */
class Window {
  private hits: number[] = [];
  constructor(private readonly windowMs: number) {}
  count(now: number) {
    while (this.hits.length && now - this.hits[0]! >= this.windowMs) this.hits.shift();
    return this.hits.length;
  }
  add(now: number) {
    this.hits.push(now);
  }
}

export interface BreakerSnapshot {
  velocityOpenUntil: number | null;
  openSellers: { origin: string; until: number }[];
  consecutiveFailures: Record<string, number>;
}

/**
 * Buyer-side circuit breakers:
 *  - velocity: too many payments overall (runaway agent)
 *  - per-URL: same resource paid repeatedly (agent loop)
 *  - pay-and-fail: seller takes payment but returns errors
 *  - price spike: seller raised the price for a URL beyond tolerance
 */
export class BuyerBreakers {
  private velocity: Window;
  private perUrl = new Map<string, Window>();
  private velocityOpenUntil = 0;
  private sellerOpenUntil = new Map<string, number>();
  private consecutiveFailures = new Map<string, number>();
  private lastPrice = new Map<string, number>();

  constructor(private readonly cfg: Policy["breakers"]) {
    this.velocity = new Window(cfg.velocity.windowMs);
  }

  check(url: string, origin: string, priceUsd: number, now = Date.now()): Decision {
    if (now < this.velocityOpenUntil)
      return { allow: false, code: "velocity_breaker_open", reason: `velocity breaker open until ${new Date(this.velocityOpenUntil).toISOString()}` };
    if (this.velocity.count(now) >= this.cfg.velocity.maxPayments) {
      this.velocityOpenUntil = now + this.cfg.cooldownMs;
      return { allow: false, code: "velocity_breaker_open", reason: `>${this.cfg.velocity.maxPayments} payments in ${this.cfg.velocity.windowMs}ms` };
    }
    const sellerUntil = this.sellerOpenUntil.get(origin) ?? 0;
    if (now < sellerUntil)
      return { allow: false, code: "seller_breaker_open", reason: `seller ${origin} blocked after repeated paid failures` };
    const w = this.perUrl.get(url);
    if (w && w.count(now) >= this.cfg.perUrl.maxPayments)
      return { allow: false, code: "loop_detected", reason: `${url} paid ${this.cfg.perUrl.maxPayments}x in ${this.cfg.perUrl.windowMs}ms` };
    const prev = this.lastPrice.get(url);
    if (prev !== undefined && priceUsd > prev * (1 + this.cfg.priceIncreaseTolerance))
      return { allow: false, code: "price_spike", reason: `price for ${url} rose from $${prev} to $${priceUsd}` };
    return { allow: true };
  }

  recordPayment(url: string, priceUsd: number, now = Date.now()) {
    this.velocity.add(now);
    let w = this.perUrl.get(url);
    if (!w) this.perUrl.set(url, (w = new Window(this.cfg.perUrl.windowMs)));
    w.add(now);
    this.lastPrice.set(url, priceUsd);
  }

  /** Call after the paid response arrives. */
  recordOutcome(origin: string, ok: boolean, now = Date.now()) {
    if (ok) {
      this.consecutiveFailures.delete(origin);
      return;
    }
    const n = (this.consecutiveFailures.get(origin) ?? 0) + 1;
    this.consecutiveFailures.set(origin, n);
    if (n >= this.cfg.payAndFailThreshold) {
      this.sellerOpenUntil.set(origin, now + this.cfg.cooldownMs);
      this.consecutiveFailures.delete(origin);
    }
  }

  /** Operator override (e.g. from the control plane) after a price change is approved. */
  acceptPrice(url: string, priceUsd: number) {
    this.lastPrice.set(url, priceUsd);
  }

  reset() {
    this.velocityOpenUntil = 0;
    this.sellerOpenUntil.clear();
    this.consecutiveFailures.clear();
  }

  snapshot(now = Date.now()): BreakerSnapshot {
    return {
      velocityOpenUntil: now < this.velocityOpenUntil ? this.velocityOpenUntil : null,
      openSellers: [...this.sellerOpenUntil].filter(([, u]) => now < u).map(([origin, until]) => ({ origin, until })),
      consecutiveFailures: Object.fromEntries(this.consecutiveFailures),
    };
  }
}
