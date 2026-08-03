import type { FillRecord, OrderRecord, PositionRecord, RiskDecision } from "../execution/types";
import type { ExecutionIntent } from "../strategy/types";

// Statistics is a pure reduction over persisted execution evidence.
//
// It computes nothing the engine does not already record. Every number here is
// reproducible from orders, fills, intents and risk decisions alone, so
// Statistics and Replay can never disagree.

export interface WindowPerformance {
  seconds: number;
  buffer: number | null;
  trades: number;
  filled: number;
  fillRate: number;
  realizedPnl: number;
}

export interface DailySummary {
  day: string;
  trades: number;
  filled: number;
  realizedPnl: number;
}

export interface StatisticsSnapshot {
  generatedAt: string;
  today: {
    day: string;
    realizedPnl: number;
    trades: number;
    filled: number;
    cancelled: number;
    rejected: number;
  };
  totals: {
    trades: number;
    filled: number;
    cancelled: number;
    rejected: number;
    failed: number;
    expired: number;
    fills: number;
  };
  rates: { fillRate: number; winRate: number; lossRate: number };
  latency: {
    avgFillMs: number | null;
    avgTriggerToFillMs: number | null;
    avgSubmitMs: number | null;
  };
  pnl: {
    realized: number;
    unrealized: number;
    largestWin: number;
    largestLoss: number;
  };
  best: { window: number | null; buffer: number | null };
  windows: WindowPerformance[];
  daily: DailySummary[];
  session: {
    startedAt: string | null;
    trades: number;
    filled: number;
    realizedPnl: number;
  };
}

export interface StatisticsInput {
  now: string;
  sessionStartedAt: string | null;
  orders: OrderRecord[];
  fills: FillRecord[];
  positions: PositionRecord[];
  intents: ExecutionIntent[];
  risk: RiskDecision[];
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Realized PnL of a settled binary outcome position: a share pays 1 when the
 * outcome resolves true and 0 otherwise. Until settlement is known SPACE holds
 * the position at cost, so realized PnL only moves on CLOSED positions.
 */
export function realizedPnl(position: PositionRecord): number {
  if (position.status !== "CLOSED") return 0;
  const proceeds = (position.settledValue ?? 0) * position.size;
  return proceeds - position.cost;
}

/** Mark-to-market of an open position against its last known price. */
export function unrealizedPnl(position: PositionRecord): number {
  if (position.status !== "ACTIVE") return 0;
  const mark = position.markPrice ?? position.avgPrice;
  return mark * position.size - position.cost;
}

export function computeStatistics(input: StatisticsInput): StatisticsSnapshot {
  const today = day(input.now);
  const intentById = new Map(input.intents.map((intent) => [intent.id, intent]));
  const fillsByOrder = new Map<string, FillRecord[]>();
  for (const fill of input.fills) {
    fillsByOrder.set(fill.orderId, [...(fillsByOrder.get(fill.orderId) ?? []), fill]);
  }

  const terminal = (state: string) => ["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(state);
  const counts = {
    trades: input.orders.length,
    filled: input.orders.filter((order) => order.state === "FILLED").length,
    cancelled: input.orders.filter((order) => order.state === "CANCELLED").length,
    rejected: input.risk.filter((decision) => decision.status === "REJECTED").length,
    failed: input.orders.filter((order) => order.state === "FAILED").length,
    expired: input.orders.filter((order) => order.state === "EXPIRED").length,
    fills: input.fills.length,
  };

  const settled = input.positions.filter((position) => position.status === "CLOSED");
  const pnls = settled.map(realizedPnl);
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);

  const fillLatencies: number[] = [];
  const triggerLatencies: number[] = [];
  const submitLatencies: number[] = [];
  for (const order of input.orders) {
    const orderFills = fillsByOrder.get(order.id) ?? [];
    const lastFill = orderFills[orderFills.length - 1];
    if (order.submittedAt && lastFill) {
      fillLatencies.push(Date.parse(lastFill.filledAt) - Date.parse(order.submittedAt));
    }
    if (order.submittedAt) {
      submitLatencies.push(Date.parse(order.submittedAt) - Date.parse(order.createdAt));
    }
    const intent = intentById.get(order.intentId);
    if (intent && lastFill) {
      triggerLatencies.push(Date.parse(lastFill.filledAt) - Date.parse(intent.triggerTime));
    }
  }

  const perWindow = new Map<number, WindowPerformance>();
  for (const order of input.orders) {
    const intent = intentById.get(order.intentId);
    const seconds = intent?.windowSeconds ?? 0;
    const entry = perWindow.get(seconds) ?? {
      seconds,
      buffer: intent?.buffer ?? null,
      trades: 0,
      filled: 0,
      fillRate: 0,
      realizedPnl: 0,
    };
    entry.trades += 1;
    if (order.state === "FILLED") entry.filled += 1;
    entry.realizedPnl += settled
      .filter((position) => position.tokenId === order.tokenId)
      .reduce((sum, position) => sum + realizedPnl(position), 0);
    perWindow.set(seconds, entry);
  }
  for (const entry of perWindow.values()) {
    entry.fillRate = entry.trades > 0 ? entry.filled / entry.trades : 0;
  }
  const windows = [...perWindow.values()].sort((a, b) => b.seconds - a.seconds);
  const bestWindow = windows.reduce<WindowPerformance | null>(
    (best, entry) => (best === null || entry.realizedPnl > best.realizedPnl ? entry : best),
    null,
  );

  const dailyMap = new Map<string, DailySummary>();
  for (const order of input.orders) {
    const key = day(order.createdAt);
    const entry = dailyMap.get(key) ?? { day: key, trades: 0, filled: 0, realizedPnl: 0 };
    entry.trades += 1;
    if (order.state === "FILLED") entry.filled += 1;
    dailyMap.set(key, entry);
  }
  for (const position of settled) {
    const key = day(position.updatedAt ?? input.now);
    const entry = dailyMap.get(key) ?? { day: key, trades: 0, filled: 0, realizedPnl: 0 };
    entry.realizedPnl += realizedPnl(position);
    dailyMap.set(key, entry);
  }
  const daily = [...dailyMap.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14);

  const todayOrders = input.orders.filter((order) => day(order.createdAt) === today);
  const sessionOrders = input.sessionStartedAt
    ? input.orders.filter((order) => order.createdAt >= input.sessionStartedAt!)
    : input.orders;

  const realized = pnls.reduce((sum, value) => sum + value, 0);
  const unrealized = input.positions.reduce((sum, position) => sum + unrealizedPnl(position), 0);

  return {
    generatedAt: input.now,
    today: {
      day: today,
      realizedPnl: dailyMap.get(today)?.realizedPnl ?? 0,
      trades: todayOrders.length,
      filled: todayOrders.filter((order) => order.state === "FILLED").length,
      cancelled: todayOrders.filter((order) => order.state === "CANCELLED").length,
      rejected: input.risk.filter(
        (decision) => decision.status === "REJECTED" && day(decision.at) === today,
      ).length,
    },
    totals: counts,
    rates: {
      fillRate: counts.trades > 0 ? counts.filled / counts.trades : 0,
      winRate: pnls.length > 0 ? wins.length / pnls.length : 0,
      lossRate: pnls.length > 0 ? losses.length / pnls.length : 0,
    },
    latency: {
      avgFillMs: mean(fillLatencies),
      avgTriggerToFillMs: mean(triggerLatencies),
      avgSubmitMs: mean(submitLatencies),
    },
    pnl: {
      realized,
      unrealized,
      largestWin: wins.length > 0 ? Math.max(...wins) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses) : 0,
    },
    best: { window: bestWindow?.seconds ?? null, buffer: bestWindow?.buffer ?? null },
    windows,
    daily,
    session: {
      startedAt: input.sessionStartedAt,
      trades: sessionOrders.length,
      filled: sessionOrders.filter((order) => order.state === "FILLED").length,
      realizedPnl: realized,
    },
  };
  void terminal;
}
