import type { Address } from "viem";

/**
 * Contracts the keeper touches, per network. Each was checked on chain on 2026-11-11: code present,
 * the router's WETH9() and factory() match, the USDC/WETH 0.05% pool exists with liquidity, and the
 * quoter prices 0.01 ETH within 0.1% of the Chainlink feed on mainnet.
 * Not configurable: a wrong router or feed address would be a way to drain the float.
 */
export interface NetworkContracts {
  chainId: number;
  usdc: Address;
  weth: Address;
  /** Uniswap SwapRouter02. */
  router: Address;
  /** Uniswap QuoterV2. */
  quoter: Address;
  /** Chainlink ETH/USD, 8 decimals (Base heartbeat 1200 s). */
  ethUsdFeed: Address;
  /** Chainlink L2 sequencer uptime feed (answer 0 = up), where one exists. */
  sequencerFeed: Address | null;
}

export const CONTRACTS = {
  "eip155:8453": {
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    ethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    // description() "L2 Sequencer Uptime Status Feed", checked on chain 2026-11-11.
    sequencerFeed: "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433",
  },
  "eip155:84532": {
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    weth: "0x4200000000000000000000000000000000000006",
    router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
    ethUsdFeed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
    sequencerFeed: null,
  },
} as const satisfies Record<string, NetworkContracts>;

export type SupportedNetwork = keyof typeof CONTRACTS;
