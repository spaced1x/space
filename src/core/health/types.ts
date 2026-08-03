// DISABLED is deliberately distinct from NOT_INITIALIZED: a disabled module is
// implemented and healthy but switched off by the operator, while
// NOT_INITIALIZED means the module does not exist yet in this milestone.
export const HEALTH_STATES = ["OK", "DEGRADED", "FAILED", "DISABLED", "NOT_INITIALIZED"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const HEALTH_COMPONENTS = [
  "configuration",
  "clock",
  "database",
  "logging",
  "dashboard",
  "engine",
  "scheduler",
  "market_discovery",
  "settlement_twap",
  "strategy",
  "window_5m",
  "window_15m",
  "binance",
  "chainlink",
  "polymarket",
  "wallet",
  "risk",
  "execution",
  "replay",
  "telegram",
] as const;
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

import type { JsonObject } from "../shared/json";

export interface HealthResult {
  state: HealthState;
  message: string;
  details?: JsonObject;
}

// Reserved diagnostic shape for the database component. Fields are optional so
// the interface is stable now and can be filled in as capabilities land.
export interface DatabaseDiagnostics extends JsonObject {
  engine?: string;
  path?: string;
  journalMode?: string;
  walEnabled?: boolean | null;
  schemaVersion?: number | null;
  migrationVersion?: number | null;
  appliedMigrations?: number[];
  latencyMs?: number | null;
  sizeBytes?: number | null;
  openedAt?: string;
}

export interface HealthEntry extends HealthResult {
  component: HealthComponent;
  checkedAt: string;
}

export interface HealthReport {
  state: HealthState;
  checkedAt: string;
  components: HealthEntry[];
}
