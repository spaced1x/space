import { eventBus } from "../bus/events";
import { systemClock } from "../shared/clock";
import type { PriceSample } from "../feeds/types";
import type {
  DiscoveredMarket,
  DiscoveryStats,
  MarketHorizon,
  MarketState,
  SettlementSample,
} from "./types";

// Single owner of market truth. Pure and immutable: each publish produces a new
// frozen object with a monotonic version, so consumers can compare by version.

const emptyDiscovery: DiscoveryStats = {
  lastRefreshAt: null,
  lastSuccessAt: null,
  refreshes: 0,
  errors: 0,
  lastError: null,
  candidatesSeen: 0,
  latencyMs: null,
};

function initial(): MarketState {
  return Object.freeze({
    version: 0,
    publishedAt: systemClock.iso(),
    markets: Object.freeze({ FIVE_MINUTE: null, FIFTEEN_MINUTE: null }) as Record<
      MarketHorizon,
      DiscoveredMarket | null
    >,
    binance: null,
    chainlink: null,
    settlement: null,
    discovery: { ...emptyDiscovery },
  });
}

let state: MarketState = initial();

export function getMarketState(): MarketState {
  return state;
}

export function resetMarketState(): void {
  state = initial();
}

function publish(next: Omit<MarketState, "version" | "publishedAt">, reason: string): MarketState {
  state = Object.freeze({
    ...next,
    markets: Object.freeze({ ...next.markets }) as Record<MarketHorizon, DiscoveredMarket | null>,
    version: state.version + 1,
    publishedAt: systemClock.iso(),
  });
  if (reason) {
    eventBus.publish({
      type: "market.state.published",
      severity: "INFO",
      correlationId: `market_v${state.version}`,
      source: "market-state",
      payload: { reason, version: state.version },
    });
  }
  return state;
}

export function applyPriceSample(sample: PriceSample): MarketState {
  const key = sample.source === "BINANCE" ? "binance" : "chainlink";
  return publish({ ...state, [key]: sample }, "");
}

/**
 * Publishes a settlement price observed by the active TWAP provider. This is
 * the only settlement source the strategy engine reads — there is no fallback.
 */
export function applySettlementSample(sample: SettlementSample): MarketState {
  return publish({ ...state, settlement: sample }, "");
}

export function applyDiscovery(
  markets: Partial<Record<MarketHorizon, DiscoveredMarket | null>>,
  stats: DiscoveryStats,
): MarketState {
  const nextMarkets = { ...state.markets, ...markets };
  const changed = (Object.keys(nextMarkets) as MarketHorizon[]).some(
    (horizon) => nextMarkets[horizon]?.conditionId !== state.markets[horizon]?.conditionId,
  );
  return publish(
    { ...state, markets: nextMarkets, discovery: stats },
    changed ? "active market changed" : "",
  );
}