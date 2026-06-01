/**
 * SuiDex V3 CLMM — Math utilities
 *
 * Q64 fixed-point arithmetic (2^64), NOT Q96 like Uniswap V3.
 * All sqrt prices are Q64.64 format.
 */

import { Q64, MIN_TICK, MAX_TICK } from './constants.js';

// ─── BigInt helpers ──────────────────────────────────────────────

function mulShr(a: bigint, b: bigint, shift: number): bigint {
  return (a * b) >> BigInt(shift);
}

function divRound(num: bigint, denom: bigint, roundUp: boolean): bigint {
  const result = num / denom;
  if (roundUp && num % denom > 0n) return result + 1n;
  return result;
}

// ─── Tick → Sqrt Price (Q64) ─────────────────────────────────────

const NEG_TICK_FACTORS: [number, bigint][] = [
  [0,  18445821805675392311n],
  [1,  18444899583751176498n],
  [2,  18443055278223354162n],
  [3,  18439367220385604838n],
  [4,  18431993317065449817n],
  [5,  18417254355718160513n],
  [6,  18387811781193591352n],
  [7,  18329067761203520168n],
  [8,  18212142134806087854n],
  [9,  17980523815641551639n],
  [10, 17526086738831147013n],
  [11, 16651378430235024244n],
  [12, 15030750278693429944n],
  [13, 12247334978882834399n],
  [14, 8131365268884726200n],
  [15, 3584323654723342297n],
  [16, 696457651847595233n],
  [17, 26294789957452057n],
  [18, 37481735321082n],
];

const POS_TICK_FACTORS: [number, bigint][] = [
  [0,  79232123823359799118286999567n],
  [1,  79236085330515764027303304731n],
  [2,  79244008939048815603706035061n],
  [3,  79259858533276714757314932305n],
  [4,  79291567232598584799939703904n],
  [5,  79355022692464371645785046466n],
  [6,  79482085999252804386437311141n],
  [7,  79736823300114093921829183326n],
  [8,  80248749790819932309965073892n],
  [9,  81282483887344747381513967011n],
  [10, 83390072131320151908154831281n],
  [11, 87770609709833776024991924138n],
  [12, 97234110755111693312479820773n],
  [13, 119332217159966728226237229890n],
  [14, 179736315981702064433883588727n],
  [15, 407748233172238350107850275304n],
  [16, 2098478828474011932436660412517n],
  [17, 55581415166113811149459800483533n],
  [18, 38992368544603139932233054999993551n],
];

function getSqrtPriceAtNegativeTick(absTick: number): bigint {
  let v = (absTick & 1) !== 0 ? 18445821805675392311n : Q64;
  for (const [bit, factor] of NEG_TICK_FACTORS) {
    if (bit === 0) continue;
    if ((absTick & (1 << bit)) !== 0) v = mulShr(v, factor, 64);
  }
  return v;
}

function getSqrtPriceAtPositiveTick(absTick: number): bigint {
  let v = (absTick & 1) !== 0
    ? 79232123823359799118286999567n
    : 79228162514264337593543950336n;
  for (const [bit, factor] of POS_TICK_FACTORS) {
    if (bit === 0) continue;
    if ((absTick & (1 << bit)) !== 0) v = mulShr(v, factor, 96);
  }
  return v >> 32n;
}

/** Convert a tick index to its Q64 sqrt price. */
export function tickToSqrtPrice(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`Tick ${tick} out of bounds [${MIN_TICK}, ${MAX_TICK}]`);
  }
  if (tick < 0) return getSqrtPriceAtNegativeTick(-tick);
  return getSqrtPriceAtPositiveTick(tick);
}

/** Convert a Q64 sqrt price to the corresponding tick index (integer binary search, exact). */
export function sqrtPriceToTick(sqrtPrice: bigint): number {
  if (sqrtPrice <= 0n) throw new Error('sqrtPrice must be positive');
  // Binary search: find tick where tickToSqrtPrice(tick) <= sqrtPrice < tickToSqrtPrice(tick+1)
  let low = MIN_TICK;
  let high = MAX_TICK;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const midSqrt = tickToSqrtPrice(mid);
    if (midSqrt <= sqrtPrice) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** Convert a Q64 sqrt price to a human-readable price. */
export function sqrtPriceToPrice(sqrtPrice: bigint, decimalsX: number, decimalsY: number): number {
  const sqrtPriceNum = Number(sqrtPrice) / Number(Q64);
  return sqrtPriceNum * sqrtPriceNum * Math.pow(10, decimalsX - decimalsY);
}

/** Convert a human-readable price to a tick index (snapped to tick spacing). */
export function priceToTick(price: number, decimalsX: number, decimalsY: number, tickSpacing: number): number {
  const priceRaw = price / Math.pow(10, decimalsX - decimalsY);
  const exactTick = Math.log(priceRaw) / Math.log(1.0001);
  const snapped = Math.round(exactTick / tickSpacing) * tickSpacing;
  return Math.max(MIN_TICK, Math.min(MAX_TICK, snapped));
}

/** Convert tick to price (convenience). */
export function tickToPrice(tick: number, decimalsX: number, decimalsY: number): number {
  return sqrtPriceToPrice(tickToSqrtPrice(tick), decimalsX, decimalsY);
}

// ─── Position Value Calculation ──────────────────────────────────

function getAmountXDelta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lower, upper] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  const priceDelta = upper - lower;
  if (priceDelta === 0n || liquidity === 0n) return 0n;
  return divRound((liquidity * priceDelta) << 64n, lower * upper, roundUp);
}

function getAmountYDelta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const priceDelta = sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA;
  if (priceDelta === 0n || liquidity === 0n) return 0n;
  return divRound(liquidity * priceDelta, Q64, roundUp);
}

/** Compute token amounts for a given liquidity amount within a price range. */
export function getAmountsForLiquidity(
  sqrtPriceCurrent: bigint,
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint,
  liquidity: bigint,
  roundUp = false,
): { amountX: bigint; amountY: bigint } {
  if (sqrtPriceLower >= sqrtPriceUpper) return { amountX: 0n, amountY: 0n };
  if (sqrtPriceCurrent <= sqrtPriceLower) {
    return { amountX: getAmountXDelta(sqrtPriceLower, sqrtPriceUpper, liquidity, roundUp), amountY: 0n };
  }
  if (sqrtPriceCurrent >= sqrtPriceUpper) {
    return { amountX: 0n, amountY: getAmountYDelta(sqrtPriceLower, sqrtPriceUpper, liquidity, roundUp) };
  }
  return {
    amountX: getAmountXDelta(sqrtPriceCurrent, sqrtPriceUpper, liquidity, roundUp),
    amountY: getAmountYDelta(sqrtPriceLower, sqrtPriceCurrent, liquidity, roundUp),
  };
}

/** Compute maximum liquidity for given token amounts and price range. */
export function getLiquidityForAmounts(
  sqrtPriceCurrent: bigint,
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint,
  amountX: bigint,
  amountY: bigint,
): bigint {
  if (sqrtPriceLower >= sqrtPriceUpper) return 0n;
  const liqForX = (sqrtA: bigint, sqrtB: bigint, amount: bigint) => {
    const [lower, upper] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
    return (amount * (lower * upper / Q64)) / (upper - lower);
  };
  const liqForY = (sqrtA: bigint, sqrtB: bigint, amount: bigint) => {
    const [lower, upper] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
    return (amount * Q64) / (upper - lower);
  };
  if (sqrtPriceCurrent <= sqrtPriceLower) return liqForX(sqrtPriceLower, sqrtPriceUpper, amountX);
  if (sqrtPriceCurrent >= sqrtPriceUpper) return liqForY(sqrtPriceLower, sqrtPriceUpper, amountY);
  const lx = liqForX(sqrtPriceCurrent, sqrtPriceUpper, amountX);
  const ly = liqForY(sqrtPriceLower, sqrtPriceCurrent, amountY);
  return lx < ly ? lx : ly;
}
