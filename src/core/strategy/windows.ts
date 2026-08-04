import type { DiscoveredMarket } from "../market/types";
import { bufferFor } from "./config";
import type { Direction, FrozenTrigger, QuotaState, StrategyConfig, WindowRecord } from "./types";

// Frozen Window Engine — pure maths and pure planning. No clock, no IO, no
// state of its own: every function is a deterministic function of its inputs.

/**
 * Windows are laid out relative to settlement and never overlap: the 15s
 * window is live from T-15s until the 10s window opens at T-10s, and the
 * smallest window runs to settlement. Exactly one window can be ACTIVE at a
 * time, which is what makes quota consumption race-free on the single loop.
 */
export function planWindows(
  market: DiscoveredMarket,
  config: StrategyConfig,
  settlementAtMs: number,
): WindowRecord[] {
  return config.windows.map((window, index) => {
    const next = config.windows[index + 1];
    const opensAtMs = settlementAtMs - window.seconds * 1000;
    const expiresAtMs = next ? settlementAtMs - next.seconds * 1000 : settlementAtMs;
    return {
      id: `${market.conditionId}:${window.seconds}s`,
      conditionId: market.conditionId,
      slug: market.slug,
      horizon: market.horizon,
      seconds: window.seconds,
      buffer: bufferFor(config, window.seconds),
      enabled: window.enabled,
      opensAt: new Date(opensAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      state: "WAITING",
      frozen: null,
      triggeredAt: null,
      settlementTwapAtTrigger: null,
      intentId: null,
      reason: "waiting for window open",
      timeline: [{ at: new Date().toISOString(), state: "WAITING", reason: "window planned" }],
    } satisfies WindowRecord;
  });
}

/** Direction is decided once, from Opening TWAP versus PTB. */
export function resolveDirection(openingTwap: number, ptb: number): Direction {
  return openingTwap >= ptb ? "UP" : "DOWN";
}

/** UP = Opening TWAP + Buffer · DOWN = Opening TWAP - Buffer. */
export function computeFrozenTrigger(
  openingTwap: number,
  buffer: number,
  direction: Direction,
): number {
  return direction === "UP" ? openingTwap + buffer : openingTwap - buffer;
}

/** Build the write-once frozen record for a window at its open instant. */
export function freeze(
  openingTwap: number,
  ptb: number,
  buffer: number,
  windowOpenTime: string,
): FrozenTrigger {
  const direction = resolveDirection(openingTwap, ptb);
  return Object.freeze({
    openingTwap,
    ptb,
    direction,
    buffer,
    frozenTrigger: computeFrozenTrigger(openingTwap, buffer, direction),
    windowOpenTime,
  });
}

/**
 * Trigger Engine predicate.
 * UP triggers when the live settlement TWAP reaches or passes the frozen
 * trigger from below; DOWN when it reaches or passes it from above.
 */
export function isTriggered(frozen: FrozenTrigger, settlementTwap: number): boolean {
  return frozen.direction === "UP"
    ? settlementTwap >= frozen.frozenTrigger
    : settlementTwap <= frozen.frozenTrigger;
}

/** Quota is consumed only by windows that produced an execution intent. */
export function quotaState(windows: WindowRecord[], config: StrategyConfig): QuotaState {
  const used = windows.filter((window) => window.intentId !== null).length;
  return {
    tradesPerMarket: config.tradesPerMarket,
    used,
    remaining: Math.max(0, config.tradesPerMarket - used),
  };
}
