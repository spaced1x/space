import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import { createWsClient, type WsClient, type WsClientStats } from "../shared/ws-client.server";

// Polymarket Real-Time Data Service (RTDS).
//
// Official contract (docs.polymarket.com):
//   - endpoint  wss://ws-live-data.polymarket.com
//   - public: no API key, no secret, no auth frame of any kind
//   - subscribe { action, subscriptions: [{ topic, type, filters }] }
//   - heartbeat: the client sends the text frame `PING` every 5 seconds
//   - no snapshot and no replay after a disconnect: resubscribe every time
//
// One process holds one RTDS socket. Both TWAP providers (30s and 60s) are
// topic subscriptions on that single connection.

const log = createLogger("rtds-socket");

export interface RtdsUpdate {
  price: number;
  /** Chainlink observation time from the payload. */
  sourceMs: number | null;
  /** RTDS publish time from the envelope, used for latency. */
  publishedMs: number | null;
  symbol: string | null;
  windowSeconds: number | null;
}

type Listener = (update: RtdsUpdate) => void;

interface Subscription {
  topic: string;
  symbol: string;
  listeners: Set<Listener>;
  /** Set when RTDS answers that the topic is unknown (not yet activated). */
  unavailableReason: string | null;
}

const subscriptions = new Map<string, Subscription>();
let client: WsClient | undefined;
let started = false;

function subscribeFrame(topic: string, symbol: string): string {
  return JSON.stringify({
    action: "subscribe",
    subscriptions: [{ topic, type: "update", filters: JSON.stringify([symbol]) }],
  });
}

/** E18 fixed-point string -> decimal. Falls back to the plain value field. */
export function decodeE18(raw: unknown): number | null {
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    try {
      return Number(BigInt(raw.trim())) / 1e18;
    } catch {
      return null;
    }
  }
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function toMs(value: unknown): number | null {
  const raw = readNumber(value);
  if (raw === null || raw <= 0) return null;
  let ms = raw;
  if (ms > 1e17) ms = ms / 1e6;
  else if (ms > 1e14) ms = ms / 1e3;
  else if (ms < 1e11) ms = ms * 1000;
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

function dispatch(topic: string, envelope: Record<string, unknown>, payload: unknown): void {
  const subscription = subscriptions.get(topic);
  if (!subscription) return;
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const price = decodeE18(record["full_accuracy_value"]) ?? readNumber(record["value"]);
    if (price === null || !Number.isFinite(price) || price <= 0) continue;
    subscription.unavailableReason = null;
    const update: RtdsUpdate = {
      price,
      sourceMs: toMs(record["timestamp"]),
      publishedMs: toMs(envelope["timestamp"]),
      symbol: typeof record["symbol"] === "string" ? (record["symbol"] as string) : null,
      windowSeconds: readNumber(record["window_s"]),
    };
    for (const listener of subscription.listeners) listener(update);
  }
}

function ingest(raw: string): void {
  const text = raw.trim();
  if (!text || text === "PONG" || text === "PING") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  for (const envelope of envelopes) {
    if (!envelope || typeof envelope !== "object") continue;
    const record = envelope as Record<string, unknown>;
    const topic = typeof record["topic"] === "string" ? (record["topic"] as string) : "";
    const type = typeof record["type"] === "string" ? (record["type"] as string) : "";
    if (type === "error" || record["error"]) {
      const reason = String(record["error"] ?? record["payload"] ?? "RTDS error");
      const subscription = topic ? subscriptions.get(topic) : undefined;
      if (subscription) subscription.unavailableReason = reason;
      log.warn("rtds reported an error", { topic, reason });
      continue;
    }
    if (!topic) continue;
    dispatch(topic, record, record["payload"]);
  }
}

function resubscribeAll(send: (frame: string) => void): void {
  for (const subscription of subscriptions.values()) {
    send(subscribeFrame(subscription.topic, subscription.symbol));
  }
  log.info("rtds subscriptions sent", { topics: [...subscriptions.keys()] });
}

function ensureClient(): WsClient {
  if (client) return client;
  const env = loadEnv();
  client = createWsClient({
    name: "rtds",
    url: () => loadEnv().RTDS_WS_URL,
    onOpen: (send) => resubscribeAll(send),
    onMessage: ingest,
    // The docs specify a raw text PING frame, not a JSON message.
    ping: () => "PING",
    pingMs: env.RTDS_PING_MS,
    staleMs: env.RTDS_STALE_MS,
    maxAttempts: env.WS_MAX_RECONNECT_ATTEMPTS,
    maxBackoffMs: env.WS_MAX_BACKOFF_MS,
  });
  return client;
}

/** Registers a topic listener. Returns an unsubscribe function. */
export function subscribeRtdsTopic(topic: string, symbol: string, listener: Listener): () => void {
  const existing = subscriptions.get(topic);
  const subscription: Subscription = existing ?? {
    topic,
    symbol,
    listeners: new Set<Listener>(),
    unavailableReason: null,
  };
  subscription.symbol = symbol;
  subscription.listeners.add(listener);
  subscriptions.set(topic, subscription);
  if (started && client?.isOpen()) client.send(subscribeFrame(topic, symbol));
  return () => {
    subscription.listeners.delete(listener);
    if (!subscription.listeners.size) subscriptions.delete(topic);
  };
}

export function startRtdsSocket(): void {
  if (started) return;
  started = true;
  ensureClient().start();
}

export function stopRtdsSocket(): void {
  if (!started && !client) return;
  started = false;
  client?.stop();
  client = undefined;
}

export function pollRtdsSocket(): void {
  if (!started) return;
  client?.tick();
}

export function rtdsSocketStats(): WsClientStats & { topics: string[] } {
  const base = client?.stats() ?? {
    state: "IDLE" as const,
    endpoint: null,
    connected: false,
    attempts: 0,
    reconnects: 0,
    messages: 0,
    errors: 0,
    lastError: null,
    lastMessageAt: null,
    lastConnectedAt: null,
    ageMs: null,
    budgetExhausted: false,
  };
  return { ...base, topics: [...subscriptions.keys()] };
}

export function rtdsTopicUnavailable(topic: string): string | null {
  return subscriptions.get(topic)?.unavailableReason ?? null;
}

/** Live socket count for the runtime resource audit. */
export function rtdsSocketResources(): { sockets: number } {
  return { sockets: client && started ? 1 : 0 };
}

/** Age of the last frame on the shared socket, for provider staleness reporting. */
export function rtdsSocketAgeMs(): number | null {
  const stats = client?.stats();
  if (!stats?.lastMessageAt) return null;
  return clock().now() - Date.parse(stats.lastMessageAt);
}
