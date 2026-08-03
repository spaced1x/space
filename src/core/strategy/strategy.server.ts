import { eventBus } from "../bus/events";
import { clock } from "../clock/clock.service";
import { toStrategyConfig } from "../config/operations";
import { activeOperations, promoteFor, subscribeOperations } from "../config/operations.server";
import { strategyRepository } from "../db/repositories/strategy.repository";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import { getMarketState } from "../market/state";
import { getRuntimeState } from "../state/store";
import { DEFAULT_STRATEGY_CONFIG } from "./config";
import { createStrategyEngine, type StrategyEngine } from "./engine";
import type { StrategyEvent, StrategySnapshot, WindowRecord } from "./types";

// Runtime host for the strategy engine: it owns nothing the pure engine owns.
// Its only jobs are (1) drive evaluation from the single scheduler tick,
// (2) persist evidence, (3) publish events, (4) report health.

const log = createLogger("strategy");

let engine: StrategyEngine = createStrategyEngine(DEFAULT_STRATEGY_CONFIG);
let started = false;
let startedAt: string | null = null;
let evaluations = 0;
let lastEvaluationAt: string | null = null;
let lastDurationMs: number | null = null;
let lastError: string | null = null;
let persistenceError: string | null = null;
let intents = 0;

// The Operations Desk owns operational settings. Promotion happens on a new
// market only, so a live market keeps the configuration it started with.
subscribeOperations((ops) => {
  engine.setConfig(toStrategyConfig(ops, DEFAULT_STRATEGY_CONFIG));
});

export function startStrategyEngine(): void {
  if (started) return;
  engine = createStrategyEngine(toStrategyConfig(activeOperations(), DEFAULT_STRATEGY_CONFIG));
  started = true;
  startedAt = clock().iso();
  evaluations = 0;
  intents = 0;
  lastError = null;
  log.info("strategy engine started", {
    windows: DEFAULT_STRATEGY_CONFIG.windows.map((window) => window.seconds),
    tradesPerMarket: DEFAULT_STRATEGY_CONFIG.tradesPerMarket,
  });
}

export function stopStrategyEngine(): void {
  if (!started) return;
  started = false;
  engine.reset();
  log.info("strategy engine stopped", { evaluations, intents });
}

/** Called by the engine loop's serialized tick. Never by the dashboard. */
export async function evaluateStrategy(): Promise<void> {
  if (!started) return;
  const begin = clock().now();
  try {
    const runtime = getRuntimeState();
    const market = getMarketState();
    // Promote any staged configuration if the tracked market set changed.
    promoteFor(market);
    const events = engine.evaluate(begin, market, {
      FIVE_MINUTE: runtime.windows.fiveMinute,
      FIFTEEN_MINUTE: runtime.windows.fifteenMinute,
    });
    evaluations += 1;
    lastEvaluationAt = new Date(begin).toISOString();
    lastError = null;
    if (events.length) await publish(events);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    log.error("strategy evaluation failed", { reason: lastError });
  } finally {
    lastDurationMs = clock().now() - begin;
  }
}

async function publish(events: StrategyEvent[]): Promise<void> {
  const snapshot = engine.snapshot(clock().now(), getMarketState());
  const byId = new Map<string, WindowRecord>(snapshot.windows.map((w) => [w.id, w]));

  for (const event of events) {
    eventBus.publish({
      type: `strategy.${event.type}`,
      severity: event.type === "intent.created" ? "SUCCESS" : "INFO",
      correlationId: event.windowId ?? event.conditionId,
      source: "strategy",
      payload: {
        state: event.state,
        reason: event.reason,
        window: event.windowId,
        conditionId: event.conditionId,
      },
    });
    if (event.type === "intent.created" && event.intent) intents += 1;
  }

  // Persistence is best effort: a runtime without native SQLite (the preview
  // sandbox) must still run the strategy, it simply keeps no evidence.
  try {
    for (const event of events) {
      if (!event.windowId) continue;
      const window = byId.get(event.windowId);
      if (event.type === "window.transition" && window) {
        await strategyRepository.saveWindow(window);
        await strategyRepository.appendTransition(
          window.id,
          window.conditionId,
          event.state ?? window.state,
          event.reason,
          event.at,
        );
      }
      if (event.type === "window.frozen" && window) {
        await strategyRepository.recordFrozenTrigger(window);
      }
      if (event.type === "intent.created" && event.intent) {
        // Every intent is stamped with the Operations Desk version that produced
        // it, so PnL can be attributed to an exact configuration.
        await strategyRepository.insertIntent(event.intent, activeOperations().version);
      }
    }
    persistenceError = null;
  } catch (error) {
    persistenceError = error instanceof Error ? error.message : String(error);
  }
}

export function strategySnapshot(): StrategySnapshot {
  return engine.snapshot(clock().now(), getMarketState());
}

export function strategyHealth(): HealthResult {
  const details = {
    started,
    startedAt,
    evaluations,
    lastEvaluationAt,
    lastDurationMs,
    lastError,
    persistenceError,
    intents,
    tradesPerMarket: engine.config().tradesPerMarket,
    windows: engine.config().windows.map((window) => window.seconds),
  };
  if (!started) return { state: "DISABLED", message: "strategy engine not running", details };
  if (lastError) return { state: "FAILED", message: lastError, details };
  if (persistenceError) {
    return { state: "DEGRADED", message: `evidence not persisted: ${persistenceError}`, details };
  }
  return {
    state: "OK",
    message: "frozen window strategy evaluating (no execution)",
    details,
  };
}

export function settlementTwapHealth(): HealthResult {
  const snapshot = strategySnapshot();
  const reading = snapshot.twap;
  const details = {
    state: reading.state,
    value: reading.value,
    samples: reading.samples,
    startAt: reading.startAt,
    endAt: reading.endAt,
    lengthSeconds: reading.lengthSeconds,
    lastUpdateAt: reading.lastUpdateAt,
    horizon: snapshot.market.horizon,
  };
  if (!started) return { state: "DISABLED", message: "strategy engine not running", details };
  if (reading.state === "OK") {
    return { state: "OK", message: reading.message, details };
  }
  if (reading.state === "IDLE") {
    return { state: "DEGRADED", message: reading.message, details };
  }
  return { state: "DEGRADED", message: reading.message, details };
}
