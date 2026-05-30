/**
 * SuiDex V3 CLMM — On-chain constants
 */

export const MAINNET = {
  /** Latest published package (for function calls) */
  PACKAGE_ID: '0xb5f529c1dcda6580a61bf7ee9fbd524b50be62f11044d137c8202c8cbace9e56',
  /** Original package (for struct type arguments) */
  ORIGINAL_PACKAGE_ID: '0xb5f529c1dcda6580a61bf7ee9fbd524b50be62f11044d137c8202c8cbace9e56',
  /** Version object (shared, immutable) */
  VERSION_ID: '0x0999bbc9c063580eca62e888b8f0d8e6e9159cd9db1b8a8c88e448a2b5dd4d4d',
  /** Sui Clock object */
  CLOCK_ID: '0x0000000000000000000000000000000000000000000000000000000000000006',
} as const;

export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673515401279992447579055n;
export const Q64 = 1n << 64n;
export const FEE_DENOMINATOR = 1_000_000n;
