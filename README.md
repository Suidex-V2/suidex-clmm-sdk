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

The SuiDex CLMM SDK provides everything needed to interact with SuiDex V3 concentrated liquidity pools on Sui. Get quotes, build swap transactions, manage liquidity positions, and perform CLMM math calculations.

Built on the [Sui TypeScript SDK](https://sdk.mystenlabs.com/sui) using the official [client extension pattern](https://sdk.mystenlabs.com/sui/sdk-building), so it works with any Sui client (`SuiGrpcClient`, `SuiGraphQLClient`, or any `ClientWithCoreApi`).

### Features

- **On-chain quotes** — Exact swap output via `compute_swap_result` simulation (multi-tick accurate, not an approximation)
- **Transaction builders** — Swap, add/remove liquidity, collect fees — all return a `Transaction` ready for wallet signing
- **CLMM math** — Tick/price conversions, position amount calculations, liquidity math (Q64 fixed-point)
- **SIP-58 compatible** — Uses `coinWithBalance` for automatic coin object + address balance resolution
- **Transport agnostic** — Works with gRPC, GraphQL, or any Sui client
- **Zero dependencies** — Only `@mysten/sui` as a peer dependency

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

### Get a Quote

```typescript
const quote = await client.suidex.view.getQuote({
  poolId: '0x02c8...0629',
  tokenXType: '0x2::sui::SUI',
  tokenYType: '0x...::victory_token::VICTORY_TOKEN',
  isXtoY: true,
  amountIn: 1_000_000_000n, // 1 SUI (9 decimals)
});

console.log('Output:', quote.amountOut);       // Raw base units
console.log('Impact:', quote.priceImpact, '%'); // e.g. 0.46
console.log('Fee rate:', quote.feeRate);        // e.g. 3000 (= 0.30%)
```

### Build a Swap Transaction

```typescript
const tx = client.suidex.tx.swap({
  poolId: '0x02c8...0629',
  tokenXType: '0x2::sui::SUI',
  tokenYType: '0x...::victory_token::VICTORY_TOKEN',
  isXtoY: true,
  amountIn: 1_000_000_000n,
  minAmountOut: 0n,
  sender: '0xYourAddress',
});

// Sign with any Sui wallet
const result = await wallet.signAndExecuteTransaction({ transaction: tx });
```

### Read Pool State

```typescript
const pool = await client.suidex.getPool('0x02c8...0629');

console.log('Token X:', pool.tokenXType);
console.log('Token Y:', pool.tokenYType);
console.log('Sqrt Price:', pool.sqrtPrice);
console.log('Liquidity:', pool.liquidity);
console.log('Fee Rate:', pool.feeRate);       // 3000 = 0.30%
console.log('Tick Spacing:', pool.tickSpacing);
console.log('Current Tick:', pool.tickIndex);
```

### Add Liquidity

```typescript
// Open a new position and add liquidity
const tx = client.suidex.tx.addLiquidity({
  poolId: '0x02c8...0629',
  tokenXType: '0x2::sui::SUI',
  tokenYType: '0x...::victory_token::VICTORY_TOKEN',
  tickLower: 4200,
  tickUpper: 5400,
  amountX: 1_000_000_000n, // 1 SUI
  amountY: 500_000_000n,   // 500 VICTORY (6 decimals)
  sender: '0xYourAddress',
});

// Add to an existing position
const tx2 = client.suidex.tx.addLiquidity({
  // ...same params...
  existingPositionId: '0xPositionId',
});
```

### Remove Liquidity

```typescript
const tx = client.suidex.tx.removeLiquidity({
  poolId: '0x02c8...0629',
  positionId: '0xPositionId',
  tokenXType: '0x2::sui::SUI',
  tokenYType: '0x...::victory_token::VICTORY_TOKEN',
  liquidityAmount: 1_000_000n,
  sender: '0xYourAddress',
  closePosition: false, // Set true to close the position entirely
});
```

### Collect Fees

```typescript
const tx = client.suidex.tx.collectFees({
  poolId: '0x02c8...0629',
  positionId: '0xPositionId',
  tokenXType: '0x2::sui::SUI',
  tokenYType: '0x...::victory_token::VICTORY_TOKEN',
  sender: '0xYourAddress',
});
```

## Math Utilities

The SDK exports CLMM math functions for working with ticks, prices, and positions.

```typescript
import {
  tickToSqrtPrice,
  sqrtPriceToPrice,
  priceToTick,
  tickToPrice,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
} from '@suidex/clmm-sdk';

// Convert between ticks and prices
const sqrtPrice = tickToSqrtPrice(5000);
const price = sqrtPriceToPrice(sqrtPrice, 9, 6); // decimalsX, decimalsY
const tick = priceToTick(1800, 9, 6, 60);         // price, decimalsX, decimalsY, tickSpacing

// Calculate position token amounts
const { amountX, amountY } = getAmountsForLiquidity(
  pool.sqrtPrice,                // current pool sqrt price
  tickToSqrtPrice(tickLower),    // lower bound
  tickToSqrtPrice(tickUpper),    // upper bound
  positionLiquidity,             // position liquidity value
);

// Calculate liquidity from token amounts
const liquidity = getLiquidityForAmounts(
  pool.sqrtPrice,
  tickToSqrtPrice(tickLower),
  tickToSqrtPrice(tickUpper),
  amountX,
  amountY,
);
```

## Important Notes

### Amounts are in raw base units

All amounts in the SDK use raw on-chain base units (the smallest indivisible unit of each token). To convert to human-readable values, divide by `10^decimals`:

| Token | Decimals | 1.0 tokens = raw |
|-------|----------|-------------------|
| SUI   | 9        | `1_000_000_000`   |

Check each token's decimals via `suix_getCoinMetadata`. The SDK does not assume decimals for any token.

### Fee rate encoding

Fee rates are stored as integers where `1_000_000 = 100%`:

| Fee rate value | Percentage |
|----------------|------------|
| 500            | 0.05%      |
| 3000           | 0.30%      |
| 10000          | 1.00%      |

### Price representation

SuiDex V3 uses **Q64 fixed-point** sqrt prices (2^64 scale factor), different from Uniswap V3's Q96. The `sqrtPriceToPrice()` function handles the conversion to human-readable prices — pass the correct decimals for each token.

### Swap mechanism

Swaps use the **flash_swap + repay_flash_swap** pattern (hot potato). The SDK builds the full PTB atomically — no partial execution is possible.

## Constants

```typescript
import { MAINNET, MIN_TICK, MAX_TICK, Q64 } from '@suidex/clmm-sdk';

MAINNET.PACKAGE_ID   // V3 contract package
MAINNET.VERSION_ID   // Version object
MAINNET.CLOCK_ID     // Sui Clock (0x6)

MIN_TICK  // -443636
MAX_TICK  //  443636
Q64       // 2^64 (18446744073709551616n)
```

## Custom Deployments

Override package IDs for testnet or custom deployments:

```typescript
const client = new SuiGrpcClient({ ... }).$extend(
  suidexCLMM({
    packageId: '0xYourPackage',
    versionId: '0xYourVersion',
  })
);
```

## Contract

SuiDex V3 CLMM is an audited, MIT-licensed concentrated liquidity protocol on Sui.

- **Audits**: [SpyWolf](https://github.com/AuditReports) | [HackenProof](https://hackenproof.com)
- **Contract source**: [suidex-v3-clmm](https://github.com/Suidex-V2/suidex-v3-clmm)

## License

MIT
