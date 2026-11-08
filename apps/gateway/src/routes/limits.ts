import type { Context } from "hono";

/** The one request header this deployment trusts for the client's IP (CLIENT_IP_HEADER). */
export type ClientIpHeader = "x-real-ip" | "cf-connecting-ip" | "x-forwarded-for-first" | "x-forwarded-for-last";

/**
 * The client's IP for rate limiting, read from exactly one header: the one our edge proxy sets and
 * overwrites. Never fall through to another header, because a client can set any header the edge
 * doesn't control (e.g. CF-Connecting-IP when Cloudflare isn't in front) and pick its own bucket.
 * Missing header => "unknown": one shared bucket, which fails closed rather than open.
 */
export function clientIp(c: Context, source: ClientIpHeader): string {
  const raw =
    source === "x-forwarded-for-first" ? c.req.header("x-forwarded-for")?.split(",")[0]
    : source === "x-forwarded-for-last" ? c.req.header("x-forwarded-for")?.split(",").at(-1)
    : c.req.header(source);
  const ip = raw?.trim();
  return ip ? ip.slice(0, 64) : "unknown";
}

/**
 * Fixed-window counter per key, per replica. A first line against floods; the per-user lockout in
 * the database is what stops password guessing across replicas.
 */
export class WindowLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True if this hit is allowed. */
  hit(key: string): boolean {
    const now = this.now();
    const h = this.hits.get(key);
    if (!h || now > h.resetAt) {
      if (this.hits.size >= 50_000) this.hits.clear();
      this.hits.set(key, { n: 1, resetAt: now + this.windowMs });
      return true;
    }
    return ++h.n <= this.max;
  }
}
