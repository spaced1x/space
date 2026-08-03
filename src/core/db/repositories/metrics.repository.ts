import { systemClock } from "../../shared/clock";
import { requireDriver } from "../database.server";

export interface RuntimeMetricsRecord {
  id: number;
  sampled_at: string;
  memory_rss_mb: number | null;
  memory_heap_mb: number | null;
  cpu_user_seconds: number | null;
  cpu_system_seconds: number | null;
  scheduler_drift_ms: number | null;
  scheduler_ticks: number | null;
  db_size_bytes: number | null;
  feed_reconnects: number;
  venue_errors: number;
}

export interface RuntimeMetricsSample {
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

export const metricsRepository = {
  async insert(sample: RuntimeMetricsSample): Promise<number> {
    const driver = await requireDriver();
    const result = driver.run(
      `INSERT INTO runtime_metrics
       (sampled_at, memory_rss_mb, memory_heap_mb, cpu_user_seconds, cpu_system_seconds,
        scheduler_drift_ms, scheduler_ticks, db_size_bytes, feed_reconnects, venue_errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        systemClock.iso(),
        sample.memoryRssMb,
        sample.memoryHeapMb,
        sample.cpuUserSeconds,
        sample.cpuSystemSeconds,
        sample.schedulerDriftMs,
        sample.schedulerTicks,
        sample.dbSizeBytes,
        sample.feedReconnects,
        sample.venueErrors,
      ],
    );
    return Number(result.lastInsertRowid);
  },

  async recent(limit = 100): Promise<RuntimeMetricsRecord[]> {
    const driver = await requireDriver();
    return driver.all<RuntimeMetricsRecord>(
      `SELECT id, sampled_at, memory_rss_mb, memory_heap_mb, cpu_user_seconds, cpu_system_seconds,
              scheduler_drift_ms, scheduler_ticks, db_size_bytes, feed_reconnects, venue_errors
       FROM runtime_metrics
       ORDER BY id DESC
       LIMIT ?`,
      [limit],
    );
  },

  async latest(): Promise<RuntimeMetricsRecord | null> {
    const rows = await this.recent(1);
    return rows[0] ?? null;
  },
};
