import type { FillRecord, OrderRecord, OrderTransitionRecord } from "../execution/types";
import { derivePositionTransitions } from "../execution/positions";
import type { MarketHorizon } from "../market/types";
import type { Direction, WindowState } from "../strategy/types";
import type {
  DiscoveryRow,
  FrozenRow,
  IntentRow,
  OrderEventRow,
  RiskRow,
  TransitionRow,
  WindowRow,
} from "../db/repositories/replay.repository";
import type { SettlementRow } from "../db/repositories/settlement.repository";
import { directionWasCorrect } from "../settlement/apply";
import type { ReplayMarket, ReplayWindow } from "./types";

// Pure Replay assembler.
//
// Input: rows exactly as persisted. Output: one fully explained market.
// No clock, no network, no runtime state — so the same rows always produce the
// same explanation, which is the entire point of Replay.

export interface ReplayInput {
  conditionId: string;
  discovery: DiscoveryRow | undefined;
  windows: WindowRow[];
  frozen: FrozenRow[];
  transitions: TransitionRow[];
  intents: IntentRow[];
  risk: RiskRow[];
  orders: OrderRecord[];
  orderEvents: OrderEventRow[];
  /** Persisted order lifecycle ledger for this market. */
  orderTransitions?: OrderTransitionRecord[];
  fills: FillRecord[];
  settlement?: SettlementRow | null;
}

/** Human explanation for every window outcome. Replay's core promise. */
export function explainWindow(window: ReplayWindow): string {
  switch (window.state) {
    case "WAITING":
      return `window never opened; scheduled for ${window.opensAt}`;
    case "OPEN":
    case "ACTIVE":
      return `window was live at ${window.seconds}s with frozen trigger ${
        window.frozenTrigger ?? "—"
      }`;
    case "WINDOW_DISABLED":
      return `${window.seconds}s window was disabled by the operator, so no trigger was possible`;
    case "QUOTA_EXHAUSTED":
      return "trades per market was already consumed before this window opened";
    case "NO_TRIGGER":
      return window.frozenTrigger === null
        ? `no frozen trigger was captured: ${window.reason}`
        : `settlement TWAP never crossed the frozen trigger ${window.frozenTrigger} (${window.direction ?? "—"})`;
    case "TRIGGERED":
    case "COMPLETED": {
      if (!window.intent) return `window triggered but produced no intent: ${window.reason}`;
      const rejected = window.risk.find((decision) => decision.status === "REJECTED");
      if (rejected) return `intent rejected by the Risk Engine — ${rejected.code}: ${rejected.reason}`;
      if (!window.order) return "intent approved but no order chain was opened";
      if (window.order.state === "FILLED") {
        return `filled ${window.order.filledSize} @ ${window.order.avgPrice ?? "—"} (${window.order.kind})`;
      }
      if (window.fills.length > 0) {
        return `partially filled ${window.order.filledSize}/${window.order.size} — ${window.order.state}`;
      }
      return `order ended ${window.order.state}: ${window.order.reason}`;
    }
    case "EXPIRED":
      return `window expired at ${window.expiresAt} without a trigger`;
    default:
      return window.reason;
  }
}

export function assembleReplay(input: ReplayInput): ReplayMarket {
  const frozenByWindow = new Map(input.frozen.map((row) => [row.window_id, row]));
  const intentById = new Map(input.intents.map((row) => [row.id, row]));
  const ordersByIntent = new Map(input.orders.map((order) => [order.intentId, order]));
  const fillsByOrder = new Map<string, FillRecord[]>();
  for (const fill of input.fills) {
    fillsByOrder.set(fill.orderId, [...(fillsByOrder.get(fill.orderId) ?? []), fill]);
  }
  const eventsByOrder = new Map<string, OrderEventRow[]>();
  for (const event of input.orderEvents) {
    eventsByOrder.set(event.order_id, [...(eventsByOrder.get(event.order_id) ?? []), event]);
  }
  const transitionsByOrder = new Map<string, OrderTransitionRecord[]>();
  for (const transition of input.orderTransitions ?? []) {
    transitionsByOrder.set(transition.orderId, [
      ...(transitionsByOrder.get(transition.orderId) ?? []),
      transition,
    ]);
  }
  const riskByIntent = new Map<string, RiskRow[]>();
  for (const decision of input.risk) {
    riskByIntent.set(decision.intent_id, [...(riskByIntent.get(decision.intent_id) ?? []), decision]);
  }
  const transitionsByWindow = new Map<string, TransitionRow[]>();
  for (const transition of input.transitions) {
    transitionsByWindow.set(transition.window_id, [
      ...(transitionsByWindow.get(transition.window_id) ?? []),
      transition,
    ]);
  }

  const windows: ReplayWindow[] = input.windows
    .slice()
    .sort((a, b) => b.seconds - a.seconds)
    .map((row) => {
      const frozen = frozenByWindow.get(row.id) ?? null;
      const intentRow = row.intent_id ? (intentById.get(row.intent_id) ?? null) : null;
      const order = intentRow ? (ordersByIntent.get(intentRow.id) ?? null) : null;
      const fills = order ? (fillsByOrder.get(order.id) ?? []) : [];
      const risk = intentRow ? (riskByIntent.get(intentRow.id) ?? []) : [];

      const window: ReplayWindow = {
        id: row.id,
        seconds: row.seconds,
        buffer: row.buffer,
        enabled: row.enabled === 1,
        opensAt: row.opens_at,
        expiresAt: row.expires_at,
        state: row.state as WindowState,
        reason: row.reason,
        openingTwap: frozen?.opening_twap ?? null,
        ptb: frozen?.ptb ?? intentRow?.ptb ?? null,
        direction: (frozen?.direction ?? intentRow?.direction ?? null) as Direction | null,
        frozenTrigger: frozen?.frozen_trigger ?? intentRow?.frozen_trigger ?? null,
        triggeredAt: row.triggered_at,
        settlementTwapAtTrigger: row.settlement_twap_at_trigger,
        triggerReason: row.reason,
        transitions: (transitionsByWindow.get(row.id) ?? []).map((transition) => ({
          at: transition.occurred_at,
          state: transition.state as WindowState,
          reason: transition.reason,
        })),
        intent: intentRow
          ? {
              id: intentRow.id,
              createdAt: intentRow.created_at,
              direction: intentRow.direction as Direction,
              openingTwap: intentRow.opening_twap,
              settlementTwap: intentRow.settlement_twap,
              ptb: intentRow.ptb,
              buffer: intentRow.buffer,
              frozenTrigger: intentRow.frozen_trigger,
              triggerTime: intentRow.trigger_time,
              reason: intentRow.reason,
            }
          : null,
        risk: risk.map((decision) => ({
          status: decision.status as "APPROVED" | "REJECTED",
          code: decision.code as never,
          reason: decision.reason,
          intentId: decision.intent_id,
          at: decision.occurred_at,
        })),
        order,
        orderEvents: (order ? (eventsByOrder.get(order.id) ?? []) : []).map((event) => ({
          at: event.occurred_at,
          state: event.state,
          reason: event.reason,
          attempt: event.attempt,
        })),
        orderTransitions: order ? (transitionsByOrder.get(order.id) ?? []) : [],
        fills: fills.map((fill) => ({
          id: fill.id,
          size: fill.size,
          price: fill.price,
          at: fill.filledAt,
          source: fill.source,
        })),
        outcome: "",
      };
      window.outcome = explainWindow(window);
      return window;
    });

  const first = input.windows[0];
  const filledSize = input.fills.reduce((sum, fill) => sum + fill.size, 0);
  const cost = input.fills.reduce((sum, fill) => sum + fill.size * fill.price, 0);
  const settlement = input.settlement ?? null;
  const resolved = settlement && settlement.resolved_outcome !== "UNRESOLVED";
  // A winning share settles at 1, a losing share at 0. Reconstructed from the
  // persisted fills and the venue outcome only.
  const settledValue = resolved
    ? input.fills.reduce(
        (sum, fill) => sum + (fill.outcome === settlement.resolved_outcome ? fill.size : 0),
        0,
      )
    : null;
  const tradedDirection =
    (input.intents[0]?.direction as "UP" | "DOWN" | undefined) ?? null;

  return {
    market: {
      conditionId: input.conditionId,
      slug: input.discovery?.slug ?? first?.slug ?? input.conditionId,
      horizon: (input.discovery?.horizon ?? first?.horizon ?? "FIVE_MINUTE") as MarketHorizon,
      question: input.discovery?.question ?? "",
      status: input.discovery?.status ?? "UNKNOWN",
      ptb: input.discovery?.ptb ?? null,
      settlementAt: input.discovery?.settlement_at ?? first?.expires_at ?? null,
      discoveredAt: input.discovery?.discovered_at ?? null,
      windows: windows.length,
      triggers: input.frozen.length,
      intents: input.intents.length,
      orders: input.orders.length,
      fills: input.fills.length,
    },
    discovery: input.discovery
      ? {
          conditionId: input.discovery.condition_id,
          slug: input.discovery.slug,
          question: input.discovery.question,
          status: input.discovery.status,
          ptb: input.discovery.ptb,
          closeAt: input.discovery.close_at,
          settlementAt: input.discovery.settlement_at,
          upTokenId: input.discovery.up_token_id,
          downTokenId: input.discovery.down_token_id,
          discoveredAt: input.discovery.discovered_at,
        }
      : null,
    settlement: {
      settlementAt: input.discovery?.settlement_at ?? first?.expires_at ?? null,
      status: input.discovery?.status ?? "UNKNOWN",
      filledSize,
      cost,
      avgPrice: filledSize > 0 ? cost / filledSize : null,
      resolvedOutcome: settlement?.resolved_outcome ?? null,
      directionCorrect: directionWasCorrect(tradedDirection, settlement),
      settledValue,
      realizedPnl: settledValue === null ? null : settledValue - cost,
      note:
        input.fills.length === 0
          ? resolved
            ? `market resolved ${settlement.resolved_outcome} with no fills on this market`
            : "no fills on this market"
          : resolved
            ? `${input.fills.length} fill(s) settled against venue outcome ${settlement.resolved_outcome}`
            : `${input.fills.length} fill(s) reconstructed from immutable venue trade ids; settlement not yet ingested`,
    },
    windows,
    // Positions are never stored: the ledger is re-derived from the same
    // immutable fills every time, so Replay and the runtime always agree.
    positionTransitions: derivePositionTransitions(input.orders, input.fills),
  };
}
