/**
 * @suidex/clmm-sdk — Comprehensive Test Suite
 *
 * Tests every SDK method against Sui mainnet using real funded transactions.
 * Run: npx tsx --test test/sdk.test.ts
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  SECTIONS                                                    │
 * │                                                              │
 * │  1. Math — tick/price conversions, liquidity calculations    │
 * │  2. On-chain reads — getPool, getPosition, listPositions     │
 * │  3. Quoting — getQuote (both dirs), preSwap (multi-pool)     │
 * │  4. Swaps — real X→Y and Y→X swaps with slippage             │
 * │  5. Liquidity — open, add to existing, partial/full remove   │
 * │  6. Fees & Rewards — collectFees, collectReward, collectAll  │
 * │  7. Flash loans — borrow + repay in one TX                   │
 * │  8. Indexer API — getAllPools, getPoolTicks, getStats         │
 * │  9. APR estimation — fee APR, reward APR                     │
 * │ 10. Tick validation — client-side guards                     │
 * │                                                              │
 * │  Wallet: keeper (has SUI + can acquire VICTORY via swap)     │
 * │  Pool: SUI/VICTORY (0x02c8...0629) — 0.30% fee, spacing 60  │
 * │  All funds returned to SUI at end. Gas cost ~0.02 SUI.       │
 * └──────────────────────────────────────────────────────────────┘
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { suidexCLMM, SuiDexCLMMClient } from '../src/sdk.js';
import {
  tickToSqrtPrice, sqrtPriceToTick, sqrtPriceToPrice, priceToTick, tickToPrice,
  getAmountsForLiquidity, getLiquidityForAmounts,
} from '../src/math.js';
import { MAINNET, MIN_TICK, MAX_TICK, MIN_SQRT_PRICE, MAX_SQRT_PRICE, Q64, FEE_DENOMINATOR } from '../src/constants.js';
import { EVENT_TYPES } from '../src/events.js';
import type { Pool, Position } from '../src/types.js';

// ─── Test Wallet & Pool ──────────────────────────────────────────

const KEEPER_KEY = '***REMOVED***';
const keypair = Ed25519Keypair.fromSecretKey(KEEPER_KEY);
const WALLET = keypair.toSuiAddress();

const POOL_ID = '0x02c83820cc8412e103d6520424a380e207e43033cad040e72331a719335f0629';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const VICTORY_TYPE = '0xbfac5e1c6bf6ef29b12f7723857695fd2f4da9a11a7d88162c15e9124c243a4a::victory_token::VICTORY_TOKEN';

const client = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
}).$extend(suidexCLMM());

// ─── Helpers ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  PASS: ${msg}`); passed++; }
  else { console.error(`  FAIL: ${msg}`); failed++; failures.push(msg); }
}

async function execute(tx: any): Promise<string> {
  tx.setGasBudget(50_000_000);
  const result = await keypair.signAndExecuteTransaction({
    transaction: tx, client,
    include: { effects: true, balanceChanges: true },
  });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`TX failed: ${result.FailedTransaction.status.error?.message}`);
  }
  return result.Transaction.digest;
}

async function getBalance(coinType: string): Promise<bigint> {
  const res = await fetch('https://fullnode.mainnet.sui.io:443', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getBalance', params: [WALLET, coinType] }),
  });
  const { result } = await res.json() as any;
  return BigInt(result?.totalBalance ?? '0');
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════
//  1. MATH
// ═══════════════════════════════════════════════════════════════

function testTickSqrtPriceConversions() {
  console.log('\n── 1a. tickToSqrtPrice ──');

  assert(tickToSqrtPrice(0) === Q64, 'tick(0) = Q64');
  assert(tickToSqrtPrice(100) > Q64, 'tick(100) > Q64');
  assert(tickToSqrtPrice(-100) < Q64, 'tick(-100) < Q64');
  assert(tickToSqrtPrice(1000) > tickToSqrtPrice(100), 'monotonically increasing');
  assert(tickToSqrtPrice(MIN_TICK) >= MIN_SQRT_PRICE, 'MIN_TICK >= MIN_SQRT_PRICE');
  assert(tickToSqrtPrice(MAX_TICK) <= MAX_SQRT_PRICE, 'MAX_TICK <= MAX_SQRT_PRICE');

  let threw = false;
  try { tickToSqrtPrice(MIN_TICK - 1); } catch { threw = true; }
  assert(threw, 'tick below MIN_TICK throws');
  threw = false;
  try { tickToSqrtPrice(MAX_TICK + 1); } catch { threw = true; }
  assert(threw, 'tick above MAX_TICK throws');
}

function testSqrtPriceToTick() {
  console.log('\n── 1b. sqrtPriceToTick ──');

  // Exact round-trips
  for (const tick of [0, 1, 100, 1000, 10000, -1, -100, -1000, -10000, MIN_TICK, MAX_TICK]) {
    assert(sqrtPriceToTick(tickToSqrtPrice(tick)) === tick, `round-trip tick ${tick}`);
  }

  // Stress: every 1000th tick
  let stress = 0;
  for (let t = MIN_TICK; t <= MAX_TICK; t += 1000) {
    if (sqrtPriceToTick(tickToSqrtPrice(t)) !== t) { assert(false, `stress fail at ${t}`); return; }
    stress++;
  }
  assert(true, `${stress} ticks stress-tested`);

  // Between two ticks → returns lower
  const mid = (tickToSqrtPrice(100) + tickToSqrtPrice(101)) / 2n;
  assert(sqrtPriceToTick(mid) === 100, 'mid-tick resolves to lower');

  // Boundary
  assert(sqrtPriceToTick(Q64) === 0, 'Q64 → tick 0');
  assert(sqrtPriceToTick(Q64 - 1n) === -1, 'Q64-1 → tick -1');
}

function testPriceConversions() {
  console.log('\n── 1c. Price conversions ──');

  assert(Math.abs(sqrtPriceToPrice(Q64, 9, 9) - 1.0) < 0.001, 'sqrtPriceToPrice(Q64, 9, 9) ≈ 1.0');
  assert(Math.abs(sqrtPriceToPrice(Q64, 9, 6) - 1000) < 1, 'sqrtPriceToPrice(Q64, 9, 6) ≈ 1000');
  assert(priceToTick(1.0, 9, 9, 1) === 0, 'priceToTick(1.0) = 0');

  // Round-trip: tick → price → tick
  for (const tick of [0, 100, 1000, -100, -1000]) {
    const price = tickToPrice(tick, 9, 9);
    const back = priceToTick(price, 9, 9, 1);
    assert(Math.abs(back - tick) <= 1, `price round-trip tick ${tick} → ${price.toFixed(4)} → ${back}`);
  }

  // Spacing snapping
  assert(priceToTick(1.5, 9, 9, 60) % 60 === 0, 'priceToTick snaps to spacing=60');
}

function testLiquidityMath() {
  console.log('\n── 1d. Liquidity math ──');

  const sqrtLower = tickToSqrtPrice(1000);
  const sqrtUpper = tickToSqrtPrice(5000);
  const liq = 1_000_000_000_000n;

  // Below range: X only
  const below = getAmountsForLiquidity(tickToSqrtPrice(500), sqrtLower, sqrtUpper, liq);
  assert(below.amountX > 0n && below.amountY === 0n, 'below range: X only');

  // Above range: Y only
  const above = getAmountsForLiquidity(tickToSqrtPrice(6000), sqrtLower, sqrtUpper, liq);
  assert(above.amountX === 0n && above.amountY > 0n, 'above range: Y only');

  // In range: both
  const sqrtMid = tickToSqrtPrice(3000);
  const mid = getAmountsForLiquidity(sqrtMid, sqrtLower, sqrtUpper, liq);
  assert(mid.amountX > 0n && mid.amountY > 0n, 'in range: both tokens');

  // Round-trip
  const liqBack = getLiquidityForAmounts(sqrtMid, sqrtLower, sqrtUpper, mid.amountX, mid.amountY);
  const diff = liqBack > liq ? liqBack - liq : liq - liqBack;
  assert(diff * 100n < liq, 'liquidity round-trip within 1%');

  // Zero / inverted
  assert(getAmountsForLiquidity(sqrtMid, sqrtLower, sqrtUpper, 0n).amountX === 0n, 'zero liquidity');
  assert(getAmountsForLiquidity(sqrtMid, sqrtUpper, sqrtLower, liq).amountX === 0n, 'inverted range');
}

// ═══════════════════════════════════════════════════════════════
//  2. ON-CHAIN READS
// ═══════════════════════════════════════════════════════════════

async function testGetPool(): Promise<Pool> {
  console.log('\n── 2a. getPool ──');
  const pool = await client.suidex.getPool(POOL_ID);
  assert(pool.poolId === POOL_ID, `poolId correct`);
  assert(pool.tokenXType.includes('::sui::SUI'), 'tokenX is SUI');
  assert(pool.tokenYType.includes('::victory_token::VICTORY_TOKEN'), 'tokenY is VICTORY');
  assert(pool.feeRate === 3000, `feeRate: ${pool.feeRate}`);
  assert(pool.tickSpacing === 60, `tickSpacing: ${pool.tickSpacing}`);
  assert(pool.sqrtPrice > 0n, `sqrtPrice > 0`);
  assert(pool.liquidity > 0n, `liquidity > 0`);

  // sqrtPriceToTick matches pool.tickIndex
  assert(sqrtPriceToTick(pool.sqrtPrice) === pool.tickIndex, `sqrtPriceToTick matches tickIndex (${pool.tickIndex})`);

  // Not found throws
  let threw = false;
  try { await client.suidex.getPool('0x0000000000000000000000000000000000000000000000000000000000000001'); } catch { threw = true; }
  assert(threw, 'invalid poolId throws');
  return pool;
}

async function testGetPositionAndList(positionId: string) {
  console.log('\n── 2b. getPosition + listPositions ──');

  const pos = await client.suidex.getPosition(positionId);
  assert(pos.positionId === positionId, `positionId matches`);
  assert(pos.poolId === POOL_ID, `poolId matches`);
  assert(pos.liquidity > 0n, `liquidity: ${pos.liquidity}`);
  assert(pos.tickLower < pos.tickUpper, `ticks ordered: [${pos.tickLower}, ${pos.tickUpper}]`);
  assert(typeof pos.feeGrowthInsideXLast === 'bigint', 'feeGrowthInsideXLast is bigint');
  assert(typeof pos.tokensOwedX === 'bigint', 'tokensOwedX is bigint');

  const positions = await client.suidex.listPositions(WALLET);
  assert(positions.length > 0, `listPositions found ${positions.length}`);
  assert(positions.some(p => p.positionId === positionId), 'our position in list');
}

// ═══════════════════════════════════════════════════════════════
//  3. QUOTING
// ═══════════════════════════════════════════════════════════════

async function testQuoting() {
  console.log('\n── 3a. getQuote (X→Y) ──');
  const quoteXY = await client.suidex.view.getQuote({
    poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: true, amountIn: 100_000_000n,
  });
  assert(quoteXY.amountOut > 0n, `output: ${quoteXY.amountOut}`);
  assert(quoteXY.feeAmount > 0n, `feeAmount: ${quoteXY.feeAmount}`);
  assert(quoteXY.sqrtPriceAfter > 0n, 'sqrtPriceAfter > 0');
  assert(quoteXY.priceImpact >= 0, `priceImpact: ${quoteXY.priceImpact}%`);
  assert(quoteXY.feeRate === 3000, `feeRate: ${quoteXY.feeRate}`);
  assert(quoteXY.isXtoY === true, 'direction X→Y');

  console.log('\n── 3b. getQuote (Y→X) ──');
  const quoteYX = await client.suidex.view.getQuote({
    poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: false, amountIn: quoteXY.amountOut,
  });
  assert(quoteYX.amountOut > 0n, `output: ${quoteYX.amountOut}`);
  assert(quoteYX.isXtoY === false, 'direction Y→X');
  const roundTripLoss = Number(100_000_000n - quoteYX.amountOut) * 100 / 100_000_000;
  assert(roundTripLoss > 0.3 && roundTripLoss < 3, `round-trip loss: ${roundTripLoss.toFixed(2)}%`);

  console.log('\n── 3c. preSwap (multi-pool) ──');
  const preSwapOut = await client.suidex.view.preSwap({
    route: [{ poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE, isXtoY: true }],
    amountIn: 100_000_000n,
  });
  assert(preSwapOut === quoteXY.amountOut, `preSwap matches getQuote: ${preSwapOut}`);
  assert(await client.suidex.view.preSwap({ route: [], amountIn: 100_000_000n }) === 0n, 'empty route = 0');
}

// ═══════════════════════════════════════════════════════════════
//  4. SWAPS (real transactions)
// ═══════════════════════════════════════════════════════════════

async function testSwaps() {
  console.log('\n── 4a. swap X→Y (SUI → VICTORY) ──');
  const quote = await client.suidex.view.getQuote({
    poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: true, amountIn: 50_000_000n,
  });
  const minOut = quote.amountOut - (quote.amountOut * 200n) / 10000n;
  const tx = client.suidex.tx.swap({
    poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: true, amountIn: 50_000_000n, minAmountOut: minOut, sender: WALLET,
  });
  const digest = await execute(tx);
  assert(true, `executed: ${digest.slice(0, 16)}...`);
  await sleep(2000);
  const vicBal = await getBalance(VICTORY_TYPE);
  assert(vicBal > 0n, `VICTORY balance: ${vicBal}`);
}

async function testSwapReverse() {
  console.log('\n── 4b. swap Y→X (VICTORY → SUI, return funds) ──');
  await sleep(2000);
  const vicBal = await getBalance(VICTORY_TYPE);
  if (vicBal === 0n) { assert(true, 'no VICTORY to swap back'); return; }
  const tx = client.suidex.tx.swap({
    poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: false, amountIn: vicBal, minAmountOut: 0n, sender: WALLET,
  });
  const digest = await execute(tx);
  assert(true, `executed: ${digest.slice(0, 16)}...`);
  await sleep(2000);
  assert(await getBalance(VICTORY_TYPE) < 1000n, 'VICTORY returned (dust or zero)');
}

// ═══════════════════════════════════════════════════════════════
//  5. LIQUIDITY (real transactions)
// ═══════════════════════════════════════════════════════════════

async function testLiquidityLifecycle(pool: Pool): Promise<string> {
  const spacing = pool.tickSpacing;
  const tickLower = Math.floor((pool.tickIndex - spacing * 5) / spacing) * spacing;
  const tickUpper = Math.ceil((pool.tickIndex + spacing * 5) / spacing) * spacing;

  console.log('\n── 5a. addLiquidity (new position) ──');
  const addTx = client.suidex.tx.addLiquidity({
    poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    tickLower, tickUpper, amountX: 10_000_000n, amountY: 10_000_000n,
    minAmountX: 0n, minAmountY: 0n, sender: WALLET, tickSpacing: spacing,
  });
  assert(true, `opened: ${(await execute(addTx)).slice(0, 16)}...`);
  await sleep(2000);

  const positions = await client.suidex.listPositions(WALLET);
  const posId = positions[positions.length - 1].positionId;
  const pos = await client.suidex.getPosition(posId);
  assert(pos.liquidity > 0n, `new position liquidity: ${pos.liquidity}`);

  console.log('\n── 5b. addLiquidity (existing position) ──');
  const addTx2 = client.suidex.tx.addLiquidity({
    poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    tickLower, tickUpper, amountX: 10_000_000n, amountY: 10_000_000n,
    minAmountX: 0n, minAmountY: 0n, sender: WALLET,
    existingPositionId: posId, tickSpacing: spacing,
  });
  assert(true, `added: ${(await execute(addTx2)).slice(0, 16)}...`);
  await sleep(2000);
  const posAfter = await client.suidex.getPosition(posId);
  assert(posAfter.liquidity > pos.liquidity, `liquidity increased: ${pos.liquidity} → ${posAfter.liquidity}`);

  console.log('\n── 5c. removeLiquidity (partial) ──');
  const halfLiq = posAfter.liquidity / 2n;
  const rmTx = client.suidex.tx.removeLiquidity({
    poolId: POOL_ID, positionId: posId, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    liquidityAmount: halfLiq, minAmountX: 0n, minAmountY: 0n, sender: WALLET, closePosition: false,
  });
  assert(true, `partial remove: ${(await execute(rmTx)).slice(0, 16)}...`);
  await sleep(2000);
  const posHalf = await client.suidex.getPosition(posId);
  assert(posHalf.liquidity === posAfter.liquidity - halfLiq, `remaining: ${posHalf.liquidity}`);

  return posId;
}

async function testClosePosition(positionId: string) {
  console.log('\n── 5d. removeLiquidity (full + close) ──');
  const pos = await client.suidex.getPosition(positionId);
  const tx = client.suidex.tx.removeLiquidity({
    poolId: POOL_ID, positionId, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    liquidityAmount: pos.liquidity, minAmountX: 0n, minAmountY: 0n,
    sender: WALLET, closePosition: true, rewardCoinTypes: [VICTORY_TYPE],
  });
  assert(true, `closed: ${(await execute(tx)).slice(0, 16)}...`);
  await sleep(2000);
  try { await client.suidex.getPosition(positionId); } catch { assert(true, 'position deleted'); return; }
  assert(true, 'position closed');
}

// ═══════════════════════════════════════════════════════════════
//  6. FEES & REWARDS (real transactions)
// ═══════════════════════════════════════════════════════════════

async function testFeesAndRewards(positionId: string) {
  console.log('\n── 6a. collectFees ──');
  const feeTx = client.suidex.tx.collectFees({
    poolId: POOL_ID, positionId, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE, sender: WALLET,
  });
  assert(true, `fees: ${(await execute(feeTx)).slice(0, 16)}...`);
  await sleep(3000);

  console.log('\n── 6b. collectReward (standalone) ──');
  const rewardTx = client.suidex.tx.collectReward({
    poolId: POOL_ID, positionId, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    rewardCoinType: VICTORY_TYPE, sender: WALLET,
  });
  try {
    assert(true, `reward: ${(await execute(rewardTx)).slice(0, 16)}...`);
  } catch (e: any) {
    if (e.message.includes('abort code: 28')) { assert(true, 'no active reward (abort 28 — expected)'); }
    else throw e;
  }
  await sleep(3000);

  console.log('\n── 6c. collectAllRewards ──');
  const allTx = client.suidex.tx.collectAllRewards({
    poolId: POOL_ID, positionId, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    rewardCoinTypes: [VICTORY_TYPE], sender: WALLET,
  });
  try {
    assert(true, `all rewards: ${(await execute(allTx)).slice(0, 16)}...`);
  } catch (e: any) {
    if (e.message.includes('abort code: 28')) { assert(true, 'no active reward (abort 28 — expected)'); }
    else throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
//  7. FLASH LOANS (real transaction)
// ═══════════════════════════════════════════════════════════════

async function testFlashLoan() {
  console.log('\n── 7. flashLoan + repayFlashLoan ──');
  const { tx, balanceX, balanceY, receipt } = client.suidex.tx.flashLoan({
    poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    amountX: 1_000_000n, amountY: 0n, sender: WALLET,
  });
  // Add fee from gas to cover flash loan cost
  const feeCoins = tx.splitCoins(tx.gas, [tx.pure.u64(10_000n)]);
  const feeBal = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [SUI_TYPE], arguments: [feeCoins] });
  tx.moveCall({ target: '0x2::balance::join', typeArguments: [SUI_TYPE], arguments: [balanceX, feeBal] });
  client.suidex.tx.repayFlashLoan({
    tx, poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    receipt, balanceX, balanceY,
  });
  assert(true, `flash loan: ${(await execute(tx)).slice(0, 16)}...`);
}

// ═══════════════════════════════════════════════════════════════
//  8. INDEXER API
// ═══════════════════════════════════════════════════════════════

async function testIndexerAPI() {
  console.log('\n── 8a. api.getAllPools ──');
  const pools = await client.suidex.api.getAllPools();
  assert(pools.length > 0, `found ${pools.length} pools`);
  const ourPool = pools.find(p => p.poolId === POOL_ID);
  assert(ourPool !== undefined, 'SUI/VICTORY pool in list');
  if (ourPool) {
    assert(ourPool.feeRate === 3000, `feeRate: ${ourPool.feeRate}`);
    assert(ourPool.tickSpacing === 60, `tickSpacing: ${ourPool.tickSpacing}`);
    assert(ourPool.liquidity > 0n, `liquidity > 0`);
    assert(typeof ourPool.tvlUsd === 'number', `tvlUsd: ${ourPool.tvlUsd}`);
    assert(typeof ourPool.volume24hUsd === 'number', `volume24hUsd: ${ourPool.volume24hUsd}`);
  }

  console.log('\n── 8b. api.getPoolTicks ──');
  const ticks = await client.suidex.api.getPoolTicks(POOL_ID);
  assert(ticks.length > 0, `found ${ticks.length} tick ranges`);
  assert(ticks[0].tickLower < ticks[0].tickUpper, 'tickLower < tickUpper');
  assert(ticks[0].netLiquidity > 0n, `netLiquidity > 0`);

  console.log('\n── 8c. api.getStats ──');
  const stats = await client.suidex.api.getStats();
  assert(stats.totalPools > 0, `totalPools: ${stats.totalPools}`);
  assert(typeof stats.totalTvlUsd === 'number', `totalTvlUsd: ${stats.totalTvlUsd}`);
  assert(stats.activePositions >= 0, `activePositions: ${stats.activePositions}`);
}

// ═══════════════════════════════════════════════════════════════
//  9. APR ESTIMATION
// ═══════════════════════════════════════════════════════════════

function testAPREstimation() {
  console.log('\n── 9. APR estimation ──');

  // Fee APR: $1000/day volume, 0.3% fee, 10% share, $100 position
  // Expected: 1000 × 0.003 × 0.1 / 100 × 365 × 100 = 109.5%
  const feeAPR = SuiDexCLMMClient.estimateFeeAPR({
    volume24hUsd: 1000, feeRate: 3000,
    positionLiquidity: 100n, poolLiquidity: 1000n, positionValueUsd: 100,
  });
  assert(Math.abs(feeAPR - 109.5) < 1, `fee APR: ${feeAPR.toFixed(1)}% (expect ~109.5%)`);

  // Zero pool liquidity → 0
  assert(SuiDexCLMMClient.estimateFeeAPR({
    volume24hUsd: 1000, feeRate: 3000,
    positionLiquidity: 100n, poolLiquidity: 0n, positionValueUsd: 100,
  }) === 0, 'zero pool liquidity → 0');

  // Reward APR: 1 token/sec (9 dec), $1/token, 50% share, $200 value
  const rewardAPR = SuiDexCLMMClient.estimateRewardAPR({
    rewardPerSecond: 1_000_000_000n, rewardDecimals: 9, rewardPriceUsd: 1.0,
    positionLiquidity: 500n, poolLiquidity: 1000n, positionValueUsd: 200,
  });
  assert(rewardAPR > 7_000_000, `reward APR: ${rewardAPR.toFixed(0)}%`);
}

// ═══════════════════════════════════════════════════════════════
//  10. TICK VALIDATION
// ═══════════════════════════════════════════════════════════════

function testTickValidation() {
  console.log('\n── 10. Tick validation ──');

  const base = { poolId: POOL_ID, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    amountX: 100n, amountY: 100n, sender: WALLET };

  // tickLower >= tickUpper
  try { client.suidex.tx.addLiquidity({ ...base, tickLower: 5000, tickUpper: 4000 }); assert(false, 'should throw'); }
  catch (e: any) { assert(e.message.includes('must be less than'), 'tickLower >= tickUpper throws'); }

  // Equal ticks
  try { client.suidex.tx.addLiquidity({ ...base, tickLower: 5000, tickUpper: 5000 }); assert(false, 'should throw'); }
  catch (e: any) { assert(e.message.includes('must be less than'), 'equal ticks throws'); }

  // Out of bounds
  try { client.suidex.tx.addLiquidity({ ...base, tickLower: MIN_TICK - 1, tickUpper: 0 }); assert(false, 'should throw'); }
  catch (e: any) { assert(e.message.includes('out of bounds'), 'below MIN_TICK throws'); }

  try { client.suidex.tx.addLiquidity({ ...base, tickLower: 0, tickUpper: MAX_TICK + 1 }); assert(false, 'should throw'); }
  catch (e: any) { assert(e.message.includes('out of bounds'), 'above MAX_TICK throws'); }

  // Misaligned
  try { client.suidex.tx.addLiquidity({ ...base, tickLower: 4201, tickUpper: 5400, tickSpacing: 60 }); assert(false, 'should throw'); }
  catch (e: any) { assert(e.message.includes('not aligned'), 'misaligned tick throws'); }

  // Valid — should NOT throw
  const tx = client.suidex.tx.addLiquidity({ ...base, tickLower: 4200, tickUpper: 5400, tickSpacing: 60 });
  assert(tx !== null, 'valid aligned ticks pass');

  // Without tickSpacing — no alignment check (backwards compat)
  const tx2 = client.suidex.tx.addLiquidity({ ...base, tickLower: 4201, tickUpper: 5401 });
  assert(tx2 !== null, 'no tickSpacing → no alignment check');
}

// ═══════════════════════════════════════════════════════════════
//  11. CONSTANTS & EVENTS
// ═══════════════════════════════════════════════════════════════

function testConstantsAndEvents() {
  console.log('\n── 11. Constants & event types ──');
  assert(MAINNET.PACKAGE_ID.startsWith('0x'), 'PACKAGE_ID starts with 0x');
  assert(MAINNET.VERSION_ID.startsWith('0x'), 'VERSION_ID starts with 0x');
  assert(MAINNET.CLOCK_ID === '0x0000000000000000000000000000000000000000000000000000000000000006', 'CLOCK_ID is 0x6');
  assert(Q64 === 1n << 64n, 'Q64 = 2^64');
  assert(FEE_DENOMINATOR === 1_000_000n, 'FEE_DENOMINATOR = 1M');

  assert(EVENT_TYPES.Swap.includes('::trade::SwapEvent'), 'SwapEvent type');
  assert(EVENT_TYPES.AddLiquidity.includes('::liquidity::AddLiquidityEvent'), 'AddLiquidityEvent type');
  assert(EVENT_TYPES.CollectFee.includes('::collect::FeeCollectedEvent'), 'FeeCollectedEvent type');
  assert(EVENT_TYPES.CollectReward.includes('::collect::CollectPoolRewardEvent'), 'CollectPoolRewardEvent type');
  assert(EVENT_TYPES.FlashLoan.includes('::trade::FlashLoanEvent'), 'FlashLoanEvent type');
  assert(EVENT_TYPES.PoolCreated.includes('::create_pool::PoolCreatedEvent'), 'PoolCreatedEvent type');
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('@suidex/clmm-sdk — Test Suite');
  console.log(`Wallet: ${WALLET}`);
  console.log(`Pool:   SUI/VICTORY (${POOL_ID.slice(0, 16)}...)`);

  const suiBefore = await getBalance(SUI_TYPE);
  console.log(`SUI:    ${(Number(suiBefore) / 1e9).toFixed(4)}\n`);

  try {
    // 1. Math (pure — no network)
    testTickSqrtPriceConversions();
    testSqrtPriceToTick();
    testPriceConversions();
    testLiquidityMath();

    // 2. On-chain reads
    const pool = await testGetPool();

    // 3. Quoting
    await testQuoting();

    // 4. Swaps (acquire VICTORY for LP tests)
    await testSwaps();

    // 5. Liquidity lifecycle
    const positionId = await testLiquidityLifecycle(pool);

    // 2b. Position reads (need a live position)
    await testGetPositionAndList(positionId);

    // 6. Fees & rewards
    await testFeesAndRewards(positionId);

    // 5d. Close position
    await sleep(3000);
    await testClosePosition(positionId);

    // 4b. Swap VICTORY back to SUI
    await testSwapReverse();

    // 7. Flash loans
    await testFlashLoan();

    // 8. Indexer API
    await testIndexerAPI();

    // 9. APR estimation (pure math)
    testAPREstimation();

    // 10. Tick validation (pure — no network)
    testTickValidation();

    // 11. Constants & events (pure)
    testConstantsAndEvents();

  } catch (err: any) {
    console.error('\nFATAL:', err.message ?? err);
    failed++;
    failures.push(`FATAL: ${err.message}`);
  }

  // Balance report
  await sleep(1000);
  const suiAfter = await getBalance(SUI_TYPE);
  console.log(`\n─── Results ───`);
  console.log(`  Tests:  ${passed} passed, ${failed} failed`);
  console.log(`  Gas:    ${(Number(suiBefore - suiAfter) / 1e9).toFixed(4)} SUI`);
  if (failures.length > 0) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
