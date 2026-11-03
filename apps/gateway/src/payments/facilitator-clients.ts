import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Config } from "../config";

const X402ORG_URL = "https://x402.org/facilitator";

/** HTTPFacilitatorClient wants auth headers keyed by facilitator path. */
export const bearerAuth = (token: string) => async () => {
  const h = { Authorization: `Bearer ${token}` };
  return { verify: h, settle: h, supported: h };
};

type FacilitatorConfig = Pick<
  Config,
  "FACILITATOR" | "FACILITATOR_URL" | "FACILITATOR_AUTH_TOKEN" | "CDP_API_KEY_ID" | "CDP_API_KEY_SECRET" | "FALLBACK_FACILITATOR_URL" | "FALLBACK_FACILITATOR_AUTH_TOKEN" | "FACILITATOR_TIMEOUT_MS"
>;

/** Primary and optional fallback facilitator clients, from config. */
export function createFacilitatorClients(cfg: FacilitatorConfig) {
  const timeoutMs = cfg.FACILITATOR_TIMEOUT_MS;
  const primary =
    cfg.FACILITATOR === "cdp"
      ? new HTTPFacilitatorClient({ ...createFacilitatorConfig(cfg.CDP_API_KEY_ID, cfg.CDP_API_KEY_SECRET), timeoutMs })
      : cfg.FACILITATOR === "url"
        ? new HTTPFacilitatorClient({ url: cfg.FACILITATOR_URL, timeoutMs, createAuthHeaders: cfg.FACILITATOR_AUTH_TOKEN ? bearerAuth(cfg.FACILITATOR_AUTH_TOKEN) : undefined })
        : new HTTPFacilitatorClient({ url: X402ORG_URL, timeoutMs });
  const fallback = cfg.FALLBACK_FACILITATOR_URL
    ? new HTTPFacilitatorClient({
        url: cfg.FALLBACK_FACILITATOR_URL,
        timeoutMs,
        createAuthHeaders: cfg.FALLBACK_FACILITATOR_AUTH_TOKEN ? bearerAuth(cfg.FALLBACK_FACILITATOR_AUTH_TOKEN) : undefined,
      })
    : undefined;
  return { primary, fallback };
}
