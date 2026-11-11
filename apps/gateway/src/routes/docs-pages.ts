import { createHash } from "node:crypto";
import { isMainnet } from "../config";
import type { AppDeps } from "../context";
import { catalogView, type EndpointView, type ProductView, type ScopeView } from "./catalog-model";
import type { Viewer } from "../customers/web-session";
import { headerActs } from "./site";
import { BRAND_MARK, esc, FAVICON, THEME_CSS } from "./site-theme";

/**
 * Human pages for what agents read as JSON: the data catalog (/catalog, and /v1/products in a
 * browser) and the API reference (/docs, and /openapi.json in a browser). Both are rendered from
 * catalogView() and the OpenAPI document, so they can't drift from the API.
 *
 * No script at all: navigation is anchors and <details>, so the CSP is default-src 'none' plus one
 * style hash.
 */

const PAGE_CSS = `
.page-head{padding:56px 0 32px}
.page-head .lede{margin-bottom:24px}
.actions{display:flex;flex-wrap:wrap;gap:12px}
.prod{scroll-margin-top:88px;margin:0 0 32px}
.prod .card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;margin-bottom:8px}
.prod>.card>p{color:var(--on-surface-v);margin:0 0 20px;max-width:780px}
h4{font:500 14px/1.3 var(--font);letter-spacing:.4px;text-transform:uppercase;color:var(--on-surface-v);margin:24px 0 12px}
.cover{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.scope{background:var(--surface);border:1px solid var(--outline-v);border-radius:16px;padding:14px 16px;display:grid;gap:4px}
.scope b{font-weight:500}.scope span{font-size:13px;color:var(--on-surface-v)}
.state{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500}
.state::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.state.live{color:var(--tertiary)}.state.stale{color:var(--on-warn-container)}.state.sim{color:var(--on-surface-v)}
.ep-path{font-family:var(--mono);font-size:14px;overflow-wrap:anywhere}
.ep-sum{color:var(--on-surface-v);font-size:14px;margin-top:2px}
.method{display:inline-block;font:600 11px/1 var(--mono);letter-spacing:.5px;padding:4px 7px;border-radius:6px;background:var(--tertiary-container);color:var(--on-tertiary-container);margin-right:8px;vertical-align:1px}
.method.sse{background:var(--primary-container);color:var(--on-primary-container)}
.method.free{background:var(--surface-chh);color:var(--on-surface)}
.price{font-variant-numeric:tabular-nums;white-space:nowrap}
.na{color:var(--on-surface-v)}
td a{white-space:nowrap}
/* Docs layout: sticky contents on wide screens, a collapsible list on phones. */
.docs{display:grid;grid-template-columns:240px minmax(0,1fr);gap:48px;align-items:start;padding:40px 0 64px}
.toc{position:sticky;top:88px;max-height:calc(100vh - 104px);overflow:auto;font-size:14px}
.toc-narrow{display:none}
.toc ul{list-style:none;margin:0;padding:0}.toc li{margin:0}
.toc a{display:block;padding:6px 12px;border-radius:999px;color:var(--on-surface-v);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.appbar nav a[aria-current=page]{background:var(--secondary-container);color:var(--on-secondary-container)}
.toc a:hover{background:var(--surface-ch);color:var(--on-surface)}
.toc .grp{font-weight:500;color:var(--on-surface);margin-top:12px}
.toc .sub a{padding-left:24px;font-family:var(--mono);font-size:12.5px}
.doc section{scroll-margin-top:88px;padding:0 0 40px;margin:0 0 40px;border-bottom:1px solid var(--outline-v)}
.doc section:last-child{border-bottom:0}
.doc p{max-width:780px}
.op{scroll-margin-top:88px;background:var(--surface-dim);border:1px solid var(--outline-v);border-radius:20px;padding:24px;margin:0 0 20px}
.op h3{font:500 16px/1.4 var(--mono);margin:0 0 6px;overflow-wrap:anywhere}
.op>p{color:var(--on-surface-v);margin:0 0 14px}
.pays{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.op pre{margin:0 0 4px;white-space:pre-wrap;overflow-wrap:anywhere}
.op table{margin:0 0 8px}
.ways{display:grid;gap:16px;grid-template-columns:repeat(3,minmax(0,1fr))}
.ways .card{padding:22px}.ways p{color:var(--on-surface-v);margin:6px 0 12px;font-size:15px}
.ways pre{margin:0;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:960px){.docs{grid-template-columns:minmax(0,1fr);gap:16px;padding-top:24px}.toc-wide{display:none}.toc-narrow{display:block}
.toc{position:static;max-height:none;background:var(--surface-c);border-radius:16px;padding:4px 8px}
.toc summary{display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:12px;font-weight:500;list-style:none}
.toc summary::-webkit-details-marker{display:none}.toc summary::after{content:"+";font-size:20px;color:var(--on-surface-v)}
.toc[open] summary::after{content:"−"}.toc ul{padding:0 0 8px}.ways{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.page-head{padding:32px 0 20px}.op{padding:18px;border-radius:16px}
.kv thead{display:none}.kv,.kv tbody,.kv tr,.kv td{display:block}.kv tr{border-top:1px solid var(--outline-v);padding:10px 0}
.kv td{border:0;padding:2px 0}.kv td:first-child{font-weight:500}.kv td code{white-space:normal;overflow-wrap:anywhere}}
`;

const CSS = THEME_CSS + PAGE_CSS;
const sha = (s: string) => `sha256-${createHash("sha256").update(s).digest("base64")}`;

export const DOCS_CSP = ["default-src 'none'", `style-src '${sha(CSS)}'`, "img-src data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");

export const DOCS_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": DOCS_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  // Per-visitor header (signed in or not): never cache shared; never serve HTML to a JSON client.
  "cache-control": "private, no-cache",
  vary: "Accept, Cookie",
};

const NETWORK_NAMES: Record<string, string> = { "eip155:8453": "Base", "eip155:84532": "Base Sepolia" };

export interface ShellOptions {
  title: string;
  description: string;
  active: "catalog" | "docs" | "wallet";
  body: string;
  /** Page-specific CSS, appended to the theme (covered by the same style hash). */
  css?: string;
  /** Page script (hash-pinned in the CSP). */
  script?: string;
  /** The signed-in customer, if any (header shows their account instead of sign in). */
  viewer?: Viewer | null;
}

/** The CSP for a page built with pageShell: one style hash, and a script hash only if it has one. */
export function pageCsp(o: Pick<ShellOptions, "css" | "script">): string {
  return [
    "default-src 'none'",
    `style-src '${sha(CSS + (o.css ?? ""))}'`,
    ...(o.script ? [`script-src '${sha(o.script)}'`, "connect-src 'self'"] : []),
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function pageShell(d: AppDeps, o: ShellOptions): string {
  return shell(d, o);
}

function shell(d: AppDeps, o: ShellOptions): string {
  const mainnet = isMainnet(d.cfg);
  const network = NETWORK_NAMES[d.cfg.X402_NETWORK] ?? d.cfg.X402_NETWORK;
  const nav = (href: string, label: string, key?: string) => `<a href="${href}"${key === o.active ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · wearebase</title>
<meta name="description" content="${esc(o.description)}">
${mainnet ? "" : '<meta name="robots" content="noindex">\n'}<meta name="theme-color" content="#0b57d0">
<link rel="icon" href="${esc(FAVICON)}">
<style>${CSS}${o.css ?? ""}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${mainnet ? "" : `<div class="banner" role="note">Test environment. Payments use ${esc(network)} test USDC, so no real money moves.</div>`}
<header class="appbar"><div class="wrap">
  <a class="brand" href="/">${BRAND_MARK}<span>wearebase</span></a>
  <nav aria-label="Main">${nav("/#offer", "What we offer")}${nav("/catalog", "Catalog", "catalog")}${nav("/docs", "API reference", "docs")}${nav("/wallet", "Wallet", "wallet")}${nav("/#pricing", "Pricing")}</nav>
  <div class="acts">${headerActs(d, o.viewer, '<a class="btn filled" href="/#how-to-use">Get started</a>')}</div>
</div></header>
<main id="main">${o.body}</main>
<footer><div class="wrap">
  <nav aria-label="Footer"><a href="/">Home</a><a href="/catalog">Catalog</a><a href="/docs">API reference</a><a href="/openapi.json?format=json">openapi.json</a><a href="/v1/products?format=json">Catalog (JSON)</a><a href="/status">Service status</a></nav>
  <div>Payments on ${esc(network)}.${d.catalog.product("grid") ? " Grid data supported by National Energy SO Open Data; not provided or endorsed by NESO." : ""}</div>
</div></footer>
${o.script ? `<script>${o.script}</script>\n` : ""}</body>
</html>`;
}

const usd = (v: string) => `$${v}`;
const gbp = (v: number) => `£${v.toFixed(3)}`;
const DASH = '<span class="na" title="Not accepted for this endpoint">—</span>';

function stateOf(s: ScopeView): string {
  if (s.mode !== "live") return `<span class="state sim">Simulated</span>`;
  if (!s.fresh) return `<span class="state stale">Delayed: not charged</span>`;
  return `<span class="state live">Live</span>`;
}

function age(s: ScopeView): string {
  const parts: string[] = [];
  if (s.vessels !== undefined) parts.push(`${s.vessels} vessel${s.vessels === 1 ? "" : "s"}`);
  if (s.data_age_s !== null) parts.push(s.data_age_s < 90 ? `updated ${s.data_age_s}s ago` : `updated ${Math.round(s.data_age_s / 60)} min ago`);
  else if (!s.fresh) parts.push("no data yet");
  return parts.join(" · ");
}

function productChip(v: ProductView): string {
  if (v.coverage.some((s) => s.mode !== "live")) return `<span class="chip warn">Simulated data</span>`;
  if (!v.coverage.length) return "";
  const fresh = v.coverage.filter((s) => s.fresh).length;
  if (fresh === v.coverage.length) return `<span class="chip ok"><span class="dot"></span>Live data</span>`;
  if (fresh === 0) return `<span class="chip warn">Data delayed: calls are not charged</span>`;
  return `<span class="chip ok"><span class="dot"></span>Live in ${fresh} of ${v.coverage.length}</span>`;
}

const methodBadge = (e: EndpointView) => (e.kind === "stream" ? '<span class="method sse">SSE</span>' : e.kind === "free" ? '<span class="method free">FREE</span>' : '<span class="method">GET</span>');

function endpointRows(v: ProductView): string {
  return v.endpoints
    .map((e) => {
      const x402 = e.pay.x402 ? usd(e.pay.x402.price_usdc) : DASH;
      const credits = e.pay.credits ? gbp(e.pay.credits.price_gbp) : DASH;
      const session = e.pay.session ? (e.kind === "stream" ? `${usd(e.pay.session.price_usdc)} / event` : usd(e.pay.session.price_usdc)) : DASH;
      const free = e.kind === "free";
      return `<tr><td>${methodBadge(e)}<span class="ep-path">${esc(e.path)}</span><div class="ep-sum">${esc(e.summary)}</div></td>
<td class="num price" data-label="x402">${free ? "Free" : x402}</td><td class="num price" data-label="Credits">${free ? "Free" : credits}</td><td class="num price" data-label="Session">${free ? "Free" : session}</td>
<td><a href="/docs#${esc(e.id)}">Docs</a></td></tr>`;
    })
    .join("\n");
}

function dataProductSection(v: ProductView): string {
  const cover = v.coverage.length
    ? `<h4>Coverage</h4><div class="cover">${v.coverage.map((s) => `<div class="scope"><b>${esc(s.name)}</b>${stateOf(s)}<span>${esc(age(s) || s.id)}</span></div>`).join("")}</div>`
    : "";
  return `<section class="prod" id="${esc(v.id)}" aria-labelledby="${esc(v.id)}-h"><div class="card">
<div class="card-head"><h2 id="${esc(v.id)}-h">${esc(v.name)}</h2>${productChip(v)}</div>
<p>${esc(v.description)}</p>
${cover}
<h4>Endpoints</h4>
<div class="scroll"><table class="stack"><thead><tr><th>Endpoint</th><th class="num">x402 (USDC)</th><th class="num">Credits (GBP)</th><th class="num">Session</th><th></th></tr></thead>
<tbody>${endpointRows(v)}</tbody></table></div>
</div></section>`;
}

function accessSection(v: ProductView): string {
  const sizes = v.endpoints;
  return `<section class="prod" id="${esc(v.id)}" aria-labelledby="${esc(v.id)}-h"><div class="card filled">
<div class="card-head"><h2 id="${esc(v.id)}-h">${esc(v.name)}</h2><span class="chip info">Way to pay</span></div>
<p>${esc(v.description)}</p>
<div class="scroll"><table class="stack"><thead><tr><th>Buy</th><th class="num">Price (USDC)</th><th></th></tr></thead><tbody>
${sizes.map((e) => `<tr><td>${methodBadge(e)}<span class="ep-path">${esc(e.path)}</span><div class="ep-sum">${esc(e.summary)}</div></td><td class="num price" data-label="Price">${e.kind === "free" ? "Free" : e.pay.x402 ? usd(e.pay.x402.price_usdc) : DASH}</td><td><a href="/docs#${esc(e.id)}">Docs</a></td></tr>`).join("\n")}
</tbody></table></div>
</div></section>`;
}

export function renderCatalogPage(d: AppDeps, viewer?: Viewer | null): string {
  const views = catalogView(d);
  const data = views.filter((v) => v.kind === "data");
  const access = views.filter((v) => v.kind === "access");
  const body = `<div class="wrap">
<div class="page-head">
  <span class="overline">Catalog</span>
  <h1>Data you can buy, one request at a time</h1>
  <p class="lede">Every product, where it covers right now, and what each call costs. Pay per call in USDC with x402, from prepaid GBP credits, or from an x402 session. Prices include the on-chain network fee, so a wallet needs only USDC. You're never charged for stale data.</p>
  <div class="actions"><a class="btn filled" href="/docs">API reference</a><a class="btn outlined" href="/v1/products?format=json">Catalog as JSON</a></div>
</div>
${data.map(dataProductSection).join("\n")}
${access.map(accessSection).join("\n")}
</div>`;
  return shell(d, { title: "Data catalog", description: "Products, live coverage and per-call prices.", active: "catalog", body, viewer });
}

// ---------------------------------------------------------------------------------------------
// API reference

interface OpenApiLike {
  info: { title: string };
  paths: Record<string, unknown>;
}
type Op = { get?: { responses?: Record<string, { description?: string }> } };

function paramTable(e: EndpointView): string {
  if (!e.parameters.length) return "";
  const rows = e.parameters
    .map((p) => {
      const s = p.schema as { type?: string; enum?: unknown[]; format?: string; minimum?: number; maximum?: number };
      const type = s.enum ? s.enum.map(String).join(" | ") : [s.type, s.format].filter(Boolean).join(", ");
      return `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}${p.required ? ", required" : ""}</td><td><code>${esc(type)}</code></td><td>${esc(p.description ?? "")}</td></tr>`;
    })
    .join("");
  return `<h4>Parameters</h4><div class="scroll"><table class="kv"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function payChips(e: EndpointView): string {
  if (e.kind === "free") return `<div class="pays"><span class="chip ok">Free, no payment</span></div>`;
  const out: string[] = [];
  if (e.pay.x402) out.push(`<span class="chip info">x402 ${usd(e.pay.x402.price_usdc)} USDC</span>`);
  if (e.pay.credits) out.push(`<span class="chip info">Credits ${gbp(e.pay.credits.price_gbp)}</span>`);
  if (e.pay.session) out.push(`<span class="chip info">Session ${usd(e.pay.session.price_usdc)}${e.kind === "stream" ? " / event" : ""}</span>`);
  return `<div class="pays">${out.join("")}</div>`;
}

function example(base: string, e: EndpointView): string {
  const url = `${base}${e.example}`;
  if (e.kind === "free") return `curl "${url}"`;
  if (e.kind === "stream") return `curl -N -H "Authorization: Session $SESSION" \\\n  "${url}"`;
  const lines = [`# 402 with the price; pay with an x402 client, or:`];
  if (e.pay.credits) lines.push(`curl -H "Authorization: Bearer $API_KEY" \\\n  "${url}"`);
  else lines.push(`curl -i "${url}"`);
  return lines.join("\n");
}

function responsesList(spec: OpenApiLike, e: EndpointView): string {
  const r = (spec.paths[e.path] as Op | undefined)?.get?.responses;
  if (!r) return "";
  return `<h4>Responses</h4><div class="scroll"><table class="kv"><tbody>${Object.entries(r)
    .map(([code, v]) => `<tr><td class="num"><code>${esc(code)}</code></td><td>${esc(v.description ?? "")}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

function opArticle(base: string, spec: OpenApiLike, e: EndpointView): string {
  return `<article class="op" id="${esc(e.id)}" aria-labelledby="${esc(e.id)}-h">
<h3 id="${esc(e.id)}-h">${methodBadge(e)}${esc(e.path)}</h3>
<p>${esc(e.summary)}</p>
${payChips(e)}
<h4>Example</h4><pre><code>${esc(example(base, e))}</code></pre>
${paramTable(e)}
${responsesList(spec, e)}
</article>`;
}

export function renderDocsPage(d: AppDeps, spec: OpenApiLike, viewer?: Viewer | null): string {
  const base = d.cfg.PUBLIC_BASE_URL;
  const views = catalogView(d);
  const links = `<ul>
<li><a href="#overview">Overview</a></li><li><a href="#pay">Paying for calls</a></li><li><a href="#responses">Responses and errors</a></li>
${views.map((v) => `<li><a class="grp" href="#ref-${esc(v.id)}">${esc(v.name)}</a><ul class="sub">${v.endpoints.map((e) => `<li><a href="#${esc(e.id)}">${esc(e.path.replace(`/v1/${v.id}`, "") || "/")}</a></li>`).join("")}</ul></li>`).join("\n")}
</ul>`;
  // Desktop: an always-open sticky list. Phones: the same links in a collapsed menu (no script).
  const toc = `<div class="toc toc-wide">${links}</div><details class="toc toc-narrow"><summary>On this page</summary>${links}</details>`;
  const body = `<div class="wrap"><div class="docs">
<nav aria-label="API reference contents">${toc}</nav>
<div class="doc">
<section id="overview" aria-labelledby="overview-h">
  <span class="overline">API reference</span>
  <h1 id="overview-h">${esc(spec.info.title)}</h1>
  <p class="lede">Maritime and energy-grid intelligence over plain HTTPS GET. JSON responses, priced per call, with no SDK required.</p>
  <h4>Base URL</h4><pre><code>${esc(base)}</code></pre>
  <div class="actions"><a class="btn tonal" href="/openapi.json?format=json" download="openapi.json">Download openapi.json</a><a class="btn outlined" href="/catalog">Catalog and live coverage</a></div>
</section>
<section id="pay" aria-labelledby="pay-h">
  <h2 id="pay-h">Paying for calls</h2>
  <p>Free endpoints need nothing. Paid endpoints accept any of these; each endpoint below lists which, and the price.</p>
  <div class="ways">
    <div class="card"><h3>x402 (no account)</h3><p>Call the endpoint. You get <code>402</code> with a USDC price. Sign it with your wallet and repeat the call with the signature.</p><pre><code>PAYMENT-SIGNATURE: &lt;signed payment&gt;</code></pre></div>
    <div class="card"><h3>Credits (GBP)</h3><p>Prepay in GBP from <a href="/account">your account</a>, then send your API key. VAT is charged at top-up.</p><pre><code>Authorization: Bearer mk_...</code></pre></div>
    <div class="card"><h3>Session (prepaid x402)</h3><p>Buy a session once with x402, then read at memory speed until it's spent. Streams need a session.</p><pre><code>Authorization: Session &lt;token&gt;</code></pre></div>
  </div>
</section>
<section id="responses" aria-labelledby="responses-h">
  <h2 id="responses-h">Responses and errors</h2>
  <p>Every data response says its <code>mode</code> (<code>live</code> or <code>simulated</code>) and how fresh it is. You're charged only for a <code>200</code>.</p>
  <div class="scroll"><table class="kv"><thead><tr><th>Status</th><th>Meaning</th><th>Charged</th></tr></thead><tbody>
  <tr><td><code>200</code></td><td>The data</td><td>Yes</td></tr>
  <tr><td><code>402</code></td><td>Payment needed: the price is in the <code>PAYMENT-REQUIRED</code> header and the body, with the credits and session alternatives</td><td>No</td></tr>
  <tr><td><code>400</code> / <code>404</code></td><td>Invalid parameter, or unknown region, country or vessel</td><td>No</td></tr>
  <tr><td><code>401</code></td><td>Invalid API key or session</td><td>No</td></tr>
  <tr><td><code>503</code></td><td>Data is stale, not for sale on this network, or payments are briefly unavailable</td><td>No</td></tr>
  </tbody></table></div>
</section>
${views
  .map(
    (v) => `<section id="ref-${esc(v.id)}" aria-labelledby="ref-${esc(v.id)}-h">
  <h2 id="ref-${esc(v.id)}-h">${esc(v.name)}</h2>
  <p>${esc(v.description)}</p>
  ${v.endpoints.map((e) => opArticle(base, spec, e)).join("\n")}
</section>`,
  )
  .join("\n")}
</div></div></div>`;
  return shell(d, { title: "API reference", description: "Endpoints, parameters, prices and how to pay.", active: "docs", body, viewer });
}
