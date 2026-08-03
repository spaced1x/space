import { eventBus } from "../bus/events";
import { systemClock } from "../shared/clock";

export type EngineStatus = "BOOTING" | "OBSERVE" | "ARMED" | "PAUSED" | "STOPPED";
export type OperatingMode = "STRATEGY" | "MANUAL";

export interface RuntimeState {
  engineStatus: EngineStatus;
  mode: OperatingMode;
  windows: { fiveMinute: boolean; fifteenMinute: boolean };
  sessionStartedAt: string;
  lastTransitionAt: string;
  lastTransitionReason: string;
  version: number;
}

// The engine process owns runtime state. The dashboard reads snapshots and
// issues commands; it never holds authoritative state of its own.
let state: RuntimeState = Object.freeze({
  engineStatus: "BOOTING",
  mode: "STRATEGY",
  windows: { fiveMinute: true, fifteenMinute: true },
  sessionStartedAt: systemClock.iso(),
  lastTransitionAt: systemClock.iso(),
  lastTransitionReason: "process boot",
  version: 1,
});

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
    correlationId,
    source: "state-store",
    payload: { ...state },
  });
  return state;
}