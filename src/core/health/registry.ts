import { systemClock } from "../shared/clock";
import type { HealthComponent, HealthEntry, HealthReport, HealthResult, HealthState } from "./types";
import { HEALTH_COMPONENTS } from "./types";

export type HealthCheck = () => HealthResult | Promise<HealthResult>;

const checks = new Map<HealthComponent, HealthCheck>();

export function registerHealthCheck(component: HealthComponent, check: HealthCheck): void {
  checks.set(component, check);
}

export function clearHealthChecks(): void {
  checks.clear();
}

const RANK: Record<HealthState, number> = { OK: 0, NOT_INITIALIZED: 1, DEGRADED: 2, FAILED: 3 };

// A component that has no check yet is NOT_INITIALIZED, never silently OK.
export async function collectHealth(): Promise<HealthReport> {
  const checkedAt = systemClock.iso();
  const components: HealthEntry[] = [];

  for (const component of HEALTH_COMPONENTS) {
    const check = checks.get(component);
    if (!check) {
      components.push({
        component,
        checkedAt,
        state: "NOT_INITIALIZED",
        message: "module not implemented yet",
      });
      continue;
    }
    try {
      const result = await check();
      components.push({ component, checkedAt, ...result });
    } catch (error) {
      components.push({
        component,
        checkedAt,
        state: "FAILED",
        message: error instanceof Error ? error.message : "health check threw",
      });
    }
  }

  // Overall state ignores NOT_INITIALIZED modules that are simply not built yet;
  // it is FAILED/DEGRADED only when an implemented dependency is unhealthy.
  const worst = components
    .filter((entry) => entry.state !== "NOT_INITIALIZED")
    .reduce<HealthState>((acc, entry) => (RANK[entry.state] > RANK[acc] ? entry.state : acc), "OK");

  return { state: worst, checkedAt, components };
}