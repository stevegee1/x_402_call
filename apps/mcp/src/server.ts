import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PolicyDeniedError, type Policy, type PolicyClient } from "@mx/policy-sdk";
import { z } from "zod";
import { buildTools, toolName, trimForModel, type CatalogProduct, type ToolDef } from "./catalog-tools";

/**
 * The MCP server: tools generated from the gateway catalog, an x402 session the agent can buy and
 * then read from automatically, and a local spending report. Runs on the customer's side; keys
 * never leave this process. stdout is the MCP channel, so anything logged goes to stderr.
 */

export interface ServerDeps {
  gateway: string;
  policy: Policy;
  client: PolicyClient;
  /** Plain fetch for session reads (prepaid: no per-call payment, so not through the policy). */
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => number;
}

/** Old hand-written tool names, kept so existing agent prompts and configs keep working. */
const ALIASES: Record<string, string> = {
  list_regions: "maritime.regions",
  get_vessels: "maritime.vessels",
  get_vessel: "maritime.vessel",
  get_density: "maritime.density",
  get_anchorage_queue: "maritime.queue",
  get_anomalies: "maritime.anomalies",
};

const DEFAULT_LIMIT = 50;
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

interface Session {
  token: string;
  id: string;
  expiresAt: number;
  /** Last known balance in USDC atomic units (from the gateway's response headers). */
  remainingAtomic: bigint;
}

export async function loadCatalog(gateway: string, f: typeof fetch = fetch, timeoutMs = 8_000): Promise<CatalogProduct[]> {
  const res = await f(`${gateway}/v1/products?format=json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: CatalogProduct[] };
  if (!Array.isArray(body.data)) throw new Error("catalog: unexpected response");
  return body.data;
}

export function createMcpServer(d: ServerDeps) {
  const f = d.fetch ?? fetch;
  const log = d.log ?? ((m: string) => console.error(`[wearebase-mcp] ${m}`));
  const now = d.now ?? Date.now;
  const server = new McpServer({ name: "wearebase-data", version: "0.2.0" });
  let session: Session | undefined;
  const registered = new Set<string>();

  const activeSession = () => (session && session.expiresAt > now() + 5_000 ? session : undefined);

  /** Pays per call (x402 wallet or credits) through the policy engine. */
  async function payPerCall(path: string) {
    try {
      const res = await d.client.fetch(`${d.gateway}${path}`);
      return { res, via: res.headers.get("x-payment-id") ? "x402" : res.headers.get("x-credits-charged-gbp-micros") ? "credits" : "none" };
    } finally {
      void d.client.flush(); // ship policy decisions promptly: MCP processes are short-lived
    }
  }

  async function call(tool: ToolDef, args: Record<string, unknown>) {
    let path: string;
    try {
      path = tool.path(args);
    } catch (e) {
      return text({ error: "invalid_arguments", detail: (e as Error).message });
    }
    const limit = typeof args.limit === "number" ? args.limit : DEFAULT_LIMIT;
    try {
      let res: Response | undefined;
      let via = "none";
      const s = tool.endpoint.kind === "paid" && tool.endpoint.pay.session ? activeSession() : undefined;
      if (s) {
        res = await f(`${d.gateway}${path}`, { headers: { authorization: `Session ${s.token}`, accept: "application/json" } });
        if (res.status === 401 || res.status === 402) {
          // Spent or expired: forget it and pay per call instead.
          log(`session ${s.id} ${res.status === 402 ? "spent" : "expired"}; paying per call`);
          session = undefined;
          res = undefined;
        } else {
          via = "session";
          const left = res.headers.get("x-session-remaining-usdc-atomic");
          if (left && /^\d+$/.test(left)) s.remainingAtomic = BigInt(left);
        }
      }
      if (!res) ({ res, via } = await payPerCall(path));
      const body = await res.json().catch(() => ({}));
      if (res.status === 402) return text({ error: "payment_required", detail: "no way to pay is configured, or credits are exhausted; buy a session with buy_session, or set MX_WALLET_PRIVATE_KEY / MX_API_KEY", accepts: body.accepts, credits: body.credits });
      if (!res.ok) return text({ error: body.error ?? `http_${res.status}`, detail: body.detail, charged: false });
      const paid =
        via === "session"
          ? { via, session_remaining_usdc: session ? Number(session.remainingAtomic) / 1e6 : null }
          : via === "x402"
            ? { via, payment_id: res.headers.get("x-payment-id"), settlement: res.headers.get("x-settlement") }
            : via === "credits"
              ? { via, charged_gbp: Number(res.headers.get("x-credits-charged-gbp-micros") ?? 0) / 1e6, balance_gbp: res.headers.get("x-credits-balance-gbp-micros") ? Number(res.headers.get("x-credits-balance-gbp-micros")) / 1e6 : null }
              : undefined;
      return text({ ...(trimForModel(body, limit) as object), ...(paid ? { paid } : {}) });
    } catch (e) {
      if (e instanceof PolicyDeniedError) return text({ error: "denied_by_policy", rule: e.code, detail: e.message });
      return text({ error: "request_failed", detail: (e as Error).message });
    }
  }

  function register(name: string, tool: ToolDef, aliasOf?: string) {
    if (registered.has(name)) return;
    registered.add(name);
    server.registerTool(
      name,
      {
        title: aliasOf ? `${tool.title} (alias)` : tool.title,
        description: aliasOf ? `Same as ${aliasOf}. ${tool.description}` : tool.description,
        inputSchema: {
          ...tool.inputSchema,
          ...(tool.endpoint.kind === "free" && !Object.keys(tool.inputSchema).length ? {} : { limit: z.number().int().min(1).max(500).optional().describe(`Max items returned in data (default ${DEFAULT_LIMIT}), to keep responses small`) }),
        },
      },
      (args: Record<string, unknown>) => call(tool, args ?? {}),
    );
  }

  /** Registers every catalog tool not yet registered (and the old aliases). Returns how many were added. */
  function addCatalog(products: CatalogProduct[]): number {
    const before = registered.size;
    const tools = buildTools(products);
    for (const t of tools) register(t.name, t);
    for (const [alias, id] of Object.entries(ALIASES)) {
      const t = tools.find((x) => x.endpoint.id === id);
      if (t) register(alias, t, toolName(id));
    }
    return registered.size - before;
  }

  server.registerTool(
    "buy_session",
    {
      title: "Buy an x402 session",
      description:
        "Prepay once from your wallet (x402, USDC), then paid tools read from the session automatically: faster, and one on-chain payment instead of one per call. Sizes: usd1, usd5, usd20; valid about an hour. Needs a wallet (MX_WALLET_PRIVATE_KEY) and a policy that allows the price.",
      inputSchema: { size: z.enum(["usd1", "usd5", "usd20"]).describe("Session size in USD") },
    },
    async ({ size }) => {
      try {
        const { res } = await payPerCall(`/v1/sessions/${size}`);
        const body = (await res.json().catch(() => ({}))) as { session_token?: string; session_id?: string; amount_usdc?: string; expires_at?: string; error?: string; detail?: string };
        if (!res.ok || !body.session_token) return text({ error: body.error ?? `http_${res.status}`, detail: body.detail ?? "session not bought; nothing charged unless a payment id is shown", payment_id: res.headers.get("x-payment-id") });
        session = {
          token: body.session_token,
          id: body.session_id ?? "",
          expiresAt: Date.parse(body.expires_at ?? "") || now() + 55 * 60_000,
          remainingAtomic: BigInt(Math.round(Number(body.amount_usdc ?? 0) * 1e6)),
        };
        log(`session ${session.id} bought (${body.amount_usdc} USDC) until ${body.expires_at}`);
        // The token stays in this process; the agent only needs to know it's active.
        return text({ ok: true, session_id: session.id, amount_usdc: body.amount_usdc, expires_at: body.expires_at, note: "Paid tools now read from this session until it's spent or expires, then fall back to per-call payment." });
      } catch (e) {
        if (e instanceof PolicyDeniedError) return text({ error: "denied_by_policy", rule: e.code, detail: e.message });
        return text({ error: "request_failed", detail: (e as Error).message });
      }
    },
  );

  server.registerTool(
    "spending_report",
    { title: "Spending report", description: "Free, local. Today's spend against policy budgets, circuit-breaker state, and the active session's balance." },
    async () => {
      const s = activeSession();
      return text({
        agent: d.policy.agentId,
        spent_today: { usd: round(d.client.spendLog.spentToday("USD")), gbp: round(d.client.spendLog.spentToday("GBP")) },
        budgets: { usd: d.policy.dailyBudgetUsd, gbp: d.policy.dailyBudgetGbp ?? null },
        session: s ? { session_id: s.id, remaining_usdc: Number(s.remainingAtomic) / 1e6, expires_at: new Date(s.expiresAt).toISOString() } : null,
        breakers: d.client.breakers.snapshot(),
        recent: d.client.recentEvents().slice(-10),
      });
    },
  );

  server.registerTool(
    "refresh_catalog",
    { title: "Refresh catalog", description: "Free. Reloads the gateway's product list and adds tools for anything new." },
    async () => {
      try {
        const added = addCatalog(await loadCatalog(d.gateway, f));
        if (added) server.sendToolListChanged();
        return text({ ok: true, tools_added: added, tools: [...registered].sort() });
      } catch (e) {
        return text({ error: "catalog_unavailable", detail: (e as Error).message });
      }
    },
  );

  return { server, addCatalog, registered, get session() { return activeSession(); } };
}
