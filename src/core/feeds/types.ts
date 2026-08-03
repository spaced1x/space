import type { HealthResult } from "../health/types";

// Provider-neutral feed contracts. Business logic depends on these shapes only,
// so a provider swap is a new adapter file, never an engine change.

export type PriceSource = "BINANCE" | "CHAINLINK";

export interface PriceSample {
  source: PriceSource;
  symbol: string;
  price: number;
  /** When SPACE observed the sample. */
  observedAt: string;
  /** Provider-reported timestamp, when the provider supplies one. */
  sourceAt: string | null;
  /** observedAt - sourceAt, or request round trip for pull feeds. */
  latencyMs: number | null;
}

export interface FeedStats {
  connected: boolean;
  samples: number;
  errors: number;
  reconnects: number;
  lastError: string | null;
  lastSampleAt: string | null;
  latencyMs: number | null;
}

/** A price feed. Push feeds stream; pull feeds are polled by the scheduler. */
export interface PriceFeed {
  readonly name: string;
  readonly source: PriceSource;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Pull feeds refresh here; push feeds no-op. */
  poll(): Promise<void>;
  latest(): PriceSample | null;
  stats(): FeedStats;
  health(): HealthResult;
}