import { eventBus } from "../bus/events";
import { clock } from "../clock/clock.service";
import { createBinanceFeed } from "../feeds/binance.server";
import { createChainlinkFeed } from "../feeds/chainlink.server";
import type { PriceFeed } from "../feeds/types";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import { discoveryHealth, refreshMarkets } from "../market/discovery.server";
import { applyPriceSample, getMarketState } from "../market/state";
import { registerTask, schedulerStatus, unregisterTask } from "../scheduler/scheduler.server";
import {
  executionSnapshot,
  runExecution,
  startExecutionEngine,
  stopExecutionEngine,
} from "../execution/execution.server";
import { correlationId } from "../shared/ids";
import {
  evaluateStrategy,
  startStrategyEngine,
  stopStrategyEngine,
  strategySnapshot,
} from "../strategy/strategy.server";

// The serialized runtime loop. It owns the scheduler registrations, the feed
// lifecycle, market state publication, the strategy evaluation step, the
// execution step and runtime health. Strategy runs before execution on every
// pass, so an order can only ever follow an already-persisted intent.

const log = createLogger("engine");

const FEED_WATCHDOG_MS = 2_000;
const CHAINLINK_POLL_MS = 15_000;
const DISCOVERY_MS = 20_000;
const PUBLISH_MS = 1_000;
// The 3s window needs sub-second resolution; this is still one scheduler task.
const STRATEGY_MS = 200;
// Execution polls slightly slower than strategy: fills, timeouts and retries
// are venue-bound, not tick-bound.
const EXECUTION_MS = 500;

let binance: PriceFeed | undefined;
let chainlink: PriceFeed | undefined;
let started = false;
let startedAt: string | null = null;
let ticks = 0;
let lastTickAt: string | null = null;
let lastTickDurationMs: number | null = null;
let lastError: string | null = null;

export function feeds(): { binance: PriceFeed | undefined; chainlink: PriceFeed | undefined } {
  return { binance, chainlink };
}

export async function startEngineLoop(): Promise<void> {
  if (started) return;
  started = true;
  startedAt = clock().iso();

  binance = createBinanceFeed((sample) => applyPriceSample(sample));
  chainlink = createChainlinkFeed((sample) => applyPriceSample(sample));
  await binance.start();
  await chainlink.start();
  startStrategyEngine();
  startExecutionEngine();

  // Every timer in SPACE belongs to the scheduler. These four registrations are
  // the whole of milestone 2's recurring work.
  registerTask({
    name: "engine.tick",
    intervalMs: PUBLISH_MS,
    runOnStart: true,
    run: () => tick(),
  });
  registerTask({
    name: "feed.binance.watchdog",
    intervalMs: FEED_WATCHDOG_MS,
    run: () => binance?.poll() ?? Promise.resolve(),
  });
  registerTask({
    name: "feed.chainlink.poll",
    intervalMs: CHAINLINK_POLL_MS,
    runOnStart: true,
    run: () => chainlink?.poll() ?? Promise.resolve(),
  });
  registerTask({
    name: "market.discovery",
    intervalMs: DISCOVERY_MS,
    runOnStart: true,
    run: () => refreshMarkets(),
  });
  registerTask({
    name: "strategy.evaluate",
    intervalMs: STRATEGY_MS,
    run: () => evaluateStrategy(),
  });
  registerTask({
    name: "execution.run",
    intervalMs: EXECUTION_MS,
    runOnStart: true,
    run: () => runExecution(),
  });

  eventBus.publish({
    type: "engine.loop.started",
    severity: "SUCCESS",
    correlationId: correlationId("engine"),
    source: "engine",
    payload: { publishMs: PUBLISH_MS, discoveryMs: DISCOVERY_MS },
  });
  log.info("engine loop started");
}

// One tick, one writer. Feed samples are already applied to market state by the
// adapters; the tick keeps the sequence explicit and records liveness.
async function tick(): Promise<void> {
  const startedTickAt = clock().now();
  try {
    const state = getMarketState();
    lastError = null;
    ticks += 1;
    lastTickAt = new Date(startedTickAt).toISOString();
    void state;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  } finally {
    lastTickDurationMs = clock().now() - startedTickAt;
  }
}

export async function stopEngineLoop(): Promise<void> {
  if (!started) return;
  started = false;
  for (const name of [
    "engine.tick",
    "feed.binance.watchdog",
    "feed.chainlink.poll",
    "market.discovery",
    "strategy.evaluate",
    "execution.run",
  ]) {
    unregisterTask(name);
  }
  stopExecutionEngine();
  stopStrategyEngine();
  await binance?.stop();
  await chainlink?.stop();
  binance = undefined;
  chainlink = undefined;
  log.info("engine loop stopped", { ticks });
}

export function engineHealth(): HealthResult {
  const details = {
    started,
    startedAt,
    ticks,
    lastTickAt,
    lastTickDurationMs,
    lastError,
    marketStateVersion: getMarketState().version,
    scheduler: schedulerStatus().running,
  };
  if (!started) {
    return { state: "DISABLED", message: "engine loop not running", details };
  }
  if (lastError) return { state: "DEGRADED", message: lastError, details };
  const discovery = discoveryHealth();
  if (discovery.state === "DEGRADED") {
    return { state: "DEGRADED", message: "market discovery degraded", details };
  }
  return { state: "OK", message: "serialized loop running", details };
}

export function engineRuntimeSnapshot() {
  return {
    started,
    startedAt,
    ticks,
    lastTickAt,
    lastTickDurationMs,
    scheduler: schedulerStatus(),
    market: getMarketState(),
    strategy: strategySnapshot(),
    execution: executionSnapshot(),
    feeds: {
      binance: binance?.stats() ?? null,
      chainlink: chainlink?.stats() ?? null,
    },
  };
}