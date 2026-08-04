import { eventBus } from "../bus/events";
import { kvRepository } from "../db/repositories/kv.repository";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";

export type RuntimeLifecycle =
  "STOPPED" | "STARTING" | "VALIDATING" | "READY" | "RUNNING" | "STOPPING" | "FAILED";

export type OperatingMode = "STRATEGY" | "MANUAL";

export interface RuntimeState {
  lifecycle: RuntimeLifecycle;
  mode: OperatingMode;
  windows: { fiveMinute: boolean; fifteenMinute: boolean };
  sessionStartedAt: string;
  lastTransitionAt: string;
  lastTransitionReason: string;
  version: number;
  emergencyStop: boolean;
  emergencyStopReason: string | null;
  /** Human-readable reason when the runtime is FAILED or STOPPED. */
  shutdownReason: string | null;
}

const RUNTIME_STATE_KEY = "runtime.state";
const log = createLogger("state-store");

// The engine process owns runtime state. The dashboard reads snapshots and
// issues commands; it never holds authoritative state of its own.
let state: RuntimeState = Object.freeze({
  lifecycle: "STOPPED",
  mode: "STRATEGY",
  windows: { fiveMinute: true, fifteenMinute: true },
  sessionStartedAt: systemClock.iso(),
  lastTransitionAt: systemClock.iso(),
  lastTransitionReason: "process boot",
  version: 1,
  emergencyStop: false,
  emergencyStopReason: null,
  shutdownReason: null,
});

export async function loadRuntimeState(): Promise<void> {
  try {
    const raw = await kvRepository.get(RUNTIME_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Omit<RuntimeState, "sessionStartedAt" | "version">;
    state = Object.freeze({
      ...state,
      lifecycle: saved.lifecycle ?? "STOPPED",
      mode: saved.mode,
      windows: saved.windows,
      emergencyStop: saved.emergencyStop ?? false,
      emergencyStopReason: saved.emergencyStopReason ?? null,
      shutdownReason: saved.shutdownReason ?? null,
      lastTransitionReason: "restored from persistence",
      version: state.version + 1,
    });
    log.info("runtime state restored", { lifecycle: state.lifecycle, mode: state.mode });
  } catch (error) {
    log.warn("runtime state restore failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function persistRuntimeState(): void {
  const payload = JSON.stringify({
    lifecycle: state.lifecycle,
    mode: state.mode,
    windows: state.windows,
    emergencyStop: state.emergencyStop,
    emergencyStopReason: state.emergencyStopReason,
    shutdownReason: state.shutdownReason,
    lastTransitionAt: state.lastTransitionAt,
    lastTransitionReason: state.lastTransitionReason,
  });
  void kvRepository.set(RUNTIME_STATE_KEY, payload).catch((error) => {
    log.warn("runtime state persist failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}

export function getRuntimeState(): RuntimeState {
  return state;
}

export function updateRuntimeState(
  patch: Partial<Omit<RuntimeState, "version" | "sessionStartedAt" | "lastTransitionAt">>,
  reason: string,
  correlationId: string,
): RuntimeState {
  state = Object.freeze({
    ...state,
    ...patch,
    windows: { ...state.windows, ...(patch.windows ?? {}) },
    lastTransitionAt: systemClock.iso(),
    lastTransitionReason: reason,
    version: state.version + 1,
  });
  eventBus.publish({
    type: "runtime.state.changed",
    severity: "INFO",
    correlationId,
    source: "state-store",
    payload: { ...state },
  });
  persistRuntimeState();
  return state;
}

/**
 * Latch the emergency stop. Once set, the engine cannot RUN until the operator
 * explicitly resets the latch. This is a latched kill switch, not a pause:
 * existing orders stay in flight, but no new orders may be created.
 */
export function latchEmergencyStop(reason: string, correlationId: string): RuntimeState {
  return updateRuntimeState(
    { emergencyStop: true, emergencyStopReason: reason },
    `emergency stop: ${reason}`,
    correlationId,
  );
}

/** Reset the emergency stop latch. Only an explicit operator command may do this. */
export function resetEmergencyStop(correlationId: string): RuntimeState {
  return updateRuntimeState(
    { emergencyStop: false, emergencyStopReason: null },
    "emergency stop reset",
    correlationId,
  );
}
