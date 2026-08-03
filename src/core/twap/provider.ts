// Settlement TWAP provider contract.
//
// The TWAP service consumes providers through this interface only. Nothing
// above the service (strategy, execution, replay, statistics, UI) knows which
// provider is active — the registry owns that decision.

export type TwapProviderId = "rtds" | "chainlink";

export type TwapProviderState =
  | "CONNECTED"
  | "WAITING"
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "FAILED";

/** One observed settlement price. Never synthesised, never interpolated. */
export interface TwapSample {
  price: number;
  atMs: number;
  latencyMs: number | null;
  /** Provider sequence number when the provider exposes one. */
  sequence: number | null;
}

export interface TwapProviderDescription {
  endpoint: string | null;
  environment: string;
  symbol: string;
  authType: string | null;
  transport: string;
}

export interface TwapProviderStatus {
  id: TwapProviderId;
  label: string;
  state: TwapProviderState;
  /** Operator-language explanation of the current state. */
  reason: string;
  /** What the operator must do, or null when nothing is required. */
  action: string | null;
  /** What this state means for trading while the provider is active. */
  tradingImpact: string;
  endpoint: string | null;
  environment: string;
  symbol: string;
  authType: string | null;
  transport: string;
  price: number | null;
  /** Age of the last observed price in ms, or null when nothing arrived yet. */
  freshnessMs: number | null;
  latencyMs: number | null;
  reconnects: number;
  samples: number;
  errors: number;
  sequence: number | null;
  sequenceGaps: number;
  lastSuccessAt: string | null;
  lastMessageAt: string | null;
  lastError: string | null;
}

export interface TwapProvider {
  readonly id: TwapProviderId;
  readonly label: string;
  describe(): TwapProviderDescription;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Pull providers refresh here; streaming providers run their watchdog. */
  poll(): Promise<void>;
  latest(): TwapSample | null;
  status(): TwapProviderStatus;
}

/** Deep, schema-agnostic extraction so a provider payload change is config-only. */
const PRICE_KEYS = ["price", "p", "value", "last", "lastPrice", "close", "c", "mid", "index"];
const TIME_KEYS = ["timestamp", "ts", "time", "t", "at", "eventTime", "E", "observedAt"];
const SEQUENCE_KEYS = ["sequence", "seq", "sequenceNumber", "id", "u", "n"];

function firstNumber(value: unknown, keys: string[], depth = 0): number | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
  }
  for (const nested of Object.values(record)) {
    const found = firstNumber(nested, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function normaliseTimestamp(raw: number | null, nowMs: number): number | null {
  if (raw === null) return null;
  // Accept seconds, milliseconds, microseconds and nanoseconds transparently.
  let ms = raw;
  if (ms > 1e17) ms = ms / 1e6;
  else if (ms > 1e14) ms = ms / 1e3;
  else if (ms < 1e11) ms = ms * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // A provider clock more than a day away from ours is not usable.
  if (Math.abs(nowMs - ms) > 86_400_000) return null;
  return Math.round(ms);
}

/**
 * Reads a price sample out of an arbitrary provider payload. Returns null when
 * the payload carries no usable price — never a guess.
 */
export function readSampleFromPayload(
  payload: unknown,
  nowMs: number,
): { price: number; sourceMs: number | null; sequence: number | null } | null {
  if (payload === null || typeof payload !== "object") return null;
  const price = firstNumber(payload, PRICE_KEYS);
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  const sourceMs = normaliseTimestamp(firstNumber(payload, TIME_KEYS), nowMs);
  const sequenceRaw = firstNumber(payload, SEQUENCE_KEYS);
  const sequence =
    sequenceRaw !== null && Number.isInteger(sequenceRaw) && sequenceRaw >= 0 ? sequenceRaw : null;
  return { price, sourceMs, sequence };
}