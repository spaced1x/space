import { registerHealthCheck } from "../health/registry";
import type { HealthResult } from "../health/types";
import { systemClock, type Clock } from "../shared/clock";

// The authoritative runtime clock. Every module that needs time takes it from
// here so tests and replay can drive deterministic time from one place.
let active: Clock = systemClock;
let startedAtMs = active.now();
let startedAtIso = active.iso();

export function clock(): Clock {
  return active;
}

export function setClock(next: Clock): void {
  active = next;
  startedAtMs = next.now();
  startedAtIso = next.iso();
}

export function uptimeMs(): number {
  return active.now() - startedAtMs;
}

// Drift between the injected clock and the host wall clock. Zero for the system
// clock; non-zero under replay or a fixed clock, which the operator must see.
export function clockDriftMs(): number {
  return active.now() - Date.now();
}

export function clockHealth(): HealthResult {
  const drift = clockDriftMs();
  const deterministic = active !== systemClock;
  return {
    state: deterministic ? "DEGRADED" : "OK",
    message: deterministic
      ? "non-system clock installed (replay or test)"
      : "system clock authoritative",
    details: {
      source: deterministic ? "injected" : "system",
      startedAt: startedAtIso,
      now: active.iso(),
      uptimeMs: uptimeMs(),
      driftMs: drift,
      timezone: "UTC",
    },
  };
}

export const clockServiceHealth = clockHealth;

export function registerClockService(): void {
  registerHealthCheck("clock", clockHealth);
}
