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
}

export interface RemoveLiquidityParams {
  poolId: string;
  positionId: string;
  tokenXType: string;
  tokenYType: string;
  liquidityAmount: bigint;
  sender: string;
  /** Close the position after removing all liquidity. Rewards must be collected first — pass rewardCoinType if the pool has incentives. */
  closePosition?: boolean;
  /** If closing a position on an incentivized pool, provide the reward coin type to auto-collect before close. */
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

export interface SuiDexSDKOptions<Name = 'suidex'> {
  name?: Name;
  /** Override package IDs (for testnet or custom deployments) */
  packageId?: string;
  versionId?: string;
}
