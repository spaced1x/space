import { databaseHealth } from "../db/database.server";
import { metricsRepository } from "../db/repositories/metrics.repository";
import { createLogger } from "../logging/logger";
import { schedulerStatus } from "../scheduler/scheduler.server";
import { systemClock } from "../shared/clock";

// Production runtime metrics.
//
// Samples process health every 30 seconds and persists it to SQLite. This gives
// the operator objective evidence for the release gate: memory growth, CPU burn,
// scheduler drift, feed reconnects and venue errors over a 24-hour soak test.

const log = createLogger("runtime-metrics");

let feedReconnects = 0;
let venueErrors = 0;

export function recordFeedReconnect(): void {
  feedReconnects += 1;
}

export function recordVenueError(): void {
  venueErrors += 1;
}

export interface MetricsSnapshot {
  sampledAt: string;
  memoryRssMb: number | null;
  memoryHeapMb: number | null;
  cpuUserSeconds: number | null;
  cpuSystemSeconds: number | null;
  schedulerDriftMs: number | null;
  schedulerTicks: number | null;
  dbSizeBytes: number | null;
  feedReconnects: number;
  venueErrors: number;
}

export function captureMetricsSnapshot(): MetricsSnapshot {
  const usage = process.memoryUsage();
  const cpu = process.cpuUsage();
  const scheduler = schedulerStatus();
  return {
    sampledAt: systemClock.iso(),
    memoryRssMb: Math.round((usage.rss / 1024 / 1024) * 100) / 100,
    memoryHeapMb: Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100,
    cpuUserSeconds: Math.round((cpu.user / 1e6) * 100) / 100,
    cpuSystemSeconds: Math.round((cpu.system / 1e6) * 100) / 100,
    schedulerDriftMs: scheduler.maxTickDriftMs,
    schedulerTicks: scheduler.ticks,
    dbSizeBytes: null,
    feedReconnects,
    venueErrors,
  };
}

export async function sampleAndPersistMetrics(): Promise<MetricsSnapshot> {
  const snapshot = captureMetricsSnapshot();
  try {
    const db = await databaseHealth();
    snapshot.dbSizeBytes = db.details?.["sizeBytes"] ? Number(db.details["sizeBytes"]) : null;
    await metricsRepository.insert({
      memoryRssMb: snapshot.memoryRssMb,
      memoryHeapMb: snapshot.memoryHeapMb,
      cpuUserSeconds: snapshot.cpuUserSeconds,
      cpuSystemSeconds: snapshot.cpuSystemSeconds,
      schedulerDriftMs: snapshot.schedulerDriftMs,
      schedulerTicks: snapshot.schedulerTicks,
      dbSizeBytes: snapshot.dbSizeBytes,
      feedReconnects: snapshot.feedReconnects,
      venueErrors: snapshot.venueErrors,
    });
    log.debug("runtime metrics sampled", { sample: { ...snapshot } });
  } catch (error) {
    log.warn("runtime metrics sample failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return snapshot;
}

export async function latestMetrics(): Promise<MetricsSnapshot | null> {
  const record = await metricsRepository.latest();
  if (!record) return null;
  return {
    sampledAt: record.sampled_at,
    memoryRssMb: record.memory_rss_mb,
    memoryHeapMb: record.memory_heap_mb,
    cpuUserSeconds: record.cpu_user_seconds,
    cpuSystemSeconds: record.cpu_system_seconds,
    schedulerDriftMs: record.scheduler_drift_ms,
    schedulerTicks: record.scheduler_ticks,
    dbSizeBytes: record.db_size_bytes,
    feedReconnects: record.feed_reconnects,
    venueErrors: record.venue_errors,
  };
}

export async function metricsHistory(limit = 100): Promise<MetricsSnapshot[]> {
  const records = await metricsRepository.recent(limit);
  return records.map((record) => ({
    sampledAt: record.sampled_at,
    memoryRssMb: record.memory_rss_mb,
    memoryHeapMb: record.memory_heap_mb,
    cpuUserSeconds: record.cpu_user_seconds,
    cpuSystemSeconds: record.cpu_system_seconds,
    schedulerDriftMs: record.scheduler_drift_ms,
    schedulerTicks: record.scheduler_ticks,
    dbSizeBytes: record.db_size_bytes,
    feedReconnects: record.feed_reconnects,
    venueErrors: record.venue_errors,
  }));
}
