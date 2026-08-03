import type { MarketHorizon, MarketState } from "../market/types";
import { lockConfig } from "./config";
import { buildPrediction } from "./prediction";
import { createSettlementTwap, type SettlementTwapEngine } from "./twap";
import type {
  ExecutionIntent,
  StrategyConfig,
  StrategyEvent,
  StrategySnapshot,
  TwapReading,
  WindowRecord,
  WindowState,
} from "./types";
import { TERMINAL_WINDOW_STATES } from "./types";
import { freeze, isTriggered, planWindows, quotaState } from "./windows";

// The Frozen Window Strategy Engine.
//
// Deterministic by construction: it takes (nowMs, unified market state,
// enabled windows), owns no timers, reads no provider, and produces the same
// events for the same inputs. Persistence and scheduling live in
// engine.server.ts so this module stays testable with a fixed clock.

interface MarketPlan {
  conditionId: string;
  slug: string;
  horizon: MarketHorizon;
  settlementAtMs: number;
  /** Configuration is locked for the life of the market. */
  config: StrategyConfig;
  windows: WindowRecord[];
  intents: ExecutionIntent[];
}

export interface StrategyEngine {
  ingestPrice(price: number, atMs: number): void;
  evaluate(
    nowMs: number,
    market: MarketState,
    enabled: Record<MarketHorizon, boolean>,
  ): StrategyEvent[];
  snapshot(nowMs: number, market: MarketState): StrategySnapshot;
  reset(): void;
  config(): StrategyConfig;
  /**
   * Swap the configuration version. A market already in flight is unaffected:
   * every MarketPlan captures its configuration at plan creation and never
   * re-reads it, so a new document only reaches the next planned market.
   */
  setConfig(next: StrategyConfig): void;
}

const HORIZONS: MarketHorizon[] = ["FIVE_MINUTE", "FIFTEEN_MINUTE"];

export function createStrategyEngine(input: StrategyConfig): StrategyEngine {
  let config = lockConfig(input);
  const twap: SettlementTwapEngine = createSettlementTwap(config);
  const plans = new Map<MarketHorizon, MarketPlan>();
  let timeline: StrategyEvent[] = [];
  let lastBinanceObservedAt: string | null = null;
  let previousTwapValue: number | null = null;

  function emit(event: StrategyEvent, sink: StrategyEvent[]): void {
    sink.push(event);
    timeline = [...timeline, event].slice(-200);
  }

  function transition(
    plan: MarketPlan,
    window: WindowRecord,
    state: WindowState,
    reason: string,
    at: string,
    sink: StrategyEvent[],
  ): void {
    window.state = state;
    window.reason = reason;
    window.timeline = [...window.timeline, { at, state, reason }];
    emit(
      {
        type: "window.transition",
        at,
        windowId: window.id,
        conditionId: plan.conditionId,
        state,
        reason,
      },
      sink,
    );
  }

  function planFor(horizon: MarketHorizon, market: MarketState, sink: StrategyEvent[]) {
    const discovered = market.markets[horizon];
    const existing = plans.get(horizon);
    if (!discovered || !discovered.settlementAt) {
      return existing && existing.windows.every((w) => TERMINAL_WINDOW_STATES.includes(w.state))
        ? existing
        : (existing ?? null);
    }
    if (existing && existing.conditionId === discovered.conditionId) return existing;

    const settlementAtMs = Date.parse(discovered.settlementAt);
    if (!Number.isFinite(settlementAtMs)) return existing ?? null;

    const created: MarketPlan = {
      conditionId: discovered.conditionId,
      slug: discovered.slug,
      horizon,
      settlementAtMs,
      // Locked here: a later Operations Desk edit cannot reach this market.
      config,
      windows: planWindows(discovered, config, settlementAtMs),
      intents: [],
    };
    plans.set(horizon, created);
    emit(
      {
        type: "market.plan.created",
        at: new Date(settlementAtMs).toISOString(),
        windowId: null,
        conditionId: created.conditionId,
        state: null,
        reason: `planned ${created.windows.length} windows for ${horizon}`,
      },
      sink,
    );
    return created;
  }

  function evaluatePlan(
    plan: MarketPlan,
    nowMs: number,
    market: MarketState,
    horizonEnabled: boolean,
    sink: StrategyEvent[],
  ): void {
    const discovered = market.markets[plan.horizon];
    const ptb = discovered?.conditionId === plan.conditionId ? discovered.ptb : null;
    const reading = twap.read(nowMs, plan.settlementAtMs, plan.horizon);
    // Advisory trend only: remember the previous reading before it changes.
    previousTwapValue = reading.value ?? previousTwapValue;
    const at = new Date(nowMs).toISOString();

    // Deterministic order: furthest-from-settlement first.
    for (const window of plan.windows) {
      if (TERMINAL_WINDOW_STATES.includes(window.state)) continue;
      const opensAtMs = Date.parse(window.opensAt);
      const expiresAtMs = Date.parse(window.expiresAt);

      if (!horizonEnabled || !window.enabled) {
        transition(
          plan,
          window,
          "WINDOW_DISABLED",
          horizonEnabled ? "window disabled in configuration" : "market horizon disabled by operator",
          at,
          sink,
        );
        continue;
      }

      if (nowMs >= expiresAtMs) {
        const hadTrigger = window.frozen !== null;
        transition(
          plan,
          window,
          "EXPIRED",
          hadTrigger ? "window expired" : "window expired before a trigger could be frozen",
          at,
          sink,
        );
        transition(
          plan,
          window,
          "NO_TRIGGER",
          hadTrigger
            ? "settlement TWAP never reached the frozen trigger"
            : "no frozen trigger: PTB or settlement TWAP unavailable",
          at,
          sink,
        );
        continue;
      }

      if (window.state === "WAITING") {
        if (nowMs < opensAtMs) continue;
        if (quotaState(plan.windows, plan.config).remaining <= 0) {
          transition(plan, window, "QUOTA_EXHAUSTED", "trades per market already consumed", at, sink);
          continue;
        }
        transition(plan, window, "OPEN", "window opened", at, sink);
      }

      if (window.state === "OPEN") {
        // Freeze exactly once, and only on validated inputs.
        if (ptb === null) {
          window.reason = "waiting for validated PTB";
          continue;
        }
        if (reading.state !== "OK" || reading.value === null) {
          window.reason = `waiting for settlement TWAP (${reading.state})`;
          continue;
        }
        if (window.frozen !== null) throw new Error(`${window.id}: frozen trigger already written`);
        const frozen = freeze(reading.value, ptb, window.buffer, at);
        window.frozen = frozen;
        emit(
          {
            type: "window.frozen",
            at,
            windowId: window.id,
            conditionId: plan.conditionId,
            state: "ACTIVE",
            reason: `${frozen.direction} trigger ${frozen.frozenTrigger}`,
            frozen,
          },
          sink,
        );
        transition(
          plan,
          window,
          "ACTIVE",
          `frozen ${frozen.direction} trigger at ${frozen.frozenTrigger}`,
          at,
          sink,
        );
      }

      if (window.state === "ACTIVE" && window.frozen) {
        if (reading.state !== "OK" || reading.value === null) {
          window.reason = `settlement TWAP ${reading.state}; triggering blocked`;
          continue;
        }
        if (!isTriggered(window.frozen, reading.value)) {
          window.reason = `live ${reading.value.toFixed(2)} vs trigger ${window.frozen.frozenTrigger.toFixed(2)}`;
          continue;
        }
        if (quotaState(plan.windows, plan.config).remaining <= 0) {
          transition(plan, window, "QUOTA_EXHAUSTED", "trades per market already consumed", at, sink);
          continue;
        }
        window.triggeredAt = at;
        window.settlementTwapAtTrigger = reading.value;
        transition(
          plan,
          window,
          "TRIGGERED",
          `settlement TWAP ${reading.value.toFixed(2)} reached frozen trigger ${window.frozen.frozenTrigger.toFixed(2)}`,
          at,
          sink,
        );

        // Intent id is derived, never random, so replay reproduces it exactly.
        const intent: ExecutionIntent = Object.freeze({
          id: `intent:${window.id}`,
          createdAt: at,
          conditionId: plan.conditionId,
          slug: plan.slug,
          horizon: plan.horizon,
          windowSeconds: window.seconds,
          direction: window.frozen.direction,
          openingTwap: window.frozen.openingTwap,
          settlementTwap: reading.value,
          ptb: window.frozen.ptb,
          buffer: window.frozen.buffer,
          frozenTrigger: window.frozen.frozenTrigger,
          triggerTime: at,
          reason: `${window.frozen.direction} trigger satisfied in the ${window.seconds}s window`,
        });
        window.intentId = intent.id;
        plan.intents = [...plan.intents, intent];
        emit(
          {
            type: "intent.created",
            at,
            windowId: window.id,
            conditionId: plan.conditionId,
            state: "TRIGGERED",
            reason: intent.reason,
            intent,
          },
          sink,
        );
        transition(plan, window, "COMPLETED", "execution intent created", at, sink);
      }
    }
  }

  function focusedPlan(nowMs: number): MarketPlan | null {
    let best: MarketPlan | null = null;
    for (const plan of plans.values()) {
      const live = plan.windows.some((w) => !TERMINAL_WINDOW_STATES.includes(w.state));
      const bestLive = best?.windows.some((w) => !TERMINAL_WINDOW_STATES.includes(w.state)) ?? false;
      if (!best) {
        best = plan;
        continue;
      }
      if (live !== bestLive) {
        if (live) best = plan;
        continue;
      }
      const distance = Math.abs(plan.settlementAtMs - nowMs);
      if (distance < Math.abs(best.settlementAtMs - nowMs)) best = plan;
    }
    return best;
  }

  return {
    config: () => config,
    setConfig: (next: StrategyConfig) => {
      config = lockConfig(next);
    },

    ingestPrice(price, atMs) {
      twap.ingest(price, atMs);
    },

    reset() {
      plans.clear();
      timeline = [];
      lastBinanceObservedAt = null;
      twap.reset();
    },

    evaluate(nowMs, market, enabled) {
      const events: StrategyEvent[] = [];
      // Strategy consumes the unified market state only — never a provider.
      const sample = market.binance;
      if (sample && sample.observedAt !== lastBinanceObservedAt) {
        lastBinanceObservedAt = sample.observedAt;
        twap.ingest(sample.price, Date.parse(sample.observedAt));
      }
      for (const horizon of HORIZONS) {
        const plan = planFor(horizon, market, events);
        if (!plan) continue;
        evaluatePlan(plan, nowMs, market, enabled[horizon] ?? true, events);
      }
      return events;
    },

    snapshot(nowMs, market): StrategySnapshot {
      const plan = focusedPlan(nowMs);
      const discovered = plan ? market.markets[plan.horizon] : null;
      const reading: TwapReading = twap.read(
        nowMs,
        plan?.settlementAtMs ?? null,
        plan?.horizon ?? null,
      );
      const windows = plan ? plan.windows.map((window) => ({ ...window })) : [];
      const active = windows.find((window) => window.state === "ACTIVE") ?? null;
      const intents = [...plans.values()].flatMap((entry) => entry.intents).slice(-20);
      const ptb = discovered?.conditionId === plan?.conditionId ? (discovered?.ptb ?? null) : null;

      return {
        config,
        market: {
          conditionId: plan?.conditionId ?? null,
          slug: plan?.slug ?? null,
          horizon: plan?.horizon ?? null,
          ptb,
          closeAt: discovered?.closeAt ?? null,
          settlementAt: plan ? new Date(plan.settlementAtMs).toISOString() : null,
        },
        twap: reading,
        quota: plan
          ? quotaState(plan.windows, plan.config)
          : { tradesPerMarket: config.tradesPerMarket, used: 0, remaining: config.tradesPerMarket },
        activeWindowId: active?.id ?? null,
        windows,
        intents,
        prediction: buildPrediction(reading, ptb, active, previousTwapValue),
        timeline: timeline.slice(-40),
      };
    },
  };
}
