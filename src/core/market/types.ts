import type { PriceSample } from "../feeds/types";

// One immutable, versioned view of the world. Every future module (TWAP,
// windows, risk) reads this and never queries a provider directly.

export type MarketHorizon = "FIVE_MINUTE" | "FIFTEEN_MINUTE";

export const MARKET_HORIZONS: MarketHorizon[] = ["FIVE_MINUTE", "FIFTEEN_MINUTE"];

export type MarketStatus = "OPEN" | "CLOSING" | "CLOSED" | "RESOLVED" | "UNKNOWN";

export interface DiscoveredMarket {
  horizon: MarketHorizon;
  /** Venue condition id — the stable identity of the market. */
  conditionId: string;
  slug: string;
  question: string;
  status: MarketStatus;
  /** Price-to-beat from official market metadata; null until resolvable. */
  ptb: number | null;
  /** Trading close. */
  closeAt: string | null;
  /** Settlement / resolution time. */
  settlementAt: string | null;
  upTokenId: string | null;
  downTokenId: string | null;
  discoveredAt: string;
  /**
   * Read-only venue metadata carried through from the Gamma payload for the
   * operator terminal. None of it participates in market selection.
   */
  liquidity: number | null;
  volume: number | null;
  /** Venue-reported probability of the UP outcome (0-1). */
  probability: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  /** Midpoint of the venue book; null until both sides are known. */
  midPrice: number | null;
  spread: number | null;
  minOrderSize: number | null;
  resolutionSource: string | null;
}

export interface DiscoveryStats {
  lastRefreshAt: string | null;
  lastSuccessAt: string | null;
  refreshes: number;
  errors: number;
  lastError: string | null;
  candidatesSeen: number;
  latencyMs: number | null;
}

/**
 * One settlement price observed by the active TWAP provider. The market state
 * carries the sample only; which provider produced it is a registry concern.
 */
export interface SettlementSample {
  providerId: string;
  providerLabel: string;
  price: number;
  /** Provider timestamp for the observation, in epoch ms. */
  atMs: number;
  observedAt: string;
  latencyMs: number | null;
  sequence: number | null;
}

export interface MarketState {
  version: number;
  publishedAt: string;
  markets: Record<MarketHorizon, DiscoveredMarket | null>;
  binance: PriceSample | null;
  chainlink: PriceSample | null;
  /** Settlement source of truth for the TWAP service. Null until a provider reports. */
  settlement: SettlementSample | null;
  discovery: DiscoveryStats;
}
