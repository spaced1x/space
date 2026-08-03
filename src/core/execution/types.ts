import type { MarketHorizon } from "../market/types";
import type { Direction, ExecutionIntent } from "../strategy/types";

// Execution vocabulary. Pure data: no timers, no venue, no side effects.
//
// The execution path is fixed by the approved architecture:
//   Strategy -> Execution Intent -> Risk Engine -> Execution Engine ->
//   Polymarket CLOB -> Order Monitor -> Order State
// Nothing in SPACE may shortcut it.

export type OrderMode = "LIMIT_ONLY" | "MARKET_ONLY" | "LIMIT_THEN_MARKET";
export const ORDER_MODES: OrderMode[] = ["LIMIT_ONLY", "MARKET_ONLY", "LIMIT_THEN_MARKET"];

export type OrderKind = "LIMIT" | "MARKET";
export type OrderSide = "BUY" | "SELL";

/** Append-only lifecycle (specification §9). */
export type OrderState =
  | "INTENT_CREATED"
  | "RISK_APPROVED"
  | "RISK_REJECTED"
  | "ORDER_BUILD"
  | "LIMIT_SUBMITTED"
  | "LIMIT_TIMEOUT"
  | "LIMIT_CANCELLED"
  | "MARKET_SUBMITTED"
  | "PARTIAL_FILL"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";

export const TERMINAL_ORDER_STATES: OrderState[] = [
  "RISK_REJECTED",
  "FILLED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
];

export function isTerminalOrderState(state: OrderState): boolean {
  return TERMINAL_ORDER_STATES.includes(state);
}

/** States in which the venue may still be holding a live order. */
export const LIVE_ORDER_STATES: OrderState[] = [
  "ORDER_BUILD",
  "LIMIT_SUBMITTED",
  "MARKET_SUBMITTED",
  "PARTIAL_FILL",
];

export type RiskStatus = "APPROVED" | "REJECTED";

/** Deterministic rejection vocabulary. Replay renders these verbatim. */
export type RiskCode =
  | "OK"
  | "ENGINE_NOT_ARMED"
  | "MODE_NOT_STRATEGY"
  | "MODE_NOT_MANUAL"
  | "MANUAL_DISABLED"
  | "STRATEGY_DISABLED"
  | "MARKET_DISABLED"
  | "WINDOW_DISABLED"
  | "QUOTA_EXHAUSTED"
  | "MAX_POSITIONS"
  | "DAILY_TRADING_DISABLED"
  | "WALLET_NOT_READY"
  | "MARKET_NOT_ACTIVE"
  | "MARKET_MISMATCH"
  | "TOKEN_UNAVAILABLE"
  | "INTENT_ALREADY_EXECUTED"
  | "INVALID_ORDER_SIZE";

export interface RiskDecision {
  status: RiskStatus;
  code: RiskCode;
  reason: string;
  intentId: string;
  at: string;
}

export interface OrderRecord {
  /** Derived from the intent id: one order chain per intent, forever. */
  id: string;
  intentId: string;
  conditionId: string;
  slug: string;
  horizon: MarketHorizon;
  tokenId: string;
  outcome: Direction;
  side: OrderSide;
  mode: OrderMode;
  kind: OrderKind;
  limitPrice: number | null;
  size: number;
  state: OrderState;
  /** Retry counter. Retries reuse the intent and this same order chain. */
  attempt: number;
  clientId: string | null;
  venueOrderId: string | null;
  filledSize: number;
  avgPrice: number | null;
  reason: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  terminalAt: string | null;
}

export interface FillRecord {
  /** Venue trade id. Primary key — the anti-duplication guarantee. */
  id: string;
  orderId: string;
  intentId: string;
  conditionId: string;
  tokenId: string;
  outcome: Direction;
  side: OrderSide;
  size: number;
  price: number;
  filledAt: string;
  source: string;
}

export interface OrderEventRecord {
  orderId: string;
  intentId: string;
  state: OrderState;
  reason: string;
  attempt: number;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export type PositionStatus = "ACTIVE" | "CLOSED";

export interface PositionRecord {
  conditionId: string;
  slug: string;
  tokenId: string;
  outcome: Direction;
  horizon: MarketHorizon;
  size: number;
  avgPrice: number;
  cost: number;
  status: PositionStatus;
  openedAt: string;
  lastFillAt: string;
  fills: number;
}

export interface ExecutionConfig {
  /** Default remains LIMIT_ONLY (specification §4). */
  mode: OrderMode;
  /** Order size in outcome shares. */
  size: number;
  /** Limit price used when the book gives no better reference. */
  limitPrice: number;
  /** Hard ceiling; a computed limit price is never allowed above it. */
  maxLimitPrice: number;
  /** Ticks added to the best ask when pricing a marketable limit. */
  priceSlippage: number;
  limitTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  maxPositions: number;
  strategyEnabled: boolean;
  marketEnabled: boolean;
  dailyTradingEnabled: boolean;
  fillPollMs: number;
}

export interface WalletStatus {
  ready: boolean;
  environment: "V1_TESTNET" | "V2_MAINNET";
  chainId: number;
  address: string | null;
  funderAddress: string | null;
  /** Credential presence only. Values are never read outside the wallet layer. */
  hasPrivateKey: boolean;
  hasApiCredentials: boolean;
  reason: string;
}

/** Everything the Risk Engine is allowed to look at. Injected, never fetched. */
export interface RiskContext {
  at: string;
  /**
   * Manual Trading path. Manual orders reuse this exact Risk Engine; only the
   * strategy-specific checks (strategy mode, strategy enabled, per-market
   * quota) are swapped for the manual equivalents.
   */
  manual?: boolean;
  manualEnabled?: boolean;
  engineArmed: boolean;
  strategyMode: boolean;
  strategyEnabled: boolean;
  marketEnabled: boolean;
  windowEnabled: boolean;
  quotaRemaining: number;
  openPositions: number;
  maxPositions: number;
  dailyTradingEnabled: boolean;
  wallet: WalletStatus;
  marketActive: boolean;
  activeConditionId: string | null;
  tokenId: string | null;
  alreadyExecuted: boolean;
  size: number;
}

export interface ExecutionSnapshot {
  config: ExecutionConfig;
  wallet: WalletStatus;
  venue: { kind: string; ready: boolean; host: string; message: string };
  orders: OrderRecord[];
  activeOrders: OrderRecord[];
  pendingOrders: OrderRecord[];
  filledOrders: OrderRecord[];
  fills: FillRecord[];
  positions: PositionRecord[];
  counts: {
    orders: number;
    active: number;
    pending: number;
    filled: number;
    rejected: number;
    failed: number;
    positions: number;
  };
  lastRisk: RiskDecision | null;
  riskRejections: RiskDecision[];
  intentsSeen: number;
  lastError: string | null;
  startedAt: string | null;
}

export type { ExecutionIntent };
