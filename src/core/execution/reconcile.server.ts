import { clock } from "../clock/clock.service";
import { requireDriver } from "../db/database.server";
import { createLogger } from "../logging/logger";
import { correlationId } from "../shared/ids";
import type { ExecutionStore } from "./store";
import type { FillRecord, OrderRecord, OrderState, ReconciliationResult } from "./types";
import { LIVE_ORDER_STATES } from "./types";
import type { OpenOrderSummary, VenueAdapter, VenueTrade } from "./venue";

// Venue Reconciler.
//
// Runs once per boot before the engine accepts an ARM command. It asks the
// venue for open orders by token, compares them with the local order chains,
// and adopts or closes any divergence. The goal is simple: after a crash or
// PM2 restart, SPACE must never submit a duplicate order because it lost
// track of one that is still live on the venue.

const log = createLogger("reconcile");

interface ReconciliationReportRow {
  id: number;
  created_at: string;
  runtime_id: string;
  state: string;
  orders_examined: number;
  adopted: number;
  closed: number;
  failed: number;
  divergences: number;
  message: string;
  details: string;
}

function runtimeId(): string {
  return `${process.pid}-${Date.now()}`;
}

async function persistReport(result: ReconciliationResult, details: unknown): Promise<void> {
  try {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO reconciliation_reports (
        created_at, runtime_id, state, orders_examined, adopted, closed, failed,
        divergences, message, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clock().iso(),
        runtimeId(),
        result.state,
        result.examined,
        result.adopted,
        result.closed,
        result.failed,
        result.divergences,
        result.message,
        JSON.stringify(details),
      ],
    );
  } catch (error) {
    log.error("failed to persist reconciliation report", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function loadLastReconciliationReport(): Promise<ReconciliationResult | null> {
  try {
    const driver = await requireDriver();
    const row = driver.get<ReconciliationReportRow>(
      "SELECT * FROM reconciliation_reports ORDER BY created_at DESC LIMIT 1",
    );
    if (!row) return null;
    return {
      state: row.state as ReconciliationResult["state"],
      examined: row.orders_examined,
      adopted: row.adopted,
      closed: row.closed,
      failed: row.failed,
      divergences: row.divergences,
      message: row.message,
    };
  } catch {
    return null;
  }
}

export interface ReconcilePorts {
  store: ExecutionStore;
  venue: VenueAdapter;
  tokenIds: string[];
}

/**
 * Reconcile local live orders against venue truth. This function is the only
 * place in SPACE that may create an order record without a fresh intent, and it
 * does so only when the venue proves the order exists.
 */
export async function reconcileOpenOrders(ports: ReconcilePorts): Promise<ReconciliationResult> {
  const cid = correlationId("reconcile");
  const result: ReconciliationResult = {
    state: "OK",
    examined: 0,
    adopted: 0,
    closed: 0,
    failed: 0,
    divergences: 0,
    message: "no live local orders",
  };

  try {
    const local = (await ports.store.loadOrders(1000)).filter((order) =>
      LIVE_ORDER_STATES.includes(order.state),
    );
    result.examined = local.length;

    if (local.length === 0 && ports.tokenIds.length === 0) {
      await persistReport(result, { reason: "no local orders and no tokens to query" });
      return result;
    }

    const venueOpen = new Map<string, OpenOrderSummary>();
    for (const tokenId of ports.tokenIds) {
      try {
        const orders = await ports.venue.openOrders(tokenId);
        for (const order of orders) venueOpen.set(order.venueOrderId, order);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.error("failed to fetch venue open orders", { tokenId, reason, cid });
        result.state = "FAILED";
        result.message = `venue query failed for ${tokenId}: ${reason}`;
        await persistReport(result, { tokenId, reason });
        return result;
      }
    }

    const localByVenueId = new Map<string, OrderRecord>();
    for (const order of local) {
      if (order.venueOrderId) localByVenueId.set(order.venueOrderId, order);
    }

    const details: {
      tokenIds: string[];
      venueOpenCount: number;
      localLiveCount: number;
      adopted: string[];
      closed: string[];
      failed: string[];
      divergences: string[];
    } = {
      tokenIds: ports.tokenIds,
      venueOpenCount: venueOpen.size,
      localLiveCount: local.length,
      adopted: [],
      closed: [],
      failed: [],
      divergences: [],
    };

    // 1. Adopt orphans: venue has an open order we do not know about.
    for (const [venueOrderId, open] of venueOpen) {
      if (localByVenueId.has(venueOrderId)) continue;
      try {
        const trades = await ports.venue.trades(venueOrderId);
        const adopted = await adoptOrphan(ports, open, trades);
        result.adopted += 1;
        details.adopted.push(adopted.id);
        log.info("adopted orphan order", { orderId: adopted.id, venueOrderId, cid });
      } catch (error) {
        result.failed += 1;
        details.failed.push(venueOrderId);
        result.state = "FAILED";
        log.error("failed to adopt orphan", { venueOrderId, reason: String(error), cid });
      }
    }

    // 2. Reconcile known live orders: if the venue no longer knows the order,
    //    mark it closed. If the venue reports it cancelled/expired, mirror that.
    for (const order of local) {
      const open = order.venueOrderId ? venueOpen.get(order.venueOrderId) : undefined;
      if (!order.venueOrderId) {
        // Local order was built but never acknowledged. We cannot know whether
        // the venue received it, so we fail it safely and let the operator
        // investigate. It is never resubmitted automatically.
        const closed = await closeLocalOrder(
          ports,
          order,
          "FAILED",
          "recovered without venue order id; not resubmitted",
        );
        result.closed += 1;
        details.closed.push(closed.id);
        result.divergences += 1;
        details.divergences.push(`${order.id}: no venue order id`);
        continue;
      }
      if (!open) {
        // Venue does not report this order as open. It may have filled or been
        // cancelled; pull trades one more time, then close it.
        try {
          const trades = await ports.venue.trades(order.venueOrderId);
          await recordTrades(ports, order, trades);
        } catch (error) {
          log.warn("could not fetch trades for reconciled order", {
            orderId: order.id,
            venueOrderId: order.venueOrderId,
            reason: String(error),
            cid,
          });
        }
        const closed = await closeLocalOrder(
          ports,
          order,
          "CANCELLED",
          "venue no longer knows this order after restart",
        );
        result.closed += 1;
        details.closed.push(closed.id);
        result.divergences += 1;
        details.divergences.push(`${order.id}: venue missing`);
        continue;
      }
      if (open.status === "CANCELLED" || open.status === "EXPIRED") {
        const terminal: OrderState = open.status === "EXPIRED" ? "EXPIRED" : "CANCELLED";
        const closed = await closeLocalOrder(
          ports,
          order,
          terminal,
          `venue reported ${open.status.toLowerCase()} during reconciliation`,
        );
        result.closed += 1;
        details.closed.push(closed.id);
        result.divergences += 1;
        details.divergences.push(`${order.id}: venue status ${open.status}`);
      }
    }

    if (result.adopted || result.closed || result.failed) {
      result.message = `reconciliation complete: ${result.adopted} adopted, ${result.closed} closed, ${result.failed} failed`;
    }
    if (result.failed > 0 && result.state !== "FAILED") {
      result.state = "DIVERGENCE";
    }
    await persistReport(result, details);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    result.state = "FAILED";
    result.message = `reconciliation crashed: ${reason}`;
    await persistReport(result, { reason });
    return result;
  }
}

async function adoptOrphan(
  ports: ReconcilePorts,
  open: OpenOrderSummary,
  trades: VenueTrade[],
): Promise<OrderRecord> {
  const at = clock().iso();
  const id = `adopted:${open.venueOrderId}`;
  const order: OrderRecord = {
    id,
    intentId: `adopted:${open.venueOrderId}`,
    conditionId: "unknown",
    slug: "adopted-orphan",
    horizon: "FIVE_MINUTE",
    tokenId: open.tokenId,
    outcome: open.side === "BUY" ? "UP" : "DOWN",
    side: open.side,
    mode: "LIMIT_ONLY",
    kind: open.kind,
    limitPrice: open.price,
    size: open.size,
    state: open.status === "OPEN" ? "LIMIT_SUBMITTED" : "MARKET_SUBMITTED",
    attempt: 0,
    clientId: open.clientId,
    venueOrderId: open.venueOrderId,
    filledSize: open.filledSize,
    avgPrice: null,
    reason: "adopted orphan order from venue reconciliation",
    lastError: null,
    createdAt: at,
    updatedAt: at,
    submittedAt: at,
    terminalAt: null,
  };
  await ports.store.createOrder(order);
  await ports.store.appendEvent({
    orderId: order.id,
    intentId: order.intentId,
    state: order.state,
    reason: order.reason,
    attempt: 0,
    payload: { venueOrderId: open.venueOrderId, adopted: true },
    occurredAt: at,
  });
  await recordTrades(ports, order, trades);
  return order;
}

async function closeLocalOrder(
  ports: ReconcilePorts,
  order: OrderRecord,
  terminal: OrderState,
  reason: string,
): Promise<OrderRecord> {
  const at = clock().iso();
  const closed: OrderRecord = {
    ...order,
    state: terminal,
    reason,
    updatedAt: at,
    terminalAt: at,
  };
  await ports.store.updateOrder(closed);
  await ports.store.appendEvent({
    orderId: closed.id,
    intentId: closed.intentId,
    state: terminal,
    reason,
    attempt: closed.attempt,
    payload: { reconciled: true },
    occurredAt: at,
  });
  return closed;
}

async function recordTrades(
  ports: ReconcilePorts,
  order: OrderRecord,
  trades: VenueTrade[],
): Promise<void> {
  for (const trade of trades) {
    const fill: FillRecord = {
      id: trade.id,
      orderId: order.id,
      intentId: order.intentId,
      conditionId: order.conditionId,
      tokenId: trade.tokenId,
      outcome: order.outcome,
      side: order.side,
      size: trade.size,
      price: trade.price,
      filledAt: trade.at,
      source: "venue-reconcile",
    };
    await ports.store.recordFill(fill);
  }
}
