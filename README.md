# BountyForge

**Trustless On-Chain Micro-Bounty Escrow, Multi-Contributor Split Payouts & Builder Reputation on Gno.land**

Built for the **Gnome Tavern Hackathon** (`onyx-1` testnet). BountyForge pairs a reusable pure Gno package (`escrowmath`), a security-hardened escrow realm (`bountyforge`), a multi-route `gnoweb` UI, and a zero-dependency Model Context Protocol (MCP) server so both humans and AI agents can discover, fund, complete, and audit bounties natively on Gno.land.

---

## Architecture

```text
bountyforge/
├── gnowork.toml                  # Gno workspace manifest
├── p/escrowmath/                 # Reusable pure package (zero-dust BPS splits, GNOT formatting, XP tiers)
│   ├── gnomod.toml
│   ├── escrowmath.gno
│   └── escrowmath_test.gno
├── r/bountyforge/                # Stateful Gno escrow & reputation realm
│   ├── gnomod.toml
│   ├── bountyforge.gno
│   └── bountyforge_test.gno
├── mcp/bountyforge-mcp.mjs       # Zero-dep Node MCP server + CLI over ABCI vm/qrender & vm/qeval
└── deploy.ps1                    # One-command Onyx testnet deployment script
```

## Key Features

- **Strict Escrow Solvency & Security**:
  - Rejects non-EOA relay calls (`!cur.Previous().IsUserCall()`) on every mutating transaction to defend `unsafe.OriginSend()`.
  - Enforces the balance invariant `banker.GetCoin(realmAddr, "ugnot") >= totalEscrowed` on creation and top-ups.
  - Follows Checks-Effects-Interactions (CEI) on every payout, split, dispute settlement, and refund.
- **Crowdfunded Top-Ups**: Any sponsor can call `TopUpBounty` to boost an `OPEN` bounty pool.
- **Dust-Free Multi-Contributor Splits (`SplitAndPay`)**: Uses `escrowmath.SplitBasisPoints` with overflow-safe arithmetic so 100% of every `ugnot` reaches contributors with zero dust loss.
- **Optional Arbiter Dispute Resolution**: Either creator or submitter can call `OpenDispute`; the designated arbiter resolves via `ResolveDispute(bountyID, submissionIdx, builderBps)` splitting `0..10000` bps between builder and creator.
- **On-Chain Builder Reputation**: Settled payouts award deterministic XP (`Novice` -> `Apprentice` -> `Journeyman` -> `Artisan` -> `Master` -> `Grandmaster`) rendered live on `:leaderboard` and `:builder/<addr>`.
- **AI-Agent MCP Integration**: `mcp/bountyforge-mcp.mjs` exposes `bountyforge_render`, `bountyforge_eval`, and `bountyforge_build_tx` over stdio JSON-RPC 2.0 without touching private keys.

## Running Tests Locally

Requires Gno `chain/onyx` (`v1.0.0-rc.0+`) and Node.js 20+:

```bash
# Run all Gno package & realm unit tests
gno test -v ./...

# Run MCP server & transaction builder self-test
node mcp/bountyforge-mcp.mjs --self-test
```

## Deploying to Gno.land Onyx Testnet (`onyx-1`)

1. Fund your `onyx-dev` address via [faucet.gno.land](https://faucet.gno.land/).
2. Run the deployment script:

```powershell
.\deploy.ps1 -KeyName onyx-dev -Address <your-gno-address>
```

3. Browse your live realm on `gnoweb`:
   - Board: `r/<addr>/bountyforge:`
   - Bounty detail: `r/<addr>/bountyforge:bounty/1`
   - Builder profile: `r/<addr>/bountyforge:builder/<builder_addr>`
   - Leaderboard: `r/<addr>/bountyforge:leaderboard`
   - Protocol stats: `r/<addr>/bountyforge:stats`

## License

MIT — see [LICENSE](./LICENSE).
