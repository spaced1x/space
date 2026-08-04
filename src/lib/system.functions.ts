import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { bootTimes, getBootState, getBootTrace } from "../core/boot.server";
import { dispatchCommand } from "../core/bus/command-bus.server";
import { commandSchema } from "../core/bus/commands";
import { eventBus } from "../core/bus/events";
import { collectHealth } from "../core/health/registry";
import { backupRepository } from "../core/db/repositories/backup.repository";
import { telegramRepository } from "../core/db/repositories/telegram.repository";
import { metricsRepository } from "../core/db/repositories/metrics.repository";
import { snapshotRepository } from "../core/db/repositories/snapshot.repository";
import { releaseRepository } from "../core/db/repositories/release.repository";
import { engineRuntimeSnapshot } from "../core/engine/loop.server";
import { getRuntimeState } from "../core/state/store";
import { runStartupValidation } from "../core/startup/validation.server";
import { generateReleaseReport } from "../core/release/report.server";
import {
  connectionTimeline,
  environmentLabel,
  environmentResolution,
  listConnections,
} from "../core/runtime/connections.server";
import { syncConnections } from "../core/runtime/connection-sync.server";
import { databaseHealth } from "../core/db/database.server";
import {
  activeEnvironment,
  otherEnvironment,
  peekEnvironment,
} from "../core/runtime/peek.server";
import { lastResourceAudit, resourceAuditHistory } from "../core/runtime/resources.server";
import { pipelineSnapshot } from "../core/runtime/pipeline.server";
import { readRuntimeTarget } from "../core/runtime/target.server";
import { systemClock } from "../core/shared/clock";
import type { HealthReport } from "../core/health/types";

// Single read surface: Mission Control, Overview and Statistics all subscribe
// to this one snapshot so no two panels can disagree. It always carries both
// runtimes: `active` is live telemetry from this process, `inactive` is a
// read-only peek into the other environment's own database.
/**
 * Frozen runtime snapshot contract. Every operator page reads this shape and
 * nothing else. Bump `SNAPSHOT_VERSION` only alongside a documented change.
 */
export const SNAPSHOT_VERSION = 2;

let snapshotSequence = 0;

async function safeAsync<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`snapshot subsystem ${label} failed:`, error);
    return fallback;
  }
}

const notStartedHealth: HealthReport = {
  state: "NOT_INITIALIZED",
  checkedAt: new Date().toISOString(),
  components: [],
};

export const getSystemSnapshot = createServerFn({ method: "GET" }).handler(async () => {
  // The runtime boots independently of the dashboard. A snapshot read never
  // triggers a boot; it reports whatever state currently exists.
  const bootState = getBootState();

  // Refresh every connection from its live adapter before answering, so no two
  // panels can disagree and nothing is ever a stale guess.
  await safeAsync("syncConnections", () => syncConnections(), undefined);

  const db = await safeAsync("databaseHealth", () => databaseHealth(), {
    state: "NOT_INITIALIZED" as const,
    message: "database health not available",
    details: { engine: "sqlite", journalMode: "WAL", walEnabled: null },
  });
  const times = bootTimes();
  const environment = activeEnvironment();
  const inactive = await safeAsync(
    "peekEnvironment",
    () => peekEnvironment(otherEnvironment(environment)),
    null,
  );
  const metrics = await safeAsync(
    "metrics",
    async () => ({ latest: await metricsRepository.latest(), history: await metricsRepository.recent(100) }),
    { latest: null, history: [] },
  );
  const validation = await safeAsync("validation", () => runStartupValidation(), {
    valid: false,
    blockers: ["startup validation unavailable"],
    at: systemClock.iso(),
    items: [],
  });
  const active = {
    runtime: getRuntimeState(),
    health: await safeAsync("collectHealth", () => collectHealth(), notStartedHealth),
    events: eventBus.recent(12),
    engine: engineRuntimeSnapshot(),
    pipeline: await safeAsync("pipeline", async () => pipelineSnapshot(), {
      stages: [],
      blockedAt: null,
      lifecycles: {
        order: "NONE" as const,
        position: "WAITING" as const,
        twap: "PROVIDER_SELECTED" as const,
        venue: "DISCONNECTED" as const,
      },
    }),
    environment: environmentLabel(),
    connections: listConnections(),
    timeline: connectionTimeline(),
    envResolution: environmentResolution(),
    resourceAudit: lastResourceAudit(),
    resourceAudits: resourceAuditHistory().slice(-10).reverse(),
    metrics,
    validation,
    boot: {
      trace: getBootTrace(),
      startedAt: times.startedAt,
      completedAt: times.completedAt,
      state: bootState,
    },
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      bootTime: times.completedAt ?? times.startedAt,
      buildVersion: process.env["SPACE_BUILD_VERSION"] ?? "1.0.0",
      gitCommit: process.env["SPACE_GIT_COMMIT"] ?? "unknown",
      schemaVersion:
        ((db.details as { schemaVersion?: number | null } | undefined)?.schemaVersion ?? null),
    },
  };
  const generatedAt = systemClock.iso();
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    sequence: ++snapshotSequence,
    generatedAt,
    serverNow: systemClock.now(),
    activeEnvironment: environment,
    target: readRuntimeTarget(),
    active,
    inactive,
    // Flattened for the panels that only ever render the live runtime.
    ...active,
  };
});

export const sendCommand = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => commandSchema.parse(data))
  .handler(async ({ data }) => {
    return dispatchCommand(data, { actor: "operator", source: "dashboard" });
  });

export const getBackups = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await backupRepository.recent(20);
  } catch {
    return [];
  }
});

export const getTelegramOutbox = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await telegramRepository.recent(20);
  } catch {
    return [];
  }
});

const telegramBroadcastSchema = z.object({ message: z.string().min(1).max(4000) });

export const sendTelegramBroadcast = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => telegramBroadcastSchema.parse(data))
  .handler(async ({ data }) => {
    return dispatchCommand(
      { kind: "TELEGRAM_BROADCAST", message: data.message },
      { actor: "operator", source: "dashboard" },
    );
  });

export const getTelegramInbound = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await telegramRepository.recentInbound(20);
  } catch {
    return [];
  }
});

export const getRuntimeMetrics = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return {
      latest: await metricsRepository.latest(),
      history: await metricsRepository.recent(100),
    };
  } catch {
    return { latest: null, history: [] };
  }
});

export const getConfigSnapshots = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await snapshotRepository.recent(20);
  } catch {
    return [];
  }
});

export const getStartupValidation = createServerFn({ method: "GET" }).handler(async () => {
  return runStartupValidation();
});

export const getReleaseArtifact = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await releaseRepository.latest();
  } catch {
    return null;
  }
});

const releaseReportSchema = z.object({ version: z.string().min(1) });

export const runReleaseGate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => releaseReportSchema.parse(data))
  .handler(async ({ data }) => {
    return generateReleaseReport(data.version);
  });
