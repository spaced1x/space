import { clock } from "../clock/clock.service";
import { buildPositions } from "../execution/engine";
import type { HealthResult } from "../health/types";
import { getRuntimeState } from "../state/store";
import { applySettlements } from "../settlement/apply";
import { loadLedgerDataset } from "./dataset.server";
import { computeStatistics, type StatisticsSnapshot } from "./statistics";

// Statistics reads the same persisted dataset Replay reads — never live engine
// memory, and never a fallback source. If storage is unavailable the numbers
// are reported as unavailable rather than silently diverging from Replay.

let lastError: string | null = null;

export async function statistics(): Promise<StatisticsSnapshot> {
  const runtime = getRuntimeState();
  try {
    const dataset = await loadLedgerDataset();
    lastError = null;
    return computeStatistics({
      now: clock().iso(),
      sessionStartedAt: runtime.sessionStartedAt,
      orders: dataset.orders,
      fills: dataset.fills,
      // Settled positions carry their venue-resolved value, so realized PnL is
      // ground truth rather than a mark against cost.
      positions: applySettlements(
        buildPositions(dataset.orders, dataset.fills),
        dataset.settlements,
      ),
      intents: dataset.intents,
      risk: dataset.risk,
      orderTransitions: dataset.orderTransitions,
      positionTransitions: dataset.positionTransitions,
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return computeStatistics({
      now: clock().iso(),
      sessionStartedAt: runtime.sessionStartedAt,
      orders: [],
      fills: [],
      positions: [],
      intents: [],
      risk: [],
    });
  }
}

export function statisticsHealth(): HealthResult {
  if (lastError) {
    return {
      state: "DEGRADED",
      message: `statistics unavailable — persisted dataset could not be read: ${lastError}`,
      details: { lastError },
    };
  }
  return {
    state: "OK",
    message: "statistics computed from the same persisted dataset Replay reads",
    details: {},
  };
}
