import { executionRepository } from "../db/repositories/execution.repository";
import { replayRepository } from "../db/repositories/replay.repository";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import type { MarketHorizon } from "../market/types";
import { assembleReplay } from "./replay";
import type { ReplayMarket, ReplayMarketSummary } from "./types";

// Runtime host for Replay. It reads persisted rows and hands them to the pure
// assembler. It holds no state of its own and never consults the live engine.

const log = createLogger("replay");

let lastError: string | null = null;
let reconstructions = 0;

export async function listReplayMarkets(limit = 25): Promise<ReplayMarketSummary[]> {
  try {
    const [discoveries, conditions, orders, fills] = await Promise.all([
      replayRepository.discoveries(limit),
      replayRepository.windowConditions(limit),
      executionRepository.loadOrders(500),
      executionRepository.loadFills(1000),
    ]);
    lastError = null;

    const byCondition = new Map<string, ReplayMarketSummary>();
    for (const row of discoveries) {
      byCondition.set(row.condition_id, {
        conditionId: row.condition_id,
        slug: row.slug,
        horizon: row.horizon as MarketHorizon,
        question: row.question,
        status: row.status,
        ptb: row.ptb,
        settlementAt: row.settlement_at,
        discoveredAt: row.discovered_at,
        windows: 0,
        triggers: 0,
        intents: 0,
        orders: 0,
        fills: 0,
      });
    }
    for (const row of conditions) {
      const existing = byCondition.get(row.condition_id);
      if (existing) {
        existing.windows = row.windows;
        continue;
      }
      byCondition.set(row.condition_id, {
        conditionId: row.condition_id,
        slug: row.slug,
        horizon: row.horizon as MarketHorizon,
        question: "",
        status: "UNKNOWN",
        ptb: null,
        settlementAt: null,
        discoveredAt: row.opens_at,
        windows: row.windows,
        triggers: 0,
        intents: 0,
        orders: 0,
        fills: 0,
      });
    }
    for (const order of orders) {
      const entry = byCondition.get(order.conditionId);
      if (entry) entry.orders += 1;
    }
    for (const fill of fills) {
      const entry = byCondition.get(fill.conditionId);
      if (entry) entry.fills += 1;
    }

    return [...byCondition.values()]
      .sort((a, b) =>
        String(b.settlementAt ?? b.discoveredAt ?? "").localeCompare(
          String(a.settlementAt ?? a.discoveredAt ?? ""),
        ),
      )
      .slice(0, limit);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    log.warn("replay listing unavailable", { reason: lastError });
    return [];
  }
}

export async function replayMarket(conditionId: string): Promise<ReplayMarket | null> {
  try {
    const [discovery, windows, frozen, transitions, intents, risk, orderEvents, allOrders, allFills] =
      await Promise.all([
        replayRepository.discovery(conditionId),
        replayRepository.windows(conditionId),
        replayRepository.frozen(conditionId),
        replayRepository.transitions(conditionId),
        replayRepository.intents(conditionId),
        replayRepository.risk(conditionId),
        replayRepository.orderEvents(conditionId),
        executionRepository.loadOrders(500),
        executionRepository.loadFills(1000),
      ]);

    if (!discovery && windows.length === 0) return null;

    reconstructions += 1;
    lastError = null;
    return assembleReplay({
      conditionId,
      discovery,
      windows,
      frozen,
      transitions,
      intents,
      risk,
      orders: allOrders.filter((order) => order.conditionId === conditionId),
      orderEvents,
      fills: allFills.filter((fill) => fill.conditionId === conditionId),
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    log.warn("replay reconstruction failed", { conditionId, reason: lastError });
    return null;
  }
}

export function replayHealth(): HealthResult {
  const details = { reconstructions, lastError };
  if (lastError) {
    return { state: "DEGRADED", message: `replay storage unavailable: ${lastError}`, details };
  }
  return { state: "OK", message: "replay reconstructs from persisted evidence", details };
}
