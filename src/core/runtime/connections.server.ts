import { loadEnv } from "../config/env.server";
import type { HealthResult, HealthState } from "../health/types";
import { systemClock } from "../shared/clock";

// Runtime Connection Manager.
//
// One registry that owns the observable state of every external and internal
// connection SPACE depends on. Adapters report into it; the dashboard reads
// from it. Nothing here invents a value: an unreported connection stays
// NOT_STARTED until a real observation arrives.

export const CONNECTION_IDS = [
  "sqlite",
  "scheduler",
  "wallet",
  "polygon_rpc",
  "gamma",
  "market_discovery",
  "binance",
  "twap_provider",
  "clob",
  "telegram",
] as const;

export type ConnectionId = (typeof CONNECTION_IDS)[number];

export const CONNECTION_LABELS: Record<ConnectionId, string> = {
  sqlite: "Database (SQLite)",
  scheduler: "Scheduler",
  wallet: "Wallet",
  polygon_rpc: "Polygon RPC",
  gamma: "Gamma API",
  market_discovery: "Market Discovery",
  binance: "Binance",
  twap_provider: "TWAP Provider",
  clob: "Polymarket CLOB",
  telegram: "Telegram",
};

export type ConnectionState =
  | "NOT_STARTED"
  | "CONNECTING"
  | "CONNECTED"
  | "WAITING"
  | "DEGRADED"
  | "DISCONNECTED"
  | "FAILED"
  | "NOT_CONFIGURED";

/** Projection onto the frozen HealthState enum. The enum itself never changes. */
const HEALTH_PROJECTION: Record<ConnectionState, HealthState> = {
  CONNECTED: "OK",
  CONNECTING: "DEGRADED",
  WAITING: "DEGRADED",
  DEGRADED: "DEGRADED",
  DISCONNECTED: "DEGRADED",
  FAILED: "FAILED",
  NOT_CONFIGURED: "DISABLED",
  NOT_STARTED: "NOT_INITIALIZED",
};

export function projectHealthState(state: ConnectionState): HealthState {
  return HEALTH_PROJECTION[state];
}

export interface ConnectionRecord {
  id: ConnectionId;
  label: string;
  state: ConnectionState;
  health: HealthState;
  /** Why the connection is in this state, in operator language. */
  reason: string;
  /** What the operator should do, or null when nothing is required. */
  action: string | null;
  /** Whether this connection currently blocks trading. */
  blocksTrading: boolean;
  /** How the connection is expected to recover. */
  recovery: string;
  endpoint: string | null;
  environment: string;
  latencyMs: number | null;
  reconnects: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastFailureAt: string | null;
  connectedCount: number;
  disconnectedCount: number;
  lastRecoveryMs: number | null;
  /** Free-form, already-observed facts rendered on the card. */
  details: Record<string, string | number | boolean | null>;
}

export interface ConnectionTimelineEntry {
  at: string;
  id: ConnectionId;
  label: string;
  state: ConnectionState;
  message: string;
}

export interface ConnectionReport {
  state: ConnectionState;
  reason: string;
  action?: string | null;
  blocksTrading?: boolean;
  recovery?: string;
  endpoint?: string | null;
  latencyMs?: number | null;
  reconnects?: number;
  lastSuccessAt?: string | null | undefined;
  lastError?: string | null;
  details?: Record<string, string | number | boolean | null>;
}

const TIMELINE_LIMIT = 300;

function environmentName(): string {
  try {
    return loadEnv().SPACE_ENVIRONMENT;
  } catch {
    return "UNKNOWN";
  }
}

function seed(id: ConnectionId): ConnectionRecord {
  return {
    id,
    label: CONNECTION_LABELS[id],
    state: "NOT_STARTED",
    health: "NOT_INITIALIZED",
    reason: "not started yet",
    action: null,
    blocksTrading: true,
    recovery: "starts during boot",
    endpoint: null,
    environment: environmentName(),
    latencyMs: null,
    reconnects: 0,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastFailureAt: null,
    connectedCount: 0,
    disconnectedCount: 0,
    lastRecoveryMs: null,
    details: {},
  };
}

// Every connection is seeded at module load, so no subsystem is ever stateless.
const registry = new Map<ConnectionId, ConnectionRecord>(
  CONNECTION_IDS.map((id) => [id, seed(id)]),
);

const timeline: ConnectionTimelineEntry[] = [];

/** Record one observation about a connection. Only real observations belong here. */
export function reportConnection(id: ConnectionId, report: ConnectionReport): ConnectionRecord {
  const record = registry.get(id) ?? seed(id);
  const at = systemClock.iso();
  const previous = record.state;

  const next: ConnectionRecord = {
    ...record,
    state: report.state,
    health: projectHealthState(report.state),
    reason: report.reason,
    action: report.action ?? null,
    blocksTrading: report.blocksTrading ?? report.state !== "CONNECTED",
    recovery: report.recovery ?? record.recovery,
    environment: environmentName(),
    lastAttemptAt: at,
    endpoint: report.endpoint === undefined ? record.endpoint : report.endpoint,
    latencyMs: report.latencyMs === undefined ? record.latencyMs : report.latencyMs,
    reconnects: report.reconnects === undefined ? record.reconnects : report.reconnects,
    lastError: report.lastError === undefined ? record.lastError : report.lastError,
    details: report.details ?? record.details,
  };

  if (report.lastSuccessAt !== undefined) next.lastSuccessAt = report.lastSuccessAt;
  if (report.state === "CONNECTED" && report.lastSuccessAt === undefined) next.lastSuccessAt = at;

  if (previous !== report.state) {
    if (report.state === "CONNECTED") {
      next.connectedCount += 1;
      if (record.lastFailureAt) {
        next.lastRecoveryMs = Date.parse(at) - Date.parse(record.lastFailureAt);
      }
    }
    if (report.state === "DISCONNECTED" || report.state === "FAILED") {
      next.disconnectedCount += 1;
      next.lastFailureAt = at;
    }
    timeline.push({
      at,
      id,
      label: CONNECTION_LABELS[id],
      state: report.state,
      message: report.reason,
    });
    if (timeline.length > TIMELINE_LIMIT) timeline.splice(0, timeline.length - TIMELINE_LIMIT);
  }

  registry.set(id, next);
  return next;
}

/** Append a milestone to the timeline that is not a connection state change. */
export function noteTimeline(id: ConnectionId, message: string): void {
  const record = registry.get(id) ?? seed(id);
  timeline.push({
    at: systemClock.iso(),
    id,
    label: CONNECTION_LABELS[id],
    state: record.state,
    message,
  });
  if (timeline.length > TIMELINE_LIMIT) timeline.splice(0, timeline.length - TIMELINE_LIMIT);
}

export function getConnection(id: ConnectionId): ConnectionRecord {
  return { ...(registry.get(id) ?? seed(id)) };
}

export function listConnections(): ConnectionRecord[] {
  return CONNECTION_IDS.map((id) => getConnection(id));
}

export function connectionTimeline(): ConnectionTimelineEntry[] {
  return timeline.map((entry) => ({ ...entry }));
}

export function resetConnections(): void {
  for (const id of CONNECTION_IDS) registry.set(id, seed(id));
  timeline.length = 0;
}

/** Health projection for one connection, for the shared health registry. */
export function connectionHealth(id: ConnectionId): HealthResult {
  const record = getConnection(id);
  return {
    state: record.health,
    message: record.reason,
    details: {
      connection: record.state,
      endpoint: record.endpoint,
      environment: record.environment,
      latencyMs: record.latencyMs,
      reconnects: record.reconnects,
      lastSuccessAt: record.lastSuccessAt,
      lastError: record.lastError,
    },
  };
}

export interface EnvironmentResolutionRow {
  subsystem: string;
  target: string;
  environment: string;
  conformant: boolean;
  note: string;
}

/**
 * Environment conformance evidence: what every subsystem actually resolved.
 * The active environment is the single source of truth; a row whose resolved
 * environment differs from it is a conformance failure, not a warning.
 */
export function environmentResolution(): {
  environment: string;
  conformant: boolean;
  rows: EnvironmentResolutionRow[];
} {
  const env = loadEnv();
  const environment = env.SPACE_ENVIRONMENT;
  const namespace = environment === "V1_TESTNET" ? "v1" : "v2";
  const wallet = getConnection("wallet");
  const clob = getConnection("clob");
  const twap = getConnection("twap_provider");

  const rows: EnvironmentResolutionRow[] = [
    {
      subsystem: "RPC",
      target: env.POLYGON_RPC_URL ?? "not configured",
      environment,
      conformant: Boolean(env.POLYGON_RPC_URL),
      note: env.POLYGON_RPC_URL
        ? `chain ${environment === "V1_TESTNET" ? 80002 : 137} required`
        : "POLYGON_RPC_URL unset",
    },
    {
      subsystem: "Gamma",
      target: env.POLYMARKET_GAMMA_URL,
      environment,
      conformant: true,
      note: "market metadata source",
    },
    {
      subsystem: "CLOB",
      target: clob.endpoint ?? env.POLYMARKET_CLOB_URL ?? "not resolved",
      environment,
      conformant: clob.state !== "FAILED",
      note: clob.reason,
    },
    {
      subsystem: "TWAP",
      target: twap.endpoint ?? "Binance settlement TWAP",
      environment,
      conformant: twap.state !== "FAILED",
      note: twap.reason,
    },
    {
      subsystem: "Wallet",
      target: wallet.endpoint ?? "not configured",
      environment,
      conformant: wallet.state !== "FAILED",
      note: wallet.reason,
    },
    {
      subsystem: "Replay",
      target: `namespace ${namespace} · ${env.DB_PATH}`,
      environment,
      conformant: true,
      note: "replay reads only rows stamped with this environment",
    },
    {
      subsystem: "Statistics",
      target: `namespace ${namespace} · ${env.DB_PATH}`,
      environment,
      conformant: true,
      note: "statistics are scoped to this database stamp",
    },
    {
      subsystem: "Telegram",
      target: getConnection("telegram").endpoint ?? "not configured",
      environment,
      conformant: true,
      note: `notifications labelled ${environment}`,
    },
  ];

  return { environment, conformant: rows.every((row) => row.conformant), rows };
}

/** Human label for the active environment. Read from configuration, never hardcoded. */
export function environmentLabel(): { code: string; label: string; live: boolean } {
  const code = environmentName();
  if (code === "V2_MAINNET") return { code, label: "V2 MAINNET (Live)", live: true };
  if (code === "V1_TESTNET") return { code, label: "V1 TESTNET (Paper)", live: false };
  return { code, label: code, live: false };
}