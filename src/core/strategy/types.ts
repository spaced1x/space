import type { MarketHorizon } from "../market/types";

// Strategy vocabulary. These types are pure data: no timers, no providers, no
// side effects. Every strategy module in SPACE speaks exactly this language.

export type Direction = "UP" | "DOWN";

/** Lifecycle of a single execution window (specification §3.3). */
export type WindowState =
  | "WAITING"
  | "OPEN"
  | "ACTIVE"
  | "TRIGGERED"
  | "EXPIRED"
  | "COMPLETED"
  | "NO_TRIGGER"
  | "QUOTA_EXHAUSTED"
  | "WINDOW_DISABLED";

export const TERMINAL_WINDOW_STATES: WindowState[] = [
  "COMPLETED",
  "NO_TRIGGER",
  "QUOTA_EXHAUSTED",
  "WINDOW_DISABLED",
];

/** Settlement TWAP readiness. WARMING blocks any window from opening. */
export type TwapState = "IDLE" | "WARMING" | "OK" | "STALE";

export interface TwapReading {
  state: TwapState;
  /** Time-weighted average price over the settlement window, or null. */
  value: number | null;
  samples: number;
  /** Settlement TWAP window bounds (ISO), independent of sample arrival. */
  startAt: string | null;
  endAt: string | null;
  lengthSeconds: number;
  lastUpdateAt: string | null;
  message: string;
}

/** One window's configuration. Buffer is decimal and per-window. */
export interface WindowConfig {
  /** Seconds before settlement at which this window opens. */
  seconds: number;
  buffer: number;
  enabled: boolean;
}

export interface StrategyConfig {
  windows: WindowConfig[];
  /** Trades per market (quota). */
  tradesPerMarket: number;
  /** A settlement TWAP older than this cannot trigger. */
  maxTwapAgeMs: number;
  /** Minimum samples before the settlement TWAP leaves WARMING. */
  minTwapSamples: number;
}

/** Write-once evidence captured at window open. Never mutated afterwards. */
export interface FrozenTrigger {
  openingTwap: number;
  ptb: number;
  direction: Direction;
  buffer: number;
  frozenTrigger: number;
  windowOpenTime: string;
}

export interface ExecutionIntent {
  id: string;
  createdAt: string;
  conditionId: string;
  slug: string;
  horizon: MarketHorizon;
  windowSeconds: number;
  direction: Direction;
  openingTwap: number;
  settlementTwap: number;
  ptb: number;
  buffer: number;
  frozenTrigger: number;
  triggerTime: string;
  reason: string;
}

export interface WindowTimelineEntry {
  at: string;
  state: WindowState;
  reason: string;
}

export interface WindowRecord {
  id: string;
  conditionId: string;
  slug: string;
  horizon: MarketHorizon;
  seconds: number;
  buffer: number;
  enabled: boolean;
  opensAt: string;
  expiresAt: string;
  state: WindowState;
  frozen: FrozenTrigger | null;
  triggeredAt: string | null;
  settlementTwapAtTrigger: number | null;
  intentId: string | null;
  reason: string;
  timeline: WindowTimelineEntry[];
}

export type StrategyEventType =
  | "window.transition"
  | "window.frozen"
  | "intent.created"
  | "market.plan.created";

export interface StrategyEvent {
  type: StrategyEventType;
  at: string;
  windowId: string | null;
  conditionId: string;
  state: WindowState | null;
  reason: string;
  intent?: ExecutionIntent;
  frozen?: FrozenTrigger;
}

export interface BotPrediction {
  /** Advisory only. Never consulted by the trigger engine. */
  direction: Direction | null;
  settlementTwap: number | null;
  ptb: number | null;
  difference: number | null;
  buffer: number | null;
  frozenTrigger: number | null;
  suggestion: "UP" | "DOWN" | "NONE";
  note: string;
  /**
   * Advisory-only enrichment (specification §5). Confidence is |difference|
   * measured against the active buffer, clamped to 0..1; trend is the sign of
   * the recent TWAP movement. Neither is ever read by the trigger engine.
   */
  confidence: number | null;
  trend: "RISING" | "FALLING" | "FLAT" | null;
}

export interface QuotaState {
  tradesPerMarket: number;
  used: number;
  remaining: number;
}

export interface StrategySnapshot {
  config: StrategyConfig;
  market: {
    conditionId: string | null;
    slug: string | null;
    horizon: MarketHorizon | null;
    ptb: number | null;
    closeAt: string | null;
    settlementAt: string | null;
  };
  twap: TwapReading;
  quota: QuotaState;
  activeWindowId: string | null;
  windows: WindowRecord[];
  intents: ExecutionIntent[];
  prediction: BotPrediction;
  timeline: StrategyEvent[];
}
