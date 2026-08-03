import type { BotPrediction, TwapReading, WindowRecord } from "./types";

// Bot Prediction — advisory only.
//
// This module is a projection of engine state for the operator's eyes. It is
// deliberately not imported by the trigger engine, the window engine or the
// intent builder, so it is structurally incapable of influencing execution.

export function buildPrediction(
  twap: TwapReading,
  ptb: number | null,
  activeWindow: WindowRecord | null,
  /** Optional previous TWAP reading, used only to describe the trend. */
  previousTwap: number | null = null,
): BotPrediction {
  const settlementTwap = twap.value;
  const frozen = activeWindow?.frozen ?? null;
  const buffer = activeWindow?.buffer ?? null;

  const trend: BotPrediction["trend"] =
    settlementTwap === null || previousTwap === null
      ? null
      : settlementTwap > previousTwap
        ? "RISING"
        : settlementTwap < previousTwap
          ? "FALLING"
          : "FLAT";

  if (settlementTwap === null || ptb === null) {
    return {
      direction: frozen?.direction ?? null,
      settlementTwap,
      ptb,
      difference: null,
      buffer,
      frozenTrigger: frozen?.frozenTrigger ?? null,
      suggestion: "NONE",
      note: settlementTwap === null ? "settlement TWAP unavailable" : "no validated PTB",
      confidence: null,
      trend,
    };
  }

  const difference = settlementTwap - ptb;
  const suggestion = difference >= 0 ? "UP" : "DOWN";
  return {
    direction: frozen?.direction ?? suggestion,
    settlementTwap,
    ptb,
    difference,
    buffer,
    frozenTrigger: frozen?.frozenTrigger ?? null,
    suggestion,
    note: frozen
      ? "advisory view; the active window trades its frozen trigger"
      : "advisory view; no window is open",
    confidence:
      buffer && buffer > 0 ? Math.min(1, Math.abs(difference) / buffer) : difference === 0 ? 0 : 1,
    trend,
  };
}
