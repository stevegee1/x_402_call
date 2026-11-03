import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x EVM address");

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
    MAX_TIMEOUT_SECONDS: z.coerce.number().int().default(120),
    BASE_RPC_URL: z.string().url().optional(),

    // Data plane
    DATA_SOURCE: z.enum(["nats", "simulator"]).default("simulator"),
    NATS_URL: z.string().default("nats://localhost:4222"),
    SNAPSHOT_INTERVAL_MS: z.coerce.number().int().default(250),

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
  })
  .superRefine((c, ctx) => {
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
