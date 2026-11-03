import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, clients, installTestContracts, startAnvil } from "./chain";
import { startFaultProxy } from "./fault-proxy";
import { createDatabase } from "./postgres";
import { freePort, httpOk, ROOT, startService, waitFor, type Service } from "./proc";

const TSX = join(ROOT, "node_modules/.bin/tsx");
/** The FX rate every payment is valued at in e2e (FX_PROVIDER=fixed): deterministic ledger figures. */
export const E2E_FX_USDC_GBP = 0.8;

/**
 * Gateway replicas, all on one Postgres, so every settlement loop competes for the same rows (I7):
 *   async     async settlement, facilitator direct
 *   sync      inline settlement, facilitator direct
 *   flaky     async; facilitator through a fault proxy, no fallback
 *   failover  sync; primary facilitator through the fault proxy, fallback direct
 */
export type GatewayName = "async" | "sync" | "flaky" | "failover";

/** Everything a test needs to reach the stack. Serialisable: it crosses from global setup to test workers. */
export interface StackInfo {
  rpcUrl: string;
  payTo: Address;
  adminToken: string;
  facilitator: { url: string; token: string; signer: Address };
  faultProxyControlUrl: string;
  gateways: Record<GatewayName, string>;
  /** First block of the run: reconciliation scans USDC events from here. */
  startBlock: string;
}

const token = () => randomBytes(24).toString("hex");

export async function startStack(): Promise<{ info: StackInfo; stop: () => Promise<void> }> {
  const stops: (() => Promise<unknown>)[] = [];
  const stop = async () => {
    for (const s of stops.reverse()) await s().catch(() => undefined);
  };

  try {
    const anvil = await startAnvil();
    stops.push(() => anvil.service.stop());
    await installTestContracts(anvil.rpcUrl);
    const startBlock = await clients(anvil.rpcUrl).public.getBlockNumber();

    const db = await createDatabase();
    stops.push(() => db.drop());

    // A fresh payee each run: its balance must equal exactly what the ledger says we were paid.
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const adminToken = token();
    const facToken = token();

    const facPort = await freePort();
    const facilitatorUrl = `http://127.0.0.1:${facPort}`;
    const facilitator = startService("facilitator", TSX, ["src/server.ts"], {
      cwd: join(ROOT, "apps/facilitator"),
      env: {
        NODE_ENV: "production",
        PORT: String(facPort),
        LOG_LEVEL: "info",
        NETWORK: "eip155:84532",
        RPC_URL: anvil.rpcUrl,
        FACILITATOR_PRIVATE_KEY: ANVIL_KEYS.facilitator,
        AUTH_TOKEN: facToken,
        ALLOWED_PAY_TO: payTo,
      },
    });
    stops.push(() => facilitator.stop());
    await waitFor("facilitator ready", httpOk(`${facilitatorUrl}/readyz`), { service: facilitator });

    const proxy = await startFaultProxy({ host: "127.0.0.1", port: facPort });
    stops.push(() => proxy.stop());

    const gatewayEnv = (port: number, over: Record<string, string>) => ({
      NODE_ENV: "test",
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      LOG_LEVEL: "info",
      X402_NETWORK: "eip155:84532",
      PAY_TO: payTo,
      FACILITATOR: "url",
      FACILITATOR_URL: facilitatorUrl,
      FACILITATOR_AUTH_TOKEN: facToken,
      FACILITATOR_TIMEOUT_MS: "10000",
      BASE_RPC_URL: anvil.rpcUrl,
      DATA_SOURCE: "simulator",
      DATABASE_URL: db.url,
      ADMIN_TOKEN: adminToken,
      FX_PROVIDER: "fixed",
      FX_FALLBACK_USDC_GBP: String(E2E_FX_USDC_GBP),
      ...over,
    });
    const specs: Record<GatewayName, Record<string, string>> = {
      async: { SETTLEMENT_MODE: "async" },
      sync: { SETTLEMENT_MODE: "sync" },
      flaky: { SETTLEMENT_MODE: "async", FACILITATOR_URL: proxy.url },
      failover: { SETTLEMENT_MODE: "sync", FACILITATOR_URL: proxy.url, FALLBACK_FACILITATOR_URL: facilitatorUrl, FALLBACK_FACILITATOR_AUTH_TOKEN: facToken },
    };

    const gateways = {} as Record<GatewayName, string>;
    const services: Service[] = [];
    // Boot replicas concurrently: they race to migrate the same empty database, as a rolling deploy would.
    await Promise.all(
      (Object.keys(specs) as GatewayName[]).map(async (name) => {
        const port = await freePort();
        const svc = startService(`gateway-${name}`, TSX, ["src/server.ts"], { cwd: join(ROOT, "apps/gateway"), env: gatewayEnv(port, specs[name]) });
        services.push(svc);
        stops.push(() => svc.stop());
        gateways[name] = `http://127.0.0.1:${port}`;
        await waitFor(`gateway-${name} ready`, httpOk(`${gateways[name]}/readyz`), { service: svc, timeoutMs: 90_000 });
      }),
    );

    return {
      info: {
        rpcUrl: anvil.rpcUrl,
        payTo,
        adminToken,
        facilitator: { url: facilitatorUrl, token: facToken, signer: privateKeyToAccount(ANVIL_KEYS.facilitator).address },
        faultProxyControlUrl: proxy.controlUrl,
        gateways,
        startBlock: startBlock.toString(),
      },
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
