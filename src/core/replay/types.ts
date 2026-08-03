import type { OrderRecord, RiskDecision } from "../execution/types";
import type { MarketHorizon } from "../market/types";
import type { Direction, WindowState } from "../strategy/types";

// Replay vocabulary. Every field here is reconstructed from persisted rows —
// Replay never reads runtime memory, so a restarted process explains history
// exactly the same way it did before the restart.

export interface ReplayMarketSummary {
  conditionId: string;
  slug: string;
  horizon: MarketHorizon;
  question: string;
  status: string;
  ptb: number | null;
  settlementAt: string | null;
  discoveredAt: string | null;
  windows: number;
  triggers: number;
  intents: number;
  orders: number;
  fills: number;
}

export interface ReplayTransition {
  at: string;
  state: WindowState;
  reason: string;
}

export interface ReplayOrderEvent {
  at: string;
  state: string;
  reason: string;
  attempt: number;
}

export interface ReplayFill {
  id: string;
  size: number;
  price: number;
  at: string;
  source: string;
}

/** One execution window, fully explained. */
export interface ReplayWindow {
  id: string;
  seconds: number;
  buffer: number;
  enabled: boolean;
  opensAt: string;
  expiresAt: string;
  state: WindowState;
  reason: string;
  openingTwap: number | null;
  ptb: number | null;
  direction: Direction | null;
  frozenTrigger: number | null;
  triggeredAt: string | null;
  settlementTwapAtTrigger: number | null;
  triggerReason: string;
  transitions: ReplayTransition[];
  intent: {
    id: string;
    createdAt: string;
    direction: Direction;
    openingTwap: number;
    settlementTwap: number;
    ptb: number;
    buffer: number;
    frozenTrigger: number;
    triggerTime: string;
    reason: string;
  } | null;
  risk: RiskDecision[];
  order: OrderRecord | null;
  orderEvents: ReplayOrderEvent[];
  fills: ReplayFill[];
  /** Plain-language explanation of the outcome. Always populated. */
  outcome: string;
}

export interface ReplayMarket {
  market: ReplayMarketSummary;
  discovery: {
    conditionId: string;
    slug: string;
    question: string;
    status: string;
    ptb: number | null;
    closeAt: string | null;
    settlementAt: string | null;
    upTokenId: string | null;
    downTokenId: string | null;
    discoveredAt: string | null;
  } | null;
  windows: ReplayWindow[];
  settlement: {
    settlementAt: string | null;
    status: string;
    filledSize: number;
    cost: number;
    avgPrice: number | null;
    note: string;
    /** Venue-resolved outcome, once settlement has been ingested. */
    resolvedOutcome: "UP" | "DOWN" | "UNRESOLVED" | null;
    /** Whether the strategy's direction matched the resolved outcome. */
    directionCorrect: boolean | null;
    /** Settled value of the reconstructed fills: 1 per winning share. */
    settledValue: number | null;
    realizedPnl: number | null;
  };
}
