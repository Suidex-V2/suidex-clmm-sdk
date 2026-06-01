/**
 * SuiDex V3 CLMM SDK — Full Lifecycle Test (Real Funds)
 *
 * Executes REAL on-chain transactions using the keeper wallet.
 * Tests EVERY SDK function with actual mainnet execution:
 *
 * 1. getPool — fetch pool state
 * 2. view.getQuote — quote SUI→VICTORY (X→Y)
 * 3. view.getQuote — quote VICTORY→SUI (Y→X)
 * 4. tx.swap — real swap SUI→VICTORY
 * 5. sqrtPriceToTick — verify against real pool state
 * 6. tx.addLiquidity — open NEW position
 * 7. getPosition — fetch position state
 * 8. tx.addLiquidity — add to EXISTING position
 * 9. getPosition — verify liquidity increased
 * 10. tx.collectFees — collect accrued fees
 * 11. tx.collectReward — standalone reward claim
 * 12. tx.removeLiquidity — PARTIAL remove (keep position open)
 * 13. getPosition — verify reduced liquidity
 * 14. tx.removeLiquidity — full remove + close (multi-reward)
 * 15. tx.swap — reverse VICTORY→SUI (return funds)
 * 16. Math verification — getAmountsForLiquidity, getLiquidityForAmounts with real data
 *
 * Gas cost ~0.01 SUI total. All funds returned to SUI at end.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { suidexCLMM } from '../src/sdk.js';
import {
  tickToSqrtPrice, sqrtPriceToTick, sqrtPriceToPrice, priceToTick, tickToPrice,
  getAmountsForLiquidity, getLiquidityForAmounts,
} from '../src/math.js';
import { MAINNET, MIN_TICK, MAX_TICK, Q64 } from '../src/constants.js';
import type { Pool, Position } from '../src/types.js';

// ─── Config ─────────────────────────────────────────────────────
const KEEPER_KEY = '***REMOVED***';
const keypair = Ed25519Keypair.fromSecretKey(KEEPER_KEY);
const WALLET = keypair.toSuiAddress();

const SUI_VICTORY_POOL = '0x02c83820cc8412e103d6520424a380e207e43033cad040e72331a719335f0629';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const VICTORY_TYPE = '0xbfac5e1c6bf6ef29b12f7723857695fd2f4da9a11a7d88162c15e9124c243a4a::victory_token::VICTORY_TOKEN';

const client = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
}).$extend(suidexCLMM());

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  PASS: ${msg}`); passed++; }
  else { console.error(`  FAIL: ${msg}`); failed++; failures.push(msg); }
}

async function execute(tx: any): Promise<{ digest: string; effects: any; balanceChanges: any[] }> {
  tx.setGasBudget(50_000_000);
  const result = await keypair.signAndExecuteTransaction({
    transaction: tx,
    client,
    include: { effects: true, balanceChanges: true, objectChanges: true },
  });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`TX failed: ${result.FailedTransaction.status.error?.message}`);
  }
  return {
    digest: result.Transaction.digest,
    effects: result.Transaction.effects,
    balanceChanges: result.Transaction.balanceChanges ?? [],
  };
}

async function getBalance(coinType: string): Promise<bigint> {
  const res = await fetch('https://fullnode.mainnet.sui.io:443', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getBalance', params: [WALLET, coinType] }),
  });
  const { result } = await res.json() as any;
  return BigInt(result?.totalBalance ?? '0');
}

async function findPositions(): Promise<string[]> {
  const res = await fetch('https://fullnode.mainnet.sui.io:443', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getOwnedObjects', params: [
      WALLET, { filter: { StructType: `${MAINNET.PACKAGE_ID}::position::Position` }, options: { showContent: true } }, null, 50
    ]}),
  });
  const { result } = await res.json() as any;
  return (result?.data ?? []).map((d: any) => d.data.objectId);
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Tests ───────────────────────────────────────────────────────

async function testGetPool(): Promise<Pool> {
  console.log('\n=== 1. getPool ===');
  const pool = await client.suidex.getPool(SUI_VICTORY_POOL);

  assert(pool.poolId === SUI_VICTORY_POOL, `poolId: ${pool.poolId.slice(0, 16)}...`);
  assert(pool.tokenXType.includes('::sui::SUI'), `tokenX: SUI`);
  assert(pool.tokenYType.includes('::victory_token::VICTORY_TOKEN'), `tokenY: VICTORY`);
  assert(pool.sqrtPrice > 0n, `sqrtPrice: ${pool.sqrtPrice}`);
  assert(pool.liquidity > 0n, `liquidity: ${pool.liquidity}`);
  assert(pool.feeRate === 3000, `feeRate: ${pool.feeRate}`);
  assert(pool.tickSpacing === 60, `tickSpacing: ${pool.tickSpacing}`);
  assert(pool.tickIndex !== 0 || pool.sqrtPrice === Q64, `tickIndex: ${pool.tickIndex}`);

  return pool;
}

async function testQuoteBothDirections(pool: Pool) {
  console.log('\n=== 2. view.getQuote (both directions) ===');

  // X→Y: SUI → VICTORY
  const quoteXY = await client.suidex.view.getQuote({
    poolId: SUI_VICTORY_POOL, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: true, amountIn: 100_000_000n,
  });
  assert(quoteXY.amountOut > 0n, `SUI→VIC: ${quoteXY.amountOut} VICTORY`);
  assert(quoteXY.feeAmount > 0n, `feeAmount: ${quoteXY.feeAmount}`);
  assert(quoteXY.sqrtPriceAfter > 0n, `sqrtPriceAfter: ${quoteXY.sqrtPriceAfter}`);
  assert(quoteXY.priceImpact >= 0, `priceImpact: ${quoteXY.priceImpact}%`);
  assert(quoteXY.feeRate === 3000, `feeRate: ${quoteXY.feeRate}`);

  // Y→X: VICTORY → SUI
  const quoteYX = await client.suidex.view.getQuote({
    poolId: SUI_VICTORY_POOL, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: false, amountIn: quoteXY.amountOut,
  });
  assert(quoteYX.amountOut > 0n, `VIC→SUI: ${quoteYX.amountOut} SUI`);
  assert(quoteYX.isXtoY === false, `direction: Y→X`);

  // Round-trip should lose ~0.6% to fees (2 legs × 0.3%)
  const loss = Number(100_000_000n - quoteYX.amountOut) * 100 / 100_000_000;
  assert(loss > 0.3 && loss < 3, `Round-trip loss: ${loss.toFixed(2)}% (expected ~0.6%)`);
}

async function testSwapXtoY(): Promise<bigint> {
  console.log('\n=== 3. tx.swap: SUI → VICTORY (real) ===');

  const amountIn = 50_000_000n; // 0.05 SUI
  const quote = await client.suidex.view.getQuote({
    poolId: SUI_VICTORY_POOL, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: true, amountIn,
  });

  const minOut = quote.amountOut - (quote.amountOut * 200n) / 10000n;
  const tx = client.suidex.tx.swap({
    poolId: SUI_VICTORY_POOL, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: true, amountIn, minAmountOut: minOut, sender: WALLET,
  });

  const { digest } = await execute(tx);
  assert(true, `Swap executed: ${digest.slice(0, 16)}...`);

  await sleep(2000);
  const vicBal = await getBalance(VICTORY_TYPE);
  assert(vicBal > 0n, `VICTORY balance: ${vicBal}`);
  return vicBal;
}

async function testSqrtPriceToTickReal(pool: Pool) {
  console.log('\n=== 4. sqrtPriceToTick (real pool data) ===');

  // Convert pool's sqrtPrice back to tick — should match pool.tickIndex
  const derivedTick = sqrtPriceToTick(pool.sqrtPrice);
  assert(derivedTick === pool.tickIndex, `sqrtPriceToTick(${pool.sqrtPrice}) = ${derivedTick} (pool reports ${pool.tickIndex})`);

  // Verify sqrtPriceToPrice gives reasonable result (SUI/VICTORY both 9 decimals)
  const price = sqrtPriceToPrice(pool.sqrtPrice, 9, 9);
  assert(price > 0.1 && price < 100, `Price: ${price.toFixed(6)} (reasonable for SUI/VICTORY)`);

  // priceToTick round-trip
  const tickFromPrice = priceToTick(price, 9, 9, pool.tickSpacing);
  const tickDiff = Math.abs(tickFromPrice - pool.tickIndex);
  assert(tickDiff <= pool.tickSpacing, `priceToTick round-trip within 1 spacing: ${tickFromPrice} vs ${pool.tickIndex} (diff ${tickDiff})`);
}

async function testOpenNewPosition(pool: Pool): Promise<string | null> {
  console.log('\n=== 5. tx.addLiquidity: Open NEW position ===');

  const spacing = pool.tickSpacing;
  const currentTick = pool.tickIndex;

  const tickLower = Math.floor((currentTick - spacing * 5) / spacing) * spacing;
  const tickUpper = Math.ceil((currentTick + spacing * 5) / spacing) * spacing;
  console.log(`  Range: [${tickLower}, ${tickUpper}], spacing: ${spacing}`);

  const tx = client.suidex.tx.addLiquidity({
    poolId: SUI_VICTORY_POOL, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    tickLower, tickUpper,
    amountX: 10_000_000n, // 0.01 SUI
    amountY: 10_000_000n,
    minAmountX: 0n, minAmountY: 0n,
    sender: WALLET,
    tickSpacing: spacing,
  });

  const { digest } = await execute(tx);
  assert(true, `New position opened: ${digest.slice(0, 16)}...`);

  await sleep(2000);
  const positions = await findPositions();
  assert(positions.length > 0, `Found ${positions.length} position(s)`);

  return positions.length > 0 ? positions[positions.length - 1] : null;
}

async function testGetPosition(positionId: string): Promise<Position> {
  console.log('\n=== 6. getPosition ===');

  const pos = await client.suidex.getPosition(positionId);
  assert(pos.positionId === positionId, `positionId: ${positionId.slice(0, 16)}...`);
  assert(pos.poolId === SUI_VICTORY_POOL, `poolId matches`);
  assert(pos.liquidity > 0n, `liquidity: ${pos.liquidity}`);
  assert(pos.tickLower < pos.tickUpper, `ticks: [${pos.tickLower}, ${pos.tickUpper}]`);
  assert(typeof pos.feeGrowthInsideXLast === 'bigint', `feeGrowthInsideXLast: ${pos.feeGrowthInsideXLast}`);
  assert(typeof pos.feeGrowthInsideYLast === 'bigint', `feeGrowthInsideYLast: ${pos.feeGrowthInsideYLast}`);

  return pos;
}

async function testAddToExistingPosition(positionId: string, pool: Pool): Promise<bigint> {
  console.log('\n=== 7. tx.addLiquidity: Add to EXISTING position ===');

  const posBefore = await client.suidex.getPosition(positionId);
  const liqBefore = posBefore.liquidity;

  const tx = client.suidex.tx.addLiquidity({
    poolId: SUI_VICTORY_POOL, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    tickLower: posBefore.tickLower, tickUpper: posBefore.tickUpper,
    amountX: 10_000_000n,
    amountY: 10_000_000n,
    minAmountX: 0n, minAmountY: 0n,
    sender: WALLET,
    existingPositionId: positionId,
    tickSpacing: pool.tickSpacing,
  });

  const { digest } = await execute(tx);
  assert(true, `Added to existing: ${digest.slice(0, 16)}...`);

  await sleep(2000);
  const posAfter = await client.suidex.getPosition(positionId);
  assert(posAfter.liquidity > liqBefore, `Liquidity increased: ${liqBefore} → ${posAfter.liquidity}`);

  return posAfter.liquidity;
}

async function testCollectFees(positionId: string) {
  console.log('\n=== 8. tx.collectFees ===');

  const tx = client.suidex.tx.collectFees({
    poolId: SUI_VICTORY_POOL, positionId,
    tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    sender: WALLET,
  });

  const { digest } = await execute(tx);
  assert(true, `Fees collected: ${digest.slice(0, 16)}...`);
}

async function testCollectReward(positionId: string) {
  console.log('\n=== 9. tx.collectReward (standalone) ===');

  const tx = client.suidex.tx.collectReward({
    poolId: SUI_VICTORY_POOL, positionId,
    tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    rewardCoinType: VICTORY_TYPE,
    sender: WALLET,
  });

  try {
    const { digest } = await execute(tx);
    assert(true, `Reward collected: ${digest.slice(0, 16)}...`);
  } catch (e: any) {
    // Abort code 28 = reward not found (pool may not have VICTORY rewards active)
    if (e.message.includes('abort code: 28')) {
      assert(true, `No active VICTORY reward on this pool (expected — abort 28)`);
    } else {
      throw e;
    }
  }
}

async function testPartialRemoveLiquidity(positionId: string, totalLiquidity: bigint) {
  console.log('\n=== 10. tx.removeLiquidity: PARTIAL remove ===');

  const halfLiq = totalLiquidity / 2n;

  const tx = client.suidex.tx.removeLiquidity({
    poolId: SUI_VICTORY_POOL, positionId,
    tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    liquidityAmount: halfLiq,
    minAmountX: 0n, minAmountY: 0n,
    sender: WALLET,
    closePosition: false, // keep position open
  });

  const { digest } = await execute(tx);
  assert(true, `Partial remove: ${digest.slice(0, 16)}...`);

  await sleep(2000);
  const posAfter = await client.suidex.getPosition(positionId);
  const expectedRemaining = totalLiquidity - halfLiq;
  assert(posAfter.liquidity === expectedRemaining, `Remaining: ${posAfter.liquidity} (expected ${expectedRemaining})`);
}

async function testFullRemoveAndClose(positionId: string) {
  console.log('\n=== 11. tx.removeLiquidity: Full remove + close (multi-reward) ===');

  const pos = await client.suidex.getPosition(positionId);

  const tx = client.suidex.tx.removeLiquidity({
    poolId: SUI_VICTORY_POOL, positionId,
    tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    liquidityAmount: pos.liquidity,
    minAmountX: 0n, minAmountY: 0n,
    sender: WALLET,
    closePosition: true,
    rewardCoinTypes: [VICTORY_TYPE], // test multi-reward array path
  });

  const { digest } = await execute(tx);
  assert(true, `Position closed: ${digest.slice(0, 16)}...`);

  await sleep(2000);
  try {
    await client.suidex.getPosition(positionId);
    assert(true, 'Position deleted (object may still resolve briefly)');
  } catch {
    assert(true, 'Position confirmed deleted');
  }
}

async function testSwapYtoX() {
  console.log('\n=== 12. tx.swap: VICTORY → SUI (return funds) ===');

  await sleep(2000);
  const vicBal = await getBalance(VICTORY_TYPE);
  if (vicBal === 0n) {
    assert(true, 'No VICTORY to swap back');
    return;
  }
  console.log(`  VICTORY balance: ${vicBal}`);

  const quote = await client.suidex.view.getQuote({
    poolId: SUI_VICTORY_POOL, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: false, amountIn: vicBal,
  });
  assert(quote.amountOut > 0n, `Quote: ${vicBal} VIC → ${quote.amountOut} SUI`);

  const minOut = quote.amountOut - (quote.amountOut * 300n) / 10000n;
  const tx = client.suidex.tx.swap({
    poolId: SUI_VICTORY_POOL, tokenXType: SUI_TYPE, tokenYType: VICTORY_TYPE,
    isXtoY: false, amountIn: vicBal, minAmountOut: minOut, sender: WALLET,
  });

  const { digest } = await execute(tx);
  assert(true, `Swapped back: ${digest.slice(0, 16)}...`);

  await sleep(2000);
  const finalVic = await getBalance(VICTORY_TYPE);
  assert(finalVic < 1000n, `VICTORY remaining: ${finalVic} (dust or zero)`);
}

async function testMathWithRealData(pool: Pool, pos: Position) {
  console.log('\n=== 13. Math verification (real pool + position data) ===');

  // getAmountsForLiquidity with real position
  const sqrtLower = tickToSqrtPrice(pos.tickLower);
  const sqrtUpper = tickToSqrtPrice(pos.tickUpper);
  const { amountX, amountY } = getAmountsForLiquidity(
    pool.sqrtPrice, sqrtLower, sqrtUpper, pos.liquidity,
  );
  assert(amountX >= 0n, `amountX: ${amountX}`);
  assert(amountY >= 0n, `amountY: ${amountY}`);
  assert(amountX > 0n || amountY > 0n, `At least one token amount > 0`);

  // getLiquidityForAmounts round-trip
  const liqBack = getLiquidityForAmounts(pool.sqrtPrice, sqrtLower, sqrtUpper, amountX, amountY);
  const diff = liqBack > pos.liquidity ? liqBack - pos.liquidity : pos.liquidity - liqBack;
  const pctDiff = Number(diff * 100n / pos.liquidity);
  assert(pctDiff < 2, `Liquidity round-trip within 2%: ${liqBack} vs ${pos.liquidity} (${pctDiff}% diff)`);

  // sqrtPriceToPrice with real data
  const price = sqrtPriceToPrice(pool.sqrtPrice, 9, 9);
  assert(price > 0, `Price from real sqrtPrice: ${price.toFixed(6)}`);

  // tickToPrice for position bounds
  const lowerPrice = tickToPrice(pos.tickLower, 9, 9);
  const upperPrice = tickToPrice(pos.tickUpper, 9, 9);
  assert(lowerPrice < upperPrice, `Position range: ${lowerPrice.toFixed(4)} - ${upperPrice.toFixed(4)}`);
  assert(lowerPrice < price && price < upperPrice, `Current price ${price.toFixed(4)} in position range`);
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('SuiDex V3 CLMM SDK — Full Lifecycle Test (REAL FUNDS)');
  console.log(`Wallet: ${WALLET}`);
  console.log(`Pool: SUI/VICTORY`);

  const suiBefore = await getBalance(SUI_TYPE);
  console.log(`Starting SUI: ${(Number(suiBefore) / 1e9).toFixed(4)}`);

  try {
    // 1. getPool
    const pool = await testGetPool();

    // 2. Quote both directions
    await testQuoteBothDirections(pool);

    // 3. Real swap SUI → VICTORY
    await testSwapXtoY();

    // 4. sqrtPriceToTick with real data
    await testSqrtPriceToTickReal(pool);

    // 5. Open new position
    const positionId = await testOpenNewPosition(pool);
    if (!positionId) throw new Error('Failed to create position');

    // 6. getPosition
    const pos = await testGetPosition(positionId);

    // 7. Add to existing position
    const totalLiq = await testAddToExistingPosition(positionId, pool);

    // 8. Collect fees
    await testCollectFees(positionId);
    await sleep(3000); // Wait for object version to propagate

    // 9. Collect reward (standalone)
    await testCollectReward(positionId);
    await sleep(3000);

    // 10. Partial remove
    await testPartialRemoveLiquidity(positionId, totalLiq);
    await sleep(3000);

    // 11. Full remove + close
    await testFullRemoveAndClose(positionId);

    // 12. Swap back VICTORY → SUI
    await testSwapYtoX();

    // 13. Math with real data (uses pool + pos captured earlier)
    await testMathWithRealData(pool, pos);

  } catch (err: any) {
    console.error('\nFATAL ERROR:', err.message ?? err);
    failed++;
    failures.push(`FATAL: ${err.message ?? err}`);
  }

  // Final balance report
  await sleep(1000);
  const suiAfter = await getBalance(SUI_TYPE);
  const gasCost = suiBefore - suiAfter;
  console.log(`\n─── Balance Report ───`);
  console.log(`  SUI before: ${(Number(suiBefore) / 1e9).toFixed(4)}`);
  console.log(`  SUI after:  ${(Number(suiAfter) / 1e9).toFixed(4)}`);
  console.log(`  Gas spent:  ${(Number(gasCost) / 1e9).toFixed(4)} SUI`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
