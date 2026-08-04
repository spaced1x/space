import { describeEnvReadiness, loadEnv } from "../config/env.server";
import { unknownEnvKeys } from "../config/manifest";
import { activeOperations, operationsHealth } from "../config/operations.server";
import { evaluateEnvironmentConformance } from "../config/environment.server";
import { databaseHealth } from "../db/database.server";
import { instanceLockHeld } from "../db/lock.server";
import { executionRecoveryStatus } from "../execution/execution.server";
import { collectHealth } from "../health/registry";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import { getRuntimeState } from "../state/store";
import { systemClock } from "../shared/clock";

// Startup / Pre-ARM validation gate.
//
// Before the engine may ARM, every critical dependency must prove it is ready.
// This gate is called by the command bus for ARM and by the dashboard for the
// pre-arm readout. It is intentionally separate from normal health polling so
// the operator sees one consolidated verdict instead of scattered checks.

const log = createLogger("startup-validation");

export interface ValidationItem {
  name: string;
  required: boolean;
  state: HealthResult["state"];
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  at: string;
  items: ValidationItem[];
  blockers: string[];
}

export async function runStartupValidation(): Promise<ValidationReport> {
  const env = loadEnv();
  const readiness = describeEnvReadiness();
  const db = await databaseHealth();
  const ops = operationsHealth();
  const runtime = getRuntimeState();
  const recovery = executionRecoveryStatus();
  // Re-evaluated on every gate run: RPC, wallet, chain id and database stamp
  // must still agree with SPACE_ENVIRONMENT at the moment of ARM.
  const conformance = await evaluateEnvironmentConformance();

  const items: ValidationItem[] = [
    {
      name: "instance_lock",
      required: true,
      state: instanceLockHeld() ? "OK" : "FAILED",
      message: instanceLockHeld()
        ? "single-instance lock held"
        : "single-instance lock not acquired",
    },
    {
      name: "environment",
      required: true,
      state: readiness.valid ? (readiness.missingForArmed.length ? "DEGRADED" : "OK") : "FAILED",
      message: readiness.message,
    },
    {
      name: "environment_conformance",
      required: true,
      state: conformance.conformant
        ? conformance.checks.some((check) => check.state === "DEGRADED")
          ? "DEGRADED"
          : "OK"
        : "FAILED",
      message: conformance.conformant
        ? conformance.checks
            .filter((check) => check.state === "DEGRADED")
            .map((check) => `${check.name}: ${check.message}`)
            .join("; ") || `all seven environment facts agree (${conformance.environment})`
        : conformance.failures.join("; "),
    },
    {
      name: "database",
      required: true,
      state: db.state,
      message: db.message,
    },
    {
      name: "operations_config",
      required: true,
      state: ops.state,
      message: ops.message,
    },
    {
      name: "execution_recovery",
      required: true,
      state: recovery
        ? recovery.state === "FAILED"
          ? "FAILED"
          : recovery.state === "DIVERGENCE"
            ? "DEGRADED"
            : "OK"
        : "NOT_INITIALIZED",
      message: recovery ? recovery.message : "execution recovery has not run yet",
    },
    {
      name: "emergency_stop",
      required: true,
      state: runtime.emergencyStop ? "FAILED" : "OK",
      message: runtime.emergencyStop
        ? `emergency stop is latched: ${runtime.emergencyStopReason}`
        : "emergency stop not latched",
    },
  ];

  // Advisory, never an ARM blocker: a misspelled variable silently falls back
  // to its default, so the operator has to be told rather than stopped.
  const unknown = unknownEnvKeys(process.env);
  items.push({
    name: "configuration_manifest",
    required: false,
    state: unknown.length ? "DEGRADED" : "OK",
    message: unknown.length
      ? `unrecognised variable(s), ignored by SPACE: ${unknown.join(", ")}`
      : "every SPACE variable in the environment is declared in the manifest",
  });

  // Add live health for venue-dependent components only when credentials exist.
  const health = await collectHealth();
  for (const component of ["wallet", "polymarket", "binance", "chainlink"] as const) {
    const entry = health.components.find((c) => c.component === component);
    if (!entry) continue;
    items.push({
      name: component,
      required: component === "wallet" || component === "polymarket",
      state: entry.state,
      message: entry.message,
    });
  }

  const blockers = items
    .filter(
      (item) => item.required && (item.state === "FAILED" || item.state === "NOT_INITIALIZED"),
    )
    .map((item) => `${item.name}: ${item.message}`);

  // DEGRADED on a required item is a blocker for ARM.
  for (const item of items.filter((i) => i.required && i.state === "DEGRADED")) {
    blockers.push(`${item.name}: ${item.message}`);
  }

  const report: ValidationReport = {
    valid: blockers.length === 0,
    at: systemClock.iso(),
    items,
    blockers,
  };

  log.info("startup validation completed", { valid: report.valid, blockers: blockers.length });
  lastReport = report;
  return report;
}

let lastReport: ValidationReport | null = null;

/** Most recent validation report, for runtime telemetry. Null before the first run. */
export function lastValidationReport(): ValidationReport | null {
  return lastReport;
}

export function preArmReadiness(): { ready: boolean; reason: string } {
  const runtime = getRuntimeState();
  if (runtime.emergencyStop) {
    return { ready: false, reason: `emergency stop latched: ${runtime.emergencyStopReason}` };
  }
  if (runtime.lifecycle === "RUNNING") return { ready: false, reason: "engine is already RUNNING" };
  if (runtime.lifecycle === "READY") return { ready: true, reason: "ready for validation" };
  return { ready: false, reason: `engine must be READY to arm, currently ${runtime.lifecycle}` };
}
