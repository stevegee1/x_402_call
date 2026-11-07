import type { PricedResource, Product, ProductContext, ProductRoutes, ProductStatus, Resolution } from "../platform/product";
import type { Store } from "../store/types";
import type { SessionManager } from "./manager";

/** Session sizes on sale. x402 `exact` needs fixed prices, so a session is bought in set amounts. */
export const SESSION_SIZES = [
  { name: "usd1", priceUsd: "1" },
  { name: "usd5", priceUsd: "5" },
  { name: "usd20", priceUsd: "20" },
] as const;

/**
 * Buying an x402 session. It is a platform product, so it gets discovery (catalog, OpenAPI, 402)
 * and the x402 money path for free, with three differences that make it safe to sell a balance:
 *   - settlement is always sync: the token exists only once the USDC has moved on chain;
 *   - only x402 can pay (GBP credits and sessions can't buy sessions);
 *   - the settlement books a prepayment liability, not revenue (ledger isSessionPurchase).
 */
export class SessionsProduct implements Product<null> {
  readonly id = "sessions";
  readonly displayName = "x402 sessions";
  readonly kind = "access";
  readonly description =
    "Prepay once with x402, then read any product at memory speed with Authorization: Session <token>. Each read spends the product's x402 price from the balance.";
  readonly resources: readonly PricedResource[];

  constructor(
    private readonly sessions: SessionManager,
    private readonly store: Pick<Store, "getPayment">,
  ) {
    const hours = Math.round(sessions.opts.ttlMs / 3_600_000);
    this.resources = SESSION_SIZES.map((s) => ({
      id: `sessions.${s.name}`,
      path: `/${s.name}`,
      summary: `A $${s.priceUsd} session, valid ${hours} h from settlement`,
      // Credits price is required by the catalog but unused: the rail is refused.
      pricing: { kind: "fixed" as const, priceUsd: s.priceUsd, creditsGbpMicros: 0 },
      settlement: "sync" as const,
      rails: ["x402"] as const,
    }));
  }

  resolve(_c: ProductContext): Resolution<null> {
    return { scope: { scope: "sessions", fresh: true, mode: "live", sourceTs: null }, state: null };
  }

  routes(r: ProductRoutes<null>): void {
    r.free("/sizes", (c) =>
      c.json({
        data: this.resources.map((res) => ({ id: res.id, price_usdc: res.pricing.priceUsd, buy: `/v1/sessions${res.path}`, description: res.summary })),
        usage: "Authorization: Session <token>",
      }),
    );
    for (const res of this.resources) {
      r.paid(res.id, async (c) => {
        const payment = c.get("payment"); // set by billing once settled (sync)
        // The session expires ttl after settlement, exactly as the store will compute it.
        const settledAt = (await this.store.getPayment(payment.id))?.settledAt?.getTime() ?? Date.now();
        return c.json(
          {
            session_token: this.sessions.tokens.issue(payment.id),
            session_id: payment.id,
            amount_usdc: res.pricing.priceUsd,
            payer: payment.payer,
            expires_at: new Date(settledAt + this.sessions.opts.ttlMs).toISOString(),
            usage: "Authorization: Session <token>",
          },
          201,
        );
      });
    }
  }

  status(): ProductStatus {
    return { ready: true, scopes: [{ scope: "sessions", fresh: true, mode: "live", sourceTs: null }] };
  }
}
