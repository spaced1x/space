import { executionRepository } from "../db/repositories/execution.repository";
import { replayRepository } from "../db/repositories/replay.repository";
import { settlementRepository } from "../db/repositories/settlement.repository";
import { strategyRepository } from "../db/repositories/strategy.repository";
import type {
  FillRecord,
  OrderRecord,
  OrderTransitionRecord,
  PositionTransitionRecord,
  RiskDecision,
} from "../execution/types";
import type { SettlementRow } from "../db/repositories/settlement.repository";
import type { ExecutionIntent } from "../strategy/types";
import { clock } from "../clock/clock.service";

// The single persisted dataset. Replay and Statistics both read this and
// nothing else, so the two screens can never disagree: same rows, same
// derivation, same numbers. Nothing here reads live engine memory.

export interface LedgerDataset {
  loadedAt: string;
  orders: OrderRecord[];
  fills: FillRecord[];
  intents: ExecutionIntent[];
  risk: RiskDecision[];
  settlements: SettlementRow[];
  orderTransitions: OrderTransitionRecord[];
  positionTransitions: PositionTransitionRecord[];
}

const LIMITS = {
  orders: 1000,
  fills: 2000,
  intents: 1000,
  risk: 2000,
  settlements: 1000,
  transitions: 2000,
} as const;

// A short cache keeps Replay and Statistics on byte-identical rows when both
// are open, without holding derived state anywhere.
const CACHE_MS = 1_000;
let cached: LedgerDataset | null = null;
let cachedAtMs = 0;

export async function loadLedgerDataset(force = false): Promise<LedgerDataset> {
  const now = clock().now();
  if (!force && cached && now - cachedAtMs < CACHE_MS) return cached;

  const [orders, fills, intentRows, riskRows, settlements, orderTransitions, positionTransitions] =
    await Promise.all([
      executionRepository.loadOrders(LIMITS.orders),
      executionRepository.loadFills(LIMITS.fills),
      strategyRepository.recentIntents(LIMITS.intents),
      replayRepository.allRisk(LIMITS.risk),
      settlementRepository.recent(LIMITS.settlements),
      executionRepository.loadOrderTransitions(LIMITS.transitions),
      executionRepository.loadPositionTransitions(LIMITS.transitions),
    ]);

  cached = {
    loadedAt: clock().iso(),
    orders,
    fills,
    intents: intentRows as ExecutionIntent[],
    risk: riskRows.map((row) => ({
      status: row.status as RiskDecision["status"],
      code: row.code as RiskDecision["code"],
      reason: row.reason,
      intentId: row.intent_id,
      at: row.occurred_at,
    })),
    settlements,
    orderTransitions,
    positionTransitions,
  };
  cachedAtMs = now;
  return cached;
}

/** Teardown seam: an environment switch must not carry rows across databases. */
export function invalidateLedgerDataset(): void {
  cached = null;
  cachedAtMs = 0;
}
