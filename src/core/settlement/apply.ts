import type { PositionRecord } from "../execution/types";
import type { SettlementRow } from "../db/repositories/settlement.repository";

// Pure settlement application.
//
// A binary outcome share pays exactly 1 when its outcome resolves true and 0
// otherwise. Applying a settlement is therefore a closing event: the position
// becomes CLOSED with a known settled value, which is what turns Statistics'
// realized PnL from an estimate into a fact.

export function applySettlements(
  positions: PositionRecord[],
  settlements: SettlementRow[],
): PositionRecord[] {
  const byCondition = new Map(
    settlements
      .filter((row) => row.resolved_outcome !== "UNRESOLVED")
      .map((row) => [row.condition_id, row]),
  );
  return positions.map((position) => {
    const settlement = byCondition.get(position.conditionId);
    if (!settlement) return position;
    const won = position.outcome === settlement.resolved_outcome;
    return {
      ...position,
      status: "CLOSED",
      settledValue: won ? 1 : 0,
      markPrice: won ? 1 : 0,
    };
  });
}

/** Whether a resolved outcome agrees with the direction the strategy chose. */
export function directionWasCorrect(
  direction: "UP" | "DOWN" | null,
  settlement: SettlementRow | null | undefined,
): boolean | null {
  if (!direction || !settlement || settlement.resolved_outcome === "UNRESOLVED") return null;
  return settlement.resolved_outcome === direction;
}
