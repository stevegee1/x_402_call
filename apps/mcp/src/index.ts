#!/usr/bin/env -S npx tsx
/**
 * Maritime data MCP server (stdio). Runs on the CUSTOMER side, next to their agent:
 *   - pays with the customer's own wallet (x402) and/or their fiat-credit API key
 *   - every payment passes through the policy engine (budgets, allowlists, circuit breakers)
 * Keys never leave this process. stdout is the MCP channel: log to stderr only.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPolicyClient, DEFAULT_BREAKERS, PolicyDeniedError, type Policy } from "@mx/policy-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const env = process.env;
const gateway = (env.MX_GATEWAY_URL ?? "http://localhost:8080").replace(/\/$/, "");
const origin = new URL(gateway).origin;
const network = env.MX_NETWORK ?? "eip155:84532";

const policy: Policy = env.MX_POLICY_FILE
  ? (JSON.parse(readFileSync(env.MX_POLICY_FILE, "utf8")) as Policy)
  : {
      agentId: env.MX_AGENT_ID ?? "mcp-agent",
      maxPricePerRequestUsd: Number(env.MX_MAX_PRICE_USD ?? 0.1),
      dailyBudgetUsd: Number(env.MX_DAILY_BUDGET_USD ?? 2),
      dailyBudgetGbp: Number(env.MX_DAILY_BUDGET_GBP ?? 2),
      allowedNetworks: [network],
      allowedOrigins: [origin],
      breakers: DEFAULT_BREAKERS,
    };

const signer = env.MX_WALLET_PRIVATE_KEY ? privateKeyToAccount(env.MX_WALLET_PRIVATE_KEY as `0x${string}`) : undefined;
const apiKey = env.MX_API_KEY;
if (!signer && !apiKey) console.error("[maritime-mcp] neither MX_WALLET_PRIVATE_KEY nor MX_API_KEY set: paid tools will return 402 details only");

const client = createPolicyClient({
  policy,
  signer,
  credits: apiKey ? { apiKey, origins: [origin] } : undefined,
  spendLogPath: env.MX_SPEND_LOG,
  report: apiKey ? { url: `${gateway}/v1/policy/events`, apiKey } : undefined,
  onEvent: (e) => console.error(`[maritime-mcp] ${e.type} ${e.code ?? ""} ${e.url} ${e.amount ?? ""} ${e.currency ?? ""}`),
});

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

async function call(path: string, shape?: (body: any) => unknown) {
  try {
    const res = await client.fetch(`${gateway}${path}`);
    const body = await res.json().catch(() => ({}));
    if (res.status === 402) return text({ error: "payment_required", detail: "no payment method configured or credits exhausted", accepts: body.accepts, credits: body.credits });
    if (!res.ok) return text({ error: body.error ?? `http_${res.status}`, detail: body.detail });
    const payment = res.headers.get("x-payment-id") ? { payment_id: res.headers.get("x-payment-id"), settlement: res.headers.get("x-settlement") } : undefined;
    return text({ ...(shape ? (shape(body) as object) : body), payment });
  } catch (e) {
    if (e instanceof PolicyDeniedError) return text({ error: "denied_by_policy", rule: e.code, detail: e.message });
    return text({ error: "request_failed", detail: (e as Error).message });
  } finally {
    void client.flush(); // ship policy decisions to the control plane promptly (short-lived MCP processes)
  }
}

const region = z.enum(["dover", "rotterdam", "panama"]).describe("dover = Dover Strait, rotterdam = Port of Rotterdam approaches, panama = Panama Canal approaches");

const server = new McpServer({ name: "maritime-data", version: "0.1.0" });

server.registerTool(
  "list_regions",
  { title: "List regions", description: "Free. Lists covered regions, data freshness and per-call prices." },
  () => call("/v1/maritime/regions"),
);

server.registerTool(
  "get_vessels",
  {
    title: "Live vessels",
    description: "Paid (0.033 USDC). Current vessels in a region from live AIS, refreshed every 250 ms.",
    inputSchema: {
      region,
      category: z.enum(["cargo", "tanker", "passenger", "fishing", "tug", "high_speed", "other", "unknown"]).optional(),
      min_speed_kn: z.number().min(0).optional(),
      limit: z.number().int().min(1).max(500).default(50).describe("Max vessels returned to keep responses small"),
    },
  },
  ({ region, category, min_speed_kn, limit }) => {
    const q = new URLSearchParams();
    if (category) q.set("category", category);
    if (min_speed_kn !== undefined) q.set("min_speed_kn", String(min_speed_kn));
    return call(`/v1/maritime/${region}/vessels${q.size ? `?${q}` : ""}`, (b) => ({ ...b, data: b.data?.slice(0, limit), truncated: (b.count ?? 0) > limit }));
  },
);

server.registerTool(
  "get_vessel",
  { title: "Vessel detail", description: "Paid (0.033 USDC). One vessel's latest state and recent track.", inputSchema: { region, mmsi: z.number().int() } },
  ({ region, mmsi }) => call(`/v1/maritime/${region}/vessels/${mmsi}`),
);

server.registerTool(
  "get_density",
  { title: "Traffic density", description: "Paid (0.033 USDC). H3-binned vessel density, moving vs stationary.", inputSchema: { region } },
  ({ region }) => call(`/v1/maritime/${region}/density`, (b) => ({ ...b, data: b.data?.slice(0, 40) })),
);

server.registerTool(
  "get_anchorage_queue",
  { title: "Anchorage queue", description: "Paid (0.066 USDC). Vessels waiting at anchor, wait-time stats, draught-limit exposure (Panama).", inputSchema: { region } },
  ({ region }) => call(`/v1/maritime/${region}/queue`),
);

server.registerTool(
  "get_anomalies",
  { title: "Anomalies", description: "Paid (0.066 USDC). Vessels going dark (AIS gaps), position jumps, loitering.", inputSchema: { region } },
  ({ region }) => call(`/v1/maritime/${region}/anomalies`),
);

server.registerTool(
  "spending_report",
  { title: "Spending report", description: "Free, local. Today's spend against policy budgets and circuit-breaker state." },
  async () =>
    text({
      agent: policy.agentId,
      spent_today: { usd: round(client.spendLog.spentToday("USD")), gbp: round(client.spendLog.spentToday("GBP")) },
      budgets: { usd: policy.dailyBudgetUsd, gbp: policy.dailyBudgetGbp ?? null },
      breakers: client.breakers.snapshot(),
      recent: client.recentEvents().slice(-10),
    }),
);

await server.connect(new StdioServerTransport());
console.error(`[maritime-mcp] ready: gateway=${gateway} network=${network} wallet=${signer?.address ?? "none"} credits=${apiKey ? "yes" : "no"}`);
