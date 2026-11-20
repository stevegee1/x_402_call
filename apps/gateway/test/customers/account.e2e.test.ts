import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_SCRIPT } from "../../src/routes/account-pages";
import { BASE_URL, createTestEnv, type TestEnv } from "../helpers";

const ORIGIN = new URL(BASE_URL).origin;
const PASSWORD = "a long enough passphrase";

/** A browser stand-in: same-origin form posts, a cookie jar, no redirect following. */
function browser(env: TestEnv, origin = ORIGIN) {
  let cookie = "";
  const send = async (path: string, init: RequestInit & { form?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    let body = init.body;
    if (init.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      if (origin) headers.set("origin", origin);
      body = new URLSearchParams(init.form).toString();
    }
    const res = await env.fetch(`${BASE_URL}${path}`, { ...init, headers, body, method: init.form ? "POST" : (init.method ?? "GET"), redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set) {
      const [pair] = set.split(";");
      cookie = pair!.endsWith("=") ? "" : pair!;
    }
    return res;
  };
  return {
    send,
    get: (path: string) => send(path),
    post: (path: string, form: Record<string, string> = {}) => send(path, { form }),
    get cookie() {
      return cookie;
    },
    set cookie(v: string) {
      cookie = v;
    },
  };
}

const signUpForm = (over: Record<string, string> = {}) => ({ company: "Acme Trading Ltd", email: `desk-${Math.random().toString(36).slice(2)}@acme.test`, country: "GB", taxId: "", password: PASSWORD, ...over });
const keyOf = (html: string) => /<p class="key">(mk_test_[A-Za-z0-9_-]{32})<\/p>/.exec(html)?.[1];

describe("customer sign-up, sign-in and account pages", () => {
  afterEach(() => vi.useRealTimers());

  it("pages are script-free, uncached, unindexed and unframeable", async () => {
    const env = await createTestEnv();
    for (const path of ["/signup", "/signin"]) {
      const res = await env.fetch(`${BASE_URL}${path}`);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain("script-src");
      expect(csp).toContain("form-action 'self' https://checkout.stripe.com");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      const html = await res.text();
      expect(html).not.toMatch(/<script/);
      expect(html).not.toMatch(/\sstyle="/);
    }
  });

  it("sign up: creates the account, shows the API key once, signs you in, and the key works", async () => {
    const env = await createTestEnv();
    const b = browser(env);
    const form = signUpForm();
    const res = await b.post("/signup", form);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^wb_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    const key = keyOf(await res.text());
    expect(key).toBeDefined();
    expect(res.headers.get("cache-control")).toBe("no-store");

    const bal = await env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${key}` } });
    expect(await bal.json()).toMatchObject({ company: "Acme Trading Ltd", balance_gbp: 0 });

    const account = await b.get("/account");
    expect(account.status).toBe(200);
    const html = await account.text();
    expect(html).toContain("Acme Trading Ltd");
    expect(html).toContain(`Signed in as ${form.email}`);
    expect(html).toContain("£0.00");
    expect(html).toContain(`${key!.slice(0, 12)}…`);
    expect(html).not.toContain(key!); // only the prefix after the first showing
  });

  it("validation errors re-render the form with what was typed, escaped, and the field marked", async () => {
    const env = await createTestEnv();
    const b = browser(env);
    const cases: Array<[Record<string, string>, string, number]> = [
      [{ password: "short" }, "Use at least 12 characters.", 400],
      [{ company: "" }, "Enter your company name.", 400],
      [{ email: "not-an-email" }, "Enter a valid email address.", 400],
      [{ country: "DE", taxId: "" }, "Enter a valid VAT or tax ID.", 400],
    ];
    for (const [over, message, status] of cases) {
      const res = await b.post("/signup", signUpForm(over));
      expect(res.status).toBe(status);
      const html = await res.text();
      expect(html).toContain(message);
      expect(html).toContain('aria-invalid="true"');
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const xss = await (await b.post("/signup", signUpForm({ company: '"><script>alert(1)</script>', password: "short" }))).text();
    expect(xss).not.toContain("<script>alert(1)");
    expect(xss).toContain("&quot;&gt;&lt;script&gt;");
    expect(xss).not.toContain(PASSWORD); // a password is never echoed back
  });

  it("an email can hold one account, whatever its case", async () => {
    const env = await createTestEnv();
    await browser(env).post("/signup", signUpForm({ email: "desk@acme.test" }));
    const res = await browser(env).post("/signup", signUpForm({ email: "DESK@acme.test" }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("already exists");
  });

  it("refuses cross-site and origin-less form posts before doing anything", async () => {
    const env = await createTestEnv();
    for (const b of [browser(env, "https://evil.example"), browser(env, "")]) {
      const form = signUpForm();
      const res = await b.post("/signup", form);
      expect(res.status).toBe(403);
      expect(await env.store.customerByEmail(form.email)).toBeNull();
    }
    // Same-origin by Fetch Metadata when a browser omits Origin.
    const meta = await env.fetch(`${BASE_URL}/signin`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }, body: "email=a%40b.c&password=x" });
    expect(meta.status).toBe(401);
  });

  it("leaves the API and the Stripe webhook alone (no origin check outside the account pages)", async () => {
    const env = await createTestEnv();
    const hook = await env.fetch(`${BASE_URL}/v1/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "valid" }, body: "{}" });
    expect(hook.status).not.toBe(403);
    const api = await env.fetch(`${BASE_URL}/v1/credits/accounts`, { method: "POST", headers: { "content-type": "application/json", origin: "https://elsewhere.example" }, body: JSON.stringify({ company: "X", email: "x@y.z", country: "GB" }) });
    expect(api.status).toBe(201);
  });

  it("sign in: the same message for a wrong password and an unknown email", async () => {
    const env = await createTestEnv();
    const form = signUpForm();
    await browser(env).post("/signup", form);
    const wrong = await browser(env).post("/signin", { email: form.email, password: "not the password at all" });
    const unknown = await browser(env).post("/signin", { email: "nobody@acme.test", password: "not the password at all" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const msg = (h: string) => /<div class="alert error" role="alert">([^<]+)<\/div>/.exec(h)?.[1];
    expect(msg(await wrong.text())).toBe(msg(await unknown.text()));
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("sign in, then out: the old cookie is dead server-side, not just deleted", async () => {
    const env = await createTestEnv();
    const form = signUpForm();
    await browser(env).post("/signup", form);
    const b = browser(env);
    const res = await b.post("/signin", { email: form.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account");
    const stolen = b.cookie;
    expect((await b.get("/account")).status).toBe(200);
    expect((await b.get("/signin")).headers.get("location")).toBe("/account"); // already signed in

    const out = await b.post("/signout");
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/signin?signed_out=1");
    expect(b.cookie).toBe("");
    const replay = browser(env);
    replay.cookie = stolen;
    expect((await replay.get("/account")).headers.get("location")).toBe("/signin");
  });

  it("locks an account after 10 failures, even against the right password, until the lock passes", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-08T12:00:00Z"), toFake: ["Date"] });
    const env = await createTestEnv({}, { customerPolicy: { sessionTtlMs: 86_400_000, maxFailures: 10, lockMs: 15 * 60_000 } });
    const form = signUpForm();
    await browser(env).post("/signup", form);
    for (let i = 0; i < 10; i++) expect((await browser(env).post("/signin", { email: form.email, password: "wrong guess number " + i })).status).toBe(401);
    const locked = await browser(env).post("/signin", { email: form.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("locked");
    vi.setSystemTime(Date.parse("2026-11-08T12:15:01Z"));
    expect((await browser(env).post("/signin", { email: form.email, password: PASSWORD })).status).toBe(303);
  }, 60_000); // 13 real scrypt hashes: generous for loaded CI runners

  it("the per-IP sign-in limit can't be dodged by forging proxy headers the edge doesn't set", async () => {
    const env = await createTestEnv({ CLIENT_IP_HEADER: "x-real-ip" });
    const attempt = (i: number, headers: Record<string, string>) =>
      browser(env).send("/signin", { headers, form: { email: `nobody-${i}@acme.test`, password: "not the password" } });
    // 20 per 15 minutes from one client, each with a different forged CF-Connecting-IP and X-Forwarded-For.
    for (let i = 0; i < 20; i++) expect((await attempt(i, { "x-real-ip": "203.0.113.7", "cf-connecting-ip": `10.0.0.${i}`, "x-forwarded-for": `10.1.0.${i}` })).status).toBe(401);
    expect((await attempt(20, { "x-real-ip": "203.0.113.7", "cf-connecting-ip": "10.0.0.99", "x-forwarded-for": "10.1.0.99" })).status).toBe(429);
    // A different client (as the edge reports it) has its own budget.
    expect((await attempt(21, { "x-real-ip": "203.0.113.8" })).status).toBe(401);
  }, 60_000); // 22 real scrypt verifications: generous for loaded CI runners

  it("after Stripe Checkout, the buyer lands back on their dashboard with a clear message", async () => {
    const env = await createTestEnv();
    const b = browser(env);
    await b.post("/signup", signUpForm());
    for (const [path, to, text] of [
      ["/v1/credits/checkout/success", "/account?topup=success", "Payment received"],
      ["/v1/credits/checkout/cancelled", "/account?topup=cancelled", "Top-up cancelled"],
    ] as const) {
      const back = await b.get(path);
      expect(back.status).toBe(303);
      expect(back.headers.get("location")).toBe(to);
      expect(await (await b.get(to)).text()).toContain(text);
    }
    // Signed out, the return link still lands somewhere sensible: sign-in.
    expect((await browser(env).get("/account?topup=success")).headers.get("location")).toBe("/signin");
  });

  it("every page's header knows you're signed in, and none is cached for others", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const b = browser(env);
    const page = (who: ReturnType<typeof browser>, path: string) => who.send(path, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
    const anon = browser(env);
    for (const path of ["/", "/catalog", "/docs", "/wallet"]) {
      const res = await page(anon, path);
      expect(res.headers.get("cache-control"), path).toMatch(/^(private, no-cache|no-store)$/);
      expect(res.headers.get("vary"), path).toMatch(/Cookie/);
      const html = await res.text();
      expect(html, path).toContain('href="/signin"');
      expect(html, path).not.toContain("Your account");
    }
    await b.post("/signup", signUpForm({ company: "Signed In Ltd" }));
    for (const path of ["/", "/catalog", "/docs", "/wallet", "/v1/products", "/openapi.json"]) {
      const html = await (await page(b, path)).text();
      expect(html, path).toContain('<a class="btn filled" href="/account" title="Signed In Ltd">Your account</a>');
      expect(html, path).not.toContain('href="/signin">Sign in');
    }
    // A stale or forged cookie is just "signed out", never an error.
    b.cookie = "wb_session=" + "A".repeat(43);
    expect(await (await page(b, "/")).text()).toContain('href="/signin"');
  });

  it("sessions expire", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-08T12:00:00Z"), toFake: ["Date"] });
    const env = await createTestEnv({}, { customerPolicy: { sessionTtlMs: 60_000, maxFailures: 10, lockMs: 60_000 } });
    const b = browser(env);
    await b.post("/signup", signUpForm());
    expect((await b.get("/account")).status).toBe(200);
    vi.setSystemTime(Date.parse("2026-11-08T12:01:00Z"));
    expect((await b.get("/account")).headers.get("location")).toBe("/signin");
  });

  it("account pages need a valid session; a forged cookie is treated as signed out", async () => {
    const env = await createTestEnv();
    expect((await env.fetch(`${BASE_URL}/account`, { redirect: "manual" })).headers.get("location")).toBe("/signin");
    const forged = browser(env);
    forged.cookie = `wb_session=${"A".repeat(43)}`;
    expect((await forged.get("/account")).headers.get("location")).toBe("/signin");
    expect((await forged.post("/account/keys")).headers.get("location")).toBe("/signin");
  });

  it("creates and revokes API keys; a revoked key is refused at once on this replica", async () => {
    const env = await createTestEnv();
    const b = browser(env);
    const first = keyOf(await (await b.post("/signup", signUpForm())).text())!;
    const created = await b.post("/account/keys");
    const second = keyOf(await created.text())!;
    expect(second).not.toBe(first);
    const ok = (k: string) => env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${k}` } }).then((r) => r.status);
    expect(await ok(second)).toBe(200);

    const page = await (await b.get("/account")).text();
    const ids = [...page.matchAll(/action="\/account\/keys\/([0-9a-f-]{36})\/revoke"/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(2);
    const keys = await env.store.listApiKeys((await env.store.customerByEmail(/Signed in as ([^<]+)</.exec(page)![1]!))!.accountId);
    const secondId = keys.find((k) => second.startsWith(k.prefix))!.id;
    const revoked = await b.post(`/account/keys/${secondId}/revoke`);
    expect(revoked.status).toBe(200);
    expect(await revoked.text()).toContain("Key revoked");
    expect(await ok(second)).toBe(401);
    expect(await ok(first)).toBe(200);
    expect((await b.post(`/account/keys/${secondId}/revoke`)).status).toBe(404);
  });

  it("can't revoke another customer's key", async () => {
    const env = await createTestEnv();
    const victim = browser(env);
    const vForm = signUpForm();
    const vKey = keyOf(await (await victim.post("/signup", vForm)).text())!;
    const vKeyId = (await env.store.listApiKeys((await env.store.customerByEmail(vForm.email))!.accountId))[0]!.id;
    const attacker = browser(env);
    await attacker.post("/signup", signUpForm());
    expect((await attacker.post(`/account/keys/${vKeyId}/revoke`)).status).toBe(404);
    expect((await env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${vKey}` } })).status).toBe(200);
  });

  it("top-up goes to card checkout with the account's VAT treatment; an unknown pack is refused", async () => {
    const env = await createTestEnv();
    const b = browser(env);
    const form = signUpForm();
    await b.post("/signup", form);
    const res = await b.post("/account/topup", { pack: "team" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/1");
    expect(env.checkout.created[0]).toMatchObject({ email: form.email, packId: "team", netMicros: 100_000_000, vatMicros: 20_000_000 });
    expect((await b.post("/account/topup", { pack: "gold" })).status).toBe(400);
  });

  it("without card payments, top-up explains the bank-transfer route instead", async () => {
    const env = await createTestEnv();
    (env.deps.credits as unknown as { checkout: undefined }).checkout = undefined;
    const b = browser(env);
    await b.post("/signup", signUpForm());
    const res = await b.post("/account/topup", { pack: "starter" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("bank transfer");
  });

  it("on https the cookie is __Host- prefixed and Secure", async () => {
    const env = await createTestEnv({ PUBLIC_BASE_URL: "https://gw.example" });
    const res = await env.fetch(`${BASE_URL}/signup`, {
      method: "POST",
      headers: { origin: "https://gw.example", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(signUpForm()).toString(),
    });
    expect(res.status).toBe(200);
    const c = res.headers.get("set-cookie")!;
    expect(c).toMatch(/^__Host-wb_session=/);
    expect(c).toMatch(/Secure/);
    expect(c).not.toMatch(/Domain=/i);
  });

  it("the public site links to sign in and sign up", async () => {
    const env = await createTestEnv();
    const html = await (await env.fetch(`${BASE_URL}/`, { headers: { accept: "text/html" } })).text();
    expect(html).toContain('href="/signin"');
    expect(html).toContain('href="/signup"');
  });

  it("account dashboard renders the API Explorer with hash-pinned CSP and live catalog presets", async () => {
    // Client script must parse cleanly as valid JavaScript.
    expect(() => new Function(ACCOUNT_SCRIPT)).not.toThrow();

    const unescapeHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const assertAccountCsp = (res: Response, html: string) => {
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("form-action 'self' https://checkout.stripe.com");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(html).not.toMatch(/\sstyle="/);
      const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html);
      expect(styleMatch).not.toBeNull();
      const expectedStyleHash = `sha256-${createHash("sha256").update(styleMatch![1]!).digest("base64")}`;
      expect(csp).toContain(`style-src '${expectedStyleHash}'`);
      const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
      expect(scriptMatch).not.toBeNull();
      const expectedHash = `sha256-${createHash("sha256").update(scriptMatch![1]!).digest("base64")}`;
      expect(csp).toContain(`script-src '${expectedHash}'`);
    };

    const env = await createTestEnv();
    const b = browser(env);
    const created = await b.post("/signup", signUpForm());
    const newKeyHtml = await created.text();
    const key = keyOf(newKeyHtml)!;
    expect(newKeyHtml).toContain('href="/account#api-console"');
    assertAccountCsp(created, newKeyHtml);

    const extraKeyRes = await b.post("/account/keys");
    assertAccountCsp(extraKeyRes, await extraKeyRes.text());

    const res = await b.get("/account");
    expect(res.status).toBe(200);
    const html = await res.text();
    assertAccountCsp(res, html);
    expect(html).toContain('id="api-console"');
    expect(html).toContain('id="preset-select"');
    expect(html).toContain('id="auth-scheme"');
    expect(html).toContain('id="api-key-input"');
    expect(html).toContain('id="send-btn"');
    expect(html).toContain('id="acct-balance"');
    expect(html).toContain("data-key-prefix=");

    // Every rendered preset must resolve against the live gateway (no 404s, no invalid region/country slugs).
    const presets = [...html.matchAll(/<option value="([^"]+)" data-method="(GET|POST)" data-path="([^"]+)" data-body="([^"]*)"/g)];
    expect(presets.length).toBeGreaterThanOrEqual(5);
    const paths = presets.map((m) => unescapeHtml(m[3]!));
    expect(paths).toContain("/v1/credits/balance");
    expect(paths).toContain("/v1/policy/events");
    expect(paths.some((p) => p.startsWith("/v1/maritime/"))).toBe(true);

    // Execute every preset with the newly created key (at £0 balance: free endpoints 200, paid endpoints 402, never 404).
    for (const [, , method, rawPath, rawBody] of presets) {
      const path = unescapeHtml(rawPath!);
      const body = rawBody ? unescapeHtml(rawBody) : undefined;
      const r = await env.fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        body: method === "POST" ? body : undefined,
      });
      expect(r.status, `${method} ${path} should not 404`).not.toBe(404);
      expect([200, 402]).toContain(r.status);
    }

    // No-auth mode against a paid preset returns 402 Payment Required.
    const maritimePath = paths.find((p) => p.includes("/vessels") && !p.includes("235000000"))!;
    expect((await env.fetch(`${BASE_URL}${maritimePath}`)).status).toBe(402);

    // Credit the account and confirm a paid catalog preset returns 200 with live balance headers.
    const email = /Signed in as ([^<]+)</.exec(html)![1]!;
    const cust = (await env.store.customerByEmail(email))!;
    await env.store.applyTopUp(
      { ref: "test_topup", accountId: cust.accountId, netMicros: 5_000_000, vatMicros: 0 },
      {
        id: "test_topup",
        kind: "credits_topup",
        ref: "test_topup",
        occurredAt: new Date().toISOString(),
        memo: {},
        lines: [
          { account: "asset:bank_transfer", debit: 5_000_000, credit: 0 },
          { account: "liability:customer_credits", debit: 0, credit: 5_000_000 },
        ],
      },
    );
    const paidRes = await env.fetch(`${BASE_URL}${maritimePath}`, { headers: { authorization: `Bearer ${key}` } });
    expect(paidRes.status).toBe(200);
    expect(Number(paidRes.headers.get("x-credits-charged-gbp-micros"))).toBeGreaterThan(0);
    expect(Number(paidRes.headers.get("x-credits-balance-gbp-micros"))).toBeLessThan(5_000_000);
  });

  it("API Explorer client script enforces same-origin paths, credential isolation, shell-safe cURL, and live balance sync", async () => {
    type Listener = (e?: Record<string, unknown>) => unknown;
    const makeEl = <T extends Record<string, unknown> = Record<string, unknown>>(extra: T = {} as T) => {
      const listeners: Record<string, Listener[]> = {};
      const attrs = (extra.attrs as Record<string, string> | undefined) ?? {};
      return {
        value: "",
        textContent: "",
        className: "",
        type: "text",
        disabled: false,
        hidden: false,
        placeholder: "",
        attrs,
        getAttribute: (k: string) => attrs[k] ?? null,
        addEventListener: (ev: string, fn: Listener) => {
          (listeners[ev] ??= []).push(fn);
        },
        emit: async (ev: string, arg?: Record<string, unknown>) => {
          for (const fn of listeners[ev] ?? []) await fn(arg);
        },
        ...extra,
      };
    };

    const storage = new Map<string, string>();
    const sessionStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    };

    const optBalance = makeEl({ value: "credits.balance", attrs: { "data-method": "GET", "data-path": "/v1/credits/balance", "data-body": "", "data-desc": "Balance" } });
    const optPolicy = makeEl({ value: "policy.events", attrs: { "data-method": "POST", "data-path": "/v1/policy/events", "data-body": '{"events":[]}', "data-desc": "Policy" } });
    const optCustom = makeEl({ value: "custom" });
    const presetEl = makeEl({ options: [optBalance, optPolicy, optCustom], selectedIndex: 0, value: "credits.balance" });
    const methodEl = makeEl({ value: "GET" });
    const urlEl = makeEl({ value: "/v1/credits/balance" });
    const schemeEl = makeEl({ value: "Bearer" });
    const keyIn = makeEl({ type: "password", value: "" });
    const bodyWrap = makeEl({ hidden: true });
    const bodyIn = makeEl({ value: "" });
    const descEl = makeEl();
    const sendBtn = makeEl();
    const curlEl = makeEl();
    const statusEl = makeEl();
    const timeEl = makeEl();
    const infoEl = makeEl();
    const outEl = makeEl();
    const copyResBtn = makeEl({ disabled: true });
    const balEl = makeEl({ textContent: "£5.00" });
    const clearKeyBtn = makeEl();
    const signoutForm = makeEl();
    const revokeMatch = makeEl({ attrs: { "data-key-prefix": "mk_test_abcd" } });
    const revokeOther = makeEl({ attrs: { "data-key-prefix": "mk_test_zzzz" } });

    const byId: Record<string, ReturnType<typeof makeEl>> = {
      "api-console": makeEl(),
      "preset-select": presetEl,
      "req-method": methodEl,
      "req-url": urlEl,
      "auth-scheme": schemeEl,
      "api-key-input": keyIn,
      "clear-key-btn": clearKeyBtn,
      "body-section": bodyWrap,
      "req-body": bodyIn,
      "preset-desc": descEl,
      "send-btn": sendBtn,
      "curl-snippet": curlEl,
      "res-status": statusEl,
      "res-time": timeEl,
      "res-info": infoEl,
      "res-body": outEl,
      "copy-res-btn": copyResBtn,
      "acct-balance": balEl,
    };

    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    let nextRes = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "x-credits-charged-gbp-micros": "10000", "x-credits-balance-gbp-micros": "4990000", "x-request-id": "abcdef123456" },
      });

    const document = {
      querySelector: (sel: string) => (sel === ".key" ? { textContent: "mk_test_abcd1234" } : null),
      querySelectorAll: (sel: string) => (sel === 'form[action="/signout"]' ? [signoutForm] : sel === "form[data-key-prefix]" ? [revokeMatch, revokeOther] : []),
      getElementById: (id: string) => byId[id] ?? null,
    };
    let pendingFetch: Promise<void> | null = null;
    const fetchMock = async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      if (pendingFetch) await pendingFetch;
      return nextRes();
    };

    new Function("document", "window", "sessionStorage", "navigator", "performance", "fetch", ACCOUNT_SCRIPT)(
      document,
      { location: { origin: "https://www.airivets.com" } },
      sessionStorage,
      {},
      { now: () => 100 },
      fetchMock,
    );

    // 1. Key saved from .key and pre-filled; cURL uses POSIX single quotes.
    expect(storage.get("mx_api_key")).toBe("mk_test_abcd1234");
    expect(keyIn.value).toBe("mk_test_abcd1234");
    expect(curlEl.textContent).toContain("'Authorization: Bearer mk_test_abcd1234'");

    // 2. Auth scheme switching isolates Bearer and Session credentials.
    schemeEl.value = "Session";
    await schemeEl.emit("change");
    expect(keyIn.value).toBe("");
    keyIn.value = "Session sess_tok'1";
    await keyIn.emit("input");
    expect(keyIn.value).toBe("sess_tok'1");
    expect(curlEl.textContent).toContain("'Authorization: Session sess_tok'\\''1'");
    await clearKeyBtn.emit("click");
    expect(storage.get("mx_api_key")).toBe("mk_test_abcd1234");
    schemeEl.value = "Bearer";
    await schemeEl.emit("change");
    expect(keyIn.value).toBe("mk_test_abcd1234");

    // 3. Valid request uses full same-origin URL with credentials: "omit" and updates balance live.
    await sendBtn.emit("click");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://www.airivets.com/v1/credits/balance");
    expect(fetchCalls[0]!.init.credentials).toBe("omit");
    expect(balEl.textContent).toBe("£4.99");
    expect(infoEl.textContent).toContain("Charged £0.010");

    // 3b. None auth scheme omits Authorization in both fetch and cURL without clobbering stored Bearer key.
    schemeEl.value = "None";
    await schemeEl.emit("change");
    expect(keyIn.disabled).toBe(true);
    expect(curlEl.textContent).not.toContain("Authorization:");
    await sendBtn.emit("click");
    expect(fetchCalls).toHaveLength(2);
    expect((fetchCalls[1]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    schemeEl.value = "Bearer";
    await schemeEl.emit("change");
    expect(keyIn.value).toBe("mk_test_abcd1234");
    expect(storage.get("mx_api_key")).toBe("mk_test_abcd1234");

    // 4. Same-origin path guard blocks external, protocol-relative, backslash, and dot-segment bypass URLs and clears stale meta.
    for (const bad of ["https://evil.com/x", "//evil.com/x", "/\\evil.com/x", "/a/..//evil.com/x", ""]) {
      urlEl.value = bad;
      await sendBtn.emit("click");
      expect(statusEl.textContent).toBe("Invalid path");
      expect(timeEl.textContent).toBe("");
      expect(infoEl.textContent).toBe("");
      expect(copyResBtn.disabled).toBe(true);
    }
    expect(fetchCalls).toHaveLength(2);

    // 5. POST invalid JSON is rejected before fetch and clears stale meta.
    presetEl.selectedIndex = 1;
    await presetEl.emit("change");
    bodyIn.value = "{bad json";
    await sendBtn.emit("click");
    expect(statusEl.textContent).toBe("Invalid JSON");
    expect(fetchCalls).toHaveLength(2);

    // 6. In-flight request lock blocks overlapping requests, and empty balance header does not overwrite balance with £0.00.
    bodyIn.value = '{"events":[]}';
    let release!: () => void;
    pendingFetch = new Promise<void>((resolve) => {
      release = resolve;
    });
    nextRes = () => new Response('{"accepted":1}', { status: 200, headers: { "x-credits-balance-gbp-micros": "" } });
    const firstInFlight = sendBtn.emit("click");
    expect(sendBtn.disabled).toBe(true);
    await urlEl.emit("keydown", { metaKey: true, key: "Enter" });
    expect(fetchCalls).toHaveLength(3);
    release();
    await firstInFlight;
    pendingFetch = null;
    expect(sendBtn.disabled).toBe(false);
    expect(balEl.textContent).toBe("£4.99");

    // 7. Revoking non-matching key keeps stored key; revoking matching key clears it; signout clears it.
    await revokeOther.emit("submit");
    expect(storage.get("mx_api_key")).toBe("mk_test_abcd1234");
    await revokeMatch.emit("submit");
    expect(storage.get("mx_api_key")).toBeUndefined();
    storage.set("mx_api_key", "mk_test_abcd1234");
    await signoutForm.emit("submit");
    expect(storage.get("mx_api_key")).toBeUndefined();
  });
});
