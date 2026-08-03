import { eventBus } from "../bus/events";
import { kvRepository } from "../db/repositories/kv.repository";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import type { MarketState } from "../market/types";
import { systemClock } from "../shared/clock";
import {
  applyOperationsPatch,
  DEFAULT_OPERATIONS_CONFIG,
  lockOperations,
  operationsPatchSchema,
  type OperationsConfig,
  type OperationsPatch,
} from "./operations";

// Runtime host for the Operations Desk configuration.
//
// Contract (specification §4): "Configuration changes must never affect a
// market already in flight. Changes apply to the next market only."
//
// Implementation: the desk writes to `staged`. `promoteFor()` is called by the
// strategy host on every evaluation with the currently discovered condition
// ids; the staged document becomes `active` only when the tracked market set
// changes. Subscribers (strategy, execution) are notified on promotion only.

const log = createLogger("operations");
const KV_KEY = "operations.config";

let staged: OperationsConfig = lockOperations(DEFAULT_OPERATIONS_CONFIG);
let active: OperationsConfig = staged;
let appliedTo: string = "";
let promotions = 0;
let lastPromotedAt: string | null = null;
let persistenceError: string | null = null;
let loaded = false;

type Subscriber = (config: OperationsConfig) => void;
const subscribers = new Set<Subscriber>();

/** Strategy and Execution register here; they are never imported by this module. */
export function subscribeOperations(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  subscriber(active);
  return () => subscribers.delete(subscriber);
}

function notify(): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(active);
    } catch (error) {
      log.error("operations subscriber threw", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function activeOperations(): OperationsConfig {
  return active;
}

export function stagedOperations(): OperationsConfig {
  return staged;
}

export function operationsPending(): boolean {
  return staged.version !== active.version;
}

/** Load the persisted document at boot. Missing or invalid falls back to defaults. */
export async function loadOperations(): Promise<OperationsConfig> {
  if (loaded) return staged;
  try {
    const raw = await kvRepository.get(KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as OperationsConfig;
      staged = lockOperations({ ...DEFAULT_OPERATIONS_CONFIG, ...parsed });
      active = staged;
      notify();
      log.info("operations configuration restored", { version: staged.version });
    }
    persistenceError = null;
  } catch (error) {
    persistenceError = error instanceof Error ? error.message : String(error);
    log.warn("operations configuration not restored", { reason: persistenceError });
  }
  loaded = true;
  return staged;
}

export interface OperationsUpdate {
  status: "ACCEPTED" | "REJECTED";
  reason: string;
  staged: OperationsConfig;
  active: OperationsConfig;
  pending: boolean;
}

/** Stage an operator edit. Durable immediately, live only on the next market. */
export async function stageOperations(patch: unknown): Promise<OperationsUpdate> {
  const parsed = operationsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return {
      status: "REJECTED",
      reason: `invalid configuration: ${parsed.error.issues[0]?.message ?? "unknown field"}`,
      staged,
      active,
      pending: operationsPending(),
    };
  }
  let next: OperationsConfig;
  try {
    next = applyOperationsPatch(staged, parsed.data as OperationsPatch, systemClock.iso());
  } catch (error) {
    return {
      status: "REJECTED",
      reason: error instanceof Error ? error.message : String(error),
      staged,
      active,
      pending: operationsPending(),
    };
  }

  staged = next;
  try {
    await kvRepository.set(KV_KEY, JSON.stringify(staged));
    persistenceError = null;
  } catch (error) {
    // Persistence is best effort: a runtime without native SQLite still runs,
    // it simply forgets the edit on restart.
    persistenceError = error instanceof Error ? error.message : String(error);
  }

  eventBus.publish({
    type: "operations.config.staged",
    severity: "INFO",
    correlationId: `ops:v${staged.version}`,
    source: "operations",
    payload: { version: staged.version, activeVersion: active.version },
  });
  log.info("operations configuration staged", { version: staged.version });

  return {
    status: "ACCEPTED",
    reason:
      staged.version === active.version
        ? "configuration applied"
        : "configuration staged; it applies to the next market",
    staged,
    active,
    pending: operationsPending(),
  };
}

function marketKey(state: MarketState): string {
  return [state.markets.FIVE_MINUTE?.conditionId ?? "-", state.markets.FIFTEEN_MINUTE?.conditionId ?? "-"].join(
    "|",
  );
}

/**
 * Promote the staged document when the tracked market set changes. Returns the
 * configuration the engine must trade for this evaluation.
 */
export function promoteFor(state: MarketState): OperationsConfig {
  const key = marketKey(state);
  if (key === appliedTo) return active;
  appliedTo = key;
  if (staged.version === active.version) return active;

  active = staged;
  promotions += 1;
  lastPromotedAt = systemClock.iso();
  notify();
  eventBus.publish({
    type: "operations.config.promoted",
    severity: "SUCCESS",
    correlationId: `ops:v${active.version}`,
    source: "operations",
    payload: { version: active.version, market: key },
  });
  log.info("operations configuration promoted for new market", {
    version: active.version,
    market: key,
  });
  return active;
}

/** Test seam only. */
export function resetOperations(): void {
  staged = lockOperations(DEFAULT_OPERATIONS_CONFIG);
  active = staged;
  appliedTo = "";
  promotions = 0;
  lastPromotedAt = null;
  loaded = false;
}

export function operationsHealth(): HealthResult {
  const details = {
    activeVersion: active.version,
    stagedVersion: staged.version,
    pending: operationsPending(),
    promotions,
    lastPromotedAt,
    appliedTo,
    persistenceError,
  };
  if (persistenceError) {
    return { state: "DEGRADED", message: `configuration not persisted: ${persistenceError}`, details };
  }
  return {
    state: "OK",
    message: operationsPending()
      ? `v${staged.version} staged; v${active.version} live until the next market`
      : `configuration v${active.version} live`,
    details,
  };
}
