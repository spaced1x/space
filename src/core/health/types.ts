export const HEALTH_STATES = ["OK", "DEGRADED", "FAILED", "NOT_INITIALIZED"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const HEALTH_COMPONENTS = [
  "configuration",
  "database",
  "logging",
  "dashboard",
  "engine",
  "binance",
  "chainlink",
  "polymarket",
  "replay",
  "telegram",
] as const;
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

export interface HealthResult {
  state: HealthState;
  message: string;
  details?: Record<string, unknown>;
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