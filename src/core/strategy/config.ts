import type { StrategyConfig, WindowConfig } from "./types";

// Buffer Engine + configuration source.
//
// Operational settings never live in .env. Until the Operations Desk lands
// (milestone 4) these defaults are the active configuration version; the
// Operations Desk will replace this loader with a database-backed version
// without any strategy module changing.

export const DEFAULT_WINDOWS: WindowConfig[] = [
  { seconds: 15, buffer: 6.5, enabled: true },
  { seconds: 10, buffer: 5.0, enabled: true },
  { seconds: 7, buffer: 3.5, enabled: true },
  { seconds: 5, buffer: 2.0, enabled: true },
  { seconds: 3, buffer: 1.0, enabled: true },
];

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  windows: DEFAULT_WINDOWS,
  tradesPerMarket: 3,
  maxTwapAgeMs: 3_000,
  minTwapSamples: 3,
};

/**
 * Normalise and freeze a configuration version. Windows are sorted
 * furthest-from-settlement first so quota is always consumed in the
 * deterministic 15s -> 10s -> 7s -> 5s -> 3s order.
 */
export function lockConfig(config: StrategyConfig): StrategyConfig {
  const windows = [...config.windows]
    .filter((window) => window.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .map((window) => Object.freeze({ ...window }));
  if (new Set(windows.map((w) => w.seconds)).size !== windows.length) {
    throw new Error("strategy config: duplicate window seconds");
  }
  if (config.tradesPerMarket < 0) throw new Error("strategy config: tradesPerMarket must be >= 0");
  return Object.freeze({ ...config, windows: Object.freeze(windows) as WindowConfig[] });
}

/** The buffer that applies to a window, read once at window open. */
export function bufferFor(config: StrategyConfig, seconds: number): number {
  const window = config.windows.find((entry) => entry.seconds === seconds);
  if (!window) throw new Error(`strategy config: no window configured for ${seconds}s`);
  return window.buffer;
}
