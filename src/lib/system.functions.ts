import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { boot, bootTimes, getBootTrace } from "../core/boot.server";
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

// Single read surface: Mission Control, Overview and Statistics all subscribe
// to this one snapshot so no two panels can disagree.
export const getSystemSnapshot = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  // Refresh every connection from its live adapter before answering, so no two
  // panels can disagree and nothing is ever a stale guess.
  await syncConnections();
  const db = await databaseHealth();
  const times = bootTimes();
  return {
    runtime: getRuntimeState(),
    health: await collectHealth(),
    events: eventBus.recent(12),
    engine: engineRuntimeSnapshot(),
    environment: environmentLabel(),
    connections: listConnections(),
    timeline: connectionTimeline(),
    envResolution: environmentResolution(),
    boot: {
      trace: getBootTrace(),
      startedAt: times.startedAt,
      completedAt: times.completedAt,
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
});

export const sendCommand = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => commandSchema.parse(data))
  .handler(async ({ data }) => {
    await boot();
    return dispatchCommand(data, { actor: "operator", source: "dashboard" });
  });

export const getBackups = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return backupRepository.recent(20);
});

export const getTelegramOutbox = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return telegramRepository.recent(20);
});

const telegramBroadcastSchema = z.object({ message: z.string().min(1).max(4000) });

export const sendTelegramBroadcast = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => telegramBroadcastSchema.parse(data))
  .handler(async ({ data }) => {
    await boot();
    return dispatchCommand(
      { kind: "TELEGRAM_BROADCAST", message: data.message },
      { actor: "operator", source: "dashboard" },
    );
  });

export const getTelegramInbound = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return telegramRepository.recentInbound(20);
});

export const getRuntimeMetrics = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return {
    latest: await metricsRepository.latest(),
    history: await metricsRepository.recent(100),
  };
});

export const getConfigSnapshots = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return snapshotRepository.recent(20);
});

export const getStartupValidation = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return runStartupValidation();
});

export const getReleaseArtifact = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return releaseRepository.latest();
});

const releaseReportSchema = z.object({ version: z.string().min(1) });

export const runReleaseGate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => releaseReportSchema.parse(data))
  .handler(async ({ data }) => {
    await boot();
    return generateReleaseReport(data.version);
  });
