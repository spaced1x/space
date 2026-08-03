import { loadEnv } from "../config/env.server";
import { activeOperations } from "../config/operations.server";
import { collectHealth } from "../health/registry";
import { createLogger } from "../logging/logger";
import { getRuntimeState } from "../state/store";
import { runStartupValidation } from "../startup/validation.server";
import { systemClock } from "../shared/clock";
import { latestMetrics } from "../metrics/metrics.server";
import { releaseRepository } from "../db/repositories/release.repository";

// Production release report.
//
// Generated at the end of the v1.0 release gate. The report captures the exact
// environment, health, validation, metrics and configuration that existed when
// the gate was run. It is written to disk and recorded in the release_artifacts
// table for deterministic rollback.

const log = createLogger("release-report");

export interface ReleaseReport {
  version: string;
  generatedAt: string;
  environment: {
    spaceEnvironment: string;
    nodeEnv: string;
    nodeVersion: string;
    platform: string;
    dbPath: string;
  };
  runtime: ReturnType<typeof getRuntimeState>;
  operations: ReturnType<typeof activeOperations>;
  health: Awaited<ReturnType<typeof collectHealth>>;
  validation: Awaited<ReturnType<typeof runStartupValidation>>;
  metrics: Awaited<ReturnType<typeof latestMetrics>>;
  gate: {
    passed: boolean;
    checklist: Record<string, boolean>;
    failures: string[];
  };
}

export interface ReleaseGateResult {
  passed: boolean;
  report: ReleaseReport;
  path: string;
}

const RELEASE_DIR = "docs/releases/v1.0.0";

export async function generateReleaseReport(version: string): Promise<ReleaseGateResult> {
  const env = loadEnv();
  const runtime = getRuntimeState();
  const operations = activeOperations();
  const health = await collectHealth();
  const validation = await runStartupValidation();
  const metrics = await latestMetrics();

  const checklist: Record<string, boolean> = {
    env_valid: validation.valid,
    health_ok: health.state === "OK" || health.state === "DISABLED",
    db_ok: health.components.find((c) => c.component === "database")?.state === "OK",
    scheduler_ok: health.components.find((c) => c.component === "scheduler")?.state === "OK",
    no_emergency_stop: !runtime.emergencyStop,
    not_armed: runtime.lifecycle !== "RUNNING",
    metrics_sampled: metrics !== null,
  };

  const failures = Object.entries(checklist)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  const passed = failures.length === 0;

  const report: ReleaseReport = {
    version,
    generatedAt: systemClock.iso(),
    environment: {
      spaceEnvironment: env.SPACE_ENVIRONMENT,
      nodeEnv: env.NODE_ENV,
      nodeVersion: process.version,
      platform: process.platform,
      dbPath: env.DB_PATH,
    },
    runtime,
    operations,
    health,
    validation,
    metrics,
    gate: { passed, checklist, failures },
  };

  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.resolve(RELEASE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, `release-report-${version}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  await releaseRepository.insert({
    version,
    gatePassed: passed,
    reportPath,
    reason: passed ? "Release gate passed" : `Failures: ${failures.join(", ")}`,
  });

  log.info("release report generated", { version, passed, path: reportPath });
  return { passed, report, path: reportPath };
}

export async function latestReleaseArtifact() {
  return releaseRepository.latest();
}

export async function recordRollback(version: string, reason: string): Promise<void> {
  await releaseRepository.recordRollback(version, reason);
  log.warn("rollback recorded", { version, reason });
}
