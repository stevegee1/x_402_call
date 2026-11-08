import type { Context } from "hono";

/**
 * The client's IP for rate limiting. Cloudflare's header when it is in front; otherwise the last
 * X-Forwarded-For hop, which our edge proxy appends (the first hops are whatever the client sent).
 */
export function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",").at(-1)!.trim();
  return c.req.header("x-real-ip")?.trim() ?? "unknown";
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
