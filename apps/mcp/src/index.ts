#!/usr/bin/env -S npx tsx
/**
 * wearebase data MCP server (stdio). Runs on the CUSTOMER side, next to their agent:
 *   - one tool per endpoint the gateway sells, generated from its catalog (maritime, grid, ...)
 *   - buy_session: prepay once with x402, then paid tools read from the session automatically
 *   - pays with the customer's own wallet (x402) and/or their fiat-credit API key
 *   - every payment passes through the policy engine (budgets, allowlists, circuit breakers)
 * Keys never leave this process. stdout is the MCP channel: log to stderr only.
 */
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPolicyClient, DEFAULT_BREAKERS, type Policy } from "@mx/policy-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { createMcpServer, loadCatalog } from "./server";

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
if (!signer && !apiKey) console.error("[wearebase-mcp] neither MX_WALLET_PRIVATE_KEY nor MX_API_KEY set: paid tools will return 402 details only");

const client = createPolicyClient({
  policy,
  signer,
  credits: apiKey ? { apiKey, origins: [origin] } : undefined,
  spendLogPath: env.MX_SPEND_LOG,
  report: apiKey ? { url: `${gateway}/v1/policy/events`, apiKey } : undefined,
  onEvent: (e) => console.error(`[wearebase-mcp] ${e.type} ${e.code ?? ""} ${e.url} ${e.amount ?? ""} ${e.currency ?? ""}`),
});

const { server, addCatalog, registered } = createMcpServer({ gateway, policy, client });

// Tools come from the gateway's catalog. If the gateway is unreachable at start, run anyway (the
// spending report and refresh_catalog work offline) and keep retrying in the background; new tools
// are announced to the client with tools/list_changed.
async function loadWithRetry() {
  for (let attempt = 0; ; attempt++) {
    try {
      const added = addCatalog(await loadCatalog(gateway));
      console.error(`[wearebase-mcp] catalog loaded: ${added} tools`);
      return added;
    } catch (e) {
      const wait = Math.min(60_000, 1_000 * 2 ** attempt);
      console.error(`[wearebase-mcp] catalog unavailable (${(e as Error).message}); retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
const first = await Promise.race([loadWithRetry(), new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
await server.connect(new StdioServerTransport());
if (first === null) void loadWithRetry().then((n) => n && server.sendToolListChanged());
console.error(`[wearebase-mcp] ready: gateway=${gateway} network=${network} wallet=${signer?.address ?? "none"} credits=${apiKey ? "yes" : "no"} tools=${registered.size + 3}`);
