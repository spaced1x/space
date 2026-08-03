import { z } from "zod";

import { ORDER_MODES, type ExecutionConfig, type OrderMode } from "../execution/types";
import type { StrategyConfig } from "../strategy/types";

// The Operations Desk configuration document.
//
// This is the single operational configuration version of SPACE. Secrets stay
// in .env; everything an operator tunes lives here and is persisted in SQLite.
//
// Two copies exist at runtime:
//   staged  — what the operator edited, durable immediately
//   active  — what the engine is trading right now
// The staged copy is promoted to active only when a *new* market is discovered,
// so a configuration change can never reach a market already in flight.

export interface WindowSetting {
  /** Seconds before settlement at which the window opens. */
  seconds: number;
  enabled: boolean;
  /** Decimal buffer, per window. */
  buffer: number;
  /** Trade size in outcome shares, per window. */
  size: number;
}

export interface OperationsConfig {
  /** Monotonic document version. Bumped on every accepted edit. */
  version: number;
  updatedAt: string;
  strategyEnabled: boolean;
  manualEnabled: boolean;
  dailyTradingEnabled: boolean;
  markets: { fiveMinute: boolean; fifteenMinute: boolean };
  windows: WindowSetting[];
  tradesPerMarket: number;
  maxPositions: number;
  orderMode: OrderMode;
  retryCount: number;
  retryDelayMs: number;
  limitTimeoutMs: number;
}

export const DEFAULT_OPERATIONS_CONFIG: OperationsConfig = {
  version: 1,
  updatedAt: "1970-01-01T00:00:00.000Z",
  strategyEnabled: true,
  manualEnabled: false,
  dailyTradingEnabled: true,
  markets: { fiveMinute: true, fifteenMinute: true },
  windows: [
    { seconds: 15, enabled: true, buffer: 6.5, size: 5 },
    { seconds: 10, enabled: true, buffer: 5.0, size: 5 },
    { seconds: 7, enabled: true, buffer: 3.5, size: 5 },
    { seconds: 5, enabled: true, buffer: 2.0, size: 5 },
    { seconds: 3, enabled: true, buffer: 1.0, size: 5 },
  ],
  tradesPerMarket: 3,
  maxPositions: 3,
  orderMode: "LIMIT_ONLY",
  retryCount: 2,
  retryDelayMs: 500,
  limitTimeoutMs: 3_000,
};

const windowSchema = z.object({
  seconds: z.number().int().positive().max(600),
  enabled: z.boolean(),
  buffer: z.number().min(0).max(10_000),
  size: z.number().positive().max(100_000),
});

export const operationsPatchSchema = z
  .object({
    strategyEnabled: z.boolean(),
    manualEnabled: z.boolean(),
    dailyTradingEnabled: z.boolean(),
    markets: z.object({ fiveMinute: z.boolean(), fifteenMinute: z.boolean() }),
    windows: z.array(windowSchema).min(1).max(12),
    tradesPerMarket: z.number().int().min(0).max(50),
    maxPositions: z.number().int().min(0).max(100),
    orderMode: z.enum(ORDER_MODES as [OrderMode, ...OrderMode[]]),
    retryCount: z.number().int().min(0).max(20),
    retryDelayMs: z.number().int().min(0).max(60_000),
    limitTimeoutMs: z.number().int().min(0).max(120_000),
  })
  .partial();

export type OperationsPatch = z.infer<typeof operationsPatchSchema>;

/**
 * Validate, normalise and freeze a configuration document. Windows are sorted
 * furthest-from-settlement first so quota is always consumed in the
 * deterministic 15s -> 10s -> 7s -> 5s -> 3s order.
 */
export function lockOperations(config: OperationsConfig): OperationsConfig {
  const windows = [...config.windows]
    .filter((window) => window.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .map((window) => Object.freeze({ ...window }));
  if (windows.length === 0) throw new Error("operations config: at least one window is required");
  if (new Set(windows.map((w) => w.seconds)).size !== windows.length) {
    throw new Error("operations config: duplicate window seconds");
  }
  for (const window of windows) {
    if (window.buffer < 0) throw new Error(`operations config: ${window.seconds}s buffer must be >= 0`);
    if (!(window.size > 0)) throw new Error(`operations config: ${window.seconds}s size must be > 0`);
  }
  if (config.tradesPerMarket < 0) throw new Error("operations config: tradesPerMarket must be >= 0");
  if (config.maxPositions < 0) throw new Error("operations config: maxPositions must be >= 0");
  if (config.retryCount < 0) throw new Error("operations config: retryCount must be >= 0");
  return Object.freeze({
    ...config,
    markets: Object.freeze({ ...config.markets }),
    windows: Object.freeze(windows) as WindowSetting[],
  });
}

export function applyOperationsPatch(
  current: OperationsConfig,
  patch: OperationsPatch,
  at: string,
): OperationsConfig {
  return lockOperations({
    ...current,
    ...patch,
    markets: { ...current.markets, ...(patch.markets ?? {}) },
    windows: patch.windows ?? current.windows,
    version: current.version + 1,
    updatedAt: at,
  });
}

/** Projection consumed by the Strategy Engine. */
export function toStrategyConfig(config: OperationsConfig, base: StrategyConfig): StrategyConfig {
  return {
    ...base,
    windows: config.windows.map((window) => ({
      seconds: window.seconds,
      buffer: window.buffer,
      enabled: window.enabled,
    })),
    tradesPerMarket: config.tradesPerMarket,
  };
}

/** Projection consumed by the Execution Engine. */
export function toExecutionConfig(
  config: OperationsConfig,
  base: ExecutionConfig,
): ExecutionConfig {
  return {
    ...base,
    mode: config.orderMode,
    size: config.windows[0]?.size ?? base.size,
    maxRetries: config.retryCount,
    retryDelayMs: config.retryDelayMs,
    limitTimeoutMs: config.limitTimeoutMs,
    maxPositions: config.maxPositions,
    strategyEnabled: config.strategyEnabled,
    dailyTradingEnabled: config.dailyTradingEnabled,
  };
}

/** Per-window trade size, falling back to the largest window's size. */
export function sizeForWindow(config: OperationsConfig, seconds: number): number {
  const match = config.windows.find((window) => window.seconds === seconds);
  return match?.size ?? config.windows[0]?.size ?? 0;
}

export function windowEnabled(config: OperationsConfig, seconds: number): boolean {
  const match = config.windows.find((window) => window.seconds === seconds);
  return match ? match.enabled : true;
}
