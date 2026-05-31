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
import { MAINNET, MIN_SQRT_PRICE, MAX_SQRT_PRICE, Q64 } from './constants.js';
import { tickToSqrtPrice } from './math.js';
import type {
  Pool, QuoteResult, SwapParams,
  AddLiquidityParams, RemoveLiquidityParams, CollectFeesParams,
  SuiDexSDKOptions,
} from './types.js';

// ─── Client Extension Factory ────────────────────────────────────

export function suidexCLMM<const Name = 'suidex'>({
  name = 'suidex' as Name,
  packageId,
  versionId,
}: SuiDexSDKOptions<Name> = {}) {
  return {
    name,
    register: (client: ClientWithCoreApi) => {
      return new SuiDexCLMMClient({
        client,
        packageId: packageId ?? MAINNET.PACKAGE_ID,
        versionId: versionId ?? MAINNET.VERSION_ID,
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

  constructor({ client, packageId, versionId }: {
    client: ClientWithCoreApi;
    packageId: string;
    versionId: string;
  }) {
    this.#client = client;
    this.#pkg = packageId;
    this.#ver = versionId;
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
      const { amountOut, sqrtPriceAfter } = SuiDexCLMMClient.#parseSwapResult(rv.bcs ?? []);

      // Estimated price impact: compares spot price output vs actual output.
      // This is an approximation — it does not account for fee structure or
      // multi-tick crossing granularity. Treat as directional, not exact.
      let priceImpact = 0;
      const pool = await this.getPool(poolId);
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
      };
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

    /** Build a remove_liquidity transaction. */
    removeLiquidity: (params: RemoveLiquidityParams): Transaction => {
      const { poolId, positionId, tokenXType, tokenYType, liquidityAmount, sender, closePosition, minAmountX = 0n, minAmountY = 0n } = params;
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
  };

  // ─── Internal Helpers ────────────────────────────────────────

  /**
   * Parse compute_swap_result BCS return value.
   * Layout: [amount_specified_remaining(u64), amount_calculated(u64), sqrt_price(u128)]
   */
  static #parseSwapResult(bcsBytes: Uint8Array | number[]): { amountOut: bigint; sqrtPriceAfter: bigint } {
    let amountOut = 0n;
    for (let i = 0; i < 8; i++) {
      const b = bcsBytes[i + 8];
      if (b !== undefined) amountOut += BigInt(b) << BigInt(i * 8);
    }
    let sqrtPriceAfter = 0n;
    for (let i = 0; i < 16; i++) {
      const b = bcsBytes[i + 16];
      if (b !== undefined) sqrtPriceAfter += BigInt(b) << BigInt(i * 8);
    }
    return { amountOut, sqrtPriceAfter };
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
