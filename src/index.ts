/**
 * @suidex/clmm-sdk — SuiDex V3 Concentrated Liquidity SDK for Sui
 *
 * Quick start:
 *   import { SuiGrpcClient } from '@mysten/sui/grpc';
 *   import { suidexCLMM } from '@suidex/clmm-sdk';
 *
 *   const client = new SuiGrpcClient({
 *     network: 'mainnet',
 *     baseUrl: 'https://fullnode.mainnet.sui.io:443',
 *   }).$extend(suidexCLMM());
 *
 *   // Quote a swap
 *   const quote = await client.suidex.view.getQuote({ ... });
 *
 *   // Build a swap transaction
 *   const tx = client.suidex.tx.swap({ ... });
 */

// Client extension
export { suidexCLMM, SuiDexCLMMClient } from './sdk.js';

// Types
export type {
  Pool,
  Position,
  QuoteResult,
  SwapParams,
  AddLiquidityParams,
  RemoveLiquidityParams,
  CollectFeesParams,
  CollectRewardParams,
  FlashLoanParams,
  AddLiquiditySingleSidedParams,
  SuiDexSDKOptions,
} from './types.js';

// Math utilities
export {
  tickToSqrtPrice,
  sqrtPriceToTick,
  sqrtPriceToPrice,
  priceToTick,
  tickToPrice,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
} from './math.js';

// Constants
export {
  MAINNET,
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  Q64,
  FEE_DENOMINATOR,
} from './constants.js';
