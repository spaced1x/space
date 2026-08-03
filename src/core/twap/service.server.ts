import { clock } from "../clock/clock.service";
import { createLogger } from "../logging/logger";
import { applySettlementSample } from "../market/state";
import type { TwapProviderStatus } from "./provider";
import {
  activeProviderId,
  getActiveProvider,
  listProviders,
  loadActiveProvider,
  providerStatuses,
} from "./registry.server";

// TWAP service.
//
// Layering: strategy, execution, replay and statistics read settlement TWAP
// through the market state the service publishes. The service is the only
// module that talks to the provider registry, and the registry is the only
// module that decides which provider is active.
//
// Binance is never a settlement fallback: if the active provider has no price,
// the TWAP engine simply receives no samples and reports its own WARMING /
// STALE / IDLE state.

const log = createLogger("twap-service");

let started = false;
let lastPublishedAtMs: number | null = null;
let published = 0;

export interface TwapServiceSnapshot {
  started: boolean;
  activeProviderId: string;
  active: TwapProviderStatus | null;
  providers: TwapProviderStatus[];
  published: number;
  lastPublishedAt: string | null;
}

export async function startTwapService(): Promise<void> {
  if (started) return;
  await loadActiveProvider();
  for (const provider of listProviders()) {
    await provider.start();
  }
  started = true;
  published = 0;
  lastPublishedAtMs = null;
  log.info("twap service started", {
    active: activeProviderId(),
    providers: listProviders().map((provider) => provider.id),
  });
}

export async function stopTwapService(): Promise<void> {
  if (!started) return;
  started = false;
  for (const provider of listProviders()) {
    await provider.stop();
  }
  log.info("twap service stopped", { published });
}

/** Scheduler step: refresh the active provider and publish any new price. */
export async function pollTwapService(): Promise<void> {
  if (!started) return;
  const provider = getActiveProvider();
  await provider.poll();
  const sample = provider.latest();
  if (!sample) return;
  if (lastPublishedAtMs !== null && sample.atMs <= lastPublishedAtMs) return;
  lastPublishedAtMs = sample.atMs;
  published += 1;
  applySettlementSample({
    providerId: provider.id,
    providerLabel: provider.label,
    price: sample.price,
    atMs: sample.atMs,
    observedAt: new Date(clock().now()).toISOString(),
    latencyMs: sample.latencyMs,
    sequence: sample.sequence,
  });
}

export function twapServiceSnapshot(): TwapServiceSnapshot {
  const statuses = providerStatuses();
  const id = activeProviderId();
  return {
    started,
    activeProviderId: id,
    active: statuses.find((status) => status.id === id) ?? null,
    providers: statuses,
    published,
    lastPublishedAt: lastPublishedAtMs === null ? null : new Date(lastPublishedAtMs).toISOString(),
  };
}