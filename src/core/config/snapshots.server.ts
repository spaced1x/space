import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";
import { snapshotRepository } from "../db/repositories/snapshot.repository";
import { activeOperations } from "./operations.server";
import type { OperationsConfig } from "./operations";

// Configuration snapshots.
//
// Every time the active configuration changes in a way that can affect trading
// (ARM command, manual mode toggle, or explicit promotion), a snapshot of the
// active operations document is persisted. This makes every trade explainable:
// the operator can see exactly which windows, buffers, sizes and order mode were
// live when an intent was generated or a manual order was submitted.

const log = createLogger("config-snapshots");

export interface ConfigSnapshot {
  id: string;
  version: number;
  activeAt: string;
  reason: string;
  correlationId: string;
  config: OperationsConfig;
}

let lastSnapshot: ConfigSnapshot | null = null;

/** Persist a snapshot of the currently active operations configuration. */
export async function snapshotActiveConfig(
  reason: string,
  correlationId: string,
): Promise<ConfigSnapshot> {
  const config = activeOperations();
  const id = `${config.version}:${Date.now()}`;
  const activeAt = systemClock.iso();
  const snapshot: ConfigSnapshot = {
    id,
    version: config.version,
    activeAt,
    reason,
    correlationId,
    config,
  };

  try {
    await snapshotRepository.insert(id, config.version, activeAt, reason, correlationId, config);
    lastSnapshot = snapshot;
    log.info("configuration snapshot persisted", { id, version: config.version, reason });
  } catch (error) {
    log.warn("configuration snapshot failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return snapshot;
}

/** Load the most recent snapshot, or null if none exists. */
export async function latestConfigSnapshot(): Promise<ConfigSnapshot | null> {
  if (lastSnapshot) return lastSnapshot;
  try {
    const record = await snapshotRepository.latest();
    if (!record) return null;
    return {
      id: record.id,
      version: record.version,
      activeAt: record.active_at,
      reason: record.reason,
      correlationId: record.correlation_id,
      config: JSON.parse(record.document) as OperationsConfig,
    };
  } catch (error) {
    log.warn("latest configuration snapshot unavailable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Called whenever the active configuration is promoted by the engine. */
export function recordPromotionSnapshot(reason: string, correlationId: string): void {
  void snapshotActiveConfig(reason, correlationId);
}
