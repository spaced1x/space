import { eventBus } from "../bus/events";
import { systemClock } from "../shared/clock";

export type EngineStatus = "BOOTING" | "OBSERVE" | "ARMED" | "PAUSED" | "STOPPED";
export type OperatingMode = "STRATEGY" | "MANUAL";

// The single sanctioned reason string for entering ARMED. The command bus is
// the only module allowed to use it.
export const ARM_REASON = "engine armed";

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
  // Boot -> OBSERVE -> ARMED is operator-driven only. Nothing but an explicit
  // ARM command may put the engine into ARMED; any other caller attempting it
  // is a bug, so fail loudly instead of silently arming a live trading engine.
  if (patch.engineStatus === "ARMED" && reason !== ARM_REASON) {
    throw new Error("ARMED may only be entered by an explicit operator ARM command");
  }
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
  return state;
}
