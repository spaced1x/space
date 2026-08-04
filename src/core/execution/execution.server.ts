import { eventBus } from "../bus/events";
import { clock } from "../clock/clock.service";
import {
  activeOperations,
  subscribeOperations,
} from "../config/operations.server";
import { sizeForWindow, toExecutionConfig, windowEnabled as windowIsEnabled } from "../config/operations";
import { executionRepository } from "../db/repositories/execution.repository";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import { getMarketState } from "../market/state";
import { getRuntimeState } from "../state/store";
import { strategySnapshot } from "../strategy/strategy.server";
import type { ExecutionIntent } from "../strategy/types";
import { DEFAULT_EXECUTION_CONFIG } from "./config";
import { createExecutionEngine, type ExecutionEngine } from "./engine";
import { decideSize } from "./sizing";
import { venueAdapter } from "./adapter.server";
import { reconcileOpenOrders } from "./reconcile.server";
import type { ExecutionConfig, ExecutionSnapshot, OrderMode, OrderRecord, ReconciliationResult, RiskContext } from "./types";
import { walletStatus } from "./wallet.server";

// Runtime host for the Execution Engine.
//
// It wires the pure engine to the real world: SQLite storage, the Polymarket
// CLOB adapter, the runtime state store and the scheduler tick. It contains no
// strategy logic and no order logic of its own.

const log = createLogger("execution");

let config: ExecutionConfig = DEFAULT_EXECUTION_CONFIG;
let engine: ExecutionEngine | null = null;
let started = false;
let startedAt: string | null = null;
let ticks = 0;
let lastTickAt: string | null = null;
let lastError: string | null = null;
let recovered = false;
let lastReconciliation: ReconciliationResult | null = null;

/** Manual submissions in flight, keyed by intent id: size + chosen order mode. */
const manualIntents = new Map<string, { size: number; mode: OrderMode }>();

// The Operations Desk owns operational settings. Execution simply consumes the
// active (promoted) document; it never reads the staged one.
subscribeOperations((ops) => {
  config = toExecutionConfig(ops, config);
});

function buildRiskContext(intent: ExecutionIntent, attempt: number): RiskContext {
  const runtime = getRuntimeState();
  const strategy = strategySnapshot();
  const market = getMarketState().markets[intent.horizon];
  const wallet = walletStatus();
  const open = engine ? engine.positions().filter((p) => p.status === "ACTIVE") : [];
  const positions = open.length;
  const exposure = open.reduce((sum, position) => sum + position.size, 0);
  const ops = activeOperations();
  const manual = manualIntents.get(intent.id) ?? null;
  const marketEnabled =
    config.marketEnabled &&
    (intent.horizon === "FIVE_MINUTE"
      ? runtime.windows.fiveMinute && ops.markets.fiveMinute
      : runtime.windows.fifteenMinute && ops.markets.fifteenMinute);
  // Manual orders are not bound to a strategy execution window.
  const windowEnabled = manual ? true : windowIsEnabled(ops, intent.windowSeconds);
  const tokenId = market
    ? intent.direction === "UP"
      ? market.upTokenId
      : market.downTokenId
    : null;

  const at = clock().iso();
  // Sizing is decided in exactly one place, for every path and both venues.
  const sizing = decideSize({
    intentId: intent.id,
    attempt,
    source: manual ? "MANUAL" : "STRATEGY",
    requestedSize: manual ? manual.size : sizeForWindow(ops, intent.windowSeconds),
    exposureBefore: exposure,
    openPositions: positions,
    maxPositions: config.maxPositions,
    tradingEnabled: config.dailyTradingEnabled,
    at,
  });

  return {
    at,
    manual: Boolean(manual),
    manualEnabled: ops.manualEnabled,
    engineArmed: runtime.lifecycle === "RUNNING",
    strategyMode: runtime.mode === "STRATEGY",
    strategyEnabled: config.strategyEnabled,
    marketEnabled,
    windowEnabled,
    quotaRemaining: strategy.quota.remaining,
    openPositions: positions,
    maxPositions: config.maxPositions,
    dailyTradingEnabled: config.dailyTradingEnabled,
    wallet,
    marketActive: Boolean(market) && market?.status !== "CLOSED" && market?.status !== "RESOLVED",
    activeConditionId: market?.conditionId ?? null,
    tokenId,
    alreadyExecuted: false,
    size: sizing.appliedSize,
    sizing,
  };
}

function createEngine(): ExecutionEngine {
  return createExecutionEngine({
    store: executionRepository,
    venue: venueAdapter,
    now: () => clock().now(),
    config: () => config,
    riskContext: buildRiskContext,
    emit: (event) => {
      eventBus.publish({
        type: event.type,
        severity: event.severity,
        correlationId: event.intentId,
        source: "execution",
        payload: {
          orderId: event.orderId,
          state: event.state ?? null,
          reason: event.reason,
        },
      });
    },
  });
}

export function startExecutionEngine(): void {
  if (started) return;
  engine = createEngine();
  started = true;
  startedAt = clock().iso();
  ticks = 0;
  lastError = null;
  recovered = false;
  log.info("execution engine started", { mode: config.mode, size: config.size });
}

export function stopExecutionEngine(): void {
  if (!started) return;
  started = false;
  engine?.reset();
  engine = null;
  log.info("execution engine stopped", { ticks });
}

/** Reconcile persisted orders against the venue. Never resubmits. */
export async function recoverExecutionEngine(): Promise<void> {
  if (!engine || recovered) return;
  try {
    await engine.recover();

    const market = getMarketState();
    const tokenIds = Object.values(market.markets)
      .flatMap((m) => (m ? [m.upTokenId, m.downTokenId] : []))
      .filter((id): id is string => Boolean(id));
    lastReconciliation = await reconcileOpenOrders({
      store: executionRepository,
      venue: venueAdapter,
      tokenIds,
    });

    recovered = true;
    log.info("execution recovery complete", {
      orders: engine.orders().length,
      reconciliation: lastReconciliation,
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    log.error("execution recovery failed", { reason: lastError });
  }
}

/** Driven by the serialized engine loop tick. Never by the dashboard. */
export async function runExecution(): Promise<void> {
  if (!started || !engine) return;
  try {
    if (!recovered) await recoverExecutionEngine();
    const strategy = strategySnapshot();
    for (const intent of strategy.intents) {
      await engine.processIntent(intent);
    }
    await engine.monitor();
    ticks += 1;
    lastTickAt = clock().iso();
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    log.error("execution tick failed", { reason: lastError });
  }
}

export function executionSnapshot(): ExecutionSnapshot {
  const orders = engine?.orders() ?? [];
  const positions = engine?.positions() ?? [];
  const active = orders.filter((order) =>
    ["LIMIT_SUBMITTED", "MARKET_SUBMITTED", "PARTIAL_FILL"].includes(order.state),
  );
  const pending = orders.filter((order) =>
    ["INTENT_CREATED", "RISK_APPROVED", "ORDER_BUILD", "LIMIT_TIMEOUT", "LIMIT_CANCELLED"].includes(
      order.state,
    ),
  );
  const filled = orders.filter((order) => order.state === "FILLED");

  return {
    config,
    wallet: walletStatus(),
    venue: (() => {
      const description = venueAdapter.describe();
      return {
        kind: description.kind,
        ready: description.ready,
        host: description.host,
        message: description.message,
      };
    })(),
    orders,
    activeOrders: active,
    pendingOrders: pending,
    filledOrders: filled,
    fills: engine?.fills() ?? [],
    positions,
    counts: {
      orders: orders.length,
      active: active.length,
      pending: pending.length,
      filled: filled.length,
      rejected: engine?.riskRejections().length ?? 0,
      failed: orders.filter((order) => order.state === "FAILED").length,
      positions: positions.filter((position) => position.status === "ACTIVE").length,
    },
    lastRisk: engine?.lastRisk() ?? null,
    lastSizing: engine?.lastSizing() ?? null,
    riskRejections: engine?.riskRejections() ?? [],
    intentsSeen: engine?.intentsSeen() ?? 0,
    lastError,
    startedAt,
    reconciliation: lastReconciliation,
  };
}

export function executionRecoveryStatus(): ReconciliationResult | null {
  return lastReconciliation;
}

export function executionHealth(): HealthResult {
  const snapshot = executionSnapshot();
  const details = {
    started,
    startedAt,
    ticks,
    lastTickAt,
    recovered,
    mode: config.mode,
    ...snapshot.counts,
  };
  if (!started) return { state: "DISABLED", message: "execution engine not running", details };
  if (lastError) return { state: "FAILED", message: lastError, details };
  if (!recovered) {
    return { state: "DEGRADED", message: "execution recovery not complete", details };
  }
  if (lastReconciliation?.state === "FAILED") {
    return {
      state: "FAILED",
      message: `reconciliation failed: ${lastReconciliation.message}`,
      details,
    };
  }
  if (lastReconciliation?.state === "DIVERGENCE") {
    return {
      state: "DEGRADED",
      message: `reconciliation divergence: ${lastReconciliation.message}`,
      details,
    };
  }
  if (!snapshot.venue.ready) {
    return { state: "DEGRADED", message: snapshot.venue.message, details };
  }
  return { state: "OK", message: `execution armed path ready (${config.mode})`, details };
}

export function riskHealth(): HealthResult {
  const snapshot = executionSnapshot();
  const details = {
    lastCode: snapshot.lastRisk?.code ?? null,
    lastStatus: snapshot.lastRisk?.status ?? null,
    rejections: snapshot.riskRejections.length,
    intentsSeen: snapshot.intentsSeen,
    maxPositions: config.maxPositions,
  };
  if (!started) return { state: "DISABLED", message: "risk engine not running", details };
  return {
    state: "OK",
    message: snapshot.lastRisk
      ? `last decision ${snapshot.lastRisk.status}: ${snapshot.lastRisk.code}`
      : "no intents evaluated yet",
    details,
  };
}

export function setExecutionConfig(patch: Partial<ExecutionConfig>): ExecutionConfig {
  config = { ...config, ...patch };
  return config;
}

export function getExecutionConfig(): ExecutionConfig {
  return config;
}

/**
 * Manual Trading entry point. Manual orders reuse the same Risk Engine and the
 * same Execution Engine as strategy orders — the only difference is who built
 * the intent. There is no second execution path in SPACE.
 */
export async function submitManualIntent(
  intent: ExecutionIntent,
  options: { size: number; mode: OrderMode },
): Promise<OrderRecord | null> {
  if (!started || !engine) throw new Error("execution engine is not running");
  manualIntents.set(intent.id, options);
  return engine.processIntent(intent, { mode: options.mode });
}

export function lastRiskDecision() {
  return engine?.lastRisk() ?? null;
}