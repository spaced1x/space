import type { ExecutionStore } from "../../execution/store";
import type { FillRecord, OrderEventRecord, OrderRecord, RiskDecision } from "../../execution/types";
import { systemClock } from "../../shared/clock";
import { requireDriver } from "../database.server";

// Strict repository rule: SQL text exists only inside db/repositories/**.
//
// orders.intent_id is UNIQUE, fills.id is the venue trade id, order_events and
// risk_decisions are append-only. Those four facts are what make execution
// idempotent across restarts even if the engine misbehaves.

interface OrderRow {
  id: string;
  intent_id: string;
  condition_id: string;
  slug: string;
  horizon: string;
  token_id: string;
  outcome: string;
  side: string;
  mode: string;
  kind: string;
  limit_price: number | null;
  size: number;
  state: string;
  attempt: number;
  client_id: string | null;
  venue_order_id: string | null;
  filled_size: number;
  avg_price: number | null;
  reason: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  terminal_at: string | null;
}

function toOrder(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    intentId: row.intent_id,
    conditionId: row.condition_id,
    slug: row.slug,
    horizon: row.horizon as OrderRecord["horizon"],
    tokenId: row.token_id,
    outcome: row.outcome as OrderRecord["outcome"],
    side: row.side as OrderRecord["side"],
    mode: row.mode as OrderRecord["mode"],
    kind: row.kind as OrderRecord["kind"],
    limitPrice: row.limit_price,
    size: row.size,
    state: row.state as OrderRecord["state"],
    attempt: row.attempt,
    clientId: row.client_id,
    venueOrderId: row.venue_order_id,
    filledSize: row.filled_size,
    avgPrice: row.avg_price,
    reason: row.reason,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    terminalAt: row.terminal_at,
  };
}

interface FillRow {
  id: string;
  order_id: string;
  intent_id: string;
  condition_id: string;
  token_id: string;
  outcome: string;
  side: string;
  size: number;
  price: number;
  filled_at: string;
  source: string;
}

export const executionRepository: ExecutionStore = {
  async createOrder(order: OrderRecord): Promise<boolean> {
    const driver = await requireDriver();
    const result = driver.run(
      `INSERT OR IGNORE INTO orders (
         id, intent_id, condition_id, slug, horizon, token_id, outcome, side,
         mode, kind, limit_price, size, state, attempt, client_id, venue_order_id,
         filled_size, avg_price, reason, last_error, created_at, updated_at,
         submitted_at, terminal_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.id,
        order.intentId,
        order.conditionId,
        order.slug,
        order.horizon,
        order.tokenId,
        order.outcome,
        order.side,
        order.mode,
        order.kind,
        order.limitPrice,
        order.size,
        order.state,
        order.attempt,
        order.clientId,
        order.venueOrderId,
        order.filledSize,
        order.avgPrice,
        order.reason,
        order.lastError,
        order.createdAt,
        order.updatedAt,
        order.submittedAt,
        order.terminalAt,
      ],
    );
    return result.changes > 0;
  },

  async updateOrder(order: OrderRecord): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `UPDATE orders SET
         kind = ?, limit_price = ?, state = ?, attempt = ?, client_id = ?,
         venue_order_id = ?, filled_size = ?, avg_price = ?, reason = ?,
         last_error = ?, updated_at = ?, submitted_at = ?, terminal_at = ?
       WHERE id = ?`,
      [
        order.kind,
        order.limitPrice,
        order.state,
        order.attempt,
        order.clientId,
        order.venueOrderId,
        order.filledSize,
        order.avgPrice,
        order.reason,
        order.lastError,
        order.updatedAt,
        order.submittedAt,
        order.terminalAt,
        order.id,
      ],
    );
  },

  async appendEvent(event: OrderEventRecord): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO order_events (order_id, intent_id, state, reason, attempt, payload, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.orderId,
        event.intentId,
        event.state,
        event.reason,
        event.attempt,
        JSON.stringify(event.payload ?? {}),
        event.occurredAt,
      ],
    );
  },

  async recordFill(fill: FillRecord): Promise<boolean> {
    const driver = await requireDriver();
    const result = driver.run(
      `INSERT OR IGNORE INTO fills (
         id, order_id, intent_id, condition_id, token_id, outcome, side, size,
         price, filled_at, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fill.id,
        fill.orderId,
        fill.intentId,
        fill.conditionId,
        fill.tokenId,
        fill.outcome,
        fill.side,
        fill.size,
        fill.price,
        fill.filledAt,
        fill.source,
      ],
    );
    return result.changes > 0;
  },

  async recordRisk(decision: RiskDecision, attempt: number): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO risk_decisions (intent_id, status, code, reason, attempt, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        decision.intentId,
        decision.status,
        decision.code,
        decision.reason,
        attempt,
        decision.at || systemClock.iso(),
      ],
    );
  },

  async loadOrders(limit = 200): Promise<OrderRecord[]> {
    const driver = await requireDriver();
    const rows = driver.all<OrderRow>(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`, [
      limit,
    ]);
    return rows.map(toOrder);
  },

  async loadFills(limit = 500): Promise<FillRecord[]> {
    const driver = await requireDriver();
    const rows = driver.all<FillRow>(`SELECT * FROM fills ORDER BY filled_at DESC LIMIT ?`, [
      limit,
    ]);
    return rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      intentId: row.intent_id,
      conditionId: row.condition_id,
      tokenId: row.token_id,
      outcome: row.outcome as FillRecord["outcome"],
      side: row.side as FillRecord["side"],
      size: row.size,
      price: row.price,
      filledAt: row.filled_at,
      source: row.source,
    }));
  },
};