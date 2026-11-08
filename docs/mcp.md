# Connect an AI assistant (MCP)

`apps/mcp` is an MCP server that runs on **your** machine, next to your assistant (Claude Desktop,
Claude Code, or any MCP client). It gives the assistant one tool per endpoint we sell, pays for
calls with your wallet or your API key, and enforces your spending limits. Your keys never leave
your machine.

## Set up

Add this to your MCP client's configuration (Claude Desktop: Settings, Developer, Edit config):

```json
{
  "mcpServers": {
    "wearebase": {
      "command": "npx",
      "args": ["tsx", "/path/to/x_402_call/apps/mcp/src/index.ts"],
      "env": {
        "MX_GATEWAY_URL": "https://mxgateway-staging.up.railway.app",
        "MX_WALLET_PRIVATE_KEY": "0x...",
        "MX_MAX_PRICE_USD": "1",
        "MX_DAILY_BUDGET_USD": "5"
      }
    }
  }
}
```

Choose how to pay; set one or both:

| Variable | Pays with |
|---|---|
| `MX_WALLET_PRIVATE_KEY` | USDC from that wallet, per call (x402) or by buying a session. The wallet needs USDC only; no ETH. On staging, use a test wallet funded from faucet.circle.com (Base Sepolia). |
| `MX_API_KEY` | Your GBP credits (`mk_...` from your account page). |

Limits (all optional): `MX_MAX_PRICE_USD` (largest single payment; default 0.1, so set it to at
least the session size you'll buy), `MX_DAILY_BUDGET_USD` (default 2), `MX_DAILY_BUDGET_GBP`
(default 2), or a full policy file with `MX_POLICY_FILE`.

## Tools

- One per endpoint, named after it: `grid_intensity`, `grid_window`, `grid_history`,
  `maritime_vessels`, `maritime_queue`, and so on. Each description shows its current price. The
  list comes from the live catalog, so new datasets appear without updating anything; run
  `refresh_catalog` to pick them up in a running session.
- `buy_session`: prepay $1, $5 or $20 once from your wallet. Paid tools then read from the session
  automatically (faster, one on-chain payment instead of one per call) and fall back to per-call
  payment when it's spent or expires.
- `spending_report`: today's spend against your limits, and the session balance.
- The original names (`get_vessels`, `get_anchorage_queue`, `list_regions`, ...) still work.

You are never charged for errors, invalid arguments or stale data.
