import { createHash } from "node:crypto";
import type { AppDeps } from "../context";
import { isMainnet } from "../config";
import type { PricedResource, Product } from "../platform/product";

/**
 * The public one-page site, served at `/` to browsers (agents keep getting JSON there). Rendered
 * from the catalog on every request, so prices and data status can't drift from what the API does.
 * Self-contained: no third-party fonts, scripts or trackers, and a CSP that allows only the exact
 * inline style and script below (by hash).
 */

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--surface:#f8fafd;--line:#dde3ea;--text:#1f1f1f;--muted:#444746;--accent:#0b57d0;--on-accent:#fff;--code:#f0f4f9;
--ok-bg:#c4eed0;--ok:#0f5223;--warn-bg:#ffdf99;--warn:#574000;--info-bg:#d3e3fd;--info:#041e49}
@media (prefers-color-scheme:dark){:root{--bg:#131314;--surface:#1e1f20;--line:#444746;--text:#e3e3e3;--muted:#c4c7c5;--accent:#a8c7fa;--on-accent:#062e6f;--code:#282a2c;
--ok-bg:#0f5223;--ok:#c4eed0;--warn-bg:#574000;--warn:#ffdf99;--info-bg:#0842a0;--info:#d3e3fd}}
*{box-sizing:border-box}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.6 Roboto,"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif}
a{color:var(--accent)}a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wrap{max-width:1040px;margin:0 auto;padding:0 24px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--bg);padding:8px 16px;z-index:2}
.banner{background:var(--info-bg);color:var(--info);font-size:14px;padding:10px 24px;text-align:center}
header{border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px;flex-wrap:wrap}
.brand{font-size:18px;font-weight:500}
nav{display:flex;flex-wrap:wrap;gap:4px 20px;font-size:14px}nav a{color:var(--muted);text-decoration:none;padding:6px 0}nav a:hover{color:var(--accent)}
.hero{padding:88px 0 72px;max-width:760px}
h1{font-size:clamp(36px,6vw,56px);line-height:1.12;font-weight:400;letter-spacing:-.5px;margin:0 0 20px}
.lede{font-size:20px;color:var(--muted);margin:0 0 32px}
.actions{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-block;border-radius:999px;padding:11px 24px;font-family:inherit;font-size:14px;font-weight:500;line-height:1.4;text-decoration:none;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--accent)}
.btn:hover{background:var(--surface)}.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}.btn.primary:hover{opacity:.9}
section{padding:64px 0;border-top:1px solid var(--line)}
h2{font-size:32px;line-height:1.25;font-weight:400;margin:0 0 12px}.sub{color:var(--muted);margin:0 0 32px;max-width:680px}
h3{font-size:20px;font-weight:500;margin:0}
.cards{display:grid;gap:24px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px;min-width:0}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;margin-bottom:8px}
.card p{color:var(--muted);margin:0 0 16px}
.chip{display:inline-block;border-radius:8px;padding:2px 10px;font-size:13px;font-weight:500}
.chip.ok{background:var(--ok-bg);color:var(--ok)}.chip.warn{background:var(--warn-bg);color:var(--warn)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-weight:500;color:var(--muted)}
th,td{padding:10px 16px 10px 0;border-top:1px solid var(--line);vertical-align:top}td.num,th.num{white-space:nowrap}td code{white-space:nowrap}
.steps{display:grid;gap:24px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));list-style:none;margin:0;padding:0;counter-reset:s}
.steps li{counter-increment:s}.steps li::before{content:counter(s);display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--info-bg);color:var(--info);font-weight:500;margin-bottom:12px}
.steps p{color:var(--muted);margin:6px 0 0}
code{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:var(--code);border-radius:12px;padding:16px;overflow-x:auto;margin:0 0 24px}
#try-out{min-height:96px;margin:16px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.guarantees{display:grid;gap:24px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}.guarantees p{color:var(--muted);margin:6px 0 0}.guarantees h3{font-size:16px}
@media (max-width:640px){.hero{padding:56px 0 48px}section{padding:48px 0}.card{padding:16px}table thead{display:none}table,tbody,tr,td{display:block}tr{border-top:1px solid var(--line);padding:12px 0}td{border:0;padding:2px 0}td code{white-space:normal;overflow-wrap:anywhere}td.num{display:inline-block;margin-right:16px;font-weight:500}td.num::before{content:attr(data-label) " ";font-weight:400;color:var(--muted)}}
footer{border-top:1px solid var(--line);padding:32px 0 48px;font-size:14px;color:var(--muted)}footer nav{margin-bottom:12px}
`;

const JS = `
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

const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0b57d0"/><path d="M9 10l14 12M23 10L9 22" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>')}`;

const NETWORK_NAMES: Record<string, string> = { "eip155:8453": "Base", "eip155:84532": "Base Sepolia" };

/** Honest, live status for a product: anything not live and fresh says so. */
function statusChip(p: Product): string {
  const scopes = p.status().scopes;
  if (scopes.some((s) => s.mode !== "live")) return `<span class="chip warn">Simulated data</span>`;
  if (scopes.some((s) => !s.fresh)) return `<span class="chip warn">Data delayed: calls are not charged</span>`;
  return `<span class="chip ok">Live data</span>`;
}

const gbp = (micros: number) => `£${(micros / 1e6).toFixed(3)}`;

function resourceRow(p: Product, r: PricedResource): string {
  return `<tr><td><code>GET /v1/${esc(p.id)}${esc(r.path)}</code></td><td>${esc(r.summary)}</td><td class="num" data-label="USDC">$${esc(r.pricing.priceUsd)}</td><td class="num" data-label="Credits">${gbp(r.pricing.creditsGbpMicros)}</td></tr>`;
}

function productCard(p: Product): string {
  return `<article class="card">
  <div class="card-head"><h3>${esc(p.displayName)}</h3>${statusChip(p)}</div>
  <p>${esc(p.description)}</p>
  <div class="scroll"><table>
    <thead><tr><th scope="col">Endpoint</th><th scope="col">Returns</th><th scope="col" class="num">USDC</th><th scope="col" class="num">Credits</th></tr></thead>
    <tbody>${p.resources.map((r) => resourceRow(p, r)).join("")}</tbody>
  </table></div>
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

export function renderSite(d: AppDeps): string {
  const base = d.cfg.PUBLIC_BASE_URL;
  const mainnet = isMainnet(d.cfg);
  const network = NETWORK_NAMES[d.cfg.X402_NETWORK] ?? d.cfg.X402_NETWORK;
  const products = d.catalog.products;
  const samples = products.map(sampleFor).filter((s) => s !== null);
  const first = samples[0];
  const prices = products.flatMap((p) => p.resources.map((r) => Number(r.pricing.priceUsd)));
  const from = prices.length ? Math.min(...prices) : 0;
  const description = `Data for AI agents, sold per request. Agents pay from $${from} in USDC with x402; businesses can prepay in GBP.`;

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wearebase: data for AI agents, paid per request</title>
<meta name="description" content="${esc(description)}">
${mainnet ? "" : '<meta name="robots" content="noindex">\n'}<meta name="theme-color" content="#0b57d0">
<link rel="icon" href="${esc(FAVICON)}">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${mainnet ? "" : `<div class="banner" role="note">Test environment. Payments use ${esc(network)} test USDC, so no real money moves.</div>`}
<header><div class="wrap">
  <div class="brand">wearebase</div>
  <nav aria-label="Main"><a href="#products">Products</a><a href="#how">How it works</a><a href="#try">Try it</a><a href="#connect">Connect</a><a href="/openapi.json">API spec</a></nav>
</div></header>
<main id="main"><div class="wrap">
  <div class="hero">
    <h1>Data your agents can buy, one request at a time.</h1>
    <p class="lede">Your agent asks for data, sees the price, pays in USDC and gets the answer. No sign-up, contract or API key. Businesses can prepay in GBP instead.</p>
    <div class="actions"><a class="btn primary" href="#try">Try a request</a><a class="btn" href="#connect">Connect an agent</a></div>
  </div>

  <section id="products" aria-labelledby="products-h">
    <h2 id="products-h">Products</h2>
    <p class="sub">Priced per call. USDC prices include VAT; credit prices exclude it, as VAT is charged when you top up.</p>
    <div class="cards">${products.map(productCard).join("\n")}</div>
  </section>

  <section id="how" aria-labelledby="how-h">
    <h2 id="how-h">How it works</h2>
    <p class="sub">Built on <a href="https://www.x402.org/" rel="noopener">x402</a>, which puts HTTP's "402 Payment Required" status to work.</p>
    <ol class="steps">
      <li><h3>Ask</h3><p>Your agent calls an endpoint and gets a 402 response stating the exact price.</p></li>
      <li><h3>Pay</h3><p>It signs a USDC payment on ${esc(network)} and repeats the request. The wallet doesn't need ETH for gas.</p></li>
      <li><h3>Receive</h3><p>The data comes back straight away, and the payment settles on chain.</p></li>
    </ol>
  </section>

  <section id="try" aria-labelledby="try-h">
    <h2 id="try-h">Try it</h2>
    <p class="sub">Send a real request to this server, without paying. You'll see the same price offer an agent gets. Nothing is charged.</p>
    <div class="actions">${samples.map((s) => `<button class="btn" type="button" data-try="${esc(s.path)}">${esc(s.label)}: ${esc(s.id)}</button>`).join("")}</div>
    <pre id="try-out" tabindex="0" aria-live="polite"><code>Choose a request above.</code></pre>
  </section>

  <section id="connect" aria-labelledby="connect-h">
    <h2 id="connect-h">Connect an agent</h2>
    <p class="sub">See the price from any terminal:</p>
    <pre tabindex="0"><code>curl -i ${esc(base)}${esc(first?.path ?? "/v1/products")}</code></pre>
    <p class="sub">Pay with the open-source x402 client (<code>${esc(d.cfg.X402_NETWORK)}</code>):</p>
    <pre tabindex="0"><code>${esc(SNIPPET.replace("NETWORK", JSON.stringify(d.cfg.X402_NETWORK)).replace("TARGET", JSON.stringify(`${base}${first?.path ?? ""}`)))}</code></pre>
    <p class="sub">Or use prepaid credits. Create a business account, which returns your API key once:</p>
    <pre tabindex="0"><code>curl -X POST ${esc(base)}/v1/credits/accounts \\
  -H "content-type: application/json" \\
  -d '{"company":"Your Company Ltd","email":"you@example.com","country":"GB"}'

curl -H "Authorization: Bearer mk_..." ${esc(base)}${esc(first?.path ?? "/v1/products")}</code></pre>
    <p class="sub">Every endpoint and parameter is in the <a href="/openapi.json">OpenAPI spec</a>.</p>
  </section>

  <section aria-labelledby="promises-h">
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
  <div>Payments on ${esc(network)}.</div>
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
