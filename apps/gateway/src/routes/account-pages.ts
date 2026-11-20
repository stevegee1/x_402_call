import { createHash } from "node:crypto";
import { CREDIT_PACKS } from "@mx/shared";
import type { ApiKeyInfo, CreditAccount, CustomerUser, UsageRow } from "../store/types";
import type { ProductView } from "./catalog-model";
import { BRAND_MARK, esc, FAVICON, THEME_CSS } from "./site-theme";

/**
 * Server-rendered customer pages: sign up, sign in, account. Auth pages (/signup, /signin) are
 * plain HTML forms with zero script so their CSP forbids scripts outright. The signed-in account
 * dashboard (/account) and new-key page include one hash-pinned vanilla script for the interactive
 * API Explorer box. Styled with the site's Material 3 theme.
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
.console-card{margin-top:24px}
.console-preset{width:100%;margin:12px 0}
.console-bar{display:grid;grid-template-columns:104px minmax(0,1fr) auto;gap:10px;align-items:center;margin:0 0 12px}
.console-auth{display:grid;grid-template-columns:132px minmax(0,1fr) auto auto;gap:10px;align-items:center;background:var(--surface-c);border:1px solid var(--outline-v);border-radius:12px;padding:10px 12px;margin-bottom:12px}
.console-select,.console-input,.console-textarea{width:100%;border-radius:8px;border:1px solid var(--outline-v);background:var(--surface);color:var(--on-surface);font:400 14px/1.4 var(--font)}
.console-select,.console-input{height:40px;padding:0 12px}
.console-input,.console-textarea{font-family:var(--mono);font-size:13px}
.console-textarea{padding:10px 12px;min-height:92px;resize:vertical}
.console-body{margin-bottom:12px}
.console-body label{display:block;font-size:13px;font-weight:500;color:var(--on-surface-v);margin-bottom:6px}
.console-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:16px 0 8px;font-size:13px}
.console-meta .spacer{margin-left:auto}
.status-pill{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;font:600 12px/1.3 var(--mono)}
.status-2xx{background:var(--tertiary-container);color:var(--on-tertiary-container)}
.status-4xx{background:var(--warn-container);color:var(--on-warn-container)}
.status-5xx{background:var(--error-container);color:var(--on-error-container)}
.status-idle{background:var(--surface-ch);color:var(--on-surface-v)}
.res-time,.res-info{font:400 12px/1.3 var(--mono);color:var(--on-surface-v)}
.curl-box{margin:12px 0 0;background:var(--surface-c);border:1px solid var(--outline-v);border-radius:12px;padding:10px 14px}
.curl-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font:500 11px/1 var(--font);text-transform:uppercase;letter-spacing:.6px;color:var(--on-surface-v)}
.curl-pre{margin:0;padding:0;border:0;background:transparent;border-radius:0;font:400 12px/1.5 var(--mono);overflow-x:auto}
.console-out{margin:0;max-height:420px;overflow:auto;background:var(--surface);border:1px solid var(--outline-v);border-radius:12px;padding:14px 16px;font:400 13px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word}
.console-hint{font-size:13px;color:var(--on-surface-v);margin:6px 0 0}
.key-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:8px}
@media (max-width:860px){.grid2{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.console-bar,.console-auth{grid-template-columns:minmax(0,1fr)}.key-actions{grid-template-columns:minmax(0,1fr)}}
@media (max-width:560px){.row2,.packs{grid-template-columns:minmax(0,1fr)}.auth .card{padding:24px}}
`;

/**
 * Hash-pinned vanilla client script for /account (API Explorer) and newKeyPage (session key handoff).
 * Never uses innerHTML on response data; enforces same-origin relative paths so keys cannot leak.
 */
export const ACCOUNT_SCRIPT = `(function(){
var KEY_STORAGE="mx_api_key";
var keyEl=document.querySelector(".key");
var copyKeyBtn=document.getElementById("copy-key-btn");
if(keyEl&&keyEl.textContent){
  var rawKey=keyEl.textContent.trim();
  try{sessionStorage.setItem(KEY_STORAGE,rawKey);}catch(_){}
  if(copyKeyBtn){
    copyKeyBtn.addEventListener("click",function(){
      if(!navigator.clipboard)return;
      navigator.clipboard.writeText(rawKey).then(function(){
        copyKeyBtn.textContent="Copied";
        setTimeout(function(){copyKeyBtn.textContent="Copy key";},2000);
      }).catch(function(){});
    });
  }
}

document.querySelectorAll('form[action="/signout"]').forEach(function(f){
  f.addEventListener("submit",function(){
    try{sessionStorage.removeItem(KEY_STORAGE);}catch(_){}
  });
});

document.querySelectorAll("form[data-key-prefix]").forEach(function(f){
  f.addEventListener("submit",function(){
    var prefix=f.getAttribute("data-key-prefix")||"";
    if(!prefix)return;
    try{
      var stored=sessionStorage.getItem(KEY_STORAGE)||"";
      if(stored.startsWith(prefix))sessionStorage.removeItem(KEY_STORAGE);
    }catch(_){}
  });
});

var root=document.getElementById("api-console");
if(!root)return;

var presetEl=document.getElementById("preset-select");
var methodEl=document.getElementById("req-method");
var urlEl=document.getElementById("req-url");
var schemeEl=document.getElementById("auth-scheme");
var keyIn=document.getElementById("api-key-input");
var toggleKeyBtn=document.getElementById("toggle-key-btn");
var clearKeyBtn=document.getElementById("clear-key-btn");
var bodyWrap=document.getElementById("body-section");
var bodyIn=document.getElementById("req-body");
var descEl=document.getElementById("preset-desc");
var sendBtn=document.getElementById("send-btn");
var curlEl=document.getElementById("curl-snippet");
var copyCurlBtn=document.getElementById("copy-curl-btn");
var statusEl=document.getElementById("res-status");
var timeEl=document.getElementById("res-time");
var infoEl=document.getElementById("res-info");
var outEl=document.getElementById("res-body");
var copyResBtn=document.getElementById("copy-res-btn");
var balEl=document.getElementById("acct-balance");

var creds={Bearer:"",Session:""};
var activeScheme=schemeEl?schemeEl.value:"Bearer";
try{
  var saved=sessionStorage.getItem(KEY_STORAGE);
  if(saved)creds.Bearer=saved;
}catch(_){}
if(keyIn&&activeScheme==="Bearer"&&creds.Bearer)keyIn.value=creds.Bearer;

function shQuote(s){
  return "'"+String(s).replace(/'/g,"'\\\\''")+"'";
}

function resolveSafePath(raw){
  var p=(raw||"").trim();
  if(!p||!p.startsWith("/")||p.startsWith("//")||p.startsWith("/\\\\"))return null;
  try{
    var u=new URL(p,window.location.origin);
    if(u.origin!==window.location.origin||!u.pathname.startsWith("/")||u.pathname.startsWith("//")||u.pathname.startsWith("/\\\\"))return null;
    return u.pathname+u.search;
  }catch(_){return null;}
}

function parseNum(v){
  if(v===null||v.trim()==="")return null;
  var n=Number(v);
  return Number.isFinite(n)?n:null;
}

function syncKeyVisibility(){
  if(!keyIn||!schemeEl)return;
  var none=schemeEl.value==="None";
  keyIn.disabled=none;
  keyIn.placeholder=schemeEl.value==="Session"?"Paste x402 session token":"Paste API key (mk_...)";
}

function cleanAuth(){
  if(!keyIn||!schemeEl)return{scheme:"None",token:""};
  var v=keyIn.value.trim();
  var switched=false;
  if(/^Bearer\\s+/i.test(v)){
    v=v.replace(/^Bearer\\s+/i,"").trim();
    keyIn.value=v;
    if(schemeEl.value!=="Bearer"){schemeEl.value="Bearer";activeScheme="Bearer";switched=true;}
  }else if(/^Session\\s+/i.test(v)){
    v=v.replace(/^Session\\s+/i,"").trim();
    keyIn.value=v;
    if(schemeEl.value!=="Session"){schemeEl.value="Session";activeScheme="Session";switched=true;}
  }
  if(activeScheme==="Bearer"||activeScheme==="Session")creds[activeScheme]=v;
  if(switched)syncKeyVisibility();
  return{scheme:schemeEl.value,token:schemeEl.value==="None"?"":v};
}

function toggleBody(){
  if(!bodyWrap||!methodEl)return;
  bodyWrap.hidden=methodEl.value!=="POST";
}

function markCustom(){
  if(presetEl&&presetEl.value!=="custom"){
    presetEl.value="custom";
    if(descEl)descEl.textContent="Custom gateway request.";
  }
}

function updateCurl(){
  if(!curlEl)return;
  var method=(methodEl?methodEl.value:"GET").toUpperCase();
  var safePath=resolveSafePath(urlEl?urlEl.value:"");
  if(!safePath){
    curlEl.textContent="# Enter a relative path starting with a single / (for example /v1/credits/balance)";
    return;
  }
  var auth=cleanAuth();
  var fullUrl=window.location.origin+safePath;
  var parts=["curl -i"+(method==="GET"?"":" -X "+method)];
  if(auth.scheme!=="None"&&auth.token){
    parts.push("-H "+shQuote("Authorization: "+auth.scheme+" "+auth.token));
  }
  if(method==="POST"&&bodyIn&&bodyIn.value.trim()){
    var compact=bodyIn.value.trim();
    try{compact=JSON.stringify(JSON.parse(compact));}catch(_){}
    parts.push("-H 'Content-Type: application/json'");
    parts.push("-d "+shQuote(compact));
  }
  parts.push(shQuote(fullUrl));
  curlEl.textContent=parts.join(" \\\\\\n  ");
}

function applyPreset(){
  if(!presetEl)return;
  var opt=presetEl.options[presetEl.selectedIndex];
  if(!opt)return;
  if(opt.value==="custom"){
    if(descEl)descEl.textContent="Enter any relative gateway path (for example /v1/grid/england/intensity).";
    updateCurl();
    return;
  }
  var m=opt.getAttribute("data-method")||"GET";
  var p=opt.getAttribute("data-path")||"/v1/credits/balance";
  var b=opt.getAttribute("data-body")||"";
  var d=opt.getAttribute("data-desc")||"";
  if(methodEl)methodEl.value=m;
  if(urlEl)urlEl.value=p;
  if(bodyIn)bodyIn.value=b;
  if(descEl)descEl.textContent=d;
  toggleBody();
  updateCurl();
}

if(toggleKeyBtn&&keyIn){
  toggleKeyBtn.addEventListener("click",function(){
    var show=keyIn.type==="password";
    keyIn.type=show?"text":"password";
    toggleKeyBtn.textContent=show?"Hide":"Show";
  });
}

if(clearKeyBtn&&keyIn){
  clearKeyBtn.addEventListener("click",function(){
    keyIn.value="";
    if(activeScheme==="Bearer"){
      creds.Bearer="";
      try{sessionStorage.removeItem(KEY_STORAGE);}catch(_){}
    }else if(activeScheme==="Session"){
      creds.Session="";
    }
    updateCurl();
  });
}

if(keyIn){
  keyIn.addEventListener("input",function(){
    var auth=cleanAuth();
    if(auth.scheme==="Bearer"){
      try{
        if(auth.token)sessionStorage.setItem(KEY_STORAGE,auth.token);
        else sessionStorage.removeItem(KEY_STORAGE);
      }catch(_){}
    }
    updateCurl();
  });
}

if(schemeEl){
  schemeEl.addEventListener("change",function(){
    if(keyIn&&(activeScheme==="Bearer"||activeScheme==="Session")){
      creds[activeScheme]=keyIn.value.trim();
    }
    activeScheme=schemeEl.value;
    if(keyIn){
      keyIn.value=activeScheme==="None"?"":(creds[activeScheme]||"");
    }
    syncKeyVisibility();
    updateCurl();
  });
}

if(presetEl)presetEl.addEventListener("change",applyPreset);
if(methodEl)methodEl.addEventListener("change",function(){markCustom();toggleBody();updateCurl();});
if(urlEl)urlEl.addEventListener("input",function(){markCustom();updateCurl();});
if(bodyIn)bodyIn.addEventListener("input",updateCurl);

if(copyCurlBtn&&curlEl){
  copyCurlBtn.addEventListener("click",function(){
    if(!navigator.clipboard)return;
    navigator.clipboard.writeText(curlEl.textContent||"").then(function(){
      copyCurlBtn.textContent="Copied";
      setTimeout(function(){copyCurlBtn.textContent="Copy cURL";},2000);
    }).catch(function(){});
  });
}

if(copyResBtn&&outEl){
  copyResBtn.addEventListener("click",function(){
    if(!navigator.clipboard)return;
    navigator.clipboard.writeText(outEl.textContent||"").then(function(){
      copyResBtn.textContent="Copied";
      setTimeout(function(){copyResBtn.textContent="Copy response";},2000);
    }).catch(function(){});
  });
}

async function sendRequest(){
  if(!urlEl||!sendBtn||sendBtn.disabled)return;
  var safePath=resolveSafePath(urlEl.value);
  if(!safePath){
    if(statusEl){statusEl.textContent="Invalid path";statusEl.className="status-pill status-4xx";}
    if(timeEl)timeEl.textContent="";
    if(infoEl)infoEl.textContent="";
    if(copyResBtn)copyResBtn.disabled=true;
    if(outEl)outEl.textContent="Path must be a same-origin relative path starting with a single / (for example /v1/credits/balance).";
    return;
  }
  var method=(methodEl?methodEl.value:"GET").toUpperCase();
  var auth=cleanAuth();
  var bodyText=bodyIn?bodyIn.value.trim():"";
  if(method==="POST"&&bodyText){
    try{JSON.parse(bodyText);}catch(e){
      if(statusEl){statusEl.textContent="Invalid JSON";statusEl.className="status-pill status-4xx";}
      if(timeEl)timeEl.textContent="";
      if(infoEl)infoEl.textContent="";
      if(copyResBtn)copyResBtn.disabled=true;
      if(outEl)outEl.textContent="Request body is not valid JSON: "+(e&&e.message?e.message:String(e));
      return;
    }
  }

  sendBtn.disabled=true;
  sendBtn.textContent="Sending...";
  if(statusEl){statusEl.textContent="Sending...";statusEl.className="status-pill status-idle";}
  if(timeEl)timeEl.textContent="";
  if(infoEl)infoEl.textContent="";
  if(copyResBtn)copyResBtn.disabled=true;

  var t0=performance.now();
  try{
    var headers={accept:"application/json"};
    if(auth.scheme!=="None"&&auth.token){
      headers.authorization=auth.scheme+" "+auth.token;
    }
    if(method==="POST")headers["content-type"]="application/json";

    var res=await fetch(window.location.origin+safePath,{
      method:method,
      credentials:"omit",
      headers:headers,
      body:method==="POST"&&bodyText?bodyText:undefined
    });
    var dt=Math.round(performance.now()-t0);
    var text=await res.text();
    var pretty=text;
    try{pretty=JSON.stringify(JSON.parse(text),null,2);}catch(_){}

    if(statusEl){
      statusEl.textContent=res.status+(res.statusText?" "+res.statusText:"");
      statusEl.className="status-pill "+(res.ok?"status-2xx":res.status>=500?"status-5xx":"status-4xx");
    }
    if(timeEl)timeEl.textContent=dt+" ms";

    var meta=[];
    var chargedGbp=parseNum(res.headers.get("x-credits-charged-gbp-micros"));
    var balGbp=parseNum(res.headers.get("x-credits-balance-gbp-micros"));
    var chargedUsdc=parseNum(res.headers.get("x-session-charged-usdc-atomic"));
    var remUsdc=parseNum(res.headers.get("x-session-remaining-usdc-atomic"));
    var reqId=res.headers.get("x-request-id");
    if(chargedGbp!==null){
      meta.push("Charged \\u00a3"+(chargedGbp/1e6).toFixed(3));
    }
    if(balGbp!==null&&balEl){
      balEl.textContent="\\u00a3"+(balGbp/1e6).toFixed(2);
    }
    if(chargedUsdc!==null){
      meta.push("Charged $"+(chargedUsdc/1e6).toFixed(4)+" USDC");
    }
    if(remUsdc!==null){
      meta.push("Session left $"+(remUsdc/1e6).toFixed(4));
    }
    if(reqId)meta.push("Req "+reqId.slice(0,8));
    if(infoEl)infoEl.textContent=meta.join(" \\u00b7 ");

    if(outEl)outEl.textContent=pretty||"(Empty response body)";
    if(copyResBtn)copyResBtn.disabled=false;
  }catch(err){
    var dt2=Math.round(performance.now()-t0);
    if(statusEl){statusEl.textContent="Network error";statusEl.className="status-pill status-5xx";}
    if(timeEl)timeEl.textContent=dt2+" ms";
    if(outEl)outEl.textContent="Request failed: "+(err&&err.message?err.message:String(err));
  }finally{
    sendBtn.disabled=false;
    sendBtn.textContent="Send request";
  }
}

if(sendBtn)sendBtn.addEventListener("click",sendRequest);
[urlEl,keyIn,bodyIn].forEach(function(el){
  if(!el)return;
  el.addEventListener("keydown",function(e){
    if((e.metaKey||e.ctrlKey)&&e.key==="Enter")sendRequest();
  });
});

syncKeyVisibility();
applyPreset();
})();`;

const CSS = THEME_CSS + ACCOUNT_CSS;
const sha = (s: string) => `sha256-${createHash("sha256").update(s).digest("base64")}`;

/** Script-free CSP for /signup and /signin. */
export const AUTH_CSP = [
  "default-src 'none'",
  `style-src '${sha(CSS)}'`,
  "img-src data:",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const AUTH_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": AUTH_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

/** Hash-pinned CSP for /account and newKeyPage: allows only the exact API Explorer script and same-origin fetches. */
export const ACCOUNT_CSP = [
  "default-src 'none'",
  `style-src '${sha(CSS)}'`,
  `script-src '${sha(ACCOUNT_SCRIPT)}'`,
  "connect-src 'self'",
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

function shell(title: string, body: string, opts: { signedIn: boolean; testnet: string | null; script?: string }): string {
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
${opts.script ? `<script>${opts.script}</script>\n` : ""}</body>
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

export interface ApiPreset {
  id: string;
  group: string;
  label: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
  description: string;
}

export function buildApiPresets(products: ProductView[] = []): ApiPreset[] {
  const presets: ApiPreset[] = [
    {
      id: "credits.balance",
      group: "Account & Credits",
      label: "GET /v1/credits/balance (Free)",
      method: "GET",
      path: "/v1/credits/balance",
      description: "Check your GBP credit balance, company name, and account status.",
    },
    {
      id: "credits.usage",
      group: "Account & Credits",
      label: "GET /v1/credits/usage?limit=10 (Free)",
      method: "GET",
      path: "/v1/credits/usage?limit=10",
      description: "List your recent API calls and credit deductions.",
    },
    {
      id: "policy.events",
      group: "Account & Credits",
      label: "POST /v1/policy/events (Free)",
      method: "POST",
      path: "/v1/policy/events",
      body: JSON.stringify({ events: [{ action: "demo_check", timestamp: new Date().toISOString() }] }, null, 2),
      description: "Ingest policy SDK events authenticated with your API key.",
    },
  ];
  for (const p of products) {
    if (p.kind !== "data") continue;
    for (const e of p.endpoints) {
      if (e.kind === "stream") continue;
      const price = e.pay.credits ? `£${e.pay.credits.price_gbp.toFixed(3)}` : e.kind === "free" ? "Free" : e.pay.session ? `$${e.pay.session.price_usdc} session` : "Paid";
      presets.push({
        id: e.id,
        group: p.name,
        label: `${e.method} ${e.example} (${price})`,
        method: e.method,
        path: e.example,
        description: e.summary,
      });
    }
  }
  presets.push(
    {
      id: "meta.products",
      group: "Discovery",
      label: "GET /v1/products (Free)",
      method: "GET",
      path: "/v1/products",
      description: "Machine-readable catalog of all products, live coverage, and per-call prices.",
    },
    {
      id: "meta.openapi",
      group: "Discovery",
      label: "GET /openapi.json (Free)",
      method: "GET",
      path: "/openapi.json",
      description: "Full OpenAPI 3.1 specification for the gateway.",
    },
  );
  return presets;
}

function renderApiConsole(presets: ApiPreset[]): string {
  const groups = new Map<string, ApiPreset[]>();
  for (const p of presets) {
    const list = groups.get(p.group) ?? [];
    list.push(p);
    groups.set(p.group, list);
  }
  const options = [...groups.entries()]
    .map(
      ([group, items]) =>
        `<optgroup label="${esc(group)}">${items
          .map(
            (p) =>
              `<option value="${esc(p.id)}" data-method="${esc(p.method)}" data-path="${esc(p.path)}" data-body="${esc(p.body ?? "")}" data-desc="${esc(p.description)}">${esc(p.label)}</option>`,
          )
          .join("")}</optgroup>`,
    )
    .join("");
  return `<section class="card console-card" id="api-console" aria-labelledby="console-h">
  <div class="head">
    <div>
      <h2 id="console-h">API Explorer</h2>
      <p class="muted">Run live requests against any endpoint with your API key or x402 session token. Paid calls deduct from your credit balance (or session) and update your balance live.</p>
    </div>
    <span class="chip ok">Collection</span>
  </div>
  <select id="preset-select" class="console-select console-preset" aria-label="Select API endpoint preset">${options}<optgroup label="Custom"><option value="custom">Custom endpoint...</option></optgroup></select>
  <p class="console-hint" id="preset-desc"></p>
  <div class="console-bar">
    <select id="req-method" class="console-select" aria-label="HTTP method"><option value="GET">GET</option><option value="POST">POST</option></select>
    <input id="req-url" class="console-input" type="text" value="/v1/credits/balance" placeholder="/v1/..." aria-label="Endpoint path" spellcheck="false">
    <button id="send-btn" class="btn filled" type="button">Send request</button>
  </div>
  <div class="console-auth">
    <select id="auth-scheme" class="console-select" aria-label="Authorization scheme"><option value="Bearer">Bearer (Credits)</option><option value="Session">Session (Wallet)</option><option value="None">No auth (402)</option></select>
    <input id="api-key-input" class="console-input" type="password" placeholder="Paste API key (mk_...)" autocomplete="off" aria-label="API key or session token">
    <button id="toggle-key-btn" class="btn text" type="button">Show</button>
    <button id="clear-key-btn" class="btn text" type="button">Clear</button>
  </div>
  <div id="body-section" class="console-body" hidden>
    <label for="req-body">JSON request body</label>
    <textarea id="req-body" class="console-textarea" spellcheck="false" placeholder='{"events":[]}'></textarea>
  </div>
  <div class="curl-box">
    <div class="curl-head"><span>cURL command</span><button id="copy-curl-btn" class="btn text" type="button">Copy cURL</button></div>
    <pre class="curl-pre"><code id="curl-snippet"></code></pre>
  </div>
  <div class="console-meta">
    <span id="res-status" class="status-pill status-idle">Ready</span>
    <span id="res-time" class="res-time"></span>
    <span id="res-info" class="res-info"></span>
    <span class="spacer"></span>
    <button id="copy-res-btn" class="btn text" type="button" disabled>Copy response</button>
  </div>
  <pre class="console-out" tabindex="0"><code id="res-body">Choose an endpoint, paste your API key (or create one above), and click "Send request".</code></pre>
</section>`;
}

export interface AccountView {
  user: CustomerUser;
  account: CreditAccount;
  keys: ApiKeyInfo[];
  usage: UsageRow[];
  products?: ProductView[];
  notice?: { kind: "ok" | "info" | "error"; text: string };
}

export function accountPage(o: PageOpts, v: AccountView): string {
  const { account: a } = v;
  const keys = v.keys.length
    ? `<div class="scroll"><table><thead><tr><th scope="col">Key</th><th scope="col">Created</th><th scope="col">Status</th><th scope="col"><span class="skip">Actions</span></th></tr></thead><tbody>${v.keys
        .map(
          (k) =>
            `<tr><td><code>${esc(k.prefix)}…</code></td><td class="num">${when(k.createdAt)}</td><td>${k.revokedAt ? `<span class="status-revoked">Revoked</span>` : `<span class="chip ok">Active</span>`}</td><td>${
              k.revokedAt ? "" : `<form class="inline" method="post" action="/account/keys/${esc(k.id)}/revoke" data-key-prefix="${esc(k.prefix)}"><button class="btn text danger" type="submit">Revoke</button></form>`
            }</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="empty">No keys yet.</p>`;
  const usage = v.usage.length
    ? `<div class="scroll"><table><thead><tr><th scope="col">Endpoint</th><th scope="col" class="num">Amount</th><th scope="col" class="num">When</th></tr></thead><tbody>${v.usage
        .map((u) => `<tr><td><code>${esc(u.endpoint)}</code></td><td class="num">${u.micros < 0 ? "+" : ""}${gbp3(Math.abs(u.micros))}</td><td class="num">${when(u.at)}</td></tr>`)
        .join("")}</tbody></table></div>`
    : `<p class="empty">No usage yet. Calls made with your API key appear here.</p>`;
  const consoleHtml = renderApiConsole(buildApiPresets(v.products));
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
        <div class="balance" id="acct-balance">${gbp(a.balanceMicros)}</div>
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
  ${consoleHtml}
</div>`,
    { signedIn: true, testnet: o.testnet, script: ACCOUNT_SCRIPT },
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
  <div class="key-actions">
    <button class="btn tonal" type="button" id="copy-key-btn">Copy key</button>
    <a class="btn filled" href="/account#api-console">Test in API Explorer</a>
  </div>
  <p class="alt"><a href="/account">I've saved it, continue to dashboard</a></p>
</div></div>`,
    { signedIn: true, testnet: o.testnet, script: ACCOUNT_SCRIPT },
  );
}

export function errorPage(o: PageOpts, status: number, title: string, text: string, signedIn = false): string {
  return shell(title, `<div class="auth"><div class="card"><span class="overline">Error ${status}</span><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p><a class="btn filled lg" href="/">Back to home</a></div></div>`, {
    signedIn,
    testnet: o.testnet,
  });
}
