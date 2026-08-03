import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import type { HealthResult } from "../health/types";
import type { FeedStats, PriceFeed, PriceSample } from "./types";

// Binance WebSocket adapter: streaming price only. No TWAP, no strategy.
// Auto-reconnect with capped backoff, heartbeat/staleness watchdog, latency
// measurement from the venue event timestamp, and strict message validation.

const log = createLogger("binance-feed");
const STALE_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

interface TradeMessage {
  e?: string;
  E?: number;
  s?: string;
  p?: string;
}

function parseTrade(raw: unknown, symbol: string): PriceSample | null {
  if (typeof raw !== "string") return null;
  let parsed: TradeMessage;
  try {
    parsed = JSON.parse(raw) as TradeMessage;
  } catch {
    return null;
  }
  if (parsed.e !== "trade" && parsed.e !== "aggTrade") return null;
  const price = Number(parsed.p);
  if (!Number.isFinite(price) || price <= 0) return null;
  const observedMs = clock().now();
  const sourceMs = typeof parsed.E === "number" ? parsed.E : null;
  return {
    source: "BINANCE",
    symbol: (parsed.s ?? symbol).toUpperCase(),
    price,
    observedAt: new Date(observedMs).toISOString(),
    sourceAt: sourceMs === null ? null : new Date(sourceMs).toISOString(),
    latencyMs: sourceMs === null ? null : Math.max(0, observedMs - sourceMs),
  };
}

export function createBinanceFeed(onSample: (sample: PriceSample) => void): PriceFeed {
  let socket: WebSocket | undefined;
  let stopped = true;
  let connected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let latest: PriceSample | null = null;
  let lastMessageAt: number | null = null;
  let samples = 0;
  let errors = 0;
  let reconnects = 0;
  let lastError: string | null = null;
  let url = "";
  let symbol = "BTCUSDT";

  function connect(): void {
    if (stopped) return;
    if (typeof WebSocket === "undefined") {
      lastError = "WebSocket is not available in this runtime";
      return;
    }
    try {
      const next = new WebSocket(url);
      socket = next;
      next.onopen = () => {
        connected = true;
        attempt = 0;
        lastMessageAt = clock().now();
        log.info("binance connected", { url });
      };
      next.onmessage = (event: MessageEvent) => {
        lastMessageAt = clock().now();
        const sample = parseTrade(
          typeof event.data === "string" ? event.data : String(event.data),
          symbol,
        );
        if (!sample) return;
        latest = sample;
        samples += 1;
        onSample(sample);
      };
      next.onerror = () => {
        errors += 1;
        lastError = "socket error";
      };
      next.onclose = () => {
        connected = false;
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
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    try {
      socket?.close();
    } catch {
      // already closed
    }
    socket = undefined;
  }

  return {
    name: "binance",
    source: "BINANCE",

    async start() {
      const env = loadEnv();
      symbol = env.BINANCE_SYMBOL.toUpperCase();
      url = `${env.BINANCE_WS_URL.replace(/\/$/, "")}/${symbol.toLowerCase()}@trade`;
      stopped = false;
      connect();
    },

    async stop() {
      stopped = true;
      close();
      log.info("binance feed stopped", { samples, reconnects });
    },

    // Heartbeat watchdog. The scheduler owns the timer; the feed only reacts.
    async poll() {
      if (stopped) return;
      const stale = lastMessageAt !== null && clock().now() - lastMessageAt > STALE_MS;
      if (!connected || stale) {
        if (stale) lastError = `no message for ${STALE_MS}ms`;
        close();
        reconnect();
      }
    },

    latest: () => latest,

    stats(): FeedStats {
      return {
        connected,
        samples,
        errors,
        reconnects,
        lastError,
        lastSampleAt: latest?.observedAt ?? null,
        latencyMs: latest?.latencyMs ?? null,
      };
    },

    health(): HealthResult {
      if (stopped) {
        return { state: "DISABLED", message: "binance feed not started", details: { url } };
      }
      const ageMs = lastMessageAt === null ? null : clock().now() - lastMessageAt;
      const healthy = connected && ageMs !== null && ageMs <= STALE_MS;
      return {
        state: healthy ? "OK" : "DEGRADED",
        message: healthy
          ? `streaming ${symbol}`
          : (lastError ?? "connecting to binance stream"),
        details: {
          url,
          symbol,
          connected,
          samples,
          errors,
          reconnects,
          ageMs,
          price: latest?.price ?? null,
          latencyMs: latest?.latencyMs ?? null,
        },
      };
    },
  };
}