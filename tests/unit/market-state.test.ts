import { beforeEach, describe, expect, it } from "vitest";

import {
  applyDiscovery,
  applyPriceSample,
  getMarketState,
  resetMarketState,
} from "../../src/core/market/state";

describe("unified market state", () => {
  beforeEach(() => {
    resetMarketState();
  });

  it("versions monotonically on every publication", () => {
    const before = getMarketState().version;
    applyPriceSample({
      source: "BINANCE",
      symbol: "BTCUSDT",
      price: 65000,
      observedAt: new Date().toISOString(),
      receivedAt: Date.now(),
      latencyMs: 12,
    });
    expect(getMarketState().version).toBe(before + 1);
    expect(getMarketState().binance?.price).toBe(65000);
  });

  it("keeps published state immutable", () => {
    const state = getMarketState();
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("stores discovered markets per horizon", () => {
    applyDiscovery(
      {
        FIVE_MINUTE: {
          horizon: "FIVE_MINUTE",
          conditionId: "0xabc",
          question: "BTC up in 5m?",
          status: "OPEN",
          ptb: 65010,
          closeAt: new Date().toISOString(),
          settlementAt: new Date().toISOString(),
          discoveredAt: new Date().toISOString(),
        },
        FIFTEEN_MINUTE: null,
      },
      { lastRunAt: new Date().toISOString(), lastError: null, runs: 1, failures: 0 },
    );
    expect(getMarketState().markets.FIVE_MINUTE?.conditionId).toBe("0xabc");
    expect(getMarketState().markets.FIFTEEN_MINUTE).toBeNull();
  });
});
