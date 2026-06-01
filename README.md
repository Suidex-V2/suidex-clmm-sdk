<p align="center">
  <img src="https://cryptomischief.mypinata.cloud/ipfs/bafybeid2ef3p7qxc3znj5ztbkmidfmbgb43dzclc6c2qyjfqfi5jr65nnm/Victory.png" alt="SuiDex" width="80" height="80">
</p>

<h3 align="center">@suidex/clmm-sdk</h3>

<p align="center">
  TypeScript SDK for SuiDex V3 Concentrated Liquidity on Sui
  <br />
  <a href="https://suidex.org"><strong>suidex.org</strong></a>
</p>

## Overview

The SuiDex CLMM SDK provides everything needed to interact with SuiDex V3 concentrated liquidity pools on Sui — swap, provide liquidity, flash loans, multi-pool routing, position management, and CLMM math.

Built on the [Sui TypeScript SDK](https://sdk.mystenlabs.com/sui) using the official [client extension pattern](https://sdk.mystenlabs.com/sui/sdk-building), so it works with any Sui client (`SuiGrpcClient`, `SuiGraphQLClient`, or any `ClientWithCoreApi`).

### Features

- **On-chain quotes** — Exact swap output via `compute_swap_result` simulation (multi-tick accurate)
- **Multi-pool routing** — Chain quotes across multiple pools via `preSwap`
- **Transaction builders** — Swap, add/remove liquidity, collect fees/rewards, flash loans
- **Position management** — Query positions by wallet, fetch position state
- **Pool discovery** — List all pools with TVL, volume, and tick liquidity via indexer API
- **Flash loans** — Borrow pool reserves for arbitrage with atomic repayment
- **Single-sided LP** — Zap with on-chain optimal split calculation
- **APR estimation** — Fee APR and reward APR helpers
- **CLMM math** — Tick/price conversions, liquidity calculations (Q64 fixed-point)
- **Event types** — Typed interfaces for all contract events (for indexers)
- **SIP-58 compatible** — Uses `coinWithBalance` for automatic coin resolution
- **Transport agnostic** — Works with gRPC, GraphQL, or any Sui client
- **Minimal dependencies** — Only `@mysten/sui` as a peer dependency

## Installation

```bash
npm install @suidex/clmm-sdk @mysten/sui
```

## Quick Start

```typescript
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { suidexCLMM } from '@suidex/clmm-sdk';

const client = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
}).$extend(suidexCLMM());
```

## API Reference

### Pool & Position Queries

```typescript
// Fetch pool state
const pool = await client.suidex.getPool('0xPoolId');

// Fetch position state
const position = await client.suidex.getPosition('0xPositionId');

// List all positions owned by a wallet
const positions = await client.suidex.listPositions('0xWalletAddress');
```

### Quoting

```typescript
// Single-pool quote
const quote = await client.suidex.view.getQuote({
  poolId: '0xPoolId',
  tokenXType: '0x2::sui::SUI',
  tokenYType: '0x...::token::TOKEN',
  isXtoY: true,
  amountIn: 1_000_000_000n,
});
// Returns: { amountOut, feeAmount, priceImpact, sqrtPriceAfter, feeRate }

// Multi-pool route quote (A → B → C)
const output = await client.suidex.view.preSwap({
  route: [
    { poolId: '0xPool1', tokenXType: 'A', tokenYType: 'B', isXtoY: true },
    { poolId: '0xPool2', tokenXType: 'B', tokenYType: 'C', isXtoY: true },
  ],
  amountIn: 1_000_000_000n,
});
```

### Swap

```typescript
const quote = await client.suidex.view.getQuote({ ... });
const minAmountOut = quote.amountOut - (quote.amountOut * 100n) / 10000n; // 1% slippage

const tx = client.suidex.tx.swap({
  poolId: '0xPoolId',
  tokenXType: '0x2::sui::SUI',
  tokenYType: '0x...::token::TOKEN',
  isXtoY: true,
  amountIn: 1_000_000_000n,
  minAmountOut,
  sender: '0xYourAddress',
});

const result = await wallet.signAndExecuteTransaction({ transaction: tx });
```

### Add Liquidity

```typescript
// New position
const tx = client.suidex.tx.addLiquidity({
  poolId: '0xPoolId',
  tokenXType: '0x2::sui::SUI',
  tokenYType: '0x...::token::TOKEN',
  tickLower: 4200,
  tickUpper: 5400,
  amountX: 1_000_000_000n,
  amountY: 500_000_000n,
  minAmountX: 990_000_000n,
  minAmountY: 495_000_000n,
  sender: '0xYourAddress',
  tickSpacing: 60, // validates tick alignment before building TX
});

// Add to existing position
const tx2 = client.suidex.tx.addLiquidity({
  ...params,
  existingPositionId: '0xPositionId',
});
```

### Remove Liquidity

```typescript
// Partial remove (keep position open)
const tx = client.suidex.tx.removeLiquidity({
  poolId, positionId, tokenXType, tokenYType,
  liquidityAmount: position.liquidity / 2n,
  minAmountX: 0n, minAmountY: 0n,
  sender: '0xYourAddress',
  closePosition: false,
});

// Full remove + close (auto-collects fees and rewards)
const tx2 = client.suidex.tx.removeLiquidity({
  poolId, positionId, tokenXType, tokenYType,
  liquidityAmount: position.liquidity,
  minAmountX: 0n, minAmountY: 0n,
  sender: '0xYourAddress',
  closePosition: true,
  rewardCoinTypes: ['0x...::victory_token::VICTORY_TOKEN'],
});
```

### Collect Fees & Rewards

```typescript
// Collect trading fees
const tx = client.suidex.tx.collectFees({
  poolId, positionId, tokenXType, tokenYType, sender,
});

// Collect single reward type
const tx2 = client.suidex.tx.collectReward({
  poolId, positionId, tokenXType, tokenYType,
  rewardCoinType: '0x...::victory_token::VICTORY_TOKEN',
  sender,
});

// Collect ALL reward types in one TX
const tx3 = client.suidex.tx.collectAllRewards({
  poolId, positionId, tokenXType, tokenYType,
  rewardCoinTypes: ['0x...::reward1::R1', '0x...::reward2::R2'],
  sender,
});
```

### Flash Loans

```typescript
// Borrow from pool, execute arb logic, repay with fees
const { tx, balanceX, balanceY, receipt } = client.suidex.tx.flashLoan({
  poolId, tokenXType, tokenYType,
  amountX: 1_000_000_000n,
  amountY: 0n,
  sender,
});

// ... add your arbitrage logic here (moveCall, etc.) ...

// Repay (must return borrowed amount + fee)
client.suidex.tx.repayFlashLoan({
  tx, poolId, tokenXType, tokenYType,
  receipt, balanceX, balanceY,
});

await wallet.signAndExecuteTransaction({ transaction: tx });
```

### Single-Sided Liquidity (Zap)

```typescript
// Add liquidity with only one token — SDK auto-calculates optimal split
const tx = client.suidex.tx.addLiquiditySingleSided({
  poolId, tokenXType, tokenYType,
  positionId: '0xExistingPosition',
  amountIn: 1_000_000_000n,
  isTokenX: true, // depositing token X
  sender,
});
```

### Indexer API (Pool Discovery)

```typescript
// List all pools with TVL and volume
const pools = await client.suidex.api.getAllPools();
// Returns: [{ poolId, tokenXType, tokenYType, feeRate, tickSpacing, liquidity, tvlUsd, volume24hUsd, ... }]

// Get tick liquidity depth for a pool
const ticks = await client.suidex.api.getPoolTicks('0xPoolId');
// Returns: [{ tickLower, tickUpper, netLiquidity }]

// Protocol stats
const stats = await client.suidex.api.getStats();
// Returns: { totalPools, totalTvlUsd, totalVolume24hUsd, totalSwaps24h, activePositions }
```

### APR Estimation

```typescript
import { SuiDexCLMMClient } from '@suidex/clmm-sdk';

// Fee APR
const feeAPR = SuiDexCLMMClient.estimateFeeAPR({
  volume24hUsd: 50000,
  feeRate: 3000, // 0.30%
  positionLiquidity: position.liquidity,
  poolLiquidity: pool.liquidity,
  positionValueUsd: 1000,
});

// Reward APR
const rewardAPR = SuiDexCLMMClient.estimateRewardAPR({
  rewardPerSecond: 1_000_000_000n,
  rewardDecimals: 9,
  rewardPriceUsd: 0.50,
  positionLiquidity: position.liquidity,
  poolLiquidity: pool.liquidity,
  positionValueUsd: 1000,
});
```

### Math Utilities

```typescript
import {
  tickToSqrtPrice, sqrtPriceToTick, sqrtPriceToPrice,
  priceToTick, tickToPrice,
  getAmountsForLiquidity, getLiquidityForAmounts,
} from '@suidex/clmm-sdk';

// Tick ↔ sqrt price (exact, integer)
const sqrtPrice = tickToSqrtPrice(5000);
const tick = sqrtPriceToTick(pool.sqrtPrice);

// Human-readable price
const price = sqrtPriceToPrice(pool.sqrtPrice, 9, 6); // decimalsX, decimalsY
const tick2 = priceToTick(1800, 9, 6, 60); // price, decimalsX, decimalsY, tickSpacing

// Position token amounts
const { amountX, amountY } = getAmountsForLiquidity(
  pool.sqrtPrice, tickToSqrtPrice(tickLower), tickToSqrtPrice(tickUpper), liquidity,
);

// Liquidity from token amounts
const liq = getLiquidityForAmounts(
  pool.sqrtPrice, tickToSqrtPrice(tickLower), tickToSqrtPrice(tickUpper), amountX, amountY,
);
```

### Event Types (for Indexers)

```typescript
import { EVENT_TYPES } from '@suidex/clmm-sdk';
import type { SwapEvent, AddLiquidityEvent } from '@suidex/clmm-sdk';

// Filter events by type
const swapEvents = txEvents.filter(e => e.type === EVENT_TYPES.Swap);
const parsed = swapEvents[0].parsedJson as SwapEvent;
console.log(parsed.amount_x, parsed.amount_y, parsed.fee_amount);

// Available: EVENT_TYPES.Swap, .AddLiquidity, .RemoveLiquidity,
//   .CollectFee, .CollectReward, .OpenPosition, .ClosePosition,
//   .FlashLoan, .PoolCreated, .RepayFlashSwap, .RepayFlashLoan
```

## Important Notes

### Amounts are in raw base units

All amounts use raw on-chain base units. Divide by `10^decimals` for human values. Check decimals via `suix_getCoinMetadata`.

### Slippage protection

All transaction builders accept `minAmountOut` / `minAmountX` / `minAmountY` for slippage. **Always set these in production.** Passing `0n` disables slippage checks.

### Fee rate encoding

Fee rates are integers where `1_000_000 = 100%`: 500 = 0.05%, 3000 = 0.30%, 10000 = 1.00%.

### Price representation

SuiDex V3 uses **Q64 fixed-point** sqrt prices (2^64 scale factor), different from Uniswap V3's Q96.

### Tick spacing

Ticks must be aligned to the pool's `tickSpacing`. Pass `tickSpacing` to `addLiquidity` for client-side validation (avoids wasting gas on contract abort code 19).

### Closing positions

Positions with unclaimed incentive rewards cannot be closed (contract abort code 30). Pass `rewardCoinTypes` when closing to auto-collect all rewards first.

## Constants

```typescript
import { MAINNET, MIN_TICK, MAX_TICK, Q64, FEE_DENOMINATOR } from '@suidex/clmm-sdk';

MAINNET.PACKAGE_ID          // V3 contract package
MAINNET.ORIGINAL_PACKAGE_ID // Original package (for struct types)
MAINNET.VERSION_ID          // Version object
MAINNET.CLOCK_ID            // Sui Clock (0x6)

MIN_TICK  // -443636
MAX_TICK  //  443636
Q64       // 2^64 (18446744073709551616n)
FEE_DENOMINATOR // 1_000_000n
```

## Custom Deployments

```typescript
const client = new SuiGrpcClient({ ... }).$extend(
  suidexCLMM({
    packageId: '0xYourPackage',
    versionId: '0xYourVersion',
    apiUrl: 'https://your-indexer.com',
  })
);
```

## Testing

```bash
SUI_PRIVATE_KEY=suiprivkey1... npx tsx --test test/sdk.test.ts
```

Tests execute real mainnet transactions (swap, LP, fees, rewards, flash loans). Requires a funded wallet with ~0.1 SUI.

## Contract

SuiDex V3 CLMM is an audited, MIT-licensed concentrated liquidity protocol on Sui.

- **Audit**: [SpyWolf Security Audit](https://github.com/AuditReports/Spywolf) — 0 critical, 0 high, 1 medium (JIT protection, resolved)
- **Package**: `0xb5f529c1dcda6580a61bf7ee9fbd524b50be62f11044d137c8202c8cbace9e56`
- **Contract source**: [suidex-v3-clmm](https://github.com/Suidex-V2/suidex-v3-clmm)

## License

MIT
