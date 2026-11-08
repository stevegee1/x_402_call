import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { isMainnet } from "../config";
import type { AppDeps, AppEnv } from "../context";
import { makeVerifier, WalletSignIn } from "../wallet/signin";
import { WALLET_CORE_JS, WALLET_UI_JS } from "../wallet/wallet-script";
import { DOCS_HEADERS, pageCsp, pageShell } from "./docs-pages";
import { clientIp, WindowLimiter } from "./limits";
import { esc } from "./site-theme";

/** Circle USDC per network (the asset our x402 offers use). */
const USDC: Record<string, string> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const EXPLORER: Record<string, string> = { "eip155:84532": "https://sepolia.basescan.org/tx/", "eip155:8453": "https://basescan.org/tx/" };
const NETWORK_NAMES: Record<string, string> = { "eip155:84532": "Base Sepolia", "eip155:8453": "Base" };

const SCRIPT = WALLET_CORE_JS + WALLET_UI_JS;

const WALLET_CSS = `
.wallet{padding:48px 0 64px;max-width:860px}
.wallet .step{margin:0 0 24px}
.wallet .row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.kv2{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 20px;margin:12px 0 0;font-size:15px}
.kv2 dt{color:var(--on-surface-v)}.kv2 dd{margin:0;overflow-wrap:anywhere}
.sizes3{display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr));margin:16px 0 0}
.sizes3 .btn{height:56px;font-size:16px}
.token{font-family:var(--mono);font-size:13px;background:var(--surface);border:1px solid var(--outline-v);border-radius:12px;padding:12px 14px;overflow-wrap:anywhere;margin:8px 0 12px}
.wallet pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
.wallet h3{margin-top:4px}
@media (max-width:640px){.sizes3{grid-template-columns:minmax(0,1fr)}.wallet{padding-top:28px}}
`;

function walletPage(d: AppDeps): string {
  const network = d.cfg.X402_NETWORK;
  const name = NETWORK_NAMES[network] ?? network;
  const testnet = !isMainnet(d.cfg);
  const sizes = d.catalog.product("sessions")?.resources ?? [];
  const body = `<div class="wrap"><div class="wallet" id="wallet" data-network="${esc(network)}" data-asset="${esc(USDC[network] ?? "")}" data-explorer="${esc(EXPLORER[network] ?? "")}" data-faucet="${testnet ? "https://faucet.circle.com" : ""}">
  <span class="overline">Wallet</span>
  <h1>Pay from your wallet</h1>
  <p class="lede">Connect a wallet, buy a prepaid session with USDC on ${esc(name)}, and give the session token to your agent. You sign one payment; it costs no gas. You can also see every payment and session from your wallet.</p>

  <section class="card step" aria-labelledby="s1">
    <h2 id="s1">1. Connect</h2>
    <div id="connect">
      <p class="muted">Works with MetaMask, Coinbase Wallet, Rabby and other browser wallets. Your wallet only needs USDC${testnet ? ' (free test USDC: <a href="https://faucet.circle.com" rel="noopener">faucet.circle.com</a>, choose Base Sepolia)' : ""}; no ETH.</p>
      <div class="row" id="choices"></div>
      <div class="alert info" id="no-wallet" hidden>No browser wallet found. Install MetaMask or Coinbase Wallet, then reload this page. Or pay from code: see the <a href="/docs#pay">API reference</a>.</div>
      <div class="alert" id="connect-msg" hidden></div>
    </div>
    <div id="connected" hidden>
      <dl class="kv2"><dt>Wallet</dt><dd><code id="addr"></code></dd><dt>Network</dt><dd>${esc(name)}</dd><dt>USDC</dt><dd id="bal">…</dd></dl>
    </div>
  </section>

  <section class="card step" aria-labelledby="s2">
    <h2 id="s2">2. Buy a session</h2>
    <p class="muted">A session is a prepaid balance for any of our data. Each read spends that endpoint's price; sessions last about an hour. Unused balance isn't refunded, so start small.</p>
    <p class="muted" id="connect-first">Connect a wallet first.</p>
    <div class="sizes3">${sizes.map((r) => `<button class="btn tonal" type="button" disabled data-size="${esc(r.path.replace(/^\//, ""))}">Buy $${esc(r.pricing.priceUsd)}</button>`).join("")}</div>
    <div class="alert" id="buy-msg" hidden></div>
    <div id="token-box" hidden>
      <h3>Your session token</h3>
      <div class="token" id="token"></div>
      <div class="row"><button class="btn filled" type="button" id="copy">Copy token</button></div>
      <dl class="kv2"><dt>Balance</dt><dd id="tok-amount"></dd><dt>Expires</dt><dd id="tok-expires"></dd></dl>
      <h4>Use it</h4>
      <pre><code id="tok-curl"></code></pre>
      <p class="muted">In an agent, send <code>Authorization: Session &lt;token&gt;</code> on any paid request, or open a live stream. Treat it like a password until it expires.</p>
    </div>
  </section>

  <section class="card step" aria-labelledby="s3">
    <h2 id="s3">3. Your activity</h2>
    <p class="muted">See this wallet's payments and sessions. You'll sign a message to prove the wallet is yours; it moves no funds and approves nothing.</p>
    <div class="row"><button class="btn outlined" type="button" id="load-activity" disabled>Show my activity</button></div>
    <div class="alert" id="act-msg" hidden></div>
    <div id="activity" hidden>
      <h3>Sessions</h3>
      <p class="muted" id="sessions-empty" hidden>No sessions yet.</p>
      <div class="scroll"><table class="stack"><thead><tr><th>Session</th><th class="num">Bought</th><th class="num">Left</th><th>Status</th></tr></thead><tbody id="sessions-body"></tbody></table></div>
      <h3>Payments</h3>
      <p class="muted" id="payments-empty" hidden>No payments yet.</p>
      <div class="scroll"><table class="stack"><thead><tr><th>When</th><th>Endpoint</th><th class="num">Amount</th><th>Status</th><th>Chain</th></tr></thead><tbody id="payments-body"></tbody></table></div>
    </div>
  </section>
</div></div>`;
  return pageShell(d, { title: "Pay from your wallet", description: "Connect a wallet, buy an x402 session with USDC, and see your payments.", active: "wallet", body, css: WALLET_CSS, script: SCRIPT });
}

export const WALLET_CSP = pageCsp({ css: WALLET_CSS, script: SCRIPT });

/**
 * A wallet's sessions. A session's balance row is created on its first read, so a session bought but
 * not used yet exists only as its settled purchase: list purchases, with spend from the row if any.
 */
function sessionsOf(a: Awaited<ReturnType<AppDeps["store"]["walletActivity"]>>, ttlMs: number, now: number) {
  const rows = new Map(a.sessions.map((s) => [s.paymentId, s]));
  const bought = a.payments.filter((p) => p.endpoint.startsWith("sessions.") && p.status === "settled");
  const ids = new Set([...bought.map((p) => p.id), ...rows.keys()]);
  return [...ids].map((id) => {
    const row = rows.get(id);
    const p = bought.find((x) => x.id === id);
    const amount = row?.amountAtomic ?? p!.amountAtomic;
    const expires = row?.expiresAt ?? new Date((p!.settledAt ?? p!.createdAt).getTime() + ttlMs);
    return {
      session_id: id,
      amount_atomic: amount.toString(),
      // Spend is reported in batches every few seconds, so "left" can briefly lag.
      remaining_atomic: (amount - (row?.spentAtomic ?? 0n)).toString(),
      expires_at: expires.toISOString(),
      state: !row?.closedAt && expires.getTime() > now ? "active" : "ended",
    };
  });
}

/**
 * /wallet (page), and the two JSON endpoints behind "Show my activity": a sign-in challenge and the
 * activity for a proven address. Buying a session needs nothing new: the page pays the existing
 * /v1/sessions/{size} endpoint with x402, like any agent.
 */
export function walletRoutes(d: AppDeps) {
  const r = new Hono<AppEnv>();
  const chainId = Number(d.cfg.X402_NETWORK.split(":")[1]);
  // Challenges are MACed with a key derived from a server secret. Without one (dev), a per-process
  // key: proofs then only verify on the replica that issued them.
  const secret = d.cfg.SESSION_SECRET ?? d.cfg.ADMIN_TOKEN ?? randomBytes(32).toString("hex");
  const signin = new WalletSignIn({ secret, baseUrl: d.cfg.PUBLIC_BASE_URL, chainId, verify: makeVerifier(d.cfg.X402_NETWORK, d.cfg.BASE_RPC_URL) });
  const limiter = new WindowLimiter(60, 10 * 60_000);
  const headers = () => ({ ...DOCS_HEADERS, "content-security-policy": WALLET_CSP, "cache-control": "no-store", ...(isMainnet(d.cfg) ? {} : { "x-robots-tag": "noindex" }) });

  r.get("/wallet", (c) => c.body(walletPage(d), 200, headers()));

  r.post("/v1/wallet/challenge", async (c) => {
    if (!limiter.hit(clientIp(c, d.cfg.CLIENT_IP_HEADER))) return c.json({ error: "rate_limited" }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { address?: unknown };
    const ch = signin.challenge(typeof body.address === "string" ? body.address : "");
    if ("error" in ch) return c.json(ch, 400);
    return c.json(ch, 200, { "cache-control": "no-store" });
  });

  r.post("/v1/wallet/activity", async (c) => {
    if (!limiter.hit(clientIp(c, d.cfg.CLIENT_IP_HEADER))) return c.json({ error: "rate_limited" }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { message?: unknown; mac?: unknown; signature?: unknown };
    const proof = await signin.verify(body.message, body.mac, body.signature);
    if ("error" in proof) {
      d.metrics.inc("wallet_signin_refused_total", { reason: proof.error });
      return c.json(proof, 401);
    }
    const a = await d.store.walletActivity(proof.address, 50);
    return c.json(
      {
        address: proof.address,
        payments: a.payments.map((p) => ({
          id: p.id,
          created_at: p.createdAt.toISOString(),
          endpoint: p.endpoint,
          amount_atomic: p.amountAtomic.toString(),
          status: p.status,
          tx_hash: p.txHash ?? null,
        })),
        sessions: sessionsOf(a, d.sessions?.opts.ttlMs ?? 0, Date.now()),
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  return r;
}
