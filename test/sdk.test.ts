/**
 * SDK Integration Tests — runs against Sui mainnet
 *
 * Tests pool fetching, quoting, transaction building, and math utilities
 * using the live SUI/VICTORY V3 pool.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { suidexCLMM } from '../src/sdk.js';
import {
  tickToSqrtPrice, sqrtPriceToPrice, priceToTick, tickToPrice,
  getAmountsForLiquidity, getLiquidityForAmounts,
} from '../src/math.js';
import { MIN_TICK, MAX_TICK, MIN_SQRT_PRICE, MAX_SQRT_PRICE, Q64 } from '../src/constants.js';

// ─── Test Config ─────────────────────────────────────────────────

const SUI_VICTORY_POOL = '0x02c83820cc8412e103d6520424a380e207e43033cad040e72331a719335f0629';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const VICTORY_TYPE = '0xbfac5e1c6bf6ef29b12f7723857695fd2f4da9a11a7d88162c15e9124c243a4a::victory_token::VICTORY_TOKEN';

const client = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
}).$extend(suidexCLMM());

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

// ─── Tests ───────────────────────────────────────────────────────

async function testGetPool() {
  console.log('\n=== getPool ===');
  const pool = await client.suidex.getPool(SUI_VICTORY_POOL);

  assert(pool.poolId === SUI_VICTORY_POOL, 'poolId matches');
  assert(pool.sqrtPrice > 0n, `sqrtPrice is positive: ${pool.sqrtPrice}`);
  assert(pool.liquidity > 0n, `liquidity is positive: ${pool.liquidity}`);
  assert(pool.feeRate > 0, `feeRate is set: ${pool.feeRate}`);
  assert(pool.tickSpacing > 0, `tickSpacing is set: ${pool.tickSpacing}`);
  assert(pool.tokenXType.includes('sui::SUI') || pool.tokenYType.includes('sui::SUI'),
    'One token is SUI');

  return pool;
}

async function testGetQuote() {
  console.log('\n=== view.getQuote ===');

  // Small swap: 1 SUI → VICTORY
  const quote1 = await client.suidex.view.getQuote({
    poolId: SUI_VICTORY_POOL,
    tokenXType: SUI_TYPE,
    tokenYType: VICTORY_TYPE,
    isXtoY: true,
    amountIn: 1_000_000_000n, // 1 SUI
  });

  assert(quote1.amountOut > 0n, `1 SUI → ${quote1.amountOut} VICTORY`);
  assert(quote1.priceImpact >= 0, `priceImpact: ${quote1.priceImpact}%`);
  assert(quote1.sqrtPriceAfter > 0n, `sqrtPriceAfter: ${quote1.sqrtPriceAfter}`);
  assert(quote1.sqrtPriceAfter < quote1.amountIn * Q64, 'sqrtPriceAfter is reasonable');
  assert(quote1.isXtoY === true, 'isXtoY correct');
  assert(quote1.poolId === SUI_VICTORY_POOL, 'poolId correct');

  // Reverse: VICTORY → SUI
  const quote2 = await client.suidex.view.getQuote({
    poolId: SUI_VICTORY_POOL,
    tokenXType: SUI_TYPE,
    tokenYType: VICTORY_TYPE,
    isXtoY: false,
    amountIn: quote1.amountOut, // swap back what we got
  });

  assert(quote2.amountOut > 0n, `${quote1.amountOut} VICTORY → ${quote2.amountOut} SUI`);
  // Round-trip should lose some to fees + slippage
  assert(quote2.amountOut < 1_000_000_000n, 'Round-trip loses to fees (expected)');
  assert(quote2.amountOut > 900_000_000n, 'Round-trip doesn\'t lose more than 10%');

  // Larger swap: 10 SUI → VICTORY (should have higher impact)
  const quote3 = await client.suidex.view.getQuote({
    poolId: SUI_VICTORY_POOL,
    tokenXType: SUI_TYPE,
    tokenYType: VICTORY_TYPE,
    isXtoY: true,
    amountIn: 10_000_000_000n, // 10 SUI
  });

  assert(quote3.amountOut > quote1.amountOut, '10 SUI gets more than 1 SUI');
  assert(quote3.amountOut < quote1.amountOut * 10n, '10 SUI gets less than 10x (slippage)');
  assert(quote3.priceImpact >= quote1.priceImpact, 'Larger swap has >= price impact');

  return quote1;
}

async function testBuildSwap() {
  console.log('\n=== tx.swap ===');

  const tx = client.suidex.tx.swap({
    poolId: SUI_VICTORY_POOL,
    tokenXType: SUI_TYPE,
    tokenYType: VICTORY_TYPE,
    isXtoY: true,
    amountIn: 1_000_000_000n,
    minAmountOut: 0n,
    sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
  });

  assert(tx !== null, 'Transaction created');

  // Simulate the TX to verify it's valid
  const result = await client.core.simulateTransaction({
    transaction: tx,
    checksEnabled: false,
    include: { effects: true },
  });

  const effects = (result as any)?.Transaction?.effects ?? (result as any)?.effects;
  const status = effects?.status;
  assert(status?.success === true || status?.status === 'success',
    `Swap TX simulation: ${status?.success ?? status?.status}`);
}

async function testBuildAddLiquidity() {
  console.log('\n=== tx.addLiquidity ===');

  const tx = client.suidex.tx.addLiquidity({
    poolId: SUI_VICTORY_POOL,
    tokenXType: SUI_TYPE,
    tokenYType: VICTORY_TYPE,
    tickLower: -6960,
    tickUpper: 6960,
    amountX: 100_000_000n, // 0.1 SUI
    amountY: 0n,
    sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
  });

  assert(tx !== null, 'AddLiquidity Transaction created');
  // Note: simulation may fail with zero address if it tries to access coins,
  // but the TX structure being valid is the key test
}

async function testBuildRemoveLiquidity() {
  console.log('\n=== tx.removeLiquidity ===');

  // Use a known position ID for structure validation
  const tx = client.suidex.tx.removeLiquidity({
    poolId: SUI_VICTORY_POOL,
    positionId: '0x0363e28247745c1f39e176c445cfa5212ea265ad3959466bc36df6e82581c105',
    tokenXType: SUI_TYPE,
    tokenYType: VICTORY_TYPE,
    liquidityAmount: 1000n,
    sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
  });

  assert(tx !== null, 'RemoveLiquidity Transaction created');
}

async function testBuildCollectFees() {
  console.log('\n=== tx.collectFees ===');

  const tx = client.suidex.tx.collectFees({
    poolId: SUI_VICTORY_POOL,
    positionId: '0x0363e28247745c1f39e176c445cfa5212ea265ad3959466bc36df6e82581c105',
    tokenXType: SUI_TYPE,
    tokenYType: VICTORY_TYPE,
    sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
  });

  assert(tx !== null, 'CollectFees Transaction created');
}

function testMath() {
  console.log('\n=== Math Utilities ===');

  // tickToSqrtPrice
  const sqrtAt0 = tickToSqrtPrice(0);
  assert(sqrtAt0 === Q64, `tick 0 → sqrtPrice = Q64 (${sqrtAt0})`);

  const sqrtAtPos = tickToSqrtPrice(1000);
  assert(sqrtAtPos > Q64, `tick 1000 → sqrtPrice > Q64 (${sqrtAtPos})`);

  const sqrtAtNeg = tickToSqrtPrice(-1000);
  assert(sqrtAtNeg < Q64, `tick -1000 → sqrtPrice < Q64 (${sqrtAtNeg})`);

  // Bounds
  const sqrtMin = tickToSqrtPrice(MIN_TICK);
  assert(sqrtMin >= MIN_SQRT_PRICE, `MIN_TICK sqrtPrice >= MIN_SQRT_PRICE`);

  const sqrtMax = tickToSqrtPrice(MAX_TICK);
  assert(sqrtMax <= MAX_SQRT_PRICE, `MAX_TICK sqrtPrice <= MAX_SQRT_PRICE`);

  // sqrtPriceToPrice
  const price = sqrtPriceToPrice(Q64, 9, 9); // same decimals, tick 0 → price 1.0
  assert(Math.abs(price - 1.0) < 0.001, `Price at tick 0: ${price} ≈ 1.0`);

  // priceToTick
  const tickBack = priceToTick(1.0, 9, 9, 1);
  assert(tickBack === 0, `Price 1.0 → tick ${tickBack} = 0`);

  // tickToPrice round-trip
  const tick = 5000;
  const p = tickToPrice(tick, 9, 6);
  const tickRT = priceToTick(p, 9, 6, 1);
  assert(Math.abs(tickRT - tick) <= 1, `Tick round-trip: ${tick} → ${p} → ${tickRT}`);

  // getAmountsForLiquidity — below range
  const sqrtLower = tickToSqrtPrice(1000);
  const sqrtUpper = tickToSqrtPrice(2000);
  const sqrtBelow = tickToSqrtPrice(500);
  const { amountX: belowX, amountY: belowY } = getAmountsForLiquidity(sqrtBelow, sqrtLower, sqrtUpper, 1_000_000_000_000n);
  assert(belowX > 0n, `Below range: amountX > 0 (${belowX})`);
  assert(belowY === 0n, `Below range: amountY = 0`);

  // getAmountsForLiquidity — above range
  const sqrtAbove = tickToSqrtPrice(3000);
  const { amountX: aboveX, amountY: aboveY } = getAmountsForLiquidity(sqrtAbove, sqrtLower, sqrtUpper, 1_000_000_000_000n);
  assert(aboveX === 0n, `Above range: amountX = 0`);
  assert(aboveY > 0n, `Above range: amountY > 0 (${aboveY})`);

  // getAmountsForLiquidity — in range
  const sqrtMid = tickToSqrtPrice(1500);
  const { amountX: midX, amountY: midY } = getAmountsForLiquidity(sqrtMid, sqrtLower, sqrtUpper, 1_000_000_000_000n);
  assert(midX > 0n, `In range: amountX > 0 (${midX})`);
  assert(midY > 0n, `In range: amountY > 0 (${midY})`);

  // getLiquidityForAmounts — round-trip
  const liq = getLiquidityForAmounts(sqrtMid, sqrtLower, sqrtUpper, midX, midY);
  assert(liq > 0n, `getLiquidityForAmounts: ${liq}`);
  // Should be close to our input liquidity (1T)
  const diff = liq > 1_000_000_000_000n ? liq - 1_000_000_000_000n : 1_000_000_000_000n - liq;
  assert(diff * 100n < 1_000_000_000_000n, `Liquidity round-trip within 1%: ${liq}`);

  // Edge: out of bounds tick
  let threw = false;
  try { tickToSqrtPrice(MIN_TICK - 1); } catch { threw = true; }
  assert(threw, 'Throws on tick below MIN_TICK');

  threw = false;
  try { tickToSqrtPrice(MAX_TICK + 1); } catch { threw = true; }
  assert(threw, 'Throws on tick above MAX_TICK');
}

// ─── Run All Tests ───────────────────────────────────────────────

async function main() {
  console.log('SuiDex V3 CLMM SDK — Integration Tests');
  console.log('Network: mainnet');
  console.log('Pool: SUI/VICTORY');

  try {
    testMath();
    await testGetPool();
    await testGetQuote();
    await testBuildSwap();
    await testBuildAddLiquidity();
    await testBuildRemoveLiquidity();
    await testBuildCollectFees();
  } catch (err) {
    console.error('\nFATAL:', err);
    failed++;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
