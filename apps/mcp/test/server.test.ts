import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BuyerBreakers, DEFAULT_BREAKERS, SpendLog, type Policy, type PolicyClient } from "@mx/policy-sdk";
import { describe, expect, it } from "vitest";
import type { CatalogProduct } from "../src/catalog-tools";
import { createMcpServer } from "../src/server";

const GW = "https://gw.test";
const catalog = (JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8")) as { data: CatalogProduct[] }).data;
const policy: Policy = { agentId: "t", maxPricePerRequestUsd: 25, dailyBudgetUsd: 50, allowedNetworks: ["eip155:84532"], allowedOrigins: [GW], breakers: DEFAULT_BREAKERS };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake gateway: records requests; sessions have a balance; per-call payment via the policy client. */
function harness(opts: { sessionBalance?: number } = {}) {
  const seen: { url: string; auth: string | null; via: "plain" | "policy" }[] = [];
  let balance = opts.sessionBalance ?? 1_000_000;
  const gateway = (url: string, auth: string | null): Response => {
    const path = new URL(url).pathname;
    if (path === "/v1/products") return json({ data: catalog });
    if (path.startsWith("/v1/sessions/")) return json({ session_token: "ses_x.y", session_id: "sid-1", amount_usdc: "1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201, { "x-payment-id": "pay-s" });
    if (auth?.startsWith("Session ")) {
      if (balance < 10_000) return json({ error: "session_exhausted" }, 402);
      balance -= 10_000;
      return json({ mode: "live", data: [1, 2, 3] }, 200, { "x-session-remaining-usdc-atomic": String(balance) });
    }
    return json({ mode: "live", data: Array.from({ length: 80 }, (_, i) => i) }, 200, { "x-payment-id": "pay-1", "x-settlement": "pending" });
  };
  const plain: typeof fetch = async (input, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ url: String(input), auth, via: "plain" });
    return gateway(String(input), auth);
  };
  const client: PolicyClient = {
    fetch: async (input) => {
      seen.push({ url: String(input), auth: null, via: "policy" });
      return gateway(String(input), null);
    },
    spendLog: new SpendLog(),
    breakers: new BuyerBreakers(DEFAULT_BREAKERS),
    recentEvents: () => [],
    flush: async () => {},
  };
  return { seen, plain, client };
}

async function connect(h: ReturnType<typeof harness>, products: CatalogProduct[] = catalog) {
  const s = createMcpServer({ gateway: GW, policy, client: h.client, fetch: h.plain, log: () => {} });
  s.addCatalog(products);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([s.server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await mcp.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text);
  return { s, mcp, call };
}

describe("MCP server over the protocol", () => {
  it("lists every catalog tool, the old maritime names, and the session and report tools", async () => {
    const { mcp } = await connect(harness());
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const n of ["grid_intensity", "grid_history", "maritime_queue", "get_vessels", "get_anchorage_queue", "list_regions", "buy_session", "spending_report", "refresh_catalog"]) expect(names).toContain(n);
    expect(names).not.toContain("grid_stream");
  });

  it("calls the right endpoint, pays per call through the policy, and trims big results", async () => {
    const h = harness();
    const { call } = await connect(h);
    const r = await call("grid_window", { country: "england", duration_h: 2 });
    expect(h.seen.at(-1)).toMatchObject({ url: `${GW}/v1/grid/england/window?duration_h=2`, via: "policy" });
    expect(r).toMatchObject({ mode: "live", truncated: true, returned: 50, paid: { via: "x402", payment_id: "pay-1" } });
  });

  it("the old tool names still work", async () => {
    const h = harness();
    const { call } = await connect(h);
    await call("get_anchorage_queue", { region: "rotterdam" });
    expect(h.seen.at(-1)!.url).toBe(`${GW}/v1/maritime/rotterdam/queue`);
  });

  it("after buy_session, paid tools read from the session; when it's spent they fall back to per-call", async () => {
    const h = harness({ sessionBalance: 20_000 }); // two reads' worth
    const { call } = await connect(h);
    expect(await call("buy_session", { size: "usd1" })).toMatchObject({ ok: true, session_id: "sid-1" });
    expect(h.seen.at(-1)!.via).toBe("policy"); // the purchase itself goes through the policy engine

    for (let i = 0; i < 2; i++) {
      const r = await call("grid_intensity", { country: "wales" });
      expect(h.seen.at(-1)).toMatchObject({ via: "plain", auth: "Session ses_x.y" });
      expect(r.paid.via).toBe("session");
    }
    // Spent: the gateway says 402 for the session, so this call is paid per call instead.
    const r = await call("grid_intensity", { country: "wales" });
    expect(r.paid.via).toBe("x402");
    expect(h.seen.slice(-2).map((s) => s.via)).toEqual(["plain", "policy"]);
    // And the session is forgotten: the next call goes straight to per-call.
    await call("grid_intensity", { country: "wales" });
    expect(h.seen.at(-1)!.via).toBe("policy");
  });

  it("free tools never use the session", async () => {
    const h = harness();
    const { call } = await connect(h);
    await call("buy_session", { size: "usd1" });
    await call("maritime_regions");
    expect(h.seen.at(-1)!.via).toBe("policy");
  });

  it("rejects bad arguments before any request", async () => {
    const h = harness();
    const { mcp } = await connect(h);
    const before = h.seen.length;
    const r = await mcp.callTool({ name: "grid_intensity", arguments: { country: "france" } });
    expect(r.isError).toBe(true);
    expect(h.seen.length).toBe(before);
  });

  it("refresh_catalog adds endpoints the gateway gained, and announces them", async () => {
    const h = harness();
    const withoutGrid = catalog.filter((p) => p.id !== "grid");
    const { mcp, call } = await connect(h, withoutGrid);
    expect((await mcp.listTools()).tools.map((t) => t.name)).not.toContain("grid_intensity");
    let changed = false;
    mcp.setNotificationHandler((await import("@modelcontextprotocol/sdk/types.js")).ToolListChangedNotificationSchema, async () => {
      changed = true;
    });
    const r = await call("refresh_catalog");
    expect(r.tools_added).toBeGreaterThan(0);
    expect((await mcp.listTools()).tools.map((t) => t.name)).toContain("grid_intensity");
    await new Promise((res) => setTimeout(res, 10));
    expect(changed).toBe(true);
  });
});
