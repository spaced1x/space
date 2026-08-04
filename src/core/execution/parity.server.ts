import { parityRepository } from "../db/repositories/parity.repository";
import { clock } from "../clock/clock.service";
import { createLogger } from "../logging/logger";
import { activeEnvironment, databasePathFor, otherEnvironment } from "../runtime/peek.server";
import { strategySnapshot } from "../strategy/strategy.server";
import { compareParity, type ParityDifference, type ParityTuple } from "./parity";
import { executionSnapshot } from "./execution.server";
import { getMarketState } from "../market/state";

// Paper / Live parity recording and comparison.
//
// Every completed strategy evaluation records the tuple both environments must
// agree on, stamped with the environment that produced it. Whenever both
// environments have evaluated the same market window, the tuples are compared
// and any difference is persisted as a parity failure. Parity never modifies
// trading behaviour: it is operator diagnostics only.

const log = createLogger("parity");
const COMPARE_INTERVAL_MS = 30_000;

export interface ParityStatus {
  environment: string;
  comparedAt: string | null;
  comparablePairs: number;
  divergentPairs: number;
  failures: {
    conditionId: string;
    windowSeconds: number;
    field: string;
    v1: string;
    v2: string;
    at: string;
  }[];
  message: string;
}

let status: ParityStatus = {
  environment: activeEnvironment(),
  comparedAt: null,
  comparablePairs: 0,
  divergentPairs: 0,
  failures: [],
  message: "no parity comparison has run yet",
};
let lastCompareMs = 0;

/** Build the tuple from the runtime's own values. Nothing here is synthesised. */
export function currentParityTuple(): {
  tuple: ParityTuple;
  conditionId: string;
  windowSeconds: number;
} | null {
  const strategy = strategySnapshot();
  const execution = executionSnapshot();
  const conditionId = strategy.market.conditionId;
  if (!conditionId) return null;
  const window =
    strategy.windows.find((entry) => entry.id === strategy.activeWindowId) ??
    strategy.windows.at(-1);
  if (!window) return null;

  const tuple: ParityTuple = {
    discoveredMarket:
      (strategy.market.horizon ? getMarketState().markets[strategy.market.horizon]?.slug : null) ??
      strategy.market.slug,
    selectedMarket: strategy.market.slug ?? conditionId,
    windowSeconds: window.seconds,
    direction: strategy.prediction.direction,
    ptb: strategy.market.ptb,
    confidence: strategy.prediction.confidence,
    settlementTwap: strategy.prediction.settlementTwap,
    trigger: window.frozen?.frozenTrigger ?? strategy.prediction.frozenTrigger,
    riskStatus: execution.lastRisk?.status ?? null,
    riskCode: execution.lastRisk?.code ?? null,
    sizingApplied: execution.lastSizing?.appliedSize ?? null,
    sizingCap: execution.lastSizing?.cap ?? null,
    intentId: window.intentId,
  };
  return { tuple, conditionId, windowSeconds: window.seconds };
}

export async function recordParityDecision(): Promise<void> {
  const current = currentParityTuple();
  if (!current) return;
  try {
    await parityRepository.record({
      environment: activeEnvironment(),
      conditionId: current.conditionId,
      windowSeconds: current.windowSeconds,
      intentId: current.tuple.intentId,
      tuple: current.tuple,
      at: clock().iso(),
    });
  } catch (error) {
    log.warn("parity decision not recorded", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Compare this environment's decisions against the other environment's. */
export async function compareEnvironments(force = false): Promise<ParityStatus> {
  const now = clock().now();
  if (!force && now - lastCompareMs < COMPARE_INTERVAL_MS) return status;
  lastCompareMs = now;

  const active = activeEnvironment();
  const other = otherEnvironment(active);
  try {
    const [local, foreign] = await Promise.all([
      parityRepository.local(200),
      parityRepository.foreign(databasePathFor(other), 200),
    ]);
    const byKey = new Map(foreign.map((row) => [`${row.conditionId}:${row.windowSeconds}`, row]));

    let comparable = 0;
    let divergent = 0;
    const at = clock().iso();
    for (const row of local) {
      const match = byKey.get(`${row.conditionId}:${row.windowSeconds}`);
      if (!match) continue;
      comparable += 1;
      const v1 = active === "V1_TESTNET" ? row.tuple : match.tuple;
      const v2 = active === "V1_TESTNET" ? match.tuple : row.tuple;
      const differences: ParityDifference[] = compareParity(v1, v2);
      if (!differences.length) continue;
      divergent += 1;
      await parityRepository.recordFailures(row.conditionId, row.windowSeconds, differences, at);
    }

    status = {
      environment: active,
      comparedAt: at,
      comparablePairs: comparable,
      divergentPairs: divergent,
      failures: await parityRepository.failures(25),
      message: comparable
        ? divergent
          ? `${divergent} of ${comparable} comparable window(s) diverge between V1 and V2`
          : `${comparable} comparable window(s) agree between V1 and V2`
        : `no window has been evaluated by both environments yet (${other} has no matching record)`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn("parity comparison unavailable", { reason });
    status = { ...status, message: `parity comparison unavailable: ${reason}` };
  }
  return status;
}

export function parityStatus(): ParityStatus {
  return status;
}
