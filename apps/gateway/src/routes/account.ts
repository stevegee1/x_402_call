import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isMainnet } from "../config";
import type { AppDeps, AppEnv } from "../context";
import { CreditsError } from "../credits/service";
import { accountPage, ACCOUNT_HEADERS, errorPage, newKeyPage, signInPage, signUpPage, type AccountView, type PageOpts } from "./account-pages";
import { clientIp, WindowLimiter } from "./limits";

const NETWORK_NAMES: Record<string, string> = { "eip155:8453": "Base", "eip155:84532": "Base Sepolia" };

/** Which form field a sign-up error belongs to. */
const FIELD_OF: Record<string, "company" | "email" | "taxId" | "password"> = {
  invalid_company: "company",
  invalid_email: "email",
  email_taken: "email",
  invalid_tax_details: "taxId",
  invalid_password: "password",
};

const FRIENDLY: Record<string, string> = {
  invalid_company: "Enter your company name.",
  invalid_email: "Enter a valid email address.",
  invalid_tax_details: "Enter a valid VAT or tax ID. It's required outside the UK.",
};

/**
 * Customer sign-up, sign-in and account pages (browser side of the credits rail).
 *
 * Security model:
 *  - Session: 32 random bytes in an HttpOnly, SameSite=Lax cookie (`__Host-` and Secure on https);
 *    only its SHA-256 is stored. 14-day lifetime; sign-out revokes it server side.
 *  - CSRF: every POST must come from our own origin (Origin header, or Sec-Fetch-Site), on top of
 *    SameSite=Lax. Cross-site form posts are refused before any work is done.
 *  - Guessing: per-user lockout in the database (all replicas) plus a per-IP limit per replica.
 *  - Pages: no script, hash-only styles, no-store, noindex, frame-ancestors none.
 */
export function accountRoutes(d: AppDeps) {
  const r = new Hono<AppEnv>();
  const customers = d.customers;
  if (!customers) return r;
  const base = new URL(d.cfg.PUBLIC_BASE_URL);
  const secure = base.protocol === "https:";
  const COOKIE = secure ? "__Host-wb_session" : "wb_session";
  const opts: PageOpts = { testnet: isMainnet(d.cfg) ? null : (NETWORK_NAMES[d.cfg.X402_NETWORK] ?? d.cfg.X402_NETWORK), base: d.cfg.PUBLIC_BASE_URL };
  const signInLimit = new WindowLimiter(20, 15 * 60_000);
  const signUpLimit = new WindowLimiter(10, 60 * 60_000);

  const page = (c: Context<AppEnv>, html: string, status: 200 | 400 | 401 | 403 | 404 | 409 | 429 | 503 = 200) => c.body(html, status, ACCOUNT_HEADERS);
  const seeOther = (c: Context<AppEnv>, to: string) => c.body(null, 303, { location: to, "cache-control": "no-store" });

  const sameOrigin = (c: Context<AppEnv>) => {
    const origin = c.req.header("origin");
    if (origin) return origin === base.origin;
    return c.req.header("sec-fetch-site") === "same-origin";
  };

  const setSession = (c: Context<AppEnv>, token: string, expiresAt: Date) =>
    setCookie(c, COOKIE, token, { httpOnly: true, secure, sameSite: "Lax", path: "/", expires: expiresAt, maxAge: Math.floor((expiresAt.getTime() - Date.now()) / 1000) });
  const clearSession = (c: Context<AppEnv>) => deleteCookie(c, COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Lax" });
  const current = (c: Context<AppEnv>) => customers.session(getCookie(c, COOKIE));

  const form = async (c: Context<AppEnv>): Promise<Record<string, string>> => {
    const body = await c.req.parseBody().catch(() => ({}));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v.slice(0, 1_000);
    return out;
  };

  // Refuse cross-site posts to the account routes before reading the body. This router is mounted
  // at "/", so its middleware sees every request: match our paths exactly (the Stripe webhook and
  // the API must not be affected).
  const ours = (p: string) => p === "/signup" || p === "/signin" || p === "/signout" || p === "/account" || p.startsWith("/account/");
  r.use("*", async (c, next) => {
    if (c.req.method === "POST" && ours(c.req.path) && !sameOrigin(c)) {
      d.metrics.inc("account_csrf_refused_total");
      return page(c, errorPage(opts, 403, "Request refused", "This form must be sent from our own site. Reload the page and try again."), 403);
    }
    await next();
  });

  r.get("/signup", async (c) => ((await current(c)) ? seeOther(c, "/account") : page(c, signUpPage(opts))));

  r.post("/signup", async (c) => {
    const f = await form(c);
    const values = { company: f.company ?? "", email: f.email ?? "", country: f.country ?? "GB", taxId: f.taxId ?? "" };
    if (!signUpLimit.hit(clientIp(c, d.cfg.CLIENT_IP_HEADER))) return page(c, signUpPage(opts, values, { form: "Too many sign-ups from your network. Try again later." }), 429);
    try {
      const res = await customers.signUp({ ...values, password: f.password });
      setSession(c, res.token, res.expiresAt);
      d.metrics.inc("account_signups_total");
      d.log.info({ accountId: res.account.id, country: res.account.country }, "customer signed up");
      return page(c, newKeyPage(opts, res.apiKey, true));
    } catch (e) {
      if (!(e instanceof CreditsError)) throw e;
      const fieldName = FIELD_OF[e.code];
      const message = FRIENDLY[e.code] ?? e.message;
      return page(c, signUpPage(opts, values, fieldName ? { [fieldName]: message } : { form: message }), e.code === "email_taken" ? 409 : 400);
    }
  });

  r.get("/signin", async (c) => {
    if (await current(c)) return seeOther(c, "/account");
    const notice = c.req.query("signed_out") === "1" ? "You've signed out." : undefined;
    return page(c, signInPage(opts, "", undefined, notice));
  });

  r.post("/signin", async (c) => {
    const f = await form(c);
    const email = (f.email ?? "").trim();
    if (!signInLimit.hit(clientIp(c, d.cfg.CLIENT_IP_HEADER))) return page(c, signInPage(opts, email, "Too many attempts from your network. Wait a few minutes and try again."), 429);
    const res = await customers.signIn(email, f.password);
    if (!res.ok) {
      d.metrics.inc("account_signin_failed_total", { reason: res.reason });
      // One message for unknown email and wrong password, so the form doesn't reveal who has an account.
      const msg = res.reason === "locked" ? "Too many failed attempts. This account is locked for a few minutes; try again later." : "That email and password don't match an account.";
      return page(c, signInPage(opts, email, msg), res.reason === "locked" ? 429 : 401);
    }
    setSession(c, res.token, res.expiresAt);
    return seeOther(c, "/account");
  });

  r.post("/signout", async (c) => {
    await customers.signOut(getCookie(c, COOKIE));
    clearSession(c);
    return seeOther(c, "/signin?signed_out=1");
  });

  const view = async (s: NonNullable<Awaited<ReturnType<typeof current>>>, notice?: AccountView["notice"]): Promise<AccountView> => ({
    ...s,
    keys: await customers.keys(s.account.id),
    usage: await d.store.usage(s.account.id, 20),
    notice,
  });

  r.get("/account", async (c) => {
    const s = await current(c);
    if (!s) return seeOther(c, "/signin");
    return page(c, accountPage(opts, await view(s)));
  });

  r.post("/account/keys", async (c) => {
    const s = await current(c);
    if (!s) return seeOther(c, "/signin");
    const { key } = await customers.createKey(s.account.id);
    d.log.info({ accountId: s.account.id }, "api key created");
    return page(c, newKeyPage(opts, key, false));
  });

  r.post("/account/keys/:id/revoke", async (c) => {
    const s = await current(c);
    if (!s) return seeOther(c, "/signin");
    const ok = await customers.revokeKey(s.account.id, c.req.param("id"));
    if (ok) d.log.info({ accountId: s.account.id }, "api key revoked");
    const notice = ok
      ? ({ kind: "ok", text: "Key revoked. It stops working within a minute." } as const)
      : ({ kind: "error", text: "That key wasn't found or was already revoked." } as const);
    return page(c, accountPage(opts, await view(s, notice)), ok ? 200 : 404);
  });

  r.post("/account/topup", async (c) => {
    const s = await current(c);
    if (!s) return seeOther(c, "/signin");
    const f = await form(c);
    try {
      const checkout = await d.credits.startCheckout(s.account, f.pack ?? "");
      return seeOther(c, checkout.url);
    } catch (e) {
      if (!(e instanceof CreditsError)) throw e;
      const text =
        e.code === "card_payments_unavailable"
          ? `Card top-ups aren't switched on here yet. To top up by bank transfer, contact us with your account ID (${s.account.id}).`
          : "Choose one of the top-up amounts shown.";
      return page(c, accountPage(opts, await view(s, { kind: e.code === "card_payments_unavailable" ? "info" : "error", text })), e.code === "card_payments_unavailable" ? 503 : 400);
    }
  });

  return r;
}
