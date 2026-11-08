import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientIp, WindowLimiter, type ClientIpHeader } from "../../src/routes/limits";

async function ipFor(source: ClientIpHeader, headers: Record<string, string>) {
  const app = new Hono();
  app.get("/", (c) => c.text(clientIp(c, source)));
  return (await app.request("/", { headers })).text();
}

const forged = { "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 198.51.100.2", "cf-connecting-ip": "192.0.2.9" };

describe("clientIp", () => {
  it("reads only the configured header, whatever else the client sends", async () => {
    expect(await ipFor("x-real-ip", forged)).toBe("203.0.113.7");
    expect(await ipFor("cf-connecting-ip", forged)).toBe("192.0.2.9");
    expect(await ipFor("x-forwarded-for-first", forged)).toBe("198.51.100.1");
    expect(await ipFor("x-forwarded-for-last", forged)).toBe("198.51.100.2");
  });

  it("never falls back to another header when the trusted one is missing (one shared bucket instead)", async () => {
    const { "x-real-ip": _, ...withoutRealIp } = forged;
    expect(await ipFor("x-real-ip", withoutRealIp)).toBe("unknown");
    expect(await ipFor("x-real-ip", { "x-real-ip": "   " })).toBe("unknown");
    expect(await ipFor("cf-connecting-ip", { "x-real-ip": "203.0.113.7" })).toBe("unknown");
  });

  it("bounds the key length so a huge header can't bloat the limiter", async () => {
    expect((await ipFor("x-real-ip", { "x-real-ip": "1".repeat(5_000) })).length).toBe(64);
  });
});

describe("WindowLimiter", () => {
  it("allows max hits per key per window, then resets", () => {
    let t = 0;
    const l = new WindowLimiter(2, 1_000, () => t);
    expect([l.hit("a"), l.hit("a"), l.hit("a"), l.hit("b")]).toEqual([true, true, false, true]);
    t = 1_001;
    expect(l.hit("a")).toBe(true);
  });
});
