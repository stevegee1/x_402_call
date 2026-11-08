import { createHash } from "node:crypto";
import { CREDIT_PACKS } from "@mx/shared";
import type { ApiKeyInfo, CreditAccount, CustomerUser, UsageRow } from "../store/types";
import { BRAND_MARK, esc, FAVICON, THEME_CSS } from "./site-theme";

/**
 * Server-rendered customer pages: sign up, sign in, account. Plain HTML forms, no script at all,
 * so they work everywhere and the CSP can forbid scripts outright. Styled with the site's
 * Material 3 theme.
 */

const ACCOUNT_CSS = `
.auth{min-height:calc(100vh - 160px);display:grid;place-items:center;padding:48px 0}
.auth .card{width:100%;max-width:480px;padding:36px}
.auth h1{font-size:32px;letter-spacing:-.3px;margin:0 0 8px}
.auth .muted{margin:0 0 28px}
.auth .btn{width:100%;margin-top:8px}
.auth .alt{text-align:center;margin:24px 0 0;font-size:14px;color:var(--on-surface-v)}
.row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 16px}
.dash{padding:40px 0 72px}
.dash h1{font-size:clamp(28px,4vw,40px);margin:0 0 4px}
.grid2{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:24px;margin-top:32px}
.stack{display:grid;gap:24px;align-content:start}
.balance{font:400 48px/1.1 var(--font-display);margin:4px 0 6px}
.packs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:20px}
.packs form{margin:0}.packs .btn{width:100%}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 20px;margin:0;font-size:14px}.kv dt{color:var(--on-surface-v)}.kv dd{margin:0;overflow-wrap:anywhere}
.card h2{font-size:20px;font-weight:500;margin:0 0 4px}
.card .head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.inline{display:inline;margin:0}
.key{font:500 15px/1.5 var(--mono);background:var(--surface-c);border:1px dashed var(--outline);border-radius:12px;padding:16px;overflow-wrap:anywhere;user-select:all}
.status-revoked{color:var(--on-surface-v)}
.btn.danger{color:var(--error);border-color:var(--outline)}
.empty{color:var(--on-surface-v);font-size:14px;margin:8px 0 0}
@media (max-width:860px){.grid2{grid-template-columns:minmax(0,1fr)}}
@media (max-width:560px){.row2,.packs{grid-template-columns:minmax(0,1fr)}.auth .card{padding:24px}}
`;

const CSS = THEME_CSS + ACCOUNT_CSS;
const sha = (s: string) => `sha256-${createHash("sha256").update(s).digest("base64")}`;

/** No scripts at all. Forms post to us; a top-up redirects on to Stripe Checkout. */
export const ACCOUNT_CSP = [
  "default-src 'none'",
  `style-src '${sha(CSS)}'`,
  "img-src data:",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const ACCOUNT_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": ACCOUNT_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  // Personal pages, and some show a secret once: never cache, never index.
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

function shell(title: string, body: string, opts: { signedIn: boolean; testnet: string | null }): string {
  const acts = opts.signedIn
    ? `<a class="btn text" href="/account">Account</a><form class="inline" method="post" action="/signout"><button class="btn outlined" type="submit">Sign out</button></form>`
    : `<a class="btn text" href="/signin">Sign in</a><a class="btn filled" href="/signup">Get started</a>`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · wearebase</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0b57d0">
<link rel="icon" href="${esc(FAVICON)}">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${opts.testnet ? `<div class="banner" role="note">Test environment. Payments use ${esc(opts.testnet)} test USDC; card top-ups use Stripe test mode.</div>` : ""}
<header class="appbar"><div class="wrap">
  <a class="brand" href="/">${BRAND_MARK}<span>wearebase</span></a>
  <nav aria-label="Main"><a href="/#offer">What we offer</a><a href="/#how-to-use">How to use</a><a href="/#pricing">Pricing</a><a href="/openapi.json">API</a></nav>
  <div class="acts">${acts}</div>
</div></header>
<main id="main"><div class="wrap">${body}</div></main>
<footer><div class="wrap"><nav aria-label="Footer"><a href="/">Home</a><a href="/openapi.json">API spec</a><a href="/status">Service status</a></nav></div></footer>
</body>
</html>`;
}

export interface PageOpts {
  testnet: string | null;
  base: string;
}

type Fields = Record<string, string>;
type Errors = Partial<Record<"company" | "email" | "country" | "taxId" | "password" | "form", string>>;

const field = (name: string, label: string, input: string, err?: string, hint?: string) =>
  `<div class="field${err ? " invalid" : ""}"><label for="${name}">${esc(label)}</label>${input}${err ? `<span class="hint" id="${name}-err" role="alert">${esc(err)}</span>` : hint ? `<span class="hint" id="${name}-hint">${esc(hint)}</span>` : ""}</div>`;
const input = (name: string, type: string, value: string, attrs: string, err?: string) =>
  `<input id="${name}" name="${name}" type="${type}" value="${esc(value)}" ${attrs}${err ? ` aria-invalid="true" aria-describedby="${name}-err"` : ""}>`;

/** Business countries we invoice. Outside the UK a VAT/tax id is required (B2B only). */
export const COUNTRIES: ReadonlyArray<[string, string]> = [
  ["GB", "United Kingdom"], ["IE", "Ireland"], ["FR", "France"], ["DE", "Germany"], ["NL", "Netherlands"], ["BE", "Belgium"], ["LU", "Luxembourg"],
  ["ES", "Spain"], ["PT", "Portugal"], ["IT", "Italy"], ["AT", "Austria"], ["CH", "Switzerland"], ["DK", "Denmark"], ["SE", "Sweden"], ["NO", "Norway"],
  ["FI", "Finland"], ["PL", "Poland"], ["CZ", "Czechia"], ["GR", "Greece"], ["US", "United States"], ["CA", "Canada"], ["SG", "Singapore"],
  ["HK", "Hong Kong"], ["JP", "Japan"], ["AU", "Australia"], ["NZ", "New Zealand"], ["AE", "United Arab Emirates"], ["IN", "India"], ["NG", "Nigeria"],
  ["ZA", "South Africa"], ["KE", "Kenya"], ["BR", "Brazil"],
];

export function signUpPage(o: PageOpts, values: Fields = {}, errors: Errors = {}): string {
  const country = values.country || "GB";
  const select = `<select id="country" name="country" autocomplete="country" required>${COUNTRIES.map(([code, name]) => `<option value="${code}"${code === country ? " selected" : ""}>${esc(name)}</option>`).join("")}</select>`;
  return shell(
    "Create your account",
    `<div class="auth"><div class="card">
  <h1>Create your account</h1>
  <p class="muted">For businesses paying in GBP. AI agents don't need an account: they pay per request with x402.</p>
  ${errors.form ? `<div class="alert error" role="alert">${esc(errors.form)}</div>` : ""}
  <form method="post" action="/signup" novalidate>
    ${field("company", "Company name", input("company", "text", values.company ?? "", 'autocomplete="organization" required maxlength="200"', errors.company), errors.company)}
    ${field("email", "Work email", input("email", "email", values.email ?? "", 'autocomplete="email" required maxlength="254"', errors.email), errors.email)}
    <div class="row2">
      ${field("country", "Country", select, errors.country)}
      ${field("taxId", "VAT or tax ID", input("taxId", "text", values.taxId ?? "", 'autocomplete="off" maxlength="24"', errors.taxId), errors.taxId, "Required outside the UK")}
    </div>
    ${field("password", "Password", input("password", "password", "", 'autocomplete="new-password" required minlength="12" maxlength="128"', errors.password), errors.password, "At least 12 characters. A passphrase works well.")}
    <button class="btn filled lg" type="submit">Create account</button>
  </form>
  <p class="alt">Already have an account? <a href="/signin">Sign in</a></p>
</div></div>`,
    { signedIn: false, testnet: o.testnet },
  );
}

export function signInPage(o: PageOpts, email = "", error?: string, notice?: string): string {
  return shell(
    "Sign in",
    `<div class="auth"><div class="card">
  <h1>Sign in</h1>
  <p class="muted">Manage your balance, API keys and usage.</p>
  ${notice ? `<div class="alert ok" role="status">${esc(notice)}</div>` : ""}
  ${error ? `<div class="alert error" role="alert">${esc(error)}</div>` : ""}
  <form method="post" action="/signin">
    ${field("email", "Email", input("email", "email", email, 'autocomplete="username" required maxlength="254"'))}
    ${field("password", "Password", input("password", "password", "", 'autocomplete="current-password" required maxlength="128"'))}
    <button class="btn filled lg" type="submit">Sign in</button>
  </form>
  <p class="alt">New here? <a href="/signup">Create an account</a></p>
  <p class="alt">Forgotten your password? Reset by email isn't available yet; contact us and we'll verify you and reset it.</p>
</div></div>`,
    { signedIn: false, testnet: o.testnet },
  );
}

const gbp = (micros: number) => `£${(micros / 1e6).toFixed(2)}`;
const gbp3 = (micros: number) => `£${(micros / 1e6).toFixed(3)}`;
const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

export interface AccountView {
  user: CustomerUser;
  account: CreditAccount;
  keys: ApiKeyInfo[];
  usage: UsageRow[];
  notice?: { kind: "ok" | "info" | "error"; text: string };
}

export function accountPage(o: PageOpts, v: AccountView): string {
  const { account: a } = v;
  const keys = v.keys.length
    ? `<div class="scroll"><table><thead><tr><th scope="col">Key</th><th scope="col">Created</th><th scope="col">Status</th><th scope="col"><span class="skip">Actions</span></th></tr></thead><tbody>${v.keys
        .map(
          (k) =>
            `<tr><td><code>${esc(k.prefix)}…</code></td><td class="num">${when(k.createdAt)}</td><td>${k.revokedAt ? `<span class="status-revoked">Revoked</span>` : `<span class="chip ok">Active</span>`}</td><td>${
              k.revokedAt ? "" : `<form class="inline" method="post" action="/account/keys/${esc(k.id)}/revoke"><button class="btn text danger" type="submit">Revoke</button></form>`
            }</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="empty">No keys yet.</p>`;
  const usage = v.usage.length
    ? `<div class="scroll"><table><thead><tr><th scope="col">Endpoint</th><th scope="col" class="num">Amount</th><th scope="col" class="num">When</th></tr></thead><tbody>${v.usage
        .map((u) => `<tr><td><code>${esc(u.endpoint)}</code></td><td class="num">${u.micros < 0 ? "+" : ""}${gbp3(Math.abs(u.micros))}</td><td class="num">${when(u.at)}</td></tr>`)
        .join("")}</tbody></table></div>`
    : `<p class="empty">No usage yet. Calls made with your API key appear here.</p>`;
  return shell(
    "Your account",
    `<div class="dash">
  <span class="overline">Account</span>
  <h1>${esc(a.company)}</h1>
  <p class="muted">Signed in as ${esc(v.user.email)}</p>
  ${v.notice ? `<div class="alert ${v.notice.kind}" role="status">${esc(v.notice.text)}</div>` : ""}
  ${a.status !== "active" ? `<div class="alert error" role="alert">This account is suspended. API calls are refused; contact us.</div>` : ""}
  <div class="grid2">
    <div class="stack">
      <section class="card" aria-labelledby="bal-h">
        <h2 id="bal-h">Credit balance</h2>
        <div class="balance">${gbp(a.balanceMicros)}</div>
        <p class="muted">Spent per call at the prices on the <a href="/#pricing">pricing page</a>. VAT is charged when you top up.</p>
        <div class="packs">${Object.values(CREDIT_PACKS)
          .map((p) => `<form method="post" action="/account/topup"><input type="hidden" name="pack" value="${esc(p.id)}"><button class="btn tonal" type="submit">Add ${esc(gbp(p.netGbpMicros))}</button></form>`)
          .join("")}</div>
      </section>
      <section class="card" aria-labelledby="keys-h">
        <div class="head"><h2 id="keys-h">API keys</h2><form class="inline" method="post" action="/account/keys"><button class="btn outlined" type="submit">Create key</button></form></div>
        <p class="muted">Send a key as <code>Authorization: Bearer mk_…</code>. We store only a hash, so a key is shown once, when it is created.</p>
        ${keys}
      </section>
    </div>
    <div class="stack">
      <section class="card" aria-labelledby="use-h"><h2 id="use-h">Recent usage</h2>${usage}</section>
      <section class="card" aria-labelledby="det-h"><h2 id="det-h">Details</h2>
        <dl class="kv"><dt>Company</dt><dd>${esc(a.company)}</dd><dt>Billing email</dt><dd>${esc(a.email)}</dd><dt>Country</dt><dd>${esc(a.country)}</dd><dt>VAT / tax ID</dt><dd>${a.taxId ? esc(a.taxId) : "—"}</dd><dt>Account ID</dt><dd><code>${esc(a.id)}</code></dd></dl>
      </section>
    </div>
  </div>
</div>`,
    { signedIn: true, testnet: o.testnet },
  );
}

/** Shown once, straight after sign-up or key creation. The page is no-store, so Back can't re-show it from cache. */
export function newKeyPage(o: PageOpts, key: string, first: boolean): string {
  return shell(
    "Your API key",
    `<div class="auth"><div class="card">
  <span class="overline">${first ? "Account created" : "New API key"}</span>
  <h1>Save your API key</h1>
  <p class="muted">This is the only time it is shown. Store it in your secrets manager; if you lose it, create a new one and revoke this one.</p>
  <p class="key">${esc(key)}</p>
  <pre tabindex="0"><code>curl -H "Authorization: Bearer ${esc(key)}" \\
  ${esc(o.base)}/v1/credits/balance</code></pre>
  <a class="btn filled lg" href="/account">I've saved it, continue</a>
</div></div>`,
    { signedIn: true, testnet: o.testnet },
  );
}

export function errorPage(o: PageOpts, status: number, title: string, text: string, signedIn = false): string {
  return shell(title, `<div class="auth"><div class="card"><span class="overline">Error ${status}</span><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p><a class="btn filled lg" href="/">Back to home</a></div></div>`, {
    signedIn,
    testnet: o.testnet,
  });
}
