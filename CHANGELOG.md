# Changelog

## 1.0.0 (2026-05-31)

### Features
- On-chain swap quotes via `compute_swap_result` simulation
- Transaction builders: swap, addLiquidity, removeLiquidity, collectFees
- CLMM math utilities: tick/price conversions, liquidity calculations
- SIP-58 compatible (`coinWithBalance` for address balance resolution)
- Client extension pattern (`$extend(suidexCLMM())`)
- Custom deployment support (override packageId/versionId)

### Security
- Swap enforces `minAmountOut` via on-chain `balance::split` + `balance::join`
- `addLiquidity` and `removeLiquidity` accept `minAmountX`/`minAmountY` for slippage protection
- All transaction builders return unsigned `Transaction` objects — signing is always caller-controlled
