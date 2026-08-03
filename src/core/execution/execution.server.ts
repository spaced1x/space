import { eventBus } from "../bus/events";
import { clock } from "../clock/clock.service";
import { executionRepository } from "../db/repositories/execution.repository";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import { getMarketState } from "../market/state";
import { getRuntimeState } from "../state/store";
import { strategySnapshot } from "../strategy/strategy.server";
import type { ExecutionIntent } from "../strategy/types";
import { DEFAULT_EXECUTION_CONFIG } from "./config";
import { createExecutionEngine, type ExecutionEngine } from "./engine";
import { polymarketAdapter } from "./polymarket.server";
import type { ExecutionConfig, ExecutionSnapshot, RiskContext } from "./types";
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

function buildRiskContext(intent: ExecutionIntent, attempt: number): RiskContext {
  const runtime = getRuntimeState();
  const strategy = strategySnapshot();
  const market = getMarketState().markets[intent.horizon];
  const wallet = walletStatus();
  const positions = engine ? engine.positions().filter((p) => p.status === "ACTIVE").length : 0;
  const windowEnabled =
    intent.horizon === "FIVE_MINUTE" ? runtime.windows.fiveMinute : runtime.windows.fifteenMinute;
  const tokenId = market
    ? intent.direction === "UP"
      ? market.upTokenId
      : market.downTokenId
    : null;

  void attempt;
  return {
    at: clock().iso(),
    engineArmed: runtime.engineStatus === "ARMED",
    strategyMode: runtime.mode === "STRATEGY",
    strategyEnabled: config.strategyEnabled,
    marketEnabled: config.marketEnabled,
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
    size: config.size,
  };
}

function createEngine(): ExecutionEngine {
  return createExecutionEngine({
    store: executionRepository,
    venue: polymarketAdapter,
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
    recovered = true;
    log.info("execution recovery complete", { orders: engine.orders().length });
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
      const description = polymarketAdapter.describe();
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
    riskRejections: engine?.riskRejections() ?? [],
    intentsSeen: engine?.intentsSeen() ?? 0,
    lastError,
    startedAt,
  };
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