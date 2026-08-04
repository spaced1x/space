import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_CONFIG } from "../../src/core/execution/config";
import { createExecutionEngine, buildPositions } from "../../src/core/execution/engine";
import { canTransition } from "../../src/core/execution/lifecycle";
import { evaluateRisk } from "../../src/core/execution/risk";
import type { ExecutionStore } from "../../src/core/execution/store";
import type {
  ExecutionConfig,
  FillRecord,
  OrderEventRecord,
  OrderRecord,
  RiskContext,
  RiskDecision,
  WalletStatus,
} from "../../src/core/execution/types";
import type {
  VenueAdapter,
  VenueOrderAck,
  VenueOrderRequest,
  VenueOrderStatus,
  VenueTrade,
} from "../../src/core/execution/venue";
import type { ExecutionIntent } from "../../src/core/strategy/types";

// Deterministic execution tests. A hand-driven clock, an in-memory store that
// enforces the same uniqueness guarantees as SQLite, and a scripted venue.
// No timers, no network, no randomness.

const T0 = Date.parse("2026-01-01T00:04:45.000Z");

const WALLET: WalletStatus = {
  ready: true,
  environment: "V1_TESTNET",
  chainId: 80002,
  address: "0xabc",
  funderAddress: "0xabc",
  hasPrivateKey: true,
  hasApiCredentials: true,
  reason: "ready",
};

function intent(id = "intent-1"): ExecutionIntent {
  return {
    id,
    createdAt: new Date(T0).toISOString(),
    conditionId: "0xcond",
    slug: "btc-up-or-down-5m",
    horizon: "FIVE_MINUTE",
    windowSeconds: 15,
    direction: "UP",
    openingTwap: 100_000,
    settlementTwap: 100_010,
    ptb: 99_990,
    buffer: 5,
    frozenTrigger: 99_995,
    triggerTime: new Date(T0).toISOString(),
    reason: "frozen trigger crossed",
  };
}

function context(patch: Partial<RiskContext> = {}): RiskContext {
  return {
    at: new Date(T0).toISOString(),
    engineArmed: true,
    strategyMode: true,
    strategyEnabled: true,
    marketEnabled: true,
    windowEnabled: true,
    quotaRemaining: 3,
    openPositions: 0,
    maxPositions: 3,
    dailyTradingEnabled: true,
    wallet: WALLET,
    marketActive: true,
    activeConditionId: "0xcond",
    tokenId: "token-up",
    alreadyExecuted: false,
    size: 5,
    ...patch,
  };
}

/** Mirrors the SQLite guarantees: unique intent_id, unique fill id, append-only. */
function memoryStore() {
  const orders = new Map<string, OrderRecord>();
  const byIntent = new Set<string>();
  const fills = new Map<string, FillRecord>();
  const events: OrderEventRecord[] = [];
  const risks: RiskDecision[] = [];
  const transitions: import("../../src/core/execution/types").OrderTransitionRecord[] = [];
  const positionTransitions: import("../../src/core/execution/types").PositionTransitionRecord[] = [];
  const sizings: import("../../src/core/execution/types").SizingDecision[] = [];

  const store: ExecutionStore = {
    async createOrder(order) {
      if (byIntent.has(order.intentId)) return false;
      byIntent.add(order.intentId);
      orders.set(order.id, order);
      return true;
    },
    async updateOrder(order) {
      orders.set(order.id, order);
    },
    async appendEvent(event) {
      events.push(event);
    },
    async commit({ order, event, transition }) {
      orders.set(order.id, order);
      events.push(event);
      if (transition) transitions.push(transition);
    },
    async recordSizing(decision) {
      sizings.push(decision);
    },
    async recordPositionTransitions(rows) {
      let written = 0;
      for (const row of rows) {
        const key = `${row.positionKey}|${row.transition}|${row.at}|${row.fillId ?? ""}`;
        if (positionTransitions.some(
          (existing) =>
            `${existing.positionKey}|${existing.transition}|${existing.at}|${existing.fillId ?? ""}` === key,
        )) {
          continue;
        }
        positionTransitions.push(row);
        written += 1;
      }
      return written;
    },
    async loadPositionTransitions() {
      return [...positionTransitions];
    },
    async loadOrderTransitions() {
      return [...transitions];
    },
    async recordFill(fill) {
      if (fills.has(fill.id)) return false;
      fills.set(fill.id, fill);
      return true;
    },
    async recordRisk(decision) {
      risks.push(decision);
    },
    async loadOrders() {
      return [...orders.values()];
    },
    async loadFills() {
      return [...fills.values()];
    },
  };
  return { store, orders, fills, events, risks, transitions, positionTransitions, sizings };
}

interface ScriptedVenue extends VenueAdapter {
  submissions: VenueOrderRequest[];
  cancels: string[];
  setTrades(venueOrderId: string, trades: VenueTrade[]): void;
  setStatus(venueOrderId: string, status: VenueOrderStatus | null): void;
  fail(message: string | null): void;
}

function scriptedVenue(): ScriptedVenue {
  const trades = new Map<string, VenueTrade[]>();
  const statuses = new Map<string, VenueOrderStatus | null>();
  let failure: string | null = null;
  let seq = 0;

  const venue: ScriptedVenue = {
    submissions: [],
    cancels: [],
    describe: () => ({
      kind: "scripted",
      host: "memory",
      chainId: 80002,
      ready: true,
      message: "scripted venue",
    }),
    ready: () => true,
    bestPrice: async () => 0.5,
    async submit(request): Promise<VenueOrderAck> {
      if (failure) throw new Error(failure);
      venue.submissions.push(request);
      seq += 1;
      const venueOrderId = `venue-${seq}`;
      statuses.set(venueOrderId, {
        venueOrderId,
        status: "OPEN",
        size: request.size,
        filledSize: 0,
        price: request.price,
      });
      return { venueOrderId, status: "OPEN", filledSize: 0 };
    },
    async cancel(venueOrderId) {
      venue.cancels.push(venueOrderId);
      statuses.set(venueOrderId, null);
    },
    async status(venueOrderId) {
      return statuses.get(venueOrderId) ?? null;
    },
    async trades(venueOrderId) {
      return trades.get(venueOrderId) ?? [];
    },
    async openOrders(tokenId) {
      return [...statuses.entries()]
        .filter(([_, status]) => status !== null)
        .map(([venueOrderId, status]) => {
          const submission = venue.submissions.find((s) => s.tokenId === tokenId);
          return {
            venueOrderId,
            clientId: submission?.clientId ?? null,
            tokenId,
            side: (submission?.side ?? "BUY") as "BUY" | "SELL",
            kind: (submission?.kind ?? "LIMIT") as "LIMIT" | "MARKET",
            price: submission?.price ?? status?.price ?? null,
            size: status?.size ?? submission?.size ?? 0,
            filledSize: status?.filledSize ?? 0,
            status: status?.status ?? "UNKNOWN",
          };
        });
    },
    setTrades(venueOrderId, list) {
      trades.set(venueOrderId, list);
    },
    setStatus(venueOrderId, status) {
      statuses.set(venueOrderId, status);
    },
    fail(message) {
      failure = message;
    },
    health: () => ({ state: "OK", message: "scripted" }),
  };
  return venue;
}

function harness(configPatch: Partial<ExecutionConfig> = {}, contextPatch: Partial<RiskContext> = {}) {
  const memory = memoryStore();
  const venue = scriptedVenue();
  let now = T0;
  const config: ExecutionConfig = { ...DEFAULT_EXECUTION_CONFIG, ...configPatch };
  const engine = createExecutionEngine({
    store: memory.store,
    venue,
    now: () => now,
    config: () => config,
    riskContext: () => context(contextPatch),
  });
  return {
    engine,
    venue,
    memory,
    config,
    advance(ms: number) {
      now += ms;
    },
  };
}

function trade(id: string, venueOrderId: string, size: number, price = 0.52): VenueTrade {
  return {
    id,
    venueOrderId,
    tokenId: "token-up",
    size,
    price,
    at: new Date(T0).toISOString(),
    status: "MATCHED",
  };
}

describe("risk engine", () => {
  it("approves a well-formed intent in an armed engine", () => {
    const decision = evaluateRisk(intent(), context());
    expect(decision.status).toBe("APPROVED");
    expect(decision.code).toBe("OK");
  });

  it("rejects deterministically with the matching code", () => {
    const cases: Array<[Partial<RiskContext>, string]> = [
      [{ engineArmed: false }, "ENGINE_NOT_ARMED"],
      [{ strategyMode: false }, "MODE_NOT_STRATEGY"],
      [{ strategyEnabled: false }, "STRATEGY_DISABLED"],
      [{ marketEnabled: false }, "MARKET_DISABLED"],
      [{ windowEnabled: false }, "WINDOW_DISABLED"],
      [{ quotaRemaining: 0 }, "QUOTA_EXHAUSTED"],
      [{ openPositions: 3, maxPositions: 3 }, "MAX_POSITIONS"],
      [{ dailyTradingEnabled: false }, "DAILY_TRADING_DISABLED"],
      [{ wallet: { ...WALLET, ready: false } }, "WALLET_NOT_READY"],
      [{ marketActive: false }, "MARKET_NOT_ACTIVE"],
      [{ activeConditionId: "0xother" }, "MARKET_MISMATCH"],
      [{ tokenId: null }, "TOKEN_UNAVAILABLE"],
      [{ alreadyExecuted: true }, "INTENT_ALREADY_EXECUTED"],
      [{ size: 0 }, "INVALID_ORDER_SIZE"],
    ];
    for (const [patch, code] of cases) {
      const decision = evaluateRisk(intent(), context(patch));
      expect(decision.status, code).toBe("REJECTED");
      expect(decision.code).toBe(code);
    }
  });

  it("never approves an intent when the engine is not armed, whatever else is true", () => {
    expect(evaluateRisk(intent(), context({ engineArmed: false })).status).toBe("REJECTED");
  });
});

describe("order lifecycle", () => {
  it("forbids skipping the risk gate", () => {
    expect(canTransition("INTENT_CREATED", "LIMIT_SUBMITTED")).toBe(false);
    expect(canTransition("INTENT_CREATED", "RISK_APPROVED")).toBe(true);
    expect(canTransition("FILLED", "LIMIT_SUBMITTED")).toBe(false);
  });
});

describe("execution engine", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("submits exactly one limit order per approved intent", async () => {
    const order = await h.engine.processIntent(intent());
    expect(order?.state).toBe("LIMIT_SUBMITTED");
    expect(order?.kind).toBe("LIMIT");
    expect(h.venue.submissions).toHaveLength(1);
  });

  it("never creates a second order chain for the same intent", async () => {
    await h.engine.processIntent(intent());
    await h.engine.processIntent(intent());
    await h.engine.processIntent(intent());
    expect(h.venue.submissions).toHaveLength(1);
    expect(h.engine.orders()).toHaveLength(1);
  });

  it("creates no order when risk rejects", async () => {
    const rejecting = harness({}, { engineArmed: false });
    const order = await rejecting.engine.processIntent(intent());
    expect(order).toBeNull();
    expect(rejecting.venue.submissions).toHaveLength(0);
    expect(rejecting.engine.riskRejections()[0]?.code).toBe("ENGINE_NOT_ARMED");
  });

  it("submits a market order directly in MARKET_ONLY mode", async () => {
    const market = harness({ mode: "MARKET_ONLY" });
    const order = await market.engine.processIntent(intent());
    expect(order?.state).toBe("MARKET_SUBMITTED");
    expect(market.venue.submissions[0]?.kind).toBe("MARKET");
  });

  it("records a partial fill and then a complete fill", async () => {
    await h.engine.processIntent(intent());
    h.venue.setTrades("venue-1", [trade("t1", "venue-1", 2)]);
    await h.engine.monitor();
    expect(h.engine.orders()[0]?.state).toBe("PARTIAL_FILL");
    expect(h.engine.orders()[0]?.filledSize).toBeCloseTo(2);

    h.venue.setTrades("venue-1", [trade("t1", "venue-1", 2), trade("t2", "venue-1", 3)]);
    await h.engine.monitor();
    const filled = h.engine.orders()[0]!;
    expect(filled.state).toBe("FILLED");
    expect(filled.filledSize).toBeCloseTo(5);
    expect(filled.terminalAt).not.toBeNull();
  });

  it("never double counts a venue trade id", async () => {
    await h.engine.processIntent(intent());
    h.venue.setTrades("venue-1", [trade("t1", "venue-1", 2)]);
    await h.engine.monitor();
    await h.engine.monitor();
    await h.engine.monitor();
    expect(h.engine.fills()).toHaveLength(1);
    expect(h.engine.orders()[0]?.filledSize).toBeCloseTo(2);
  });

  it("times out an unfilled limit order and retries the same intent", async () => {
    await h.engine.processIntent(intent());
    h.advance(h.config.limitTimeoutMs + 1);
    await h.engine.monitor();
    expect(h.venue.cancels).toEqual(["venue-1"]);
    expect(h.engine.orders()[0]?.state).toBe("LIMIT_CANCELLED");

    h.advance(h.config.retryDelayMs + 1);
    await h.engine.monitor();
    const retried = h.engine.orders()[0]!;
    expect(retried.state).toBe("LIMIT_SUBMITTED");
    expect(retried.attempt).toBe(1);
    // The intent is reused, never recreated.
    expect(h.engine.orders()).toHaveLength(1);
    expect(retried.intentId).toBe("intent-1");
  });

  it("expires after the configured retries are exhausted", async () => {
    const limited = harness({ maxRetries: 0 });
    await limited.engine.processIntent(intent());
    limited.advance(limited.config.limitTimeoutMs + 1);
    await limited.engine.monitor();
    expect(limited.engine.orders()[0]?.state).toBe("EXPIRED");
  });

  it("falls back from limit to market in LIMIT_THEN_MARKET mode", async () => {
    const fallback = harness({ mode: "LIMIT_THEN_MARKET" });
    await fallback.engine.processIntent(intent());
    expect(fallback.venue.submissions[0]?.kind).toBe("LIMIT");
    fallback.advance(fallback.config.limitTimeoutMs + 1);
    await fallback.engine.monitor();
    await fallback.engine.monitor();
    expect(fallback.venue.submissions[1]?.kind).toBe("MARKET");
    expect(fallback.engine.orders()[0]?.state).toBe("MARKET_SUBMITTED");
  });

  it("marks an order FAILED when the venue rejects the submission", async () => {
    h.venue.fail("insufficient allowance");
    const order = await h.engine.processIntent(intent());
    expect(order?.state).toBe("FAILED");
    expect(order?.lastError).toContain("insufficient allowance");
  });
});

describe("restart recovery", () => {
  it("reconciles a live order without resubmitting it", async () => {
    const first = harness();
    await first.engine.processIntent(intent());
    first.venue.setTrades("venue-1", [trade("t1", "venue-1", 5)]);

    // A fresh engine over the same storage — as after a PM2 restart.
    let now = T0 + 10_000;
    const restarted = createExecutionEngine({
      store: first.memory.store,
      venue: first.venue,
      now: () => now,
      config: () => DEFAULT_EXECUTION_CONFIG,
      riskContext: () => context(),
    });
    await restarted.recover();
    now += 1;

    expect(first.venue.submissions).toHaveLength(1);
    expect(restarted.orders()[0]?.state).toBe("FILLED");
    expect(restarted.fills()).toHaveLength(1);
  });

  it("never re-executes an intent whose order chain already exists", async () => {
    const first = harness();
    await first.engine.processIntent(intent());

    const restarted = createExecutionEngine({
      store: first.memory.store,
      venue: first.venue,
      now: () => T0 + 10_000,
      config: () => DEFAULT_EXECUTION_CONFIG,
      riskContext: () => context(),
    });
    await restarted.recover();
    await restarted.processIntent(intent());
    expect(first.venue.submissions).toHaveLength(1);
  });

  it("fails a recovered order that never reached the venue", async () => {
    const memory = memoryStore();
    const venue = scriptedVenue();
    const at = new Date(T0).toISOString();
    await memory.store.createOrder({
      id: "order:intent-9",
      intentId: "intent-9",
      conditionId: "0xcond",
      slug: "btc-up-or-down-5m",
      horizon: "FIVE_MINUTE",
      tokenId: "token-up",
      outcome: "UP",
      side: "BUY",
      mode: "LIMIT_ONLY",
      kind: "LIMIT",
      limitPrice: 0.52,
      size: 5,
      state: "ORDER_BUILD",
      attempt: 0,
      clientId: "order:intent-9:a0:limit",
      venueOrderId: null,
      filledSize: 0,
      avgPrice: null,
      reason: "built",
      lastError: null,
      createdAt: at,
      updatedAt: at,
      submittedAt: null,
      terminalAt: null,
    });

    const engine = createExecutionEngine({
      store: memory.store,
      venue,
      now: () => T0 + 5_000,
      config: () => DEFAULT_EXECUTION_CONFIG,
      riskContext: () => context(),
    });
    await engine.recover();
    expect(engine.orders()[0]?.state).toBe("FAILED");
    expect(venue.submissions).toHaveLength(0);
  });
});

describe("position tracking", () => {
  it("derives active and closed positions from fills only", () => {
    const base = {
      intentId: "intent-1",
      conditionId: "0xcond",
      tokenId: "token-up",
      outcome: "UP" as const,
      orderId: "order:intent-1",
      source: "venue",
    };
    const positions = buildPositions(
      [],
      [
        { ...base, id: "f1", side: "BUY", size: 4, price: 0.5, filledAt: "2026-01-01T00:00:00Z" },
        { ...base, id: "f2", side: "SELL", size: 4, price: 0.7, filledAt: "2026-01-01T00:01:00Z" },
      ],
    );
    expect(positions).toHaveLength(1);
    expect(positions[0]?.status).toBe("CLOSED");
    expect(positions[0]?.fills).toBe(2);
  });
});