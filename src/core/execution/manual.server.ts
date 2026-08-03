import { clock } from "../clock/clock.service";
import { activeOperations } from "../config/operations.server";
import { createLogger } from "../logging/logger";
import { getMarketState } from "../market/state";
import type { MarketHorizon } from "../market/types";
import { correlationId as newId } from "../shared/ids";
import { getRuntimeState } from "../state/store";
import { strategySnapshot } from "../strategy/strategy.server";
import type { Direction } from "../strategy/types";
import { submitManualIntent } from "./execution.server";
import { buildManualIntent } from "./manual";
import type { OrderKind, OrderRecord, RiskDecision } from "./types";

// Runtime host for Manual Trading.
//
// It builds an intent and hands it to the Execution Engine. It contains no
// order logic, no pricing and no risk logic of its own.

const log = createLogger("manual");

export interface ManualDesk {
  enabled: boolean;
  mode: string;
  horizon: MarketHorizon;
  market: {
    conditionId: string;
    slug: string;
    question: string;
    status: string;
    closeAt: string | null;
  } | null;
  ptb: number | null;
  settlementTwap: number | null;
  difference: number | null;
  buffer: number | null;
  frozenTrigger: number | null;
  direction: Direction | null;
  suggestedDirection: Direction | null;
  confidence: number | null;
  trend: string | null;
}

export function manualDesk(horizon: MarketHorizon = "FIVE_MINUTE"): ManualDesk {
  const ops = activeOperations();
  const runtime = getRuntimeState();
  const market = getMarketState().markets[horizon] ?? null;
  const strategy = strategySnapshot();
  const twap = strategy.twap.value;
  const ptb = market?.ptb ?? null;
  const prediction = strategy.prediction;

  return {
    enabled: ops.manualEnabled && runtime.mode === "MANUAL",
    mode: runtime.mode,
    horizon,
    market: market
      ? {
          conditionId: market.conditionId,
          slug: market.slug,
          question: market.question,
          status: market.status,
          closeAt: market.closeAt,
        }
      : null,
    ptb,
    settlementTwap: twap,
    difference: twap != null && ptb != null ? twap - ptb : null,
    buffer: prediction?.buffer ?? null,
    frozenTrigger: prediction?.frozenTrigger ?? null,
    direction: prediction?.direction ?? null,
    suggestedDirection: prediction?.direction ?? null,
    confidence: prediction?.confidence ?? null,
    trend: prediction?.trend ?? null,
  };
}

export interface ManualOrderRequest {
  horizon: MarketHorizon;
  direction: Direction;
  kind: OrderKind;
  size: number;
}

export interface ManualOrderResult {
  status: "ACCEPTED" | "REJECTED";
  reason: string;
  order: OrderRecord | null;
  risk: RiskDecision | null;
}

export async function placeManualOrder(request: ManualOrderRequest): Promise<ManualOrderResult> {
  const ops = activeOperations();
  const runtime = getRuntimeState();

  if (!ops.manualEnabled) {
    return { status: "REJECTED", reason: "manual trading is disabled", order: null, risk: null };
  }
  if (runtime.mode !== "MANUAL") {
    return { status: "REJECTED", reason: "engine is not in MANUAL mode", order: null, risk: null };
  }
  const market = getMarketState().markets[request.horizon];
  if (!market) {
    return { status: "REJECTED", reason: "no active market for this horizon", order: null, risk: null };
  }
  if (!(request.size > 0)) {
    return { status: "REJECTED", reason: "size must be greater than zero", order: null, risk: null };
  }

  const intent = buildManualIntent({
    market,
    direction: request.direction,
    settlementTwap: strategySnapshot().twap.value,
    ptb: market.ptb,
    at: clock().iso(),
    id: newId("man"),
  });

  const order = await submitManualIntent(intent, {
    size: request.size,
    mode: request.kind === "MARKET" ? "MARKET_ONLY" : "LIMIT_ONLY",
  });

  log.info("manual order submitted", {
    intentId: intent.id,
    direction: request.direction,
    kind: request.kind,
    accepted: Boolean(order),
  });

  const { lastRiskDecision } = await import("./execution.server");
  const risk = lastRiskDecision();
  return order
    ? { status: "ACCEPTED", reason: `manual ${request.direction} ${request.kind} submitted`, order, risk }
    : {
        status: "REJECTED",
        reason: risk ? `${risk.code}: ${risk.reason}` : "rejected by the Risk Engine",
        order: null,
        risk,
      };
}
