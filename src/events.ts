/**
 * SuiDex V3 CLMM — Event type definitions
 *
 * These interfaces match the on-chain Move event structs emitted by the V3 contract.
 * Use them when parsing transaction events from indexers or GraphQL queries.
 *
 * Event type strings follow the pattern:
 *   `${PACKAGE_ID}::module::EventName`
 */

import { MAINNET } from './constants.js';

// ─── Event Type Strings ──────────────────────────────────────────

export const EVENT_TYPES = {
  Swap: `${MAINNET.PACKAGE_ID}::trade::SwapEvent`,
  FlashLoan: `${MAINNET.PACKAGE_ID}::trade::FlashLoanEvent`,
  RepayFlashSwap: `${MAINNET.PACKAGE_ID}::trade::RepayFlashSwapEvent`,
  RepayFlashLoan: `${MAINNET.PACKAGE_ID}::trade::RepayFlashLoanEvent`,
  OpenPosition: `${MAINNET.PACKAGE_ID}::liquidity::OpenPositionEvent`,
  ClosePosition: `${MAINNET.PACKAGE_ID}::liquidity::ClosePositionEvent`,
  AddLiquidity: `${MAINNET.PACKAGE_ID}::liquidity::AddLiquidityEvent`,
  RemoveLiquidity: `${MAINNET.PACKAGE_ID}::liquidity::RemoveLiquidityEvent`,
  CollectFee: `${MAINNET.PACKAGE_ID}::collect::FeeCollectedEvent`,
  CollectReward: `${MAINNET.PACKAGE_ID}::collect::CollectPoolRewardEvent`,
  PoolCreated: `${MAINNET.PACKAGE_ID}::create_pool::PoolCreatedEvent`,
} as const;

// ─── Event Interfaces ────────────────────────────────────────────

export interface SwapEvent {
  sender: string;
  pool_id: string;
  x_for_y: boolean;
  amount_x: string;
  amount_y: string;
  sqrt_price_before: string;
  sqrt_price_after: string;
  liquidity: string;
  tick_index: { bits: number };
  fee_amount: string;
}

export interface OpenPositionEvent {
  sender: string;
  pool_id: string;
  position_id: string;
  tick_lower_index: { bits: number };
  tick_upper_index: { bits: number };
}

export interface ClosePositionEvent {
  sender: string;
  position_id: string;
}

export interface AddLiquidityEvent {
  sender: string;
  pool_id: string;
  position_id: string;
  liquidity: string;
  amount_x: string;
  amount_y: string;
  upper_tick_index: { bits: number };
  lower_tick_index: { bits: number };
  reserve_x: string;
  reserve_y: string;
}

export interface RemoveLiquidityEvent {
  sender: string;
  pool_id: string;
  position_id: string;
  liquidity: string;
  amount_x: string;
  amount_y: string;
  upper_tick_index: { bits: number };
  lower_tick_index: { bits: number };
  reserve_x: string;
  reserve_y: string;
}

export interface FeeCollectedEvent {
  sender: string;
  pool_id: string;
  position_id: string;
  amount_x: string;
  amount_y: string;
}

export interface CollectPoolRewardEvent {
  sender: string;
  pool_id: string;
  position_id: string;
  reward_coin_type: { name: string };
  amount: string;
}

export interface FlashLoanEvent {
  sender: string;
  pool_id: string;
  amount_x: string;
  amount_y: string;
}

export interface PoolCreatedEvent {
  pool_id: string;
  token_x_type: { name: string };
  token_y_type: { name: string };
  fee_rate: string;
  tick_spacing: string;
}
