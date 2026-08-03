import { clock } from "../clock/clock.service";
import { executionRepository } from "../db/repositories/execution.repository";
import { replayRepository } from "../db/repositories/replay.repository";
import { settlementRepository } from "../db/repositories/settlement.repository";
import { strategyRepository } from "../db/repositories/strategy.repository";
import { executionSnapshot } from "../execution/execution.server";
import type { RiskDecision } from "../execution/types";
import { buildPositions } from "../execution/engine";
import type { HealthResult } from "../health/types";
import { getRuntimeState } from "../state/store";
import { applySettlements } from "../settlement/apply";
import type { ExecutionIntent } from "../strategy/types";
import { computeStatistics, type StatisticsSnapshot } from "./statistics";

// Statistics reads persisted evidence first and falls back to the live
// execution snapshot when storage is unavailable (preview sandbox). It never
// keeps counters of its own, so a restart cannot drift from the database.

let lastError: string | null = null;

export async function statistics(): Promise<StatisticsSnapshot> {
  const runtime = getRuntimeState();
  const live = executionSnapshot();
  try {
    const [orders, fills, intentRows, riskRows, settlements] = await Promise.all([
      executionRepository.loadOrders(1000),
      executionRepository.loadFills(2000),
      strategyRepository.recentIntents(1000),
      replayRepository.allRisk(2000),
      settlementRepository.recent(1000),
    ]);
    lastError = null;
    const risk: RiskDecision[] = riskRows.map((row) => ({
      status: row.status as RiskDecision["status"],
      code: row.code as RiskDecision["code"],
      reason: row.reason,
      intentId: row.intent_id,
      at: row.occurred_at,
    }));
    return computeStatistics({
      now: clock().iso(),
      sessionStartedAt: runtime.sessionStartedAt,
      orders: orders.length ? orders : live.orders,
      fills: fills.length ? fills : live.fills,
      // Settled positions carry their venue-resolved value, so realized PnL is
      // ground truth rather than a mark against cost.
      positions: applySettlements(
        orders.length ? buildPositions(orders, fills) : live.positions,
        settlements,
      ),
      intents: intentRows as ExecutionIntent[],
      risk: risk.length ? risk : live.riskRejections,
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return computeStatistics({
      now: clock().iso(),
      sessionStartedAt: runtime.sessionStartedAt,
      orders: live.orders,
      fills: live.fills,
      positions: live.positions,
      intents: [],
      risk: live.riskRejections,
    });
  }
}

export function statisticsHealth(): HealthResult {
  if (lastError) {
    return {
      state: "DEGRADED",
      message: `statistics fell back to runtime data: ${lastError}`,
      details: { lastError },
    };
  }
  return { state: "OK", message: "statistics computed from persisted evidence", details: {} };
}
