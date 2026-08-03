import type { ExecutionConfig } from "./types";

// Operational settings never live in .env. Until the Operations Desk lands,
// these defaults are the active execution configuration version; the desk will
// replace this loader with a database-backed one without any execution module
// changing.
export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  mode: "LIMIT_ONLY",
  size: 5,
  limitPrice: 0.5,
  maxLimitPrice: 0.97,
  priceSlippage: 0.02,
  limitTimeoutMs: 3_000,
  maxRetries: 2,
  retryDelayMs: 500,
  maxPositions: 3,
  strategyEnabled: true,
  marketEnabled: true,
  dailyTradingEnabled: true,
  fillPollMs: 1_000,
};

export function lockExecutionConfig(config: ExecutionConfig): ExecutionConfig {
  if (config.size <= 0) throw new Error("execution config: size must be > 0");
  if (config.limitPrice <= 0 || config.limitPrice >= 1) {
    throw new Error("execution config: limitPrice must be between 0 and 1");
  }
  if (config.maxLimitPrice <= 0 || config.maxLimitPrice >= 1) {
    throw new Error("execution config: maxLimitPrice must be between 0 and 1");
  }
  if (config.maxRetries < 0) throw new Error("execution config: maxRetries must be >= 0");
  if (config.limitTimeoutMs < 0) throw new Error("execution config: limitTimeoutMs must be >= 0");
  return Object.freeze({ ...config });
}

/** Clamp any computed price into the tradable range and the configured ceiling. */
export function clampPrice(price: number, config: ExecutionConfig): number {
  const bounded = Math.min(Math.max(price, 0.01), config.maxLimitPrice);
  return Math.round(bounded * 1000) / 1000;
}