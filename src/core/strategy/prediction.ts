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
): BotPrediction {
  const settlementTwap = twap.value;
  const frozen = activeWindow?.frozen ?? null;
  const buffer = activeWindow?.buffer ?? null;

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
  };
}
