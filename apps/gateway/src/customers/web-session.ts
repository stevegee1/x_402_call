import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Config } from "../config";
import type { AppDeps, AppEnv } from "../context";

/** The browser session cookie: `__Host-` (host-locked, Secure) on https. */
export const sessionCookieName = (cfg: Pick<Config, "PUBLIC_BASE_URL">) => (new URL(cfg.PUBLIC_BASE_URL).protocol === "https:" ? "__Host-wb_session" : "wb_session");

/** Who is viewing a page, for the header ("Account" instead of "Sign in"). Never throws. */
export interface Viewer {
  company: string;
}

export async function viewerOf(c: Context<AppEnv>, d: AppDeps): Promise<Viewer | null> {
  if (!d.customers) return null;
  const token = getCookie(c, sessionCookieName(d.cfg));
  if (!token) return null; // no lookup for anonymous visitors
  try {
    const s = await d.customers.session(token);
    return s ? { company: s.account.company } : null;
  } catch {
    return null; // a header must never take a page down
  }
}
