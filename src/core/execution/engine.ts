import type { ExecutionIntent } from "../strategy/types";
import { clampPrice, lockExecutionConfig } from "./config";
import { applyFillTotals, transitionOrder } from "./lifecycle";
import { evaluateRisk } from "./risk";
import { derivePositionTransitions } from "./positions";
import type { ExecutionStore } from "./store";
import type {
  ExecutionConfig,
  FillRecord,
  OrderRecord,
  OrderState,
  PositionRecord,
  RiskContext,
  RiskDecision,
  SizingDecision,
} from "./types";
import { isTerminalOrderState, LIVE_ORDER_STATES, orderLifecycleOf } from "./types";
import type { VenueAdapter, VenueTrade } from "./venue";

// The Execution Engine.
//
// It consumes APPROVED Execution Intents and nothing else. It never
// recalculates strategy, never modifies an intent, and never lets any other
// module talk to the venue. Every state is persisted *before* the engine
// advances, so a crash always leaves recoverable, non-duplicable evidence.

export interface ExecutionPorts {
  store: ExecutionStore;
  venue: VenueAdapter;
  now: () => number;
  config: () => ExecutionConfig;
  /** Resolved by the runtime host from the unified market state + runtime state. */
  riskContext: (intent: ExecutionIntent, attempt: number) => RiskContext;
  emit?: (event: {
    type: string;
    severity: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
    orderId: string;
    intentId: string;
    reason: string;
    state?: OrderState;
  }) => void;
}

export interface ExecutionEngine {
  recover(): Promise<void>;
  /** Idempotent: an intent already carrying an order chain is ignored. */
  processIntent(
    intent: ExecutionIntent,
    /**
     * Per-intent execution overrides. Manual Trading uses this to pick LIMIT or
     * MARKET for a single order without touching the desk configuration; the
     * strategy path never passes it.
     */
    overrides?: Partial<Pick<ExecutionConfig, "mode">>,
  ): Promise<OrderRecord | null>;
  /** Order Monitor: fills, timeouts, fallback and retries. */
  monitor(): Promise<void>;
  orders(): OrderRecord[];
  fills(): FillRecord[];
  positions(): PositionRecord[];
  lastRisk(): RiskDecision | null;
  lastSizing(): SizingDecision | null;
  riskRejections(): RiskDecision[];
  intentsSeen(): number;
  reset(): void;
}

interface Runtime {
  /** Wall-clock ms of the last submission per order, for the limit timeout. */
  submittedAtMs: Map<string, number>;
  retryAtMs: Map<string, number>;
}

export function orderIdFor(intent: ExecutionIntent): string {
  return `order:${intent.id}`;
}

export function createExecutionEngine(ports: ExecutionPorts): ExecutionEngine {
  const orders = new Map<string, OrderRecord>();
  const fills = new Map<string, FillRecord>();
  const seenIntents = new Set<string>();
  const runtime: Runtime = { submittedAtMs: new Map(), retryAtMs: new Map() };
  let last: RiskDecision | null = null;
  let rejections: RiskDecision[] = [];
  let lastSizing: SizingDecision | null = null;

  const iso = () => new Date(ports.now()).toISOString();
  const config = () => lockExecutionConfig(ports.config());

  function emit(
    type: string,
    severity: "INFO" | "SUCCESS" | "WARNING" | "ERROR",
    order: OrderRecord,
  ): void {
    ports.emit?.({
      type,
      severity,
      orderId: order.id,
      intentId: order.intentId,
      reason: order.reason,
      state: order.state,
    });
  }

  async function persist(
    order: OrderRecord,
    payload: Record<string, unknown> = {},
    from: OrderState | null = null,
  ): Promise<void> {
    orders.set(order.id, order);
    // Projection, event and transition commit together. A partially persisted
    // execution event is a runtime failure, never a silent divergence.
    await ports.store.commit({
      order,
      event: {
        orderId: order.id,
        intentId: order.intentId,
        state: order.state,
        reason: order.reason,
        attempt: order.attempt,
        payload,
        occurredAt: order.updatedAt,
      },
      transition:
        from === null
          ? null
          : {
              orderId: order.id,
              intentId: order.intentId,
              fromState: from,
              toState: order.state,
              fromLifecycle: orderLifecycleOf(from),
              toLifecycle: orderLifecycleOf(order.state, order.venueOrderId),
              at: order.updatedAt,
              venueOrderId: order.venueOrderId,
              filledSize: order.filledSize,
              price: order.avgPrice ?? order.limitPrice,
              reason: order.reason,
              error: order.lastError,
            },
    });
  }

  async function advance(
    order: OrderRecord,
    to: OrderState,
    reason: string,
    patch: Partial<Parameters<typeof transitionOrder>[2]> = {},
    payload: Record<string, unknown> = {},
  ): Promise<OrderRecord> {
    const next = transitionOrder(order, to, { reason, at: iso(), ...patch });
    await persist(next, payload, order.state);
    return next;
  }

  async function priceFor(intent: ExecutionIntent, tokenId: string): Promise<number> {
    const cfg = config();
    const best = await ports.venue.bestPrice(tokenId, "BUY").catch(() => null);
    // A marketable limit sits at the best ask plus configured slippage; with no
    // book we fall back to the configured limit price. Either way it is clamped.
    const raw = best === null ? cfg.limitPrice : best + cfg.priceSlippage;
    void intent;
    return clampPrice(raw, cfg);
  }

  async function submit(order: OrderRecord, kind: OrderRecord["kind"]): Promise<OrderRecord> {
    const clientId = `${order.id}:a${order.attempt}:${kind.toLowerCase()}`;
    // Persist the pre-submission state first: if the process dies between here
    // and the ack, recovery sees ORDER_BUILD and reconciles instead of resubmitting.
    let current = order;
    if (current.state !== "ORDER_BUILD") {
      current = await advance(current, "ORDER_BUILD", `building ${kind.toLowerCase()} order`, {
        kind,
        clientId,
      });
    } else {
      current = await persistBuild(current, kind, clientId);
    }

    try {
      const ack = await ports.venue.submit({
        clientId,
        tokenId: current.tokenId,
        side: current.side,
        kind,
        price: current.limitPrice,
        size: current.size,
      });
      const state: OrderState = kind === "LIMIT" ? "LIMIT_SUBMITTED" : "MARKET_SUBMITTED";
      const next = await advance(
        current,
        state,
        `${kind.toLowerCase()} order submitted (${ack.venueOrderId})`,
        { venueOrderId: ack.venueOrderId, submitted: true, kind, lastError: null },
        { ack: ack.status },
      );
      runtime.submittedAtMs.set(next.id, ports.now());
      emit("execution.order.submitted", "SUCCESS", next);
      return next;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failed = await advance(current, "FAILED", `submission failed: ${reason}`, {
        lastError: reason,
      });
      emit("execution.order.failed", "ERROR", failed);
      return failed;
    }
  }

  async function persistBuild(
    order: OrderRecord,
    kind: OrderRecord["kind"],
    clientId: string,
  ): Promise<OrderRecord> {
    const next = Object.freeze({
      ...order,
      kind,
      clientId,
      updatedAt: iso(),
      reason: `building ${kind.toLowerCase()} order (attempt ${order.attempt})`,
    });
    await persist(next);
    return next;
  }

  async function ingestTrades(order: OrderRecord, trades: VenueTrade[]): Promise<OrderRecord> {
    let changed = false;
    for (const trade of trades) {
      if (fills.has(trade.id)) continue;
      const fill: FillRecord = {
        id: trade.id,
        orderId: order.id,
        intentId: order.intentId,
        conditionId: order.conditionId,
        tokenId: order.tokenId,
        outcome: order.outcome,
        side: order.side,
        size: trade.size,
        price: trade.price,
        filledAt: trade.at,
        source: "venue",
      };
      // Duplicate protection lives in storage: an already-known venue trade id
      // is ignored, which is what makes restart recovery safe.
      const inserted = await ports.store.recordFill(fill);
      fills.set(fill.id, fill);
      if (inserted) changed = true;
    }
    if (!changed && order.filledSize > 0) return order;

    const mine = [...fills.values()].filter((fill) => fill.orderId === order.id);
    if (!mine.length) return order;
    const filledSize = mine.reduce((sum, fill) => sum + fill.size, 0);
    const notional = mine.reduce((sum, fill) => sum + fill.size * fill.price, 0);
    const avgPrice = filledSize > 0 ? notional / filledSize : null;
    if (Math.abs(filledSize - order.filledSize) < 1e-9) return order;

    const { order: next, state } = applyFillTotals(order, { filledSize, avgPrice }, iso());
    await persist(next, { fills: mine.length }, order.state);
    // The position lifecycle is derived from fills and appended, never stored
    // as mutable state. Re-deriving after a restart regenerates it identically.
    await ports.store.recordPositionTransitions(
      derivePositionTransitions([...orders.values()], [...fills.values()]),
    );
    emit(
      state === "FILLED" ? "execution.order.filled" : "execution.order.partial_fill",
      state === "FILLED" ? "SUCCESS" : "INFO",
      next,
    );
    return next;
  }

  async function handleTimeout(order: OrderRecord): Promise<void> {
    const cfg = config();
    let current = await advance(
      order,
      "LIMIT_TIMEOUT",
      `limit order unfilled after ${cfg.limitTimeoutMs}ms`,
    );
    emit("execution.order.timeout", "WARNING", current);

    if (current.venueOrderId) {
      try {
        await ports.venue.cancel(current.venueOrderId);
      } catch {
        // Cancellation is best effort; the monitor reconciles the true state.
      }
    }
    current = await advance(current, "LIMIT_CANCELLED", "limit order cancelled", {
      venueOrderId: null,
    });

    if (order.mode === "LIMIT_THEN_MARKET") {
      // Fallback keeps the same intent and the same order chain; the monitor
      // picks the LIMIT_CANCELLED order up next tick and builds the market leg.
      return;
    }

    if (current.attempt < cfg.maxRetries) {
      runtime.retryAtMs.set(current.id, ports.now() + cfg.retryDelayMs);
      return;
    }

    const expired = await advance(
      current,
      "EXPIRED",
      `limit order not filled after ${current.attempt + 1} attempt(s)`,
    );
    emit("execution.order.expired", "WARNING", expired);
  }

  async function retry(order: OrderRecord): Promise<void> {
    // Retry Engine: the intent is never recreated. The frozen trigger and the
    // buffer are unchanged; only the execution path is retried, re-priced from
    // the latest book, and re-checked by the Risk Engine.
    const cfg = config();
    const intentContext = ports.riskContext(intentOf(order), order.attempt + 1);
    if (intentContext.sizing) {
      lastSizing = intentContext.sizing;
      await ports.store.recordSizing(intentContext.sizing);
    }
    const decision = evaluateRisk(intentOf(order), { ...intentContext, alreadyExecuted: false });
    last = decision;
    await ports.store.recordRisk(decision, order.attempt + 1);
    if (decision.status === "REJECTED") {
      rejections = [decision, ...rejections].slice(0, 50);
      const cancelled = await advance(
        order,
        "CANCELLED",
        `retry blocked by risk: ${decision.reason}`,
      );
      emit("execution.order.cancelled", "WARNING", cancelled);
      return;
    }

    const price = await priceFor(intentOf(order), order.tokenId);
    const rebuilt = await advance(
      order,
      "ORDER_BUILD",
      `retry ${order.attempt + 1}/${cfg.maxRetries} reusing intent ${order.intentId}`,
      { attempt: order.attempt + 1, limitPrice: price, kind: "LIMIT" },
    );
    await submit(rebuilt, "LIMIT");
  }

  /** The order carries every immutable field of its intent, so retries need no lookup. */
  function intentOf(order: OrderRecord): ExecutionIntent {
    return intents.get(order.intentId) ?? recoveredIntent(order);
  }

  const intents = new Map<string, ExecutionIntent>();

  /**
   * An order adopted after a restart has no in-memory intent. Its immutable
   * fields are reconstructed from the order itself; strategy-only fields stay
   * zero and the reason marks the row as recovered rather than triggered.
   */
  function recoveredIntent(order: OrderRecord): ExecutionIntent {
    return {
      id: order.intentId,
      createdAt: order.createdAt,
      conditionId: order.conditionId,
      slug: order.slug,
      horizon: order.horizon,
      windowSeconds: 0,
      direction: order.outcome,
      openingTwap: 0,
      settlementTwap: 0,
      ptb: 0,
      buffer: 0,
      frozenTrigger: 0,
      triggerTime: order.createdAt,
      reason: "recovered intent",
    };
  }

  return {
    async recover(): Promise<void> {
      const stored = await ports.store.loadOrders();
      for (const order of stored) orders.set(order.id, order);
      for (const order of stored) seenIntents.add(order.intentId);
      for (const fill of await ports.store.loadFills()) fills.set(fill.id, fill);

      // Reconcile anything that was live when the process died. We never
      // resubmit during recovery: an unknown order is failed, not repeated.
      for (const order of stored) {
        if (!LIVE_ORDER_STATES.includes(order.state)) continue;
        if (!order.venueOrderId) {
          const failed = await advance(
            order,
            "FAILED",
            "recovered without a venue order id; not resubmitted",
          );
          emit("execution.order.recovered", "WARNING", failed);
          continue;
        }
        try {
          const trades = await ports.venue.trades(order.venueOrderId);
          const withFills = await ingestTrades(order, trades);
          const status = await ports.venue.status(order.venueOrderId);
          if (!status && !isTerminalOrderState(withFills.state)) {
            const cancelled = await advance(
              withFills,
              "CANCELLED",
              "venue no longer knows this order after restart",
            );
            emit("execution.order.recovered", "WARNING", cancelled);
            continue;
          }
          if (status && status.status === "OPEN") {
            runtime.submittedAtMs.set(order.id, ports.now());
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const failed = await advance(order, "FAILED", `recovery failed: ${reason}`, {
            lastError: reason,
          });
          emit("execution.order.recovered", "ERROR", failed);
        }
      }
    },

    async processIntent(
      intent: ExecutionIntent,
      overrides?: Partial<Pick<ExecutionConfig, "mode">>,
    ): Promise<OrderRecord | null> {
      if (seenIntents.has(intent.id)) return orders.get(orderIdFor(intent)) ?? null;
      seenIntents.add(intent.id);
      intents.set(intent.id, intent);

      const cfg = { ...config(), ...overrides };
      const context = ports.riskContext(intent, 0);
      // One sizing decision, taken before risk, persisted with the verdict.
      if (context.sizing) {
        lastSizing = context.sizing;
        await ports.store.recordSizing(context.sizing);
      }
      const decision = evaluateRisk(intent, context);
      last = decision;
      await ports.store.recordRisk(decision, 0);

      if (decision.status === "REJECTED") {
        rejections = [decision, ...rejections].slice(0, 50);
        ports.emit?.({
          type: "execution.risk.rejected",
          severity: "WARNING",
          orderId: orderIdFor(intent),
          intentId: intent.id,
          reason: `${decision.code}: ${decision.reason}`,
          state: "RISK_REJECTED",
        });
        return null;
      }

      const at = iso();
      const created: OrderRecord = Object.freeze({
        id: orderIdFor(intent),
        intentId: intent.id,
        conditionId: intent.conditionId,
        slug: intent.slug,
        horizon: intent.horizon,
        tokenId: context.tokenId!,
        outcome: intent.direction,
        side: "BUY",
        mode: cfg.mode,
        kind: cfg.mode === "MARKET_ONLY" ? "MARKET" : "LIMIT",
        limitPrice: null,
        // Per-window trade size is resolved by the Operations Desk projection
        // in the risk context, so one window can trade a different size.
        size: context.size,
        state: "INTENT_CREATED",
        attempt: 0,
        clientId: null,
        venueOrderId: null,
        filledSize: 0,
        avgPrice: null,
        reason: intent.reason,
        lastError: null,
        createdAt: at,
        updatedAt: at,
        submittedAt: null,
        terminalAt: null,
      });

      // One order chain per intent, enforced by storage.
      const opened = await ports.store.createOrder(created);
      if (!opened) {
        const existing = orders.get(created.id) ?? null;
        return existing;
      }
      orders.set(created.id, created);
      await ports.store.appendEvent({
        orderId: created.id,
        intentId: created.intentId,
        state: "INTENT_CREATED",
        reason: intent.reason,
        attempt: 0,
        payload: { direction: intent.direction, windowSeconds: intent.windowSeconds },
        occurredAt: at,
      });

      const approved = await advance(created, "RISK_APPROVED", decision.reason);
      const price = await priceFor(intent, approved.tokenId);
      const built = await advance(approved, "ORDER_BUILD", "order built", {
        limitPrice: price,
        kind: approved.kind,
      });
      return submit(built, built.kind);
    },

    async monitor(): Promise<void> {
      const cfg = config();
      const nowMs = ports.now();

      for (const order of [...orders.values()]) {
        if (isTerminalOrderState(order.state)) continue;

        // Pending retry.
        const retryAt = runtime.retryAtMs.get(order.id);
        if (retryAt !== undefined && order.state === "LIMIT_CANCELLED") {
          if (nowMs >= retryAt) {
            runtime.retryAtMs.delete(order.id);
            await retry(order);
          }
          continue;
        }

        // Market fallback waiting to be built (mode LIMIT_THEN_MARKET).
        if (order.state === "LIMIT_CANCELLED" && order.mode === "LIMIT_THEN_MARKET") {
          const price = await priceFor(intentOf(order), order.tokenId);
          const rebuilt = await advance(order, "ORDER_BUILD", "market fallback after limit timeout", {
            kind: "MARKET",
            limitPrice: price,
          });
          await submit(rebuilt, "MARKET");
          continue;
        }

        const venueOrderId = order.venueOrderId;
        if (!LIVE_ORDER_STATES.includes(order.state) || !venueOrderId) continue;

        let current = order;
        try {
          current = await ingestTrades(current, await ports.venue.trades(venueOrderId));
        } catch (error) {
          current = Object.freeze({
            ...current,
            lastError: error instanceof Error ? error.message : String(error),
          });
          orders.set(current.id, current);
        }
        if (isTerminalOrderState(current.state)) continue;

        let status = null;
        try {
          status = await ports.venue.status(venueOrderId);
        } catch {
          status = null;
        }

        if (status && (status.status === "CANCELLED" || status.status === "EXPIRED")) {
          const closed = await advance(
            current,
            status.status === "EXPIRED" ? "EXPIRED" : "CANCELLED",
            `venue reported ${status.status.toLowerCase()}`,
          );
          emit("execution.order.closed", "WARNING", closed);
          continue;
        }

        // Limit timeout handling: LIMIT_ONLY retries, LIMIT_THEN_MARKET falls
        // back to a market order, MARKET_ONLY never gets here.
        const submittedAt = runtime.submittedAtMs.get(current.id);
        const timedOut =
          submittedAt !== undefined &&
          nowMs - submittedAt >= cfg.limitTimeoutMs &&
          (current.state === "LIMIT_SUBMITTED" || current.state === "PARTIAL_FILL") &&
          current.kind === "LIMIT" &&
          current.mode !== "MARKET_ONLY";
        if (timedOut) {
          runtime.submittedAtMs.delete(current.id);
          await handleTimeout(current);
        }
      }
    },

    orders: () =>
      [...orders.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    fills: () => [...fills.values()].sort((a, b) => (a.filledAt < b.filledAt ? 1 : -1)),
    positions: () => buildPositions([...orders.values()], [...fills.values()]),
    lastRisk: () => last,
    lastSizing: () => lastSizing,
    riskRejections: () => rejections,
    intentsSeen: () => seenIntents.size,
    reset: () => {
      orders.clear();
      fills.clear();
      intents.clear();
      seenIntents.clear();
      runtime.submittedAtMs.clear();
      runtime.retryAtMs.clear();
      last = null;
      rejections = [];
      lastSizing = null;
    },
  };
}

/** Positions are derived from immutable fills, never written by hand. */
export function buildPositions(orders: OrderRecord[], fills: FillRecord[]): PositionRecord[] {
  const byOrder = new Map(orders.map((order) => [order.id, order]));
  const positions = new Map<string, PositionRecord>();

  for (const fill of [...fills].sort((a, b) => (a.filledAt < b.filledAt ? -1 : 1))) {
    const order = byOrder.get(fill.orderId);
    const key = `${fill.conditionId}:${fill.tokenId}`;
    const existing = positions.get(key);
    const signed = fill.side === "BUY" ? fill.size : -fill.size;
    if (!existing) {
      positions.set(key, {
        conditionId: fill.conditionId,
        slug: order?.slug ?? fill.conditionId,
        tokenId: fill.tokenId,
        outcome: fill.outcome,
        horizon: order?.horizon ?? "FIVE_MINUTE",
        size: signed,
        avgPrice: fill.price,
        cost: signed * fill.price,
        status: signed > 1e-9 ? "ACTIVE" : "CLOSED",
        openedAt: fill.filledAt,
        lastFillAt: fill.filledAt,
        fills: 1,
      });
      continue;
    }
    const size = existing.size + signed;
    const cost = existing.cost + signed * fill.price;
    positions.set(key, {
      ...existing,
      size,
      cost,
      avgPrice: Math.abs(size) > 1e-9 ? cost / size : existing.avgPrice,
      status: size > 1e-9 ? "ACTIVE" : "CLOSED",
      lastFillAt: fill.filledAt,
      fills: existing.fills + 1,
    });
  }

  return [...positions.values()].sort((a, b) => (a.lastFillAt < b.lastFillAt ? 1 : -1));
}