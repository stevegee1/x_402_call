import { createHash } from "node:crypto";
import { isMainnet } from "../config";
import type { AppDeps } from "../context";
import type { PricedResource, Product } from "../platform/product";
import { agentsScene, maritimeScene, paymentScene, SCENES_CSS, tradingScene } from "./site-scenes";
import { BRAND_MARK, esc, FAVICON, THEME_CSS } from "./site-theme";

/**
 * The public site, served at `/` to browsers (agents keep getting JSON there). Rendered from the
 * catalog on every request, so prices and data status can't drift from what the API does.
 * Self-contained: no third-party fonts, scripts or trackers, and a CSP that allows only the exact
 * inline style and script below (by hash). Material 3 styling lives in site-theme.ts, the animated
 * explainers in site-scenes.ts.
 */

const PAGE_CSS = `
.hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:48px;align-items:center;padding:72px 0 64px}
.hero-art{background:var(--surface-dim);border:1px solid var(--outline-v);border-radius:32px;padding:20px 12px 12px}
.actions{display:flex;flex-wrap:wrap;gap:12px}
.stats{display:flex;flex-wrap:wrap;gap:12px 36px;margin:40px 0 0;padding:0;list-style:none}
.stats b{display:block;font:400 28px/1.15 var(--font-display);color:var(--on-surface)}.stats span{font-size:14px;color:var(--on-surface-v)}
section{padding:80px 0;border-top:1px solid var(--outline-v)}
.offer{display:grid;gap:24px;grid-template-columns:repeat(2,minmax(0,1fr))}
.offer .card{display:flex;flex-direction:column;gap:12px;transition:box-shadow .3s var(--ease-std),transform .3s var(--ease-std)}
.offer .card:hover{box-shadow:var(--shadow);transform:translateY(-2px)}
.offer .art{background:var(--surface);border-radius:18px;padding:10px;margin-bottom:8px;aspect-ratio:16/10;display:grid;place-items:center;overflow:hidden}.offer .art .scene{max-height:100%;width:auto;max-width:100%}
.offer p{color:var(--on-surface-v);margin:0}
.offer ul{margin:4px 0 0;padding-left:20px;color:var(--on-surface-v)}.offer li{margin:2px 0}
.steps{display:grid;gap:16px;grid-template-columns:repeat(4,minmax(0,1fr));list-style:none;margin:0 0 32px;padding:0;counter-reset:s}
.steps li{counter-increment:s;background:var(--surface-dim);border:1px solid var(--outline-v);border-radius:24px;padding:24px}
.steps li::before{content:counter(s);display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--primary-container);color:var(--on-primary-container);font-weight:500;margin-bottom:16px}
.steps p{color:var(--on-surface-v);margin:0}
.fast{display:grid;grid-template-columns:auto 1fr auto;gap:20px;align-items:center;background:var(--primary-container);color:var(--on-primary-container);border-radius:24px;padding:24px 28px}
.fast h3{color:var(--on-primary-container)}.fast p{margin:0}
.fast .bolt path{fill:var(--primary)}.fast .bolt{width:48px;height:48px;border-radius:14px;background:var(--surface);display:grid;place-items:center}
.tabs{display:inline-flex;flex-wrap:wrap;border:1px solid var(--outline);border-radius:999px;overflow:hidden;margin:0 0 28px}
.tabs button{height:40px;padding:0 20px;border:0;border-right:1px solid var(--outline);background:transparent;color:var(--on-surface);font:500 14px/1 var(--font);cursor:pointer;display:inline-flex;align-items:center;gap:8px}
.tabs button:last-child{border-right:0}
.tabs button[aria-selected=true]{background:var(--secondary-container);color:var(--on-secondary-container)}
.tabs button[aria-selected=true]::before{content:"";width:14px;height:8px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-2px) rotate(-45deg)}
.panel{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:32px;align-items:start}
.panel[hidden]{display:none}
.panel ol{margin:0;padding-left:22px}.panel li{margin:0 0 14px;color:var(--on-surface-v)}.panel li b{color:var(--on-surface);font-weight:500}
.panel pre{margin:0 0 14px}
.cards{display:grid;gap:24px}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;margin-bottom:8px}
.card>p{color:var(--on-surface-v);margin:0 0 16px}
.na{color:var(--on-surface-v)}
.sizes{display:grid;gap:16px;grid-template-columns:repeat(3,minmax(0,1fr));margin:8px 0 0}
.size{background:var(--surface);border:1px solid var(--outline-v);border-radius:16px;padding:18px}
.size b{display:block;font:400 28px/1.2 var(--font-display)}.size span{font-size:14px;color:var(--on-surface-v)}
#try-out{min-height:110px;margin:20px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.guarantees{display:grid;gap:20px;grid-template-columns:repeat(4,minmax(0,1fr))}
.guarantees>div{background:var(--surface-dim);border-radius:20px;padding:22px}
.guarantees p{color:var(--on-surface-v);margin:6px 0 0}.guarantees h3{font-size:16px}
.identity-note{margin:24px 0 16px}
@media (max-width:960px){.hero{grid-template-columns:minmax(0,1fr);padding:48px 0}.steps,.guarantees{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{grid-template-columns:minmax(0,1fr)}}
@media (max-width:720px){.offer,.steps,.guarantees,.sizes{grid-template-columns:minmax(0,1fr)}.fast{grid-template-columns:minmax(0,1fr)}section{padding:56px 0}}
`;

const CSS = THEME_CSS + SCENES_CSS + PAGE_CSS;

const JS = `
document.documentElement.classList.add("js");
const out = document.getElementById("try-out");
for (const b of document.querySelectorAll("[data-try]")) {
  b.addEventListener("click", async () => {
    const path = b.getAttribute("data-try");
    out.textContent = "GET " + path + " ...";
    try {
      const res = await fetch(path, { headers: { accept: "application/json" } });
      const body = await res.json();
      const offer = body.accepts && body.accepts[0];
      const summary = offer
        ? { price_usdc: Number(offer.amount) / 1e6, network: offer.network, pay_to: offer.payTo, asset: offer.asset, or_prepaid_credits_gbp: body.credits && body.credits.price_gbp }
        : body;
      out.textContent = "GET " + path + "\\nHTTP " + res.status + " " + (res.status === 402 ? "Payment Required" : "") + "\\n\\n" + JSON.stringify(summary, null, 2);
    } catch {
      out.textContent = "Request failed. Please try again.";
    }
  });
}
for (const list of document.querySelectorAll("[role=tablist]")) {
  const tabs = [...list.querySelectorAll("[role=tab]")];
  const select = (t, focus) => {
    for (const x of tabs) {
      const on = x === t;
      x.setAttribute("aria-selected", String(on));
      x.tabIndex = on ? 0 : -1;
      document.getElementById(x.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) t.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t, false));
    t.addEventListener("keydown", (e) => {
      const n = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (n) { e.preventDefault(); select(tabs[(i + n + tabs.length) % tabs.length], true); }
    });
  });
  select(tabs[0], false);
}
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      e.target.classList.toggle("paused", !e.isIntersecting);
    }
  });
  for (const el of document.querySelectorAll(".scene")) io.observe(el);
}
`;

const sha = (s: string) => `sha256-${createHash("sha256").update(s).digest("base64")}`;

export const SITE_CSP = [
  "default-src 'none'",
  `style-src '${sha(CSS)}'`,
  `script-src '${sha(JS)}'`,
  "connect-src 'self'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const NETWORK_NAMES: Record<string, string> = { "eip155:8453": "Base", "eip155:84532": "Base Sepolia" };

const dataProducts = (d: AppDeps) => d.catalog.products.filter((p) => (p.kind ?? "data") === "data");
const accessProduct = (d: AppDeps) => d.catalog.products.find((p) => p.kind === "access");

/** Honest, live status for a data product: anything not live and fresh says so. */
function statusChip(p: Product): string {
  const scopes = p.status().scopes;
  if (scopes.some((s) => s.mode !== "live")) return `<span class="chip warn">Simulated data</span>`;
  if (scopes.some((s) => !s.fresh)) return `<span class="chip warn">Data delayed: calls are not charged</span>`;
  return `<span class="chip ok"><span class="dot"></span>Live data</span>`;
}

const gbp = (micros: number) => `£${(micros / 1e6).toFixed(3)}`;
const accepts = (r: PricedResource, rail: "x402" | "credits" | "session") => !r.rails || r.rails.includes(rail);

function resourceRow(p: Product, r: PricedResource, stream: boolean): string {
  const usdc = stream ? `$${esc(r.pricing.priceUsd)} / event` : `$${esc(r.pricing.priceUsd)}`;
  const credits = accepts(r, "credits") ? gbp(r.pricing.creditsGbpMicros) : `<span class="na" title="Not payable with credits">—</span>`;
  return `<tr><td><code>GET /v1/${esc(p.id)}${esc(r.path)}</code></td><td>${esc(r.summary)}${stream ? " <span class=\"chip info\">Session</span>" : ""}</td><td class="num" data-label="USDC">${usdc}</td><td class="num" data-label="Credits">${credits}</td></tr>`;
}

function productCard(d: AppDeps, p: Product): string {
  const streams = new Set(d.catalog.streams.filter((s) => s.product.id === p.id).map((s) => s.resource.id));
  return `<article class="card">
  <div class="card-head"><h3>${esc(p.displayName)}</h3>${statusChip(p)}</div>
  <p>${esc(p.description)}</p>
  <div class="scroll"><table class="stack">
    <thead><tr><th scope="col">Endpoint</th><th scope="col">Returns</th><th scope="col" class="num">USDC</th><th scope="col" class="num">Credits</th></tr></thead>
    <tbody>${p.resources.map((r) => resourceRow(p, r, streams.has(r.id))).join("")}</tbody>
  </table></div>
</article>`;
}

function sessionsCard(p: Product): string {
  return `<article class="card filled" id="sessions">
  <div class="card-head"><h3>${esc(p.displayName)}</h3><span class="chip info">Way to pay</span></div>
  <p>${esc(p.description)} Bought with x402 only; the token works once the USDC has settled.</p>
  <div class="sizes">${p.resources
    .map((r) => `<div class="size"><b>$${esc(r.pricing.priceUsd)}</b><span>${esc(r.summary)}</span><br><code>GET /v1/${esc(p.id)}${esc(r.path)}</code></div>`)
    .join("")}</div>
</article>`;
}

/** A concrete, callable URL for a product: its first resource that needs only one path value. */
function sampleFor(p: Product): { label: string; path: string; id: string } | null {
  const scope = p.status().scopes[0]?.scope;
  if (!scope) return null;
  for (const r of p.resources) {
    const pathParams = r.path.match(/:[a-z_]+/gi) ?? [];
    if (pathParams.length === 1 && !r.parameters?.some((x) => x.in === "query" && x.required)) {
      return { label: p.displayName, path: `/v1/${p.id}${r.path.replace(pathParams[0]!, scope)}`, id: r.id };
    }
  }
  return null;
}

const SNIPPET = `import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const url = TARGET;
const wallet = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);
const x402 = new x402HTTPClient(x402Client.fromConfig({
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(wallet) }],
}));

// The first request returns 402 with the price.
const challenge = await fetch(url);
const required = x402.getPaymentRequiredResponse(
  (name) => challenge.headers.get(name), await challenge.json());
const payment = await x402.createPaymentPayload(required);

// Repeat it with the signed payment to receive the data.
const res = await fetch(url, {
  headers: x402.encodePaymentSignatureHeader(payment),
});`;

const usd = (atomic: bigint) => `$${Number(atomic) / 1e6}`;

/** ERC-8004 buyer tiers, from the live policy. Omitted entirely when identity is switched off. */
function identitySection(d: AppDeps): string {
  const id = d.identity;
  if (!id) return "";
  const { perPayerCapAtomic: caps, reviewers, minFeedback, minScore, network, identityRegistry } = id.policy;
  const trusted = reviewers.length > 0;
  const row = (tier: string, when: string, cap: string) => `<tr><td>${esc(tier)}</td><td>${esc(when)}</td><td class="num" data-label="Allowance">${esc(cap)}</td></tr>`;
  return `<section id="identity" aria-labelledby="identity-h">
    <span class="overline">ERC-8004</span>
    <h2 id="identity-h">Agent identity (ERC-8004)</h2>
    <p class="sub">Agents with an on-chain <a href="https://eips.ethereum.org/EIPS/eip-8004" rel="noopener">ERC-8004</a> identity can be served faster. Identity is optional, and it only ever adds to what an agent can do: without one, or if a check fails, an agent is served as Unknown.</p>
    <div class="card"><div class="scroll"><table class="stack">
      <thead><tr><th scope="col">Tier</th><th scope="col">How an agent qualifies</th><th scope="col" class="num">Allowance</th></tr></thead>
      <tbody>
        ${row("Unknown", "No identity declared, or it can't be verified", usd(caps.unknown))}
        ${row("Identified", "The agent's verified wallet in the registry signed the payment", usd(caps.identified))}
        ${row("Trusted", trusted ? `Identified, with at least ${minFeedback} reviews averaging ${minScore} or more from our trusted reviewers` : "Not available yet: no trusted reviewers are set", trusted ? usd(caps.trusted) : "n/a")}
      </tbody>
    </table></div></div>
    <p class="sub identity-note">The allowance is how much unsettled spend one wallet can have while we still serve data before payment settles. Above it, each payment settles first, so responses are slower. Declare your agent with a header; the response's <code>X-Agent-Tier</code> shows the tier you got:</p>
    <pre tabindex="0"><code>X-Agent-Id: ${esc(network)}:${esc(identityRegistry)}:&lt;your agent id&gt;</code></pre>
    ${d.sellerIdentity ? `<p class="sub">This service's own identity: <code>${esc(d.sellerIdentity.agentRegistry)}:${esc(d.sellerIdentity.agentId)}</code></p>` : ""}
  </section>`;
}

/** "How to use": one tab per kind of buyer, each with the exact calls for this server. */
function howToUse(d: AppDeps, base: string, first: { path: string } | undefined, network: string): string {
  const target = `${base}${first?.path ?? "/v1/products"}`;
  const sessions = accessProduct(d);
  const stream = d.catalog.streams[0];
  const streamUrl = stream ? `${base}${stream.path.replace(/:[a-z_]+/i, stream.product.status().scopes[0]?.scope ?? "england")}` : "";
  const tab = (id: string, label: string, first: boolean) =>
    `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${first}"${first ? "" : ' tabindex="-1"'}>${esc(label)}</button>`;
  const agent = `<div class="panel" role="tabpanel" id="panel-agent" aria-labelledby="tab-agent">
    <ol>
      <li><b>Give your agent a wallet</b> with a little USDC on ${esc(network)}. It never needs ETH: payments are gasless signatures.</li>
      <li><b>Call any endpoint.</b> The 402 response states the exact price and where to pay.</li>
      <li><b>Sign and repeat the request.</b> The x402 client does both; the data comes back straight away.</li>
      ${d.identity ? `<li><b>Optional:</b> send an ERC-8004 <code>X-Agent-Id</code> header for a higher allowance.</li>` : ""}
    </ol>
    <div><pre tabindex="0"><code>curl -i ${esc(target)}</code></pre>
    <pre tabindex="0"><code>${esc(SNIPPET.replace("NETWORK", JSON.stringify(d.cfg.X402_NETWORK)).replace("TARGET", JSON.stringify(target)))}</code></pre></div>
  </div>`;
  const trading = sessions
    ? `<div class="panel" role="tabpanel" id="panel-trading" aria-labelledby="tab-trading">
    <ol>
      <li><b>Buy a session once</b> with x402: ${sessions.resources.map((r) => `$${esc(r.pricing.priceUsd)}`).join(", ")}. It settles on chain before the token is issued.</li>
      <li><b>Read at memory speed.</b> Send <code>Authorization: Session &lt;token&gt;</code>; each read takes its price off the balance, with no payment round trip.</li>
      ${streamUrl ? `<li><b>Subscribe to the live stream.</b> Each new version is pushed the moment it lands, charged per event.</li>` : ""}
      <li><b>Backtest without look-ahead.</b> <code>history?as_of=</code> returns the data exactly as it was known then; <code>revisions</code> shows every version.</li>
    </ol>
    <div><pre tabindex="0"><code># 1. buy a session (any x402 client), keep session_token
GET ${esc(base)}/v1/sessions${esc(sessions.resources[0]!.path)}

# 2. read from memory
curl -H "Authorization: Session $TOKEN" \\
  ${esc(target)}
${streamUrl ? `\n# 3. live push (server-sent events)\ncurl -N -H "Authorization: Session $TOKEN" \\\n  ${esc(streamUrl)}\n` : ""}
# point-in-time history for backtests
curl -H "Authorization: Session $TOKEN" \\
  "${esc(base)}/v1/grid/england/history?from=2026-11-01T00:00Z&amp;to=2026-11-02T00:00Z&amp;as_of=2026-11-01T00:00Z"</code></pre></div>
  </div>`
    : "";
  const business = `<div class="panel" role="tabpanel" id="panel-business" aria-labelledby="tab-business">
    <ol>
      <li><b>Create a business account</b>${d.customers ? ` <a href="/signup">here</a>, or with the API` : ""}. You get an API key once; keep it safe.</li>
      <li><b>Top up in GBP</b>${d.customers ? ` from your <a href="/account">account page</a>` : ""} by card or bank transfer. VAT is charged at top-up, so per-call prices exclude it.</li>
      <li><b>Call endpoints with your key.</b> Each response shows what was charged and your balance.</li>
    </ol>
    <div><pre tabindex="0"><code>curl -X POST ${esc(base)}/v1/credits/accounts \\
  -H "content-type: application/json" \\
  -d '{"company":"Your Company Ltd","email":"you@example.com","country":"GB"}'

curl -H "Authorization: Bearer mk_..." ${esc(target)}</code></pre></div>
  </div>`;
  return `<section id="how-to-use" aria-labelledby="use-h">
    <span class="overline">How to use</span>
    <h2 id="use-h">Start in minutes, whoever is buying</h2>
    <p class="sub">The same data, three ways to pay. Every endpoint and parameter is in the <a href="/openapi.json">OpenAPI spec</a>.</p>
    <div class="tabs" role="tablist" aria-label="Kind of buyer">${tab("agent", "AI agent", true)}${sessions ? tab("trading", "Trading platform", false) : ""}${tab("business", "Business (GBP)", false)}</div>
    ${agent}${trading}${business}
  </section>`;
}

export function renderSite(d: AppDeps): string {
  const base = d.cfg.PUBLIC_BASE_URL;
  const mainnet = isMainnet(d.cfg);
  const network = NETWORK_NAMES[d.cfg.X402_NETWORK] ?? d.cfg.X402_NETWORK;
  const products = dataProducts(d);
  const sessions = accessProduct(d);
  const samples = products.map(sampleFor).filter((s) => s !== null);
  const first = samples[0];
  const prices = products.flatMap((p) => p.resources.map((r) => Number(r.pricing.priceUsd)));
  const from = prices.length ? Math.min(...prices) : 0;
  const description = `Maritime and energy-grid intelligence for AI agents and trading systems, sold per request. Agents pay from $${from} in USDC with x402; businesses can prepay in GBP.`;
  const maritime = products.find((p) => p.id === "maritime");
  const grid = products.find((p) => p.id === "grid");

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wearebase: intelligence for AI agents, paid per request</title>
<meta name="description" content="${esc(description)}">
${mainnet ? "" : '<meta name="robots" content="noindex">\n'}<meta name="theme-color" content="#0b57d0">
<link rel="icon" href="${esc(FAVICON)}">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${mainnet ? "" : `<div class="banner" role="note">Test environment. Payments use ${esc(network)} test USDC, so no real money moves.</div>`}
<header class="appbar"><div class="wrap">
  <a class="brand" href="/">${BRAND_MARK}<span>wearebase</span></a>
  <nav aria-label="Main"><a href="#offer">What we offer</a><a href="#how">How it works</a><a href="#how-to-use">How to use</a><a href="#pricing">Pricing</a>${d.identity ? '<a href="#identity">Identity</a>' : ""}<a href="/openapi.json">API</a></nav>
  <div class="acts">${d.customers ? '<a class="btn text" href="/signin">Sign in</a><a class="btn filled" href="/signup">Get started</a>' : '<a class="btn text" href="#try">Try it</a><a class="btn filled" href="#how-to-use">Get started</a>'}</div>
</div></header>
<main id="main"><div class="wrap">
  <div class="hero">
    <div>
      <span class="overline">x402${d.identity ? " · ERC-8004" : ""} · USDC on ${esc(network)}</span>
      <h1>Intelligence your AI can buy, one request at a time.</h1>
      <p class="lede">Maritime and energy-grid data, cleaned and ready for models. Your agent sees the price, pays in USDC with x402 and gets the answer, with no sign-up or contract. Businesses can prepay in GBP.</p>
      <div class="actions"><a class="btn filled lg" href="#how-to-use">Start building</a><a class="btn tonal lg" href="#how">See how it works</a></div>
      <ul class="stats">
        <li><b>$${from}</b><span>from, per request</span></li>
        <li><b>In memory</b><span>reads with x402 sessions</span></li>
        <li><b>Point-in-time</b><span>history for backtests</span></li>
      </ul>
    </div>
    <div class="hero-art">${paymentScene(String(from), network)}</div>
  </div>

  <section id="offer" aria-labelledby="offer-h">
    <span class="overline">What we offer</span>
    <h2 id="offer-h">Data intelligence, delivered to machines</h2>
    <p class="sub">Every product is priced per call, paid in the same request, and never charged when the data is stale or the request fails.</p>
    <div class="offer">
      <article class="card "><div class="art">${paymentScene(String(from), network, "pay2")}</div>
        <h3>Seamless payments with x402</h3>
        <p>HTTP's "402 Payment Required", put to work. The price arrives with the response, the agent signs a USDC payment, and the data follows in the same exchange. No accounts, no keys, no invoices.</p></article>
      <article class="card "><div class="art">${agentsScene()}</div>
        <h3>Built for agent-to-agent trade</h3>
        <p>${
          d.identity
            ? "Any agent can buy. Agents with a verified ERC-8004 on-chain identity get a higher allowance and faster service, and we publish our own identity so agents can check who they are paying."
            : "Any agent with a wallet can buy: no account, no API key, no human approval. Prices, terms and data status are machine-readable on every response."
        }</p></article>
      <article class="card "><div class="art">${maritimeScene()}</div>
        <div class="card-head"><h3>Maritime intelligence</h3>${maritime ? statusChip(maritime) : ""}</div>
        <p>AIS vessel positions turned into signals a model can use:</p>
        <ul><li>Live vessel snapshots and tracks</li><li>Traffic density on an H3 grid</li><li>Anchorage queues and wait times</li><li>Anomalies: vessels going dark, jumps, loitering</li></ul></article>
      <article class="card "><div class="art">${tradingScene()}</div>
        <div class="card-head"><h3>Intelligence for AI trading platforms</h3>${grid ? statusChip(grid) : ""}</div>
        <p>GB grid carbon intensity from the system operator, with every published version kept:</p>
        <ul><li>Point-in-time history: the data as it was known, for backtests without look-ahead</li><li>Every revision of a forecast period</li><li>A live push stream of new versions</li><li>Reads from memory with prepaid sessions</li></ul></article>
    </div>
  </section>

  <section id="how" aria-labelledby="how-h">
    <span class="overline">How it works</span>
    <h2 id="how-h">Ask, pay, receive. Settled on chain.</h2>
    <p class="sub">Built on <a href="https://www.x402.org/" rel="noopener">x402</a>. Your agent does it all in one exchange, without a human in the loop.</p>
    <ol class="steps">
      <li ><h3>Ask</h3><p>Your agent calls an endpoint and gets a 402 response stating the exact price.</p></li>
      <li ><h3>Pay</h3><p>It signs a USDC payment on ${esc(network)} and repeats the request. The wallet doesn't need ETH for gas.</p></li>
      <li ><h3>Receive</h3><p>The data comes back straight away. Stale data or a failed request is never charged.</p></li>
      <li ><h3>Settle</h3><p>The payment settles on chain, and our books are reconciled against it.</p></li>
    </ol>
    ${
      sessions
        ? `<div class="fast "><div class="bolt" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg></div>
      <div><h3>Need it faster? Use a session.</h3><p>Pay once with x402, then every read is served from memory with no payment round trip. Built for trading systems that read many times a second.</p></div>
      <a class="btn filled" href="#how-to-use">Use sessions</a></div>`
        : ""
    }
  </section>

  ${howToUse(d, base, first, network)}

  <section id="pricing" aria-labelledby="pricing-h">
    <span class="overline">Pricing</span>
    <h2 id="pricing-h">Products and prices</h2>
    <p class="sub">Priced per call. USDC prices include VAT; credit prices exclude it, as VAT is charged when you top up. A dash means that way of paying isn't accepted for that endpoint.</p>
    <div class="cards">${products.map((p) => productCard(d, p)).join("\n")}${sessions ? sessionsCard(sessions) : ""}</div>
  </section>

  ${identitySection(d)}

  <section id="try" aria-labelledby="try-h">
    <span class="overline">Try it</span>
    <h2 id="try-h">See a real price offer</h2>
    <p class="sub">Send a real request to this server, without paying. You'll see the same price offer an agent gets. Nothing is charged.</p>
    <div class="actions">${samples.map((s) => `<button class="btn outlined" type="button" data-try="${esc(s.path)}">${esc(s.label)}: ${esc(s.id)}</button>`).join("")}</div>
    <pre id="try-out" tabindex="0" aria-live="polite"><code>Choose a request above.</code></pre>
  </section>

  <section aria-labelledby="promises-h">
    <span class="overline">Guarantees</span>
    <h2 id="promises-h">What you can rely on</h2>
    <div class="guarantees">
      <div><h3>No charge for stale data</h3><p>If a data feed is behind, paid calls return 503 and you aren't charged.</p></div>
      <div><h3>No charge for failed requests</h3><p>If a request is invalid or can't be served, you aren't charged for it.</p></div>
      <div><h3>A payment is used once</h3><p>Each signed payment works one time, so a replay can't charge you twice.</p></div>
      <div><h3>Books checked against the chain</h3><p>Our ledger is regularly reconciled against on-chain payments.</p></div>
    </div>
  </section>
</div></main>
<footer><div class="wrap">
  <nav aria-label="Footer"><a href="/openapi.json">API spec</a><a href="/status">Service status</a><a href="/v1/products">Catalog (JSON)</a></nav>
  <div>Payments on ${esc(network)}.${grid ? " Grid data supported by National Energy SO Open Data; not provided or endorsed by NESO." : ""}</div>
</div></footer>
<script>${JS}</script>
</body>
</html>`;
}

/** Browsers ask for HTML explicitly; curl (*\/*), SDKs and agents keep getting JSON. */
export const wantsHtml = (accept: string | undefined) => {
  if (!accept) return false;
  const html = accept.indexOf("text/html");
  const json = accept.indexOf("application/json");
  return html !== -1 && (json === -1 || html < json);
};

export const SITE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": SITE_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  // Live status on the page: short shared cache, and never serve the HTML to a JSON client.
  "cache-control": "public, max-age=30",
  vary: "Accept",
};
