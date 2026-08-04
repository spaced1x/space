import { describe, expect, it } from "vitest";

import { decideSize } from "../../src/core/execution/sizing";
import { derivePositionTransitions } from "../../src/core/execution/positions";
import { compareParity, type ParityTuple } from "../../src/core/execution/parity";
import type { FillRecord } from "../../src/core/execution/types";

// Phase 3 invariants: one sizing module, derived (never stored) positions and
// deterministic parity comparison. All pure — no clock, no database, no timers.

const AT = "2026-01-01T00:00:00.000Z";

function fill(patch: Partial<FillRecord> & Pick<FillRecord, "id" | "size" | "price" | "filledAt">): FillRecord {
  return {
    orderId: "order-1",
    intentId: "intent-1",
    conditionId: "0xcond",
    tokenId: "token-up",
    outcome: "UP",
    side: "BUY",
    source: "VENUE",
    ...patch,
  } as FillRecord;
}

describe("sizing module", () => {
  const base = {
    intentId: "intent-1",
    attempt: 0,
    source: "STRATEGY" as const,
    requestedSize: 25,
    exposureBefore: 10,
    openPositions: 1,
    maxPositions: 3,
    tradingEnabled: true,
    at: AT,
  };

  it("applies the requested size and projects exposure", () => {
    const decision = decideSize(base);
    expect(decision.appliedSize).toBe(25);
    expect(decision.cap).toBe("WINDOW_SIZE");
    expect(decision.exposureAfter).toBe(35);
  });

  it("caps to zero when trading is disabled", () => {
    const decision = decideSize({ ...base, tradingEnabled: false });
    expect(decision.appliedSize).toBe(0);
    expect(decision.cap).toBe("TRADING_DISABLED");
  });

  it("caps to zero at the position limit", () => {
    const decision = decideSize({ ...base, openPositions: 3 });
    expect(decision.appliedSize).toBe(0);
    expect(decision.cap).toBe("MAX_POSITIONS");
  });

  it("decides manual and strategy sizes through the same function", () => {
    const manual = decideSize({ ...base, source: "MANUAL", requestedSize: 5 });
    const strategy = decideSize({ ...base, requestedSize: 5 });
    expect(manual.appliedSize).toBe(strategy.appliedSize);
  });

  it("is deterministic", () => {
    expect(decideSize(base)).toEqual(decideSize(base));
  });
});

describe("position lifecycle derivation", () => {
  const fills: FillRecord[] = [
    fill({ id: "f1", size: 10, price: 0.5, filledAt: "2026-01-01T00:00:01.000Z" }),
    fill({ id: "f2", size: 10, price: 0.6, filledAt: "2026-01-01T00:00:02.000Z" }),
    fill({ id: "f3", size: 5, price: 0.7, side: "SELL", filledAt: "2026-01-01T00:00:03.000Z" }),
    fill({ id: "f4", size: 15, price: 0.8, side: "SELL", filledAt: "2026-01-01T00:00:04.000Z" }),
  ];

  it("derives open, increase, partial close and close in order", () => {
    const rows = derivePositionTransitions([], fills);
    expect(rows.map((row) => row.transition)).toEqual([
      "OPENING",
      "OPENED",
      "INCREASING",
      "REDUCING",
      "PARTIALLY_CLOSED",
      "CLOSED",
    ]);
  });

  it("regenerates an identical ledger from the same fills after a restart", () => {
    const first = derivePositionTransitions([], fills);
    const shuffled = [fills[3]!, fills[1]!, fills[0]!, fills[2]!];
    expect(derivePositionTransitions([], shuffled)).toEqual(first);
  });

  it("returns nothing when there are no fills", () => {
    expect(derivePositionTransitions([], [])).toEqual([]);
  });
});

describe("V1/V2 parity comparison", () => {
  const tuple: ParityTuple = {
    discoveredMarket: "btc-updown-1200",
    selectedMarket: "btc-updown-1200",
    windowSeconds: 15,
    direction: "UP",
    ptb: 100_000,
    confidence: 0.5,
    settlementTwap: 100_010,
    trigger: 99_995,
    riskStatus: "APPROVED",
    riskCode: "OK",
    sizingApplied: 25,
    sizingCap: "WINDOW_SIZE",
    intentId: "intent-v1",
  };

  it("reports no difference for identical decisions", () => {
    expect(compareParity(tuple, { ...tuple, intentId: "intent-v2" })).toEqual([]);
  });

  it("names every differing field", () => {
    const differences = compareParity(tuple, {
      ...tuple,
      direction: "DOWN",
      sizingApplied: 10,
    });
    expect(differences.map((difference) => difference.field).sort()).toEqual([
      "direction",
      "sizingApplied",
    ]);
    expect(differences.find((d) => d.field === "sizingApplied")).toMatchObject({
      v1: "25",
      v2: "10",
    });
  });
});
