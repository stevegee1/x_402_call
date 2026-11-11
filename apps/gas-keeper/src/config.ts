import { usdToUsdcAtomic } from "@mx/shared";
import { getAddress, parseEther } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { z } from "zod";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x EVM address").transform((a) => getAddress(a));
const eth = z.string().regex(/^\d+(\.\d{1,18})?$/, "an ETH amount, e.g. 0.01").transform((v) => parseEther(v));
const usd = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, "a USD amount, e.g. 50")
  .transform((v) => usdToUsdcAtomic(v))
  .refine((v) => v > 0n, "must be more than 0");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(8093),
    LOG_LEVEL: z.string().default("info"),

    NETWORK: z.enum(["eip155:8453", "eip155:84532"]).default("eip155:84532"),
    RPC_URL: z.string().url(),
    /**
     * The float wallet: holds a bounded amount of USDC moved in from the treasury by hand, plus a
     * little ETH for its own transactions. A leak loses at most the float, never revenue.
     */
    KEEPER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 0x-prefixed 32-byte hex key"),
    /** The facilitator's gas wallet: the only address the keeper ever sends ETH to. */
    FACILITATOR_ADDRESS: address,

    /**
     * Must equal the facilitator's own MIN_GAS_BALANCE_WEI (below it, it stops settling): set both
     * together. Alerted on; the trigger must sit above it.
     */
    FACILITATOR_MIN_ETH: eth.default("0.001"),
    /** Top up when the facilitator's balance falls below this. */
    TOPUP_TRIGGER_ETH: eth.default("0.003"),
    /** Refill the facilitator to this. */
    TOPUP_TARGET_ETH: eth.default("0.01"),
    /**
     * ETH the keeper keeps for its own transactions; restored as part of a swap. A send may leave it
     * at half this, so at least 0.0004: half (0.0002) pays for one top-up's transactions up to about
     * 0.33 gwei (55x today's Base price). Above that it alerts keeper_gas_low and still sends held ETH.
     */
    KEEPER_RESERVE_ETH: eth.default("0.001").refine((v) => v >= 400_000_000_000_000n, "must be at least 0.0004"),

    /** Most USDC one top-up may spend. */
    MAX_USDC_PER_TOPUP: usd.default("50"),
    /** Most USDC the keeper may spend in any 24 h. In memory, so a restart resets it: the float balance is the hard ceiling. */
    MAX_USDC_PER_DAY: usd.default("100"),
    /**
     * Refuse a swap quoted more than this above the Chainlink price. At least 50 bps and the pool fee
     * plus 10: Chainlink only updates on a 0.15% move (or each 20 min), so a tighter band would refuse
     * most swaps.
     */
    MAX_SLIPPAGE_BPS: z.coerce.number().int().max(500).default(100),
    /** Refuse to trade on a Chainlink answer older than this. At least the Base ETH/USD heartbeat (1200 s) plus margin, or a quiet market would block every swap. */
    PRICE_MAX_AGE_S: z.coerce.number().int().min(1500).max(86_400).default(1800),
    /** Uniswap v3 fee tier of the USDC/WETH pool (500 = 0.05%, the deepest on Base). */
    POOL_FEE: z.coerce.number().int().refine((f) => [100, 500, 3000, 10000].includes(f), "a Uniswap v3 fee tier").default(500),
    /** Alert when the float holds less USDC than this: time to move more in from the treasury. */
    FLOAT_LOW_USDC: usd.default("10"),
    /** Consecutive failed (or stuck-in-flight) ticks before alerting. */
    FAIL_ALERT_TICKS: z.coerce.number().int().min(1).max(60).default(3),

    INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
    /**
     * Wait before the first tick. Railway starts the new deployment before stopping the old one; the
     * old keeper exits within SHUTDOWN_WAIT_MS + 5 s of its SIGTERM (then it is forced out), so this
     * must be longer than that plus Railway's delay between the health check and the SIGTERM.
     */
    START_DELAY_MS: z.coerce.number().int().min(0).default(120_000),
    /** How long a stopping keeper waits for the transaction in flight (one receipt wait is up to 60 s). Keep drainingSeconds above it. */
    SHUTDOWN_WAIT_MS: z.coerce.number().int().min(65_000).max(300_000).default(75_000),
    /**
     * Optional: POSTed {text, reason, detail} once per alert (retried until delivered): blocked
     * top-ups, repeated failures, a stuck transaction, the facilitator below its minimum, the float or
     * the keeper's own gas low, a settle costing more than the allowance, or a refused start.
     */
    ALERT_WEBHOOK_URL: z.string().url().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.TOPUP_TRIGGER_ETH <= c.FACILITATOR_MIN_ETH) ctx.addIssue({ code: "custom", path: ["TOPUP_TRIGGER_ETH"], message: "must be above FACILITATOR_MIN_ETH, or the facilitator stops settling before a top-up starts" });
    // POOL_FEE is in hundredths of a basis point (500 = 5 bps): a band at or below it refuses every swap.
    const minBps = Math.max(50, c.POOL_FEE / 100 + 10);
    if (c.MAX_SLIPPAGE_BPS < minBps) ctx.addIssue({ code: "custom", path: ["MAX_SLIPPAGE_BPS"], message: `must be at least ${minBps} bps (50, and the pool fee plus 10)` });
    // Production deploys overlap: the new keeper must not tick until the old one has finished.
    if (c.NODE_ENV === "production" && c.START_DELAY_MS < c.SHUTDOWN_WAIT_MS + 30_000)
      ctx.addIssue({ code: "custom", path: ["START_DELAY_MS"], message: "must be at least SHUTDOWN_WAIT_MS + 30000 in production, so a new deployment never ticks while the old one finishes" });
    if (c.TOPUP_TARGET_ETH - c.TOPUP_TRIGGER_ETH < c.KEEPER_RESERVE_ETH && c.TOPUP_TARGET_ETH > c.TOPUP_TRIGGER_ETH)
      ctx.addIssue({ code: "custom", path: ["TOPUP_TARGET_ETH"], message: "must be at least KEEPER_RESERVE_ETH above TOPUP_TRIGGER_ETH, or top-ups shrink to dust" });
    if (c.TOPUP_TARGET_ETH <= c.TOPUP_TRIGGER_ETH) ctx.addIssue({ code: "custom", path: ["TOPUP_TARGET_ETH"], message: "must be above TOPUP_TRIGGER_ETH" });
    if (c.MAX_USDC_PER_TOPUP > c.MAX_USDC_PER_DAY) ctx.addIssue({ code: "custom", path: ["MAX_USDC_PER_TOPUP"], message: "must not exceed MAX_USDC_PER_DAY" });
    if (/^0x[a-fA-F0-9]{64}$/.test(c.KEEPER_PRIVATE_KEY) && privateKeyToAddress(c.KEEPER_PRIVATE_KEY as `0x${string}`) === c.FACILITATOR_ADDRESS)
      ctx.addIssue({ code: "custom", path: ["FACILITATOR_ADDRESS"], message: "must not be the keeper's own address" });
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
