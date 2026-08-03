import { describe, expect, it } from "vitest";

import type { DiscoveredMarket, MarketHorizon, MarketState } from "../../src/core/market/types";
import { DEFAULT_STRATEGY_CONFIG } from "../../src/core/strategy/config";
import { createStrategyEngine } from "../../src/core/strategy/engine";
import { createSettlementTwap } from "../../src/core/strategy/twap";
import type { StrategyConfig } from "../../src/core/strategy/types";
import {
  computeFrozenTrigger,
  isTriggered,
  resolveDirection,
} from "../../src/core/strategy/windows";

// Deterministic strategy tests: a fixed settlement time, a scripted price feed
// and a hand-driven clock. No timers, no network, no randomness.

const SETTLEMENT = Date.parse("2026-01-01T00:05:00.000Z");
const ENABLED: Record<MarketHorizon, boolean> = { FIVE_MINUTE: true, FIFTEEN_MINUTE: true };

const CONFIG: StrategyConfig = {
  ...DEFAULT_STRATEGY_CONFIG,
  windows: [
    { seconds: 15, buffer: 5, enabled: true },
    { seconds: 10, buffer: 4, enabled: true },
    { seconds: 7, buffer: 3, enabled: true },
    { seconds: 5, buffer: 2, enabled: true },
    { seconds: 3, buffer: 1, enabled: true },
  ],
  tradesPerMarket: 3,
  minTwapSamples: 2,
  maxTwapAgeMs: 3_000,
};

function market(ptb: number | null, horizon: MarketHorizon = "FIVE_MINUTE"): MarketState {
  const discovered: DiscoveredMarket = {
    horizon,
    conditionId: "0xcond",
    slug: "btc-up-or-down-5m",
    question: "Will BTC go up?",
    status: "OPEN",
    ptb,
    closeAt: new Date(SETTLEMENT).toISOString(),
    settlementAt: new Date(SETTLEMENT).toISOString(),
    upTokenId: "1",
    downTokenId: "2",
    discoveredAt: new Date(SETTLEMENT - 300_000).toISOString(),
  };
  return {
    version: 1,
    publishedAt: new Date(SETTLEMENT - 300_000).toISOString(),
    markets: { FIVE_MINUTE: horizon === "FIVE_MINUTE" ? discovered : null, FIFTEEN_MINUTE: horizon === "FIFTEEN_MINUTE" ? discovered : null },
    binance: null,
    chainlink: null,
    discovery: {
      lastRefreshAt: null,
      lastSuccessAt: null,
      refreshes: 1,
      errors: 0,
      lastError: null,
      candidatesSeen: 1,
      latencyMs: 10,
    },
  };
}

/** Drive the engine second-by-second with a flat, then scripted, price. */
function run(prices: (msFromSettlement: number) => number, config = CONFIG, ptb = 100_000) {
  const engine = createStrategyEngine(config);
  const state = market(ptb);
  // Warm the TWAP well before the first window opens.
  for (let offset = -40_000; offset <= 0; offset += 250) {
    const now = SETTLEMENT + offset;
    engine.ingestPrice(prices(offset), now);
    engine.evaluate(now, state, ENABLED);
  }
  return { engine, snapshot: engine.snapshot(SETTLEMENT, state) };
}

describe("settlement TWAP engine", () => {
  it("uses the final 30s for BTC 5m and the final 60s for BTC 15m", () => {
    const twap = createSettlementTwap(CONFIG);
    for (let offset = -120_000; offset <= 0; offset += 1000) {
      twap.ingest(offset < -30_000 ? 100 : 200, SETTLEMENT + offset);
    }
    const five = twap.read(SETTLEMENT, SETTLEMENT, "FIVE_MINUTE");
    const fifteen = twap.read(SETTLEMENT, SETTLEMENT, "FIFTEEN_MINUTE");
    expect(five.lengthSeconds).toBe(30);
    expect(fifteen.lengthSeconds).toBe(60);
    expect(five.value).toBeCloseTo(200, 6);
    // Half the 60s window sat at 100, half at 200.
    expect(fifteen.value).toBeCloseTo(150, 0);
  });

  it("is time-weighted, not sample-weighted", () => {
    const twap = createSettlementTwap(CONFIG);
    twap.ingest(100, SETTLEMENT - 30_000);
    twap.ingest(100, SETTLEMENT - 20_000);
    twap.ingest(200, SETTLEMENT - 15_000);
    const reading = twap.read(SETTLEMENT, SETTLEMENT, "FIVE_MINUTE");
    expect(reading.value).toBeCloseTo(150, 6);
  });

  it("reports STALE when the feed stops", () => {
    const twap = createSettlementTwap(CONFIG);
    twap.ingest(100, SETTLEMENT - 30_000);
    twap.ingest(100, SETTLEMENT - 25_000);
    const reading = twap.read(SETTLEMENT - 1_000, SETTLEMENT, "FIVE_MINUTE");
    expect(reading.state).toBe("STALE");
  });
});

describe("frozen trigger maths", () => {
  it("derives direction from opening TWAP versus PTB", () => {
    expect(resolveDirection(100_010, 100_000)).toBe("UP");
    expect(resolveDirection(99_990, 100_000)).toBe("DOWN");
  });

  it("adds the buffer for UP and subtracts it for DOWN", () => {
    expect(computeFrozenTrigger(100_000, 5, "UP")).toBe(100_005);
    expect(computeFrozenTrigger(100_000, 5, "DOWN")).toBe(99_995);
  });

  it("triggers on reaching the frozen trigger from the correct side", () => {
    const up = { direction: "UP", frozenTrigger: 100_005 } as never;
    const down = { direction: "DOWN", frozenTrigger: 99_995 } as never;
    expect(isTriggered(up, 100_005)).toBe(true);
    expect(isTriggered(up, 100_004.99)).toBe(false);
    expect(isTriggered(down, 99_995)).toBe(true);
    expect(isTriggered(down, 99_995.01)).toBe(false);
  });
});

describe("frozen window lifecycle", () => {
  it("captures the opening TWAP and never changes the trigger", () => {
    const { snapshot } = run((offset) => (offset < -14_000 ? 100_010 : 100_500));
    const first = snapshot.windows.find((window) => window.seconds === 15)!;
    expect(first.frozen).not.toBeNull();
    expect(first.frozen!.direction).toBe("UP");
    expect(first.frozen!.buffer).toBe(5);
    expect(first.frozen!.frozenTrigger).toBe(first.frozen!.openingTwap + 5);
  });

  it("produces an UP execution intent when the TWAP rises through the trigger", () => {
    const { snapshot } = run((offset) => (offset < -14_000 ? 100_010 : 101_000));
    const intent = snapshot.intents.find((entry) => entry.windowSeconds === 15);
    expect(intent).toBeDefined();
    expect(intent!.direction).toBe("UP");
    expect(intent!.settlementTwap).toBeGreaterThanOrEqual(intent!.frozenTrigger);
    expect(intent!.id).toBe("intent:0xcond:15s");
  });

  it("produces a DOWN execution intent when the TWAP falls through the trigger", () => {
    const { snapshot } = run((offset) => (offset < -14_000 ? 99_990 : 90_000));
    const intent = snapshot.intents.find((entry) => entry.windowSeconds === 15);
    expect(intent).toBeDefined();
    expect(intent!.direction).toBe("DOWN");
    expect(intent!.settlementTwap).toBeLessThanOrEqual(intent!.frozenTrigger);
  });

  it("expires a window with NO_TRIGGER when the trigger is never reached", () => {
    const { snapshot } = run(() => 100_010);
    const first = snapshot.windows.find((window) => window.seconds === 15)!;
    expect(first.state).toBe("NO_TRIGGER");
    expect(first.timeline.map((entry) => entry.state)).toEqual([
      "WAITING",
      "OPEN",
      "ACTIVE",
      "EXPIRED",
      "NO_TRIGGER",
    ]);
    expect(snapshot.intents).toHaveLength(0);
  });

  it("exhausts the quota after trades-per-market intents, in 15/10/7 order", () => {
    // A price that keeps climbing satisfies every window's UP trigger.
    const { snapshot } = run((offset) => 100_010 + (offset + 40_000) * 0.5);
    const triggered = snapshot.windows.filter((window) => window.intentId !== null);
    expect(triggered.map((window) => window.seconds)).toEqual([15, 10, 7]);
    expect(snapshot.quota).toEqual({ tradesPerMarket: 3, used: 3, remaining: 0 });
    const rest = snapshot.windows.filter((window) => window.seconds < 7);
    expect(rest.every((window) => window.state === "QUOTA_EXHAUSTED")).toBe(true);
  });

  it("marks windows WINDOW_DISABLED when the operator switches the horizon off", () => {
    const engine = createStrategyEngine(CONFIG);
    const state = market(100_000);
    for (let offset = -40_000; offset <= 0; offset += 250) {
      engine.ingestPrice(100_100, SETTLEMENT + offset);
      engine.evaluate(SETTLEMENT + offset, state, { FIVE_MINUTE: false, FIFTEEN_MINUTE: true });
    }
    const snapshot = engine.snapshot(SETTLEMENT, state);
    expect(snapshot.windows.every((window) => window.state === "WINDOW_DISABLED")).toBe(true);
  });

  it("never freezes without a validated PTB", () => {
    const engine = createStrategyEngine(CONFIG);
    const state = market(null);
    for (let offset = -40_000; offset <= 0; offset += 250) {
      engine.ingestPrice(100_100, SETTLEMENT + offset);
      engine.evaluate(SETTLEMENT + offset, state, ENABLED);
    }
    const snapshot = engine.snapshot(SETTLEMENT, state);
    expect(snapshot.windows.every((window) => window.frozen === null)).toBe(true);
    expect(snapshot.intents).toHaveLength(0);
  });

  it("is reproducible: identical inputs produce identical intents", () => {
    const script = (offset: number) => (offset < -14_000 ? 100_010 : 101_000);
    const a = run(script).snapshot;
    const b = run(script).snapshot;
    expect(JSON.stringify(a.intents)).toBe(JSON.stringify(b.intents));
  });

  it("uses each window's own buffer", () => {
    const { snapshot } = run(() => 100_010);
    expect(snapshot.windows.map((window) => window.buffer)).toEqual([5, 4, 3, 2, 1]);
  });
});
