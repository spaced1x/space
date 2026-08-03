import type { DiscoveredMarket } from "../market/types";
import type { Direction, ExecutionIntent } from "../strategy/types";

// Manual Trading intent builder.
//
// Manual mode is architecturally isolated but shares one thing with strategy:
// the execution path. A manual order is still an immutable Execution Intent,
// still passes the Risk Engine and still runs through the Execution Engine.
// The `manual:` id prefix keeps manual evidence distinguishable in Replay.

export interface ManualIntentInput {
  market: DiscoveredMarket;
  direction: Direction;
  settlementTwap: number | null;
  ptb: number | null;
  at: string;
  id: string;
}

export function isManualIntent(intentId: string): boolean {
  return intentId.startsWith("manual:");
}

export function buildManualIntent(input: ManualIntentInput): ExecutionIntent {
  const ptb = input.ptb ?? input.market.ptb ?? 0;
  const twap = input.settlementTwap ?? ptb;
  return Object.freeze({
    id: `manual:${input.id}`,
    createdAt: input.at,
    conditionId: input.market.conditionId,
    slug: input.market.slug,
    horizon: input.market.horizon,
    // Manual orders belong to no execution window; 0 marks them as such.
    windowSeconds: 0,
    direction: input.direction,
    openingTwap: twap,
    settlementTwap: twap,
    ptb,
    buffer: 0,
    frozenTrigger: ptb,
    triggerTime: input.at,
    reason: `manual ${input.direction} order issued by the operator`,
  });
}
