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

/** Runtime state machine shared by every streaming feed. */
export type FeedState = "IDLE" | "CONNECTING" | "CONNECTED" | "STALE" | "RECONNECTING" | "FAILED";

export interface FeedStats {
  connected: boolean;
  state: FeedState;
  samples: number;
  errors: number;
  reconnects: number;
  lastError: string | null;
  lastSampleAt: string | null;
  latencyMs: number | null;
  /** Provider update id / event time of the last accepted message. */
  lastSequence: number | null;
  lastUpdateAt: string | null;
  endpoint: string | null;
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
