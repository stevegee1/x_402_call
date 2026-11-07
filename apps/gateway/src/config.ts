import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x EVM address");
const addressList = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(address));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(8080),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
    LOG_LEVEL: z.string().default("info"),

    // x402
    X402_NETWORK: z.enum(["eip155:8453", "eip155:84532"]).default("eip155:84532"),
    PAY_TO: address,
    FACILITATOR: z.enum(["x402org", "cdp", "url"]).default("x402org"),
    FACILITATOR_URL: z.string().url().optional(),
    /** Bearer token for a self-hosted facilitator (apps/facilitator AUTH_TOKEN), primary or fallback. */
    FACILITATOR_AUTH_TOKEN: z.string().min(24).optional(),
    CDP_API_KEY_ID: z.string().optional(),
    CDP_API_KEY_SECRET: z.string().optional(),
    FALLBACK_FACILITATOR_URL: z.string().url().optional(),
    FALLBACK_FACILITATOR_AUTH_TOKEN: z.string().min(24).optional(),
    FACILITATOR_TIMEOUT_MS: z.coerce.number().int().default(3_000),
    SETTLEMENT_MODE: z.enum(["async", "sync"]).default("async"),
    EXPOSURE_CAP_USD: z.coerce.number().default(25),
    EXPOSURE_CAP_PER_PAYER_USD: z.coerce.number().default(1),
    /** How long a served-early payment that failed for good keeps counting against the caps. */
    EXPOSURE_FAILED_HOLD_HOURS: z.coerce.number().positive().default(24),
    /** How long its payer is settled before being served. At least the hold. */
    ASYNC_DEMOTE_AFTER_FAILURE_DAYS: z.coerce.number().positive().default(30),
    MAX_TIMEOUT_SECONDS: z.coerce.number().int().default(120),
    BASE_RPC_URL: z.string().url().optional(),

    // Data plane
    DATA_SOURCE: z.enum(["nats", "simulator"]).default("simulator"),
    NATS_URL: z.string().default("nats://localhost:4222"),
    SNAPSHOT_INTERVAL_MS: z.coerce.number().int().default(250),

    // Grid carbon product (NESO country forecast). Off unless enabled.
    GRID_ENABLED: bool.default("false"),
    GRID_SOURCE_URL: z.string().url().default("https://api.neso.energy"),
    GRID_POLL_MS: z.coerce.number().int().min(60_000).default(600_000),

    // Persistence (unset => in-memory store, dev only)
    DATABASE_URL: z.string().optional(),

    // Fiat credits
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // Ops
    ADMIN_TOKEN: z.string().min(24, "ADMIN_TOKEN must be at least 24 chars").optional(),
    /** "fixed" values every payment at FX_FALLBACK_USDC_GBP: hermetic tests only, refused in production. */
    FX_PROVIDER: z.enum(["coinbase", "fixed"]).default("coinbase"),
    FX_FALLBACK_USDC_GBP: z.coerce.number().positive().default(0.75),
    SANCTIONS_DENYLIST_PATH: z.string().optional(),
    CHAINALYSIS_API_KEY: z.string().optional(),
    SANCTIONS_FAIL_CLOSED: bool.default("false"),

    // ERC-8004 buyer identity (loosen-only: a tier can raise a payer's exposure cap, never lower it).
    ERC8004_ENABLED: bool.default("false"),
    /** Override the canonical registries for X402_NETWORK (see identity/registries.ts). */
    ERC8004_IDENTITY_REGISTRY: address.optional(),
    ERC8004_REPUTATION_REGISTRY: address.optional(),
    /** Comma-separated reviewer addresses whose feedback counts. Empty: nobody reaches "trusted". */
    ERC8004_TRUSTED_REVIEWERS: addressList.default(""),
    /** Optional tag1 filter for reputation (e.g. "quality"); empty counts every tag. */
    ERC8004_REPUTATION_TAG: z.string().default(""),
    ERC8004_TRUSTED_MIN_FEEDBACK: z.coerce.number().int().positive().default(3),
    /** Minimum mean feedback value, on the reviewers' own scale (e.g. 0-100). */
    ERC8004_TRUSTED_MIN_SCORE: z.coerce.number().default(80),
    ERC8004_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
    EXPOSURE_CAP_PER_PAYER_IDENTIFIED_USD: z.coerce.number().default(2),
    EXPOSURE_CAP_PER_PAYER_TRUSTED_USD: z.coerce.number().default(5),
    /** Our own ERC-8004 agent id as a seller, advertised in 402 responses and on /. */
    SELLER_AGENT_ID: z.string().regex(/^\d+$/, "must be a decimal agent id").optional(),
  })
  .superRefine((c, ctx) => {
    // Loosen-only: unknown <= identified <= trusted <= the global cap, which no tier can raise.
    const tiers = [c.EXPOSURE_CAP_PER_PAYER_USD, c.EXPOSURE_CAP_PER_PAYER_IDENTIFIED_USD, c.EXPOSURE_CAP_PER_PAYER_TRUSTED_USD, c.EXPOSURE_CAP_USD];
    if (tiers.some((v, i) => i > 0 && v < tiers[i - 1]!))
      ctx.addIssue({
        code: "custom",
        path: ["EXPOSURE_CAP_PER_PAYER_IDENTIFIED_USD"],
        message: "per-payer caps must satisfy unknown <= identified <= trusted <= EXPOSURE_CAP_USD (tiers only loosen)",
      });
    if (c.ASYNC_DEMOTE_AFTER_FAILURE_DAYS * 24 < c.EXPOSURE_FAILED_HOLD_HOURS)
      ctx.addIssue({ code: "custom", path: ["ASYNC_DEMOTE_AFTER_FAILURE_DAYS"], message: "must be at least EXPOSURE_FAILED_HOLD_HOURS" });
    if (c.ERC8004_ENABLED && !c.BASE_RPC_URL) ctx.addIssue({ code: "custom", path: ["BASE_RPC_URL"], message: "required when ERC8004_ENABLED=true" });
    if (c.FACILITATOR === "url" && !c.FACILITATOR_URL) ctx.addIssue({ code: "custom", path: ["FACILITATOR_URL"], message: "required when FACILITATOR=url" });
    if (c.FACILITATOR === "cdp" && !(c.CDP_API_KEY_ID && c.CDP_API_KEY_SECRET))
      ctx.addIssue({ code: "custom", path: ["CDP_API_KEY_ID"], message: "CDP credentials required when FACILITATOR=cdp" });
    if (c.X402_NETWORK === "eip155:8453" && c.FACILITATOR === "x402org")
      ctx.addIssue({ code: "custom", path: ["FACILITATOR"], message: "x402.org facilitator is testnet-only; use cdp for Base mainnet" });
    if (c.NODE_ENV === "production") {
      // Our own facilitator spends our gas: it must never be reachable without a token.
      if (c.FACILITATOR === "url" && !c.FACILITATOR_AUTH_TOKEN) ctx.addIssue({ code: "custom", path: ["FACILITATOR_AUTH_TOKEN"], message: "required in production when FACILITATOR=url" });
      if (c.FALLBACK_FACILITATOR_URL && !c.FALLBACK_FACILITATOR_AUTH_TOKEN)
        ctx.addIssue({ code: "custom", path: ["FALLBACK_FACILITATOR_AUTH_TOKEN"], message: "required in production with FALLBACK_FACILITATOR_URL" });
      if (c.GRID_ENABLED && !c.GRID_SOURCE_URL.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["GRID_SOURCE_URL"], message: "must be https in production" });
      if (c.FX_PROVIDER === "fixed") ctx.addIssue({ code: "custom", path: ["FX_PROVIDER"], message: "fixed FX is for tests; production values crypto at spot" });
      if (!c.DATABASE_URL) ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "required in production" });
      if (!c.ADMIN_TOKEN) ctx.addIssue({ code: "custom", path: ["ADMIN_TOKEN"], message: "required in production" });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  return r.data;
}

export const isMainnet = (c: Pick<Config, "X402_NETWORK">) => c.X402_NETWORK === "eip155:8453";
