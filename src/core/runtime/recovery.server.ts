import {
  CONNECTION_LABELS,
  connectionTimeline,
  type ConnectionId,
  type ConnectionState,
  type ConnectionTimelineEntry,
} from "./connections.server";

// Recovery ledger.
//
// Every fault must be visible as a closed loop: detected -> transitioned ->
// recovered -> restored. The ledger derives that loop from the persisted
// connection timeline, so a recovery that was never observed cannot be
// reported, and a recovery that happened silently is impossible to hide.

const FAULT_STATES: ConnectionState[] = [
  "DISCONNECTED",
  "FAILED",
  "STALE",
  "DEGRADED",
];

const RECOVERING_STATES: ConnectionState[] = ["RECONNECTING", "CONNECTING", "WAITING"];

export interface RecoveryRecord {
  id: ConnectionId;
  label: string;
  /** When the fault was first observed. */
  detectedAt: string;
  /** The state the connection dropped into. */
  faultState: ConnectionState;
  detail: string;
  /** Intermediate states seen on the way back, in order. */
  transitions: { at: string; state: ConnectionState; message: string }[];
  /** When the connection reported CONNECTED again, or null while still down. */
  restoredAt: string | null;
  recoveryMs: number | null;
  outcome: "RECOVERED" | "RECOVERING" | "DOWN";
}

export interface RecoveryLedger {
  records: RecoveryRecord[];
  open: number;
  recovered: number;
  slowestRecoveryMs: number | null;
  medianRecoveryMs: number | null;
}

/**
 * Build the recovery ledger from the connection timeline. Pure over its input,
 * so the soak harness and the dashboard read exactly the same derivation.
 */
export function deriveRecoveryLedger(entries: ConnectionTimelineEntry[]): RecoveryLedger {
  // The timeline is newest-first for the dashboard; recovery is a forward story.
  const ordered = [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const open = new Map<ConnectionId, RecoveryRecord>();
  const records: RecoveryRecord[] = [];

  for (const entry of ordered) {
    const active = open.get(entry.id);
    if (!active) {
      if (FAULT_STATES.includes(entry.state)) {
        open.set(entry.id, {
          id: entry.id,
          label: CONNECTION_LABELS[entry.id] ?? entry.label,
          detectedAt: entry.at,
          faultState: entry.state,
          detail: entry.message,
          transitions: [],
          restoredAt: null,
          recoveryMs: null,
          outcome: "DOWN",
        });
      }
      continue;
    }

    if (entry.state === "CONNECTED") {
      active.restoredAt = entry.at;
      active.recoveryMs = Date.parse(entry.at) - Date.parse(active.detectedAt);
      active.outcome = "RECOVERED";
      records.push(active);
      open.delete(entry.id);
      continue;
    }

    active.transitions.push({ at: entry.at, state: entry.state, message: entry.message });
    if (RECOVERING_STATES.includes(entry.state)) active.outcome = "RECOVERING";
    else if (FAULT_STATES.includes(entry.state)) active.faultState = entry.state;
  }

  const stillOpen = [...open.values()];
  const all = [...records, ...stillOpen].sort(
    (a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt),
  );

  const durations = records
    .map((record) => record.recoveryMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  return {
    records: all,
    open: stillOpen.length,
    recovered: records.length,
    slowestRecoveryMs: durations.length ? (durations.at(-1) ?? null) : null,
    medianRecoveryMs: durations.length
      ? (durations[Math.floor(durations.length / 2)] ?? null)
      : null,
  };
}

/** Live recovery ledger for the active runtime. */
export function recoveryLedger(limit = 40): RecoveryLedger {
  const ledger = deriveRecoveryLedger(connectionTimeline());
  return { ...ledger, records: ledger.records.slice(0, limit) };
}
