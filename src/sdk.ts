/**
 * SuiDex V3 CLMM SDK
 *
 * Client extension pattern following Sui SDK best practices.
 * Works with SuiGrpcClient, SuiGraphQLClient, or any ClientWithCoreApi.
 *
 * Usage:
 *   const client = new SuiGrpcClient({ ... }).$extend(suidexCLMM());
 *   const quote = await client.suidex.view.getQuote({ ... });
 *   const tx = client.suidex.tx.swap({ ... });
 */

import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { MAINNET, MIN_SQRT_PRICE, MAX_SQRT_PRICE, MIN_TICK, MAX_TICK, Q64 } from './constants.js';
import { tickToSqrtPrice } from './math.js';
import type {
  Pool, Position, QuoteResult, SwapParams,
  AddLiquidityParams, RemoveLiquidityParams, CollectFeesParams,
  CollectRewardParams, IndexerPool, TickData, SuiDexSDKOptions,
} from './types.js';

// ─── Client Extension Factory ────────────────────────────────────

export function suidexCLMM<const Name = 'suidex'>({
  name = 'suidex' as Name,
  packageId,
  versionId,
  apiUrl,
}: SuiDexSDKOptions<Name> = {}) {
  return {
    name,
    register: (client: ClientWithCoreApi) => {
      return new SuiDexCLMMClient({
        client,
        packageId: packageId ?? MAINNET.PACKAGE_ID,
        versionId: versionId ?? MAINNET.VERSION_ID,
        apiUrl: apiUrl ?? 'https://dex.suidex.org',
      });
    },
  };
}

// ─── SDK Client ──────────────────────────────────────────────────

export class SuiDexCLMMClient {
  #client: ClientWithCoreApi;
  #pkg: string;
  #ver: string;
  #clk = MAINNET.CLOCK_ID;
  #apiUrl: string;

  constructor({ client, packageId, versionId, apiUrl }: {
    client: ClientWithCoreApi;
    packageId: string;
    versionId: string;
    apiUrl?: string;
  }) {
    this.#client = client;
    this.#pkg = packageId;
    this.#ver = versionId;
    this.#apiUrl = apiUrl ?? 'https://dex.suidex.org';
  }

  // ─── Top-level Methods ───────────────────────────────────────

  /** Fetch a pool's on-chain state. */
  async getPool(poolId: string): Promise<Pool> {
    const { object } = await this.#client.core.getObject({
      objectId: poolId,
      include: { json: true },
    });
    const json = (object as any)?.json;
    if (!json) throw new Error(`Pool ${poolId} not found`);
    // Normalize type strings: on-chain JSON omits 0x prefix
    const normType = (t: string) => t.startsWith('0x') ? t : `0x${t}`;
    return {
      poolId,
      tokenXType: normType(json.type_x ?? json.coin_type_x ?? json.token_x_type ?? ''),
      tokenYType: normType(json.type_y ?? json.coin_type_y ?? json.token_y_type ?? ''),
      feeRate: Number(json.swap_fee_rate ?? json.fee_rate ?? 0),
      tickSpacing: Number(json.tick_spacing ?? 0),
      sqrtPrice: BigInt(json.sqrt_price ?? '0'),
      liquidity: BigInt(json.liquidity ?? '0'),
      tickIndex: this.#parseI32(json.tick_index),
    };
  }

  /** Fetch a position's on-chain state. */
  async getPosition(positionId: string): Promise<Position> {
    const { object } = await this.#client.core.getObject({
      objectId: positionId,
      include: { json: true },
    });
    const json = (object as any)?.json;
    if (!json) throw new Error(`Position ${positionId} not found`);
    return {
      positionId,
      poolId: json.pool_id ?? '',
      tickLower: this.#parseI32(json.tick_lower_index),
      tickUpper: this.#parseI32(json.tick_upper_index),
      liquidity: BigInt(json.liquidity ?? '0'),
      feeGrowthInsideXLast: BigInt(json.fee_growth_inside_x_last ?? '0'),
      feeGrowthInsideYLast: BigInt(json.fee_growth_inside_y_last ?? '0'),
      tokensOwedX: BigInt(json.tokens_owed_x ?? json.owed_coin_x ?? '0'),
      tokensOwedY: BigInt(json.tokens_owed_y ?? json.owed_coin_y ?? '0'),
    };
  }

  /** List all CLMM positions owned by a wallet address. */
  async listPositions(owner: string): Promise<Position[]> {
    const positionType = `${MAINNET.ORIGINAL_PACKAGE_ID}::position::Position`;
    const positions: Position[] = [];
    let cursor: string | null | undefined;

    while (true) {
      const result = await this.#client.core.listOwnedObjects({
        owner,
        type: positionType,
        include: { json: true },
        limit: 50,
        ...(cursor ? { cursor } : {}),
      }) as any;

      const objects = result?.objects ?? result?.data ?? [];
      for (const obj of objects) {
        const json = obj?.json ?? obj?.data?.content?.fields;
        if (!json) continue;
        positions.push({
          positionId: obj.objectId ?? obj?.data?.objectId ?? '',
          poolId: json.pool_id ?? '',
          tickLower: this.#parseI32(json.tick_lower_index),
          tickUpper: this.#parseI32(json.tick_upper_index),
          liquidity: BigInt(json.liquidity ?? '0'),
          feeGrowthInsideXLast: BigInt(json.fee_growth_inside_x_last ?? '0'),
          feeGrowthInsideYLast: BigInt(json.fee_growth_inside_y_last ?? '0'),
          tokensOwedX: BigInt(json.tokens_owed_x ?? json.owed_coin_x ?? '0'),
          tokensOwedY: BigInt(json.tokens_owed_y ?? json.owed_coin_y ?? '0'),
        });
      }

      cursor = result?.cursor ?? result?.nextCursor;
      if (!cursor) break;
    }

    return positions;
  }

  // ─── API Methods (indexer) ───────────────────────────────────

  api = {
    /** Fetch all pools from the SuiDex V3 indexer API. Includes TVL, volume, fee data. */
    getAllPools: async (): Promise<IndexerPool[]> => {
      const res = await fetch(`${this.#apiUrl}/api/v3/pools`);
      if (!res.ok) throw new Error(`Failed to fetch pools: ${res.status}`);
      const data = await res.json() as any[];
      return data.map(p => ({
        poolId: p.pool_id,
        tokenXType: p.token_x_type,
        tokenYType: p.token_y_type,
        feeRate: Number(p.fee_rate),
        tickSpacing: Number(p.tick_spacing),
        sqrtPrice: BigInt(p.sqrt_price ?? '0'),
        liquidity: BigInt(p.liquidity ?? '0'),
        tickIndex: Number(p.tick_index ?? 0),
        tvlUsd: Number(p.tvl_usd ?? 0),
        volume24hUsd: Number(p.volume_24h_usd ?? 0),
        approved: p.approved ?? false,
      }));
    },

    /** Fetch tick liquidity data for a pool. Returns initialized tick ranges with net liquidity. */
    getPoolTicks: async (poolId: string): Promise<TickData[]> => {
      const res = await fetch(`${this.#apiUrl}/api/v3/pools/${poolId}/ticks`);
      if (!res.ok) throw new Error(`Failed to fetch ticks: ${res.status}`);
      const data = await res.json() as any[];
      return data.map(t => ({
        tickLower: Number(t.tick_lower),
        tickUpper: Number(t.tick_upper),
        netLiquidity: BigInt(t.net_liquidity ?? '0'),
      }));
    },

    /** Fetch protocol-level stats (total TVL, volume, swaps, positions). */
    getStats: async (): Promise<{ totalPools: number; totalTvlUsd: number; totalVolume24hUsd: number; totalSwaps24h: number; activePositions: number }> => {
      const res = await fetch(`${this.#apiUrl}/api/v3/stats`);
      if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
      return res.json() as any;
    },
  };

  // ─── APR Estimation ────────────────────────────────────────────

  /**
   * Estimate fee APR for a position given pool parameters.
   * Uses: APR = (dailyVolume × feeRate × positionShare) / positionValue × 365
   */
  static estimateFeeAPR(params: {
    volume24hUsd: number;
    feeRate: number; // e.g. 3000 = 0.30%
    positionLiquidity: bigint;
    poolLiquidity: bigint;
    positionValueUsd: number;
  }): number {
    const { volume24hUsd, feeRate, positionLiquidity, poolLiquidity, positionValueUsd } = params;
    if (positionValueUsd === 0 || poolLiquidity === 0n) return 0;
    const feePercent = feeRate / 1_000_000;
    const share = Number(positionLiquidity) / Number(poolLiquidity);
    const dailyFees = volume24hUsd * feePercent * share;
    return (dailyFees / positionValueUsd) * 365 * 100; // percent
  }

  /**
   * Estimate reward APR for a position given reward emission data.
   * rewardPerSecond is the emission rate (raw units per second).
   */
  static estimateRewardAPR(params: {
    rewardPerSecond: bigint;
    rewardDecimals: number;
    rewardPriceUsd: number;
    positionLiquidity: bigint;
    poolLiquidity: bigint;
    positionValueUsd: number;
  }): number {
    const { rewardPerSecond, rewardDecimals, rewardPriceUsd, positionLiquidity, poolLiquidity, positionValueUsd } = params;
    if (positionValueUsd === 0 || poolLiquidity === 0n) return 0;
    const dailyReward = Number(rewardPerSecond) * 86400 / (10 ** rewardDecimals);
    const dailyRewardUsd = dailyReward * rewardPriceUsd;
    const share = Number(positionLiquidity) / Number(poolLiquidity);
    return (dailyRewardUsd * share / positionValueUsd) * 365 * 100;
  }

  // ─── View Methods (on-chain simulation) ──────────────────────

  view = {
    /**
     * Get an exact swap quote via on-chain simulation (compute_swap_result).
     * This is multi-tick accurate — not a single-tick approximation.
     */
    getQuote: async (params: {
      poolId: string;
      tokenXType: string;
      tokenYType: string;
      isXtoY: boolean;
      amountIn: bigint;
    }): Promise<QuoteResult> => {
      const { poolId, tokenXType, tokenYType, isXtoY, amountIn } = params;
      const sqrtLimit = isXtoY ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;

      // Fetch pool state BEFORE simulation to avoid TOCTOU race on price impact calc
      const pool = await this.getPool(poolId);

      const tx = new Transaction();
      tx.setSender('0x0000000000000000000000000000000000000000000000000000000000000000');
      tx.moveCall({
        target: `${this.#pkg}::trade::compute_swap_result`,
        typeArguments: [tokenXType, tokenYType],
        arguments: [
          tx.object(poolId),
          tx.pure.bool(isXtoY),
          tx.pure.bool(true), // exact_input
          tx.pure.u128(sqrtLimit),
          tx.pure.u64(amountIn),
        ],
      });

      const result = await this.#client.core.simulateTransaction({
        transaction: tx,
        checksEnabled: false,
        include: { commandResults: true },
      });

      const rv = (result as any)?.commandResults?.[0]?.returnValues?.[0];
      if (!rv) throw new Error('Quote simulation returned no results');
      const { amountOut, sqrtPriceAfter, feeAmount } = SuiDexCLMMClient.#parseSwapResult(rv.bcs ?? []);

      // Estimated price impact: compares spot price output vs actual output.
      // Uses pool state fetched before simulation to avoid TOCTOU.
      let priceImpact = 0;
      const sqrtPrice = pool.sqrtPrice;
      if (sqrtPrice > 0n && amountIn > 0n && amountOut > 0n) {
        const sqrtPriceSq = sqrtPrice * sqrtPrice;
        const spotOut = isXtoY
          ? (amountIn * sqrtPriceSq) / (Q64 * Q64)
          : (amountIn * Q64 * Q64) / sqrtPriceSq;
        if (spotOut > 0n) {
          priceImpact = Math.max(0, Math.round(Number((spotOut - amountOut) * 10000n / spotOut)) / 100);
        }
      }

      return {
        amountOut,
        amountIn,
        poolId,
        tokenXType,
        tokenYType,
        isXtoY,
        feeRate: pool.feeRate,
        priceImpact,
        sqrtPriceAfter,
        feeAmount,
      };
    },

    /**
     * Multi-pool chained quote. Simulates a swap through multiple pools in sequence.
     * Returns the final output amount. Useful for routing (A→B→C).
     */
    preSwap: async (params: {
      route: { poolId: string; tokenXType: string; tokenYType: string; isXtoY: boolean }[];
      amountIn: bigint;
    }): Promise<bigint> => {
      const { route, amountIn } = params;
      if (route.length === 0) return 0n;

      const tx = new Transaction();
      tx.setSender('0x0000000000000000000000000000000000000000000000000000000000000000');

      let inputAmount = tx.pure.u64(amountIn);

      for (const hop of route) {
        const sqrtLimit = hop.isXtoY ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
        const swapResult = tx.moveCall({
          target: `${this.#pkg}::trade::compute_swap_result`,
          typeArguments: [hop.tokenXType, hop.tokenYType],
          arguments: [
            tx.object(hop.poolId),
            tx.pure.bool(hop.isXtoY),
            tx.pure.bool(true), // exact_input
            tx.pure.u128(sqrtLimit),
            inputAmount,
          ],
        });
        // get_state_amount_calculated returns the output of this hop
        inputAmount = tx.moveCall({
          target: `${this.#pkg}::trade::get_state_amount_calculated`,
          arguments: [swapResult],
        });
      }

      const result = await this.#client.core.simulateTransaction({
        transaction: tx,
        checksEnabled: false,
        include: { commandResults: true },
      });

      // The last command's return value is the final output amount
      const cmdResults = (result as any)?.commandResults ?? [];
      const lastIdx = cmdResults.length - 1;
      const rv = cmdResults[lastIdx]?.returnValues?.[0];
      if (!rv) return 0n;

      const bytes = rv.bcs instanceof Uint8Array ? rv.bcs : new Uint8Array(rv.bcs ?? []);
      return BigInt(bcs.u64().parse(bytes));
    },
  };

  // ─── Transaction Builders ────────────────────────────────────

  tx = {
    /**
     * Build a swap transaction using flash_swap + repay_flash_swap.
     * Returns a Transaction ready for signing.
     */
    swap: (params: SwapParams): Transaction => {
      const { poolId, tokenXType, tokenYType, isXtoY, amountIn, minAmountOut, sender } = params;
      const sqrtLimit = isXtoY ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
      const inputType = isXtoY ? tokenXType : tokenYType;

      const tx = this.#newTx(sender);

      // Prepare input coin — coinWithBalance handles both coin objects + address balances (SIP-58)
      const isSui = inputType.endsWith('::sui::SUI');
      const inputCoin = isSui
        ? tx.splitCoins(tx.gas, [tx.pure.u64(amountIn)])
        : coinWithBalance({ type: inputType, balance: amountIn });

      // Convert to balance for flash_swap
      const inputBal = tx.moveCall({
        target: '0x2::coin::into_balance',
        typeArguments: [inputType],
        arguments: [inputCoin],
      });

      // flash_swap
      const [balX, balY, receipt] = tx.moveCall({
        target: `${this.#pkg}::trade::flash_swap`,
        typeArguments: [tokenXType, tokenYType],
        arguments: [
          tx.object(poolId),
          tx.pure.bool(isXtoY),
          tx.pure.bool(true), // exact_input
          tx.pure.u64(amountIn),
          tx.pure.u128(sqrtLimit),
          tx.object(this.#clk),
          tx.object(this.#ver),
        ],
      });

      // repay_flash_swap
      if (isXtoY) {
        const zeroBal = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [tokenYType] });
        tx.moveCall({
          target: `${this.#pkg}::trade::repay_flash_swap`,
          typeArguments: [tokenXType, tokenYType],
          arguments: [tx.object(poolId), receipt!, inputBal!, zeroBal!, tx.object(this.#ver)],
        });
        tx.moveCall({ target: '0x2::balance::destroy_zero', typeArguments: [tokenXType], arguments: [balX!] });
        // Enforce minAmountOut: split then rejoin — aborts if output < minimum
        if (minAmountOut > 0n) {
          const check = tx.moveCall({ target: '0x2::balance::split', typeArguments: [tokenYType], arguments: [balY!, tx.pure.u64(minAmountOut)] });
          tx.moveCall({ target: '0x2::balance::join', typeArguments: [tokenYType], arguments: [balY!, check] });
        }
        const outCoin = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [tokenYType], arguments: [balY!] });
        tx.transferObjects([outCoin], tx.pure.address(sender));
      } else {
        const zeroBal = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [tokenXType] });
        tx.moveCall({
          target: `${this.#pkg}::trade::repay_flash_swap`,
          typeArguments: [tokenXType, tokenYType],
          arguments: [tx.object(poolId), receipt!, zeroBal!, inputBal!, tx.object(this.#ver)],
        });
        tx.moveCall({ target: '0x2::balance::destroy_zero', typeArguments: [tokenYType], arguments: [balY!] });
        // Enforce minAmountOut: split then rejoin — aborts if output < minimum
        if (minAmountOut > 0n) {
          const check = tx.moveCall({ target: '0x2::balance::split', typeArguments: [tokenXType], arguments: [balX!, tx.pure.u64(minAmountOut)] });
          tx.moveCall({ target: '0x2::balance::join', typeArguments: [tokenXType], arguments: [balX!, check] });
        }
        const outCoin = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [tokenXType], arguments: [balX!] });
        tx.transferObjects([outCoin], tx.pure.address(sender));
      }

      return tx;
    },

    /** Build an add_liquidity transaction. Opens a new position if no existingPositionId. */
    addLiquidity: (params: AddLiquidityParams): Transaction => {
      const { poolId, tokenXType, tokenYType, tickLower, tickUpper, amountX, amountY, sender, existingPositionId, minAmountX = 0n, minAmountY = 0n } = params;

      // Validate ticks before building TX (avoids wasting gas on contract aborts)
      if (tickLower >= tickUpper) {
        throw new Error(`Invalid tick range: tickLower (${tickLower}) must be less than tickUpper (${tickUpper})`);
      }
      if (tickLower < MIN_TICK || tickUpper > MAX_TICK) {
        throw new Error(`Tick out of bounds: [${MIN_TICK}, ${MAX_TICK}]. Got tickLower=${tickLower}, tickUpper=${tickUpper}`);
      }
      if (params.tickSpacing) {
        if (tickLower % params.tickSpacing !== 0) {
          throw new Error(`tickLower (${tickLower}) not aligned to tickSpacing (${params.tickSpacing}). Use ${Math.round(tickLower / params.tickSpacing) * params.tickSpacing}`);
        }
        if (tickUpper % params.tickSpacing !== 0) {
          throw new Error(`tickUpper (${tickUpper}) not aligned to tickSpacing (${params.tickSpacing}). Use ${Math.round(tickUpper / params.tickSpacing) * params.tickSpacing}`);
        }
      }

      const tx = this.#newTx(sender);

      // Open position or use existing
      let positionArg;
      if (existingPositionId) {
        positionArg = tx.object(existingPositionId);
      } else {
        positionArg = tx.moveCall({
          target: `${this.#pkg}::liquidity::open_position`,
          typeArguments: [tokenXType, tokenYType],
          arguments: [
            tx.object(poolId),
            this.#makeI32(tx, tickLower),
            this.#makeI32(tx, tickUpper),
            tx.object(this.#ver),
          ],
        });
      }

      // Prepare coins — coinWithBalance handles coin objects + address balances (SIP-58)
      const coinX = amountX > 0n
        ? (tokenXType.endsWith('::sui::SUI') ? tx.splitCoins(tx.gas, [tx.pure.u64(amountX)]) : coinWithBalance({ type: tokenXType, balance: amountX }))
        : tx.moveCall({ target: '0x2::coin::zero', typeArguments: [tokenXType] });
      const coinY = amountY > 0n
        ? (tokenYType.endsWith('::sui::SUI') ? tx.splitCoins(tx.gas, [tx.pure.u64(amountY)]) : coinWithBalance({ type: tokenYType, balance: amountY }))
        : tx.moveCall({ target: '0x2::coin::zero', typeArguments: [tokenYType] });

      // add_liquidity
      const [refundX, refundY] = tx.moveCall({
        target: `${this.#pkg}::liquidity::add_liquidity`,
        typeArguments: [tokenXType, tokenYType],
        arguments: [
          tx.object(poolId), positionArg, coinX, coinY,
          tx.pure.u64(minAmountX), tx.pure.u64(minAmountY),
          tx.object(this.#clk), tx.object(this.#ver),
        ],
      });

      if (!existingPositionId) tx.transferObjects([positionArg], tx.pure.address(sender));
      tx.transferObjects([refundX], tx.pure.address(sender));
      tx.transferObjects([refundY], tx.pure.address(sender));

      return tx;
    },

    /** Build a remove_liquidity transaction. When closing a position on an incentivized pool, pass rewardCoinTypes to auto-collect rewards first. */
    removeLiquidity: (params: RemoveLiquidityParams): Transaction => {
      const { poolId, positionId, tokenXType, tokenYType, liquidityAmount, sender, closePosition, minAmountX = 0n, minAmountY = 0n } = params;
      // Normalize rewardCoinTypes: support both single string (legacy) and array
      const rewardCoinTypes: string[] = params.rewardCoinTypes
        ? (Array.isArray(params.rewardCoinTypes) ? params.rewardCoinTypes : [params.rewardCoinTypes])
        : params.rewardCoinType ? [params.rewardCoinType] : [];

      const tx = this.#newTx(sender);

      const [coinX, coinY] = tx.moveCall({
        target: `${this.#pkg}::liquidity::remove_liquidity`,
        typeArguments: [tokenXType, tokenYType],
        arguments: [
          tx.object(poolId), tx.object(positionId),
          tx.pure.u128(liquidityAmount),
          tx.pure.u64(minAmountX), tx.pure.u64(minAmountY),
          tx.object(this.#clk), tx.object(this.#ver),
        ],
      });

      tx.transferObjects([coinX], tx.pure.address(sender));
      tx.transferObjects([coinY], tx.pure.address(sender));

      if (closePosition) {
        // Collect fees before close
        const [feeX, feeY] = tx.moveCall({
          target: `${this.#pkg}::collect::fee`,
          typeArguments: [tokenXType, tokenYType],
          arguments: [tx.object(poolId), tx.object(positionId), tx.object(this.#clk), tx.object(this.#ver)],
        });
        tx.transferObjects([feeX], tx.pure.address(sender));
        tx.transferObjects([feeY], tx.pure.address(sender));

        // Collect ALL incentive rewards before close (required — position cannot close with unclaimed rewards)
        for (const rewardType of rewardCoinTypes) {
          const rewardCoin = tx.moveCall({
            target: `${this.#pkg}::collect::reward`,
            typeArguments: [tokenXType, tokenYType, rewardType],
            arguments: [tx.object(poolId), tx.object(positionId), tx.object(this.#clk), tx.object(this.#ver)],
          });
          tx.transferObjects([rewardCoin], tx.pure.address(sender));
        }

        tx.moveCall({
          target: `${this.#pkg}::liquidity::close_position`,
          arguments: [tx.object(positionId), tx.object(this.#ver)],
        });
      }

      return tx;
    },

    /** Build a collect_fees transaction. */
    collectFees: (params: CollectFeesParams): Transaction => {
      const { poolId, positionId, tokenXType, tokenYType, sender } = params;
      const tx = this.#newTx(sender);

      const [feeX, feeY] = tx.moveCall({
        target: `${this.#pkg}::collect::fee`,
        typeArguments: [tokenXType, tokenYType],
        arguments: [tx.object(poolId), tx.object(positionId), tx.object(this.#clk), tx.object(this.#ver)],
      });

      tx.transferObjects([feeX], tx.pure.address(sender));
      tx.transferObjects([feeY], tx.pure.address(sender));

      return tx;
    },

    /** Build a collect_reward transaction. Claims incentive rewards from a position. */
    collectReward: (params: CollectRewardParams): Transaction => {
      const { poolId, positionId, tokenXType, tokenYType, rewardCoinType, sender } = params;
      const tx = this.#newTx(sender);

      const rewardCoin = tx.moveCall({
        target: `${this.#pkg}::collect::reward`,
        typeArguments: [tokenXType, tokenYType, rewardCoinType],
        arguments: [tx.object(poolId), tx.object(positionId), tx.object(this.#clk), tx.object(this.#ver)],
      });

      tx.transferObjects([rewardCoin], tx.pure.address(sender));

      return tx;
    },

    /** Collect ALL reward types from a position in one transaction. */
    collectAllRewards: (params: {
      poolId: string;
      positionId: string;
      tokenXType: string;
      tokenYType: string;
      rewardCoinTypes: string[];
      sender: string;
    }): Transaction => {
      const { poolId, positionId, tokenXType, tokenYType, rewardCoinTypes, sender } = params;
      const tx = this.#newTx(sender);

      for (const rewardType of rewardCoinTypes) {
        const rewardCoin = tx.moveCall({
          target: `${this.#pkg}::collect::reward`,
          typeArguments: [tokenXType, tokenYType, rewardType],
          arguments: [tx.object(poolId), tx.object(positionId), tx.object(this.#clk), tx.object(this.#ver)],
        });
        tx.transferObjects([rewardCoin], tx.pure.address(sender));
      }

      return tx;
    },

    /**
     * Build a flash_loan transaction. Borrows tokens from a pool, executes
     * arbitrary logic (provided via callback), then repays with fees.
     * Returns the Transaction — caller must add their arbitrage logic between borrow and repay.
     */
    flashLoan: (params: {
      poolId: string;
      tokenXType: string;
      tokenYType: string;
      amountX: bigint;
      amountY: bigint;
      sender: string;
    }): { tx: Transaction; balanceX: any; balanceY: any; receipt: any } => {
      const { poolId, tokenXType, tokenYType, amountX, amountY, sender } = params;
      const tx = this.#newTx(sender);

      const [balanceX, balanceY, receipt] = tx.moveCall({
        target: `${this.#pkg}::trade::flash_loan`,
        typeArguments: [tokenXType, tokenYType],
        arguments: [
          tx.object(poolId),
          tx.pure.u64(amountX),
          tx.pure.u64(amountY),
          tx.object(this.#ver),
        ],
      });

      return { tx, balanceX, balanceY, receipt };
    },

    /**
     * Repay a flash loan. Call this after your arbitrage logic to close the loan.
     * Pass the receipt and balances returned from flashLoan().
     */
    repayFlashLoan: (params: {
      tx: Transaction;
      poolId: string;
      tokenXType: string;
      tokenYType: string;
      receipt: any;
      balanceX: any;
      balanceY: any;
    }): void => {
      const { tx, poolId, tokenXType, tokenYType, receipt, balanceX, balanceY } = params;
      tx.moveCall({
        target: `${this.#pkg}::trade::repay_flash_loan`,
        typeArguments: [tokenXType, tokenYType],
        arguments: [tx.object(poolId), receipt, balanceX, balanceY, tx.object(this.#ver)],
      });
    },

    /**
     * Single-sided add liquidity (zap). Uses on-chain get_optimal_swap_amount_for_single_sided_liquidity
     * to determine the optimal split, swaps one portion, then adds both tokens as liquidity.
     * Requires an existing position (to determine tick range).
     */
    addLiquiditySingleSided: (params: {
      poolId: string;
      tokenXType: string;
      tokenYType: string;
      positionId: string;
      amountIn: bigint;
      isTokenX: boolean;
      sender: string;
      slippageBps?: bigint;
    }): Transaction => {
      const { poolId, tokenXType, tokenYType, positionId, amountIn, isTokenX, sender, slippageBps = 100n } = params;
      const tx = this.#newTx(sender);
      const inputType = isTokenX ? tokenXType : tokenYType;
      const sqrtLimit = isTokenX ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;

      // Prepare input coin
      const isSui = inputType.endsWith('::sui::SUI');
      const inputCoin = isSui
        ? tx.splitCoins(tx.gas, [tx.pure.u64(amountIn)])
        : coinWithBalance({ type: inputType, balance: amountIn });

      // Get deposit amount (coin value)
      const depositAmount = tx.moveCall({
        target: '0x2::coin::value',
        typeArguments: [inputType],
        arguments: [inputCoin],
      });

      // Get optimal swap amount from on-chain binary search
      const [swapAmount] = tx.moveCall({
        target: `${this.#pkg}::trade::get_optimal_swap_amount_for_single_sided_liquidity`,
        typeArguments: [tokenXType, tokenYType],
        arguments: [
          tx.object(poolId),
          depositAmount,
          tx.object(positionId),
          tx.pure.u128(sqrtLimit),
          tx.pure.bool(isTokenX),
          tx.pure.u64(20), // max_iterations
        ],
      });

      // Split the swap portion from input
      const [swapCoin] = tx.splitCoins(inputCoin, [swapAmount]);

      // Convert swap coin to balance for flash_swap
      const swapBal = tx.moveCall({
        target: '0x2::coin::into_balance',
        typeArguments: [inputType],
        arguments: [swapCoin],
      });

      // Flash swap the portion
      const [balX, balY, receipt] = tx.moveCall({
        target: `${this.#pkg}::trade::flash_swap`,
        typeArguments: [tokenXType, tokenYType],
        arguments: [
          tx.object(poolId),
          tx.pure.bool(isTokenX),
          tx.pure.bool(true),
          swapAmount,
          tx.pure.u128(sqrtLimit),
          tx.object(this.#clk),
          tx.object(this.#ver),
        ],
      });

      // Repay flash swap
      if (isTokenX) {
        const zeroBal = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [tokenYType] });
        tx.moveCall({
          target: `${this.#pkg}::trade::repay_flash_swap`,
          typeArguments: [tokenXType, tokenYType],
          arguments: [tx.object(poolId), receipt!, swapBal!, zeroBal!, tx.object(this.#ver)],
        });
        tx.moveCall({ target: '0x2::balance::destroy_zero', typeArguments: [tokenXType], arguments: [balX!] });
        // Convert output balance to coin
        const outputCoin = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [tokenYType], arguments: [balY!] });
        // Add liquidity with remaining input + swap output
        const [refundX, refundY] = tx.moveCall({
          target: `${this.#pkg}::liquidity::add_liquidity`,
          typeArguments: [tokenXType, tokenYType],
          arguments: [
            tx.object(poolId), tx.object(positionId),
            inputCoin, outputCoin,
            tx.pure.u64(0), tx.pure.u64(0),
            tx.object(this.#clk), tx.object(this.#ver),
          ],
        });
        tx.transferObjects([refundX], tx.pure.address(sender));
        tx.transferObjects([refundY], tx.pure.address(sender));
      } else {
        const zeroBal = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [tokenXType] });
        tx.moveCall({
          target: `${this.#pkg}::trade::repay_flash_swap`,
          typeArguments: [tokenXType, tokenYType],
          arguments: [tx.object(poolId), receipt!, zeroBal!, swapBal!, tx.object(this.#ver)],
        });
        tx.moveCall({ target: '0x2::balance::destroy_zero', typeArguments: [tokenYType], arguments: [balY!] });
        const outputCoin = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [tokenXType], arguments: [balX!] });
        const [refundX, refundY] = tx.moveCall({
          target: `${this.#pkg}::liquidity::add_liquidity`,
          typeArguments: [tokenXType, tokenYType],
          arguments: [
            tx.object(poolId), tx.object(positionId),
            outputCoin, inputCoin,
            tx.pure.u64(0), tx.pure.u64(0),
            tx.object(this.#clk), tx.object(this.#ver),
          ],
        });
        tx.transferObjects([refundX], tx.pure.address(sender));
        tx.transferObjects([refundY], tx.pure.address(sender));
      }

      return tx;
    },
  };

  // ─── Internal Helpers ────────────────────────────────────────

  /**
   * Parse compute_swap_result BCS return value using @mysten/sui/bcs typed schema.
   * On-chain SwapState struct layout:
   *   amount_specified_remaining: u64, amount_calculated: u64, sqrt_price: u128,
   *   tick_index: I32, fee_growth_global: u128, protocol_fee: u64, liquidity: u128, fee_amount: u64
   */
  static readonly #swapStateSchema = bcs.struct('SwapState', {
    amount_specified_remaining: bcs.u64(),
    amount_calculated: bcs.u64(),
    sqrt_price: bcs.u128(),
    tick_index: bcs.u32(),
    fee_growth_global: bcs.u128(),
    protocol_fee: bcs.u64(),
    liquidity: bcs.u128(),
    fee_amount: bcs.u64(),
  });

  static #parseSwapResult(bcsBytes: Uint8Array | number[]): { amountOut: bigint; sqrtPriceAfter: bigint; feeAmount: bigint } {
    const bytes = bcsBytes instanceof Uint8Array ? bcsBytes : new Uint8Array(bcsBytes);
    const parsed = SuiDexCLMMClient.#swapStateSchema.parse(bytes);
    return {
      amountOut: BigInt(parsed.amount_calculated),
      sqrtPriceAfter: BigInt(parsed.sqrt_price),
      feeAmount: BigInt(parsed.fee_amount),
    };
  }

  #newTx(sender: string): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.setExpiration({ None: true }); // Wallet compat: older wallets don't support ValidDuring
    return tx;
  }

  #makeI32(tx: Transaction, tick: number) {
    if (tick >= 0) {
      return tx.moveCall({ target: `${this.#pkg}::i32::from`, arguments: [tx.pure.u32(tick)] });
    }
    return tx.moveCall({ target: `${this.#pkg}::i32::neg_from`, arguments: [tx.pure.u32(Math.abs(tick))] });
  }

  #parseI32(v: any): number {
    if (v && typeof v === 'object' && 'bits' in v) {
      const bits = Number(v.bits);
      return bits >= 0x80000000 ? bits - 0x100000000 : bits;
    }
    return Number(v ?? 0);
  }
}
