import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import {
  readSampleFromPayload,
  type TwapProvider,
  type TwapProviderDescription,
  type TwapProviderState,
  type TwapProviderStatus,
  type TwapSample,
} from "./provider";

// Polymarket RTDS settlement price provider.
//
// Nothing about the protocol is hardcoded: endpoint, authentication style,
// subscription payload, channel name and symbol all come from configuration,
// and the message reader is schema-agnostic. A venue protocol change is a
// configuration change (or, at worst, an edit to this one file) — never a
// change to strategy, execution, replay, statistics or the dashboard.

const log = createLogger("twap-rtds");
const STALE_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

interface RtdsConfig {
  enabled: boolean;
  url: string;
  apiKey: string;
  apiSecret: string;
  channel: string;
  symbol: string;
  authType: string;
  environment: string;
}

function readConfig(): RtdsConfig {
  const env = loadEnv();
  return {
    enabled: env.RTDS_ENABLED,
    url: env.RTDS_WS_URL ?? "",
    apiKey: env.RTDS_API_KEY ?? "",
    apiSecret: env.RTDS_API_SECRET ?? "",
    channel: env.RTDS_CHANNEL ?? "",
    symbol: env.RTDS_SYMBOL,
    authType: env.RTDS_AUTH_TYPE,
    environment: env.SPACE_ENVIRONMENT,
  };
}

/** Substitutes ${symbol}, ${apiKey} and ${apiSecret} inside configured payloads. */
function template(text: string, config: RtdsConfig): string {
  return text
    .replaceAll("${symbol}", config.symbol)
    .replaceAll("${apiKey}", config.apiKey)
    .replaceAll("${apiSecret}", config.apiSecret);
}

function missingConfiguration(config: RtdsConfig): string[] {
  const missing: string[] = [];
  if (!config.url) missing.push("RTDS_WS_URL");
  if (!config.channel) missing.push("RTDS_CHANNEL");
  if (config.authType === "api_key" || config.authType === "hmac") {
    if (!config.apiKey) missing.push("RTDS_API_KEY");
    if (!config.apiSecret) missing.push("RTDS_API_SECRET");
  }
  if (config.authType === "bearer" && !config.apiKey) missing.push("RTDS_API_KEY");
  return missing;
}

function connectUrl(config: RtdsConfig): string {
  const base = template(config.url, config);
  if (config.authType !== "query") return base;
  const url = new URL(base);
  if (config.apiKey) url.searchParams.set("apiKey", config.apiKey);
  if (config.apiSecret) url.searchParams.set("secret", config.apiSecret);
  return url.toString();
}

/** Auth frame for message-based auth styles. Shape is configuration-driven. */
function authFrame(config: RtdsConfig): string | null {
  switch (config.authType) {
    case "api_key":
      return JSON.stringify({ action: "auth", apiKey: config.apiKey, secret: config.apiSecret });
    case "bearer":
      return JSON.stringify({ action: "auth", token: config.apiKey });
    case "hmac":
      return JSON.stringify({
        action: "auth",
        apiKey: config.apiKey,
        secret: config.apiSecret,
        timestamp: Math.floor(clock().now() / 1000),
      });
    default:
      return null;
  }
}

/**
 * Subscription frame. RTDS_CHANNEL is sent verbatim when it is valid JSON, so a
 * new subscription format needs no code change; otherwise the channel name is
 * wrapped in the documented subscribe envelope.
 */
function subscribeFrame(config: RtdsConfig): string {
  const raw = template(config.channel, config).trim();
  if (raw.startsWith("{") || raw.startsWith("[")) return raw;
  return JSON.stringify({
    action: "subscribe",
    subscriptions: [{ topic: raw, type: config.symbol }],
  });
}

export function createRtdsProvider(): TwapProvider {
  let config = readConfig();
  let socket: WebSocket | undefined;
  let stopped = true;
  let connected = false;
  let authenticated = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let latest: TwapSample | null = null;
  let lastMessageAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let samples = 0;
  let errors = 0;
  let reconnects = 0;
  let sequenceGaps = 0;
  let lastSequence: number | null = null;
  let lastError: string | null = null;
  let endpoint: string | null = null;

  function send(frame: string | null): void {
    if (!frame || !socket) return;
    try {
      socket.send(frame);
    } catch (error) {
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  function ingest(raw: string): void {
    lastMessageAt = clock().now();
    if (raw === "ping" || raw === "PING") {
      send("pong");
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const type = typeof record["type"] === "string" ? (record["type"] as string) : "";
      if (type === "ping") {
        send(JSON.stringify({ action: "pong" }));
        return;
      }
      if (type === "auth" || type === "authenticated") authenticated = true;
      const error = record["error"] ?? record["errorMsg"];
      if (typeof error === "string" && error) {
        errors += 1;
        lastError = error;
        return;
      }
    }
    const nowMs = clock().now();
    const read = readSampleFromPayload(payload, nowMs);
    if (!read) return;
    if (read.sequence !== null && lastSequence !== null && read.sequence > lastSequence + 1) {
      sequenceGaps += 1;
    }
    if (read.sequence !== null) lastSequence = read.sequence;
    latest = {
      price: read.price,
      atMs: read.sourceMs ?? nowMs,
      latencyMs: read.sourceMs === null ? null : Math.max(0, nowMs - read.sourceMs),
      sequence: read.sequence,
    };
    samples += 1;
    lastSuccessAt = nowMs;
    lastError = null;
  }

  function connect(): void {
    if (stopped) return;
    if (typeof WebSocket === "undefined") {
      lastError = "WebSocket is not available in this runtime";
      return;
    }
    const missing = missingConfiguration(config);
    if (missing.length) return;
    try {
      endpoint = connectUrl(config);
      const next = new WebSocket(endpoint);
      socket = next;
      next.onopen = () => {
        connected = true;
        attempt = 0;
        lastMessageAt = clock().now();
        const auth = authFrame(config);
        if (auth) send(auth);
        else authenticated = true;
        send(subscribeFrame(config));
        log.info("rtds connected", { endpoint, symbol: config.symbol });
      };
      next.onmessage = (event: MessageEvent) => {
        ingest(typeof event.data === "string" ? event.data : String(event.data));
      };
      next.onerror = () => {
        errors += 1;
        lastError = "socket error";
      };
      next.onclose = () => {
        connected = false;
        authenticated = false;
        if (!stopped) reconnect();
      };
    } catch (error) {
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
      reconnect();
    }
  }

  function reconnect(): void {
    if (stopped || reconnectTimer) return;
    reconnects += 1;
    attempt += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 6));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    if (reconnectTimer && typeof reconnectTimer === "object" && "unref" in reconnectTimer) {
      (reconnectTimer as { unref: () => void }).unref();
    }
  }

  function close(): void {
    connected = false;
    authenticated = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    try {
      socket?.close();
    } catch {
      // already closed
    }
    socket = undefined;
  }

  function describe(): TwapProviderDescription {
    return {
      endpoint: endpoint ?? (config.url || null),
      environment: config.environment,
      symbol: config.symbol,
      authType: config.authType,
      transport: "websocket",
    };
  }

  function resolveState(): { state: TwapProviderState; reason: string; action: string | null } {
    if (!config.enabled) {
      return {
        state: "DISABLED",
        reason: "RTDS is disabled by configuration",
        action: "Set RTDS_ENABLED=true to use RTDS as the settlement source",
      };
    }
    const missing = missingConfiguration(config);
    if (missing.length) {
      return {
        state: "NOT_CONFIGURED",
        reason: `missing configuration: ${missing.join(", ")}`,
        action: `Set ${missing.join(", ")} in .env and restart SPACE`,
      };
    }
    if (stopped) {
      return { state: "WAITING", reason: "provider not started", action: null };
    }
    if (typeof WebSocket === "undefined") {
      return {
        state: "FAILED",
        reason: "WebSocket is not available in this runtime",
        action: "Run SPACE on the Node.js runtime used in production",
      };
    }
    if (!connected) {
      return {
        state: errors > 0 && lastError ? "FAILED" : "WAITING",
        reason: lastError ?? "connecting to RTDS",
        action: lastError ? "Verify RTDS_WS_URL and credentials" : null,
      };
    }
    if (!latest) {
      return { state: "WAITING", reason: "subscribed, awaiting first price", action: null };
    }
    const ageMs = clock().now() - latest.atMs;
    if (ageMs > STALE_MS) {
      return {
        state: "WAITING",
        reason: `last RTDS price is ${Math.round(ageMs / 1000)}s old`,
        action: null,
      };
    }
    return { state: "CONNECTED", reason: `streaming ${config.symbol} settlement price`, action: null };
  }

  return {
    id: "rtds",
    label: "Polymarket RTDS",
    describe,

    async start() {
      config = readConfig();
      if (!config.enabled) {
        stopped = true;
        log.warn("rtds disabled", { reason: "RTDS_ENABLED=false" });
        return;
      }
      const missing = missingConfiguration(config);
      stopped = false;
      if (missing.length) {
        lastError = `missing configuration: ${missing.join(", ")}`;
        log.warn("rtds not configured", { missing });
        return;
      }
      connect();
    },

    async stop() {
      stopped = true;
      close();
      log.info("rtds stopped", { samples, reconnects });
    },

    // Watchdog only: the socket streams, the scheduler owns the timer.
    async poll() {
      if (stopped || !config.enabled) return;
      if (missingConfiguration(config).length) return;
      const stale = lastMessageAt !== null && clock().now() - lastMessageAt > STALE_MS;
      if (!connected || stale) {
        if (stale) lastError = `no RTDS message for ${STALE_MS}ms`;
        close();
        reconnect();
      }
    },

    latest: () => latest,

    status(): TwapProviderStatus {
      const resolved = resolveState();
      const description = describe();
      return {
        id: "rtds",
        label: "Polymarket RTDS",
        state: resolved.state,
        reason: resolved.reason,
        action: resolved.action,
        tradingImpact:
          resolved.state === "CONNECTED"
            ? "None — settlement TWAP is being built from live RTDS prices"
            : "Settlement TWAP cannot be computed while this provider is the active source",
        endpoint: description.endpoint,
        environment: description.environment,
        symbol: description.symbol,
        authType: authenticated ? `${config.authType} (authenticated)` : config.authType,
        transport: description.transport,
        price: latest?.price ?? null,
        freshnessMs: latest === null ? null : clock().now() - latest.atMs,
        latencyMs: latest?.latencyMs ?? null,
        reconnects,
        samples,
        errors,
        sequence: lastSequence,
        sequenceGaps,
        lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
        lastMessageAt: lastMessageAt === null ? null : new Date(lastMessageAt).toISOString(),
        lastError,
      };
    },
  };
}