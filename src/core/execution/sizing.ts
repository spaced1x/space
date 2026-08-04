import type { SizingCap, SizingDecision } from "./types";

// The single sizing decision module.
//
// Automatic trading, manual trading and both venue adapters call this one
// function. Nothing else in SPACE is allowed to decide how large an order is,
// which is what makes a V1 size and a V2 size comparable.
//
// Pure and deterministic: same input -> same decision, always.

export interface SizingInput {
  intentId: string;
  attempt: number;
  source: "STRATEGY" | "MANUAL";
  /** Operator-requested size: the manual size, or the configured window size. */
  requestedSize: number;
  /** Sum of open position sizes, in outcome shares. */
  exposureBefore: number;
  openPositions: number;
  maxPositions: number;
  tradingEnabled: boolean;
  at: string;
}

export function decideSize(input: SizingInput): SizingDecision {
  const requested = round(Math.max(0, input.requestedSize));

  const decide = (applied: number, cap: SizingCap, reason: string): SizingDecision => ({
    intentId: input.intentId,
    attempt: input.attempt,
    source: input.source,
    requestedSize: requested,
    appliedSize: round(applied),
    cap,
    exposureBefore: round(input.exposureBefore),
    exposureAfter: round(input.exposureBefore + applied),
    reason,
    at: input.at,
  });

  if (!input.tradingEnabled) {
    return decide(0, "TRADING_DISABLED", "trading is disabled, so no size may be applied");
  }
  if (input.openPositions >= input.maxPositions) {
    return decide(
      0,
      "MAX_POSITIONS",
      `max positions reached (${input.openPositions}/${input.maxPositions})`,
    );
  }
  if (!(requested > 0)) {
    return decide(
      0,
      input.source === "MANUAL" ? "MANUAL_REQUEST" : "WINDOW_SIZE",
      "requested size is not greater than zero",
    );
  }
  return decide(
    requested,
    input.source === "MANUAL" ? "MANUAL_REQUEST" : "WINDOW_SIZE",
    input.source === "MANUAL"
      ? `manual request of ${requested} share(s) applied in full`
      : `window size of ${requested} share(s) applied in full`,
  );
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
