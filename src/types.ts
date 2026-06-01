/**
 * SuiDex V3 CLMM — Type definitions
 */

export interface Pool {
  poolId: string;
  tokenXType: string;
  tokenYType: string;
  feeRate: number;
  tickSpacing: number;
  sqrtPrice: bigint;
  liquidity: bigint;
  tickIndex: number;
}

export interface Position {
  positionId: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInsideXLast: bigint;
  feeGrowthInsideYLast: bigint;
  tokensOwedX: bigint;
  tokensOwedY: bigint;
}

export interface QuoteResult {
  amountOut: bigint;
  amountIn: bigint;
  poolId: string;
  tokenXType: string;
  tokenYType: string;
  isXtoY: boolean;
  feeRate: number;
  /** Estimated price impact (%). Derived from spot vs actual output — treat as directional, not exact. */
  priceImpact: number;
  sqrtPriceAfter: bigint;
  /** Exact fee amount charged by the pool (from on-chain simulation). */
  feeAmount: bigint;
}

export interface SwapParams {
  poolId: string;
  tokenXType: string;
  tokenYType: string;
  isXtoY: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
  sender: string;
}

export interface AddLiquidityParams {
  poolId: string;
  tokenXType: string;
  tokenYType: string;
  tickLower: number;
  tickUpper: number;
  amountX: bigint;
  amountY: bigint;
  sender: string;
  /** If provided, adds to existing position. Otherwise opens a new one. */
  existingPositionId?: string;
  /** Minimum token X actually deposited — aborts TX if slippage exceeds tolerance. Defaults to 0. */
  minAmountX?: bigint;
  /** Minimum token Y actually deposited — aborts TX if slippage exceeds tolerance. Defaults to 0. */
  minAmountY?: bigint;
  /** Pool tick spacing — if provided, validates tick alignment before building TX (avoids gas waste on abort code 19). */
  tickSpacing?: number;
}

export interface RemoveLiquidityParams {
  poolId: string;
  positionId: string;
  tokenXType: string;
  tokenYType: string;
  liquidityAmount: bigint;
  sender: string;
  /** Close the position after removing all liquidity. Rewards must be collected first — pass rewardCoinTypes if the pool has incentives. */
  closePosition?: boolean;
  /** All reward coin types to auto-collect before close. Supports multiple reward tokens. */
  rewardCoinTypes?: string | string[];
  /** @deprecated Use rewardCoinTypes instead. Single reward type — still works for backwards compat. */
  rewardCoinType?: string;
  /** Minimum token X received — aborts TX if slippage exceeds tolerance. Defaults to 0. */
  minAmountX?: bigint;
  /** Minimum token Y received — aborts TX if slippage exceeds tolerance. Defaults to 0. */
  minAmountY?: bigint;
}

export interface CollectFeesParams {
  poolId: string;
  positionId: string;
  tokenXType: string;
  tokenYType: string;
  sender: string;
}

export interface CollectRewardParams {
  poolId: string;
  positionId: string;
  tokenXType: string;
  tokenYType: string;
  /** The coin type of the reward token (e.g. VICTORY_TOKEN type) */
  rewardCoinType: string;
  sender: string;
}

export interface FlashLoanParams {
  poolId: string;
  tokenXType: string;
  tokenYType: string;
  amountX: bigint;
  amountY: bigint;
  sender: string;
}

export interface AddLiquiditySingleSidedParams {
  poolId: string;
  tokenXType: string;
  tokenYType: string;
  /** Existing position ID (determines tick range for optimal split) */
  positionId: string;
  /** Total amount of the single input token */
  amountIn: bigint;
  /** True if input token is tokenX, false if tokenY */
  isTokenX: boolean;
  sender: string;
}

export interface IndexerPool {
  poolId: string;
  tokenXType: string;
  tokenYType: string;
  feeRate: number;
  tickSpacing: number;
  sqrtPrice: bigint;
  liquidity: bigint;
  tickIndex: number;
  tvlUsd: number;
  volume24hUsd: number;
  approved: boolean;
}

export interface TickData {
  tickLower: number;
  tickUpper: number;
  netLiquidity: bigint;
}

export interface SuiDexSDKOptions<Name = 'suidex'> {
  name?: Name;
  /** Override package IDs (for testnet or custom deployments) */
  packageId?: string;
  versionId?: string;
  /** SuiDex V3 indexer API URL. Defaults to https://dex.suidex.org */
  apiUrl?: string;
}
