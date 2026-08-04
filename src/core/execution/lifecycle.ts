import type { OrderRecord, OrderState } from "./types";
import { isTerminalOrderState } from "./types";

// The order lifecycle state machine. Pure: it validates transitions and
// computes the next record, but never persists or submits anything.
//
// Append-only means the *history* is append-only; the current row is a
// projection of the last appended transition.
const ALLOWED: Record<OrderState, OrderState[]> = {
  INTENT_CREATED: ["RISK_APPROVED", "RISK_REJECTED"],
  RISK_APPROVED: ["ORDER_BUILD", "CANCELLED", "FAILED"],
  RISK_REJECTED: [],
  ORDER_BUILD: ["LIMIT_SUBMITTED", "MARKET_SUBMITTED", "FAILED", "CANCELLED"],
  LIMIT_SUBMITTED: [
    "PARTIAL_FILL",
    "FILLED",
    "LIMIT_TIMEOUT",
    "LIMIT_CANCELLED",
    "CANCELLED",
    "EXPIRED",
    "FAILED",
  ],
  LIMIT_TIMEOUT: ["LIMIT_CANCELLED", "MARKET_SUBMITTED", "ORDER_BUILD", "EXPIRED", "FAILED"],
  LIMIT_CANCELLED: ["MARKET_SUBMITTED", "ORDER_BUILD", "EXPIRED", "CANCELLED", "FAILED"],
  MARKET_SUBMITTED: ["PARTIAL_FILL", "FILLED", "CANCELLED", "EXPIRED", "FAILED"],
  PARTIAL_FILL: ["PARTIAL_FILL", "FILLED", "LIMIT_TIMEOUT", "CANCELLED", "EXPIRED", "FAILED"],
  FILLED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export class IllegalOrderTransition extends Error {
  constructor(
    readonly orderId: string,
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`order ${orderId}: illegal transition ${from} -> ${to}`);
    this.name = "IllegalOrderTransition";
  }
}

export interface TransitionPatch {
  reason: string;
  at: string;
  venueOrderId?: string | null;
  clientId?: string | null;
  kind?: OrderRecord["kind"];
  limitPrice?: number | null;
  attempt?: number;
  filledSize?: number;
  avgPrice?: number | null;
  lastError?: string | null;
  submitted?: boolean;
}

export function transitionOrder(
  order: OrderRecord,
  to: OrderState,
  patch: TransitionPatch,
): OrderRecord {
  if (!canTransition(order.state, to)) {
    throw new IllegalOrderTransition(order.id, order.state, to);
  }
  return Object.freeze({
    ...order,
    state: to,
    reason: patch.reason,
    venueOrderId: patch.venueOrderId !== undefined ? patch.venueOrderId : order.venueOrderId,
    clientId: patch.clientId !== undefined ? patch.clientId : order.clientId,
    kind: patch.kind ?? order.kind,
    limitPrice: patch.limitPrice !== undefined ? patch.limitPrice : order.limitPrice,
    attempt: patch.attempt ?? order.attempt,
    filledSize: patch.filledSize ?? order.filledSize,
    avgPrice: patch.avgPrice !== undefined ? patch.avgPrice : order.avgPrice,
    lastError: patch.lastError !== undefined ? patch.lastError : order.lastError,
    updatedAt: patch.at,
    submittedAt: patch.submitted ? patch.at : order.submittedAt,
    terminalAt: isTerminalOrderState(to) ? patch.at : order.terminalAt,
  });
}

/** Fill accounting. Never trusts a single report: it recomputes from evidence. */
export function applyFillTotals(
  order: OrderRecord,
  totals: { filledSize: number; avgPrice: number | null },
  at: string,
): { order: OrderRecord; state: OrderState } {
  const complete = totals.filledSize + 1e-9 >= order.size;
  const state: OrderState = complete ? "FILLED" : "PARTIAL_FILL";
  const reason = complete
    ? `filled ${round(totals.filledSize)} @ ${totals.avgPrice ?? "?"}`
    : `partial fill ${round(totals.filledSize)}/${order.size}`;
  return {
    order: transitionOrder(order, state, {
      reason,
      at,
      filledSize: totals.filledSize,
      avgPrice: totals.avgPrice,
    }),
    state,
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
