import type { RiskDecision, SizingDecision } from "./types";

// Paper / Live parity.
//
// V1 (paper) and V2 (live) run the same strategy, risk and sizing code; only
// the execution adapter differs. This module defines the decision tuple both
// environments must agree on and compares two recorded tuples field by field.
//
// A parity failure is an operator diagnostic. It is recorded and surfaced, and
// it never modifies trading behaviour.

export interface ParityTuple {
  discoveredMarket: string | null;
  selectedMarket: string | null;
  windowSeconds: number;
  direction: string | null;
  ptb: number | null;
  confidence: number | null;
  settlementTwap: number | null;
  trigger: number | null;
  riskStatus: RiskDecision["status"] | null;
  riskCode: RiskDecision["code"] | null;
  sizingApplied: number | null;
  sizingCap: SizingDecision["cap"] | null;
  intentId: string | null;
}

export interface ParityDifference {
  field: keyof ParityTuple;
  v1: string;
  v2: string;
}

export const PARITY_FIELDS: (keyof ParityTuple)[] = [
  "discoveredMarket",
  "selectedMarket",
  "windowSeconds",
  "direction",
  "ptb",
  "confidence",
  "settlementTwap",
  "trigger",
  "riskStatus",
  "riskCode",
  "sizingApplied",
  "sizingCap",
];

/** Compare two recorded tuples. The intent id is environment-local and excluded. */
export function compareParity(v1: ParityTuple, v2: ParityTuple): ParityDifference[] {
  const differences: ParityDifference[] = [];
  for (const field of PARITY_FIELDS) {
    const left = normalise(v1[field]);
    const right = normalise(v2[field]);
    if (left !== right) differences.push({ field, v1: left, v2: right });
  }
  return differences;
}

function normalise(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(Math.round(value * 1e6) / 1e6);
  return String(value);
}
