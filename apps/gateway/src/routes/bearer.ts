import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";

/**
 * Requires `Authorization: Bearer <token>`, compared in constant time. With no token configured
 * every request is refused: a missing secret must never mean "open".
 */
export function bearerAuth(token: string | undefined): MiddlewareHandler<AppEnv> {
  const expected = token ? Buffer.from(token) : undefined;
  return async (c, next) => {
    const got = Buffer.from((c.req.header("authorization") ?? "").replace(/^Bearer /, ""));
    if (!expected || got.length !== expected.length || !timingSafeEqual(got, expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}
