import { eventBus } from "../bus/events";
import { databaseResources } from "../db/database.server";
import { lockResources } from "../db/lock.server";
import { engineResources } from "../engine/loop.server";
import { clobMarketResources } from "../market/clob-ws.server";
import { schedulerResources, schedulerStatus } from "../scheduler/scheduler.server";
import { systemClock } from "../shared/clock";
import { telegramInboundResources } from "../telegram/inbound.server";
import { telegramForwardingResources } from "../telegram/telegram.service";
import { twapResources } from "../twap/service.server";
import { listConnections } from "../runtime/connections.server";

// Long-running stability instrumentation.
//
// The runtime must prove — continuously, in production, not only in a harness —
// that it is not leaking. Every number below is measured from the module that
// owns the resource. Nothing here is estimated and nothing is simulated.

export interface StabilitySample {
  at: string;
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  cpuUserSeconds: number;
  cpuSystemSeconds: number;
}

export interface StabilityCounts {
  timers: number;
  sockets: number;
  databaseHandles: number;
  locks: number;
  eventListeners: number;
  wildcardListeners: number;
  schedulerTasks: number;
  schedulers: number;
  engineLoops: number;
}

export interface StabilityVerdict {
  state: "OK" | "WARN" | "FAIL";
  findings: string[];
}

export interface StabilityReport {
  sample: StabilitySample;
  counts: StabilityCounts;
  /** Heap growth measured against the first sample of this process, per hour. */
  heapGrowthBytesPerHour: number | null;
  rssGrowthBytesPerHour: number | null;
  /** Count deltas against the first sample, which is what a leak looks like. */
  countDrift: Partial<Record<keyof StabilityCounts, number>>;
  scheduler: {
    ticks: number;
    maxTickDriftMs: number | null;
    overlaps: number;
    duplicateRegistrations: number;
    maxJitterMs: number | null;
    missedRuns: number;
  };
  snapshots: {
    generated: number;
    lastDurationMs: number | null;
    p50DurationMs: number | null;
    p95DurationMs: number | null;
  };
  reconnects: { connection: string; reconnects: number; disconnects: number }[];
  totalReconnects: number;
  samples: number;
  verdict: StabilityVerdict;
}

// Thresholds are deliberately generous: they must not fire on normal steady
// state, and must fire long before a VPS runs out of memory.
const HEAP_WARN_BYTES_PER_HOUR = 24 * 1024 * 1024;
const HEAP_FAIL_BYTES_PER_HOUR = 96 * 1024 * 1024;

const history: StabilitySample[] = [];
const HISTORY_LIMIT = 2880; // 24h at one sample per 30s.
let baseline: { sample: StabilitySample; counts: StabilityCounts } | null = null;

const snapshotDurations: number[] = [];
const SNAPSHOT_DURATION_LIMIT = 500;
let snapshotsGenerated = 0;

/** Called by the snapshot server function once per generated snapshot. */
export function recordSnapshotGeneration(durationMs: number): void {
  snapshotsGenerated += 1;
  snapshotDurations.push(durationMs);
  if (snapshotDurations.length > SNAPSHOT_DURATION_LIMIT) snapshotDurations.shift();
}

/** Forget every measurement. Used by teardown so a new runtime starts clean. */
export function resetStability(): void {
  history.length = 0;
  snapshotDurations.length = 0;
  snapshotsGenerated = 0;
  baseline = null;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[index] ?? 0);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function countRuntimeResources(): StabilityCounts {
  const scheduler = safe(schedulerResources, { schedulers: 0, timers: 0, tasks: 0, taskNames: [] });
  const engine = safe(engineResources, { loops: 0, binanceFeeds: 0, chainlinkFeeds: 0 });
  const db = safe(databaseResources, { connections: 0, path: null as string | null });
  const lock = safe(lockResources, { locks: 0, path: null as string | null });
  const twap = safe(twapResources, {
    services: 0,
    providers: 0,
    connected: 0,
    rtdsSockets: 0,
  });
  const clob = safe(clobMarketResources, { sockets: 0 });
  const inbound = safe(telegramInboundResources, { pollers: 0, timers: 0 });
  const forwarding = safe(telegramForwardingResources, { forwarders: 0 });
  const bus = safe(() => eventBus.stats(), { types: 0, handlers: 0, wildcard: 0 });

  return {
    timers: scheduler.timers + inbound.timers,
    sockets: engine.binanceFeeds + engine.chainlinkFeeds + clob.sockets + twap.rtdsSockets,
    databaseHandles: db.connections,
    locks: lock.locks,
    eventListeners: bus.handlers,
    wildcardListeners: bus.wildcard,
    schedulerTasks: scheduler.tasks,
    schedulers: scheduler.schedulers,
    engineLoops: engine.loops,
  };
}

function captureSample(): StabilitySample {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    at: systemClock.iso(),
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    cpuUserSeconds: Math.round((cpu.user / 1e6) * 100) / 100,
    cpuSystemSeconds: Math.round((cpu.system / 1e6) * 100) / 100,
  };
}

function perHour(first: number, last: number, elapsedMs: number): number | null {
  if (elapsedMs < 60_000) return null;
  return Math.round(((last - first) / elapsedMs) * 3_600_000);
}

/**
 * Take one stability measurement and grade it. Called by the scheduler task and
 * by the soak harness; both paths use exactly this code.
 */
export function measureStability(): StabilityReport {
  const sample = captureSample();
  const counts = countRuntimeResources();

  history.push(sample);
  if (history.length > HISTORY_LIMIT) history.shift();
  if (!baseline) baseline = { sample, counts };

  const elapsedMs = Date.parse(sample.at) - Date.parse(baseline.sample.at);
  const heapGrowth = perHour(baseline.sample.heapUsedBytes, sample.heapUsedBytes, elapsedMs);
  const rssGrowth = perHour(baseline.sample.rssBytes, sample.rssBytes, elapsedMs);

  const countDrift: Partial<Record<keyof StabilityCounts, number>> = {};
  for (const key of Object.keys(counts) as (keyof StabilityCounts)[]) {
    const delta = counts[key] - baseline.counts[key];
    if (delta !== 0) countDrift[key] = delta;
  }

  const status = safe<ReturnType<typeof schedulerStatus> | null>(schedulerStatus, null);

  const findings: string[] = [];
  let state: StabilityVerdict["state"] = "OK";

  // Duplication is never acceptable, at any growth rate.
  const duplicated: (keyof StabilityCounts)[] = [
    "schedulers",
    "engineLoops",
    "databaseHandles",
    "locks",
  ];
  for (const key of duplicated) {
    if (counts[key] > 1) {
      findings.push(`${key}: ${counts[key]} live, exactly one is allowed`);
      state = "FAIL";
    }
  }
  for (const [key, delta] of Object.entries(countDrift)) {
    if ((delta ?? 0) > 0) {
      findings.push(`${key} grew by ${delta} since the first measurement`);
      if (state !== "FAIL") state = "WARN";
    }
  }
  if (heapGrowth !== null && heapGrowth > HEAP_FAIL_BYTES_PER_HOUR) {
    findings.push(`heap growing ${(heapGrowth / 1024 / 1024).toFixed(1)} MB/hour`);
    state = "FAIL";
  } else if (heapGrowth !== null && heapGrowth > HEAP_WARN_BYTES_PER_HOUR) {
    findings.push(`heap growing ${(heapGrowth / 1024 / 1024).toFixed(1)} MB/hour`);
    if (state !== "FAIL") state = "WARN";
  }

  const connections = safe(listConnections, []);
  const reconnects = connections
    .filter((entry) => entry.reconnects > 0 || entry.disconnectedCount > 0)
    .map((entry) => ({
      connection: entry.label,
      reconnects: entry.reconnects,
      disconnects: entry.disconnectedCount,
    }));

  return {
    sample,
    counts,
    heapGrowthBytesPerHour: heapGrowth,
    rssGrowthBytesPerHour: rssGrowth,
    countDrift,
    scheduler: {
      ticks: status?.ticks ?? 0,
      maxTickDriftMs: status?.maxTickDriftMs ?? null,
      overlaps: status?.overlaps ?? 0,
      duplicateRegistrations: status?.duplicateRegistrations ?? 0,
      maxJitterMs: status
        ? status.tasks.reduce((max, task) => Math.max(max, task.maxJitterMs ?? 0), 0)
        : null,
      missedRuns: status ? status.tasks.reduce((sum, task) => sum + (task.missedRuns ?? 0), 0) : 0,
    },
    snapshots: {
      generated: snapshotsGenerated,
      lastDurationMs: snapshotDurations.at(-1) ?? null,
      p50DurationMs: percentile(snapshotDurations, 50),
      p95DurationMs: percentile(snapshotDurations, 95),
    },
    reconnects,
    totalReconnects: reconnects.reduce((sum, entry) => sum + entry.reconnects, 0),
    samples: history.length,
    verdict: { state, findings },
  };
}

export function stabilityHistory(limit = 120): StabilitySample[] {
  return history.slice(-limit);
}
