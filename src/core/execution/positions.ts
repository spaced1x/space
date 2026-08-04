import type {
  FillRecord,
  OrderRecord,
  PositionTransitionKind,
  PositionTransitionRecord,
} from "./types";

// Position lifecycle derivation.
//
// SPACE has no mutable positions table. `fills` is the canonical execution
// record and the current position is derived from it. This module derives the
// *lifecycle* of that position so the history can be persisted append-only.
//
// The derivation is pure and ordered by fill time, so replaying the same fills
// after a restart regenerates a byte-identical ledger.

export function derivePositionTransitions(
  orders: OrderRecord[],
  fills: FillRecord[],
): PositionTransitionRecord[] {
  void orders;
  const state = new Map<string, { size: number; cost: number; peak: number; opened: boolean }>();
  const rows: PositionTransitionRecord[] = [];

  const ordered = [...fills].sort((a, b) =>
    a.filledAt === b.filledAt ? a.id.localeCompare(b.id) : a.filledAt < b.filledAt ? -1 : 1,
  );

  for (const fill of ordered) {
    const key = `${fill.conditionId}:${fill.tokenId}`;
    const before = state.get(key) ?? { size: 0, cost: 0, peak: 0, opened: false };
    const signed = fill.side === "BUY" ? fill.size : -fill.size;
    const size = round(before.size + signed);
    const cost = round(before.cost + signed * fill.price);
    const peak = Math.max(before.peak, size);
    const avgPrice = Math.abs(size) > 1e-9 ? round(cost / size) : 0;

    const transitions: PositionTransitionKind[] = [];
    if (!before.opened) {
      transitions.push("OPENING", "OPENED");
    } else if (signed > 0) {
      transitions.push("INCREASING");
    } else if (signed < 0) {
      transitions.push(size <= 1e-9 ? "CLOSED" : "REDUCING");
    }
    if (before.opened && signed < 0 && size > 1e-9 && size < peak) {
      transitions.push("PARTIALLY_CLOSED");
    }

    for (const transition of transitions) {
      rows.push({
        positionKey: key,
        conditionId: fill.conditionId,
        tokenId: fill.tokenId,
        outcome: fill.outcome,
        transition,
        size,
        avgPrice,
        cost,
        fillId: fill.id,
        at: fill.filledAt,
      });
    }

    state.set(key, { size, cost, peak, opened: true });
  }

  return rows;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
