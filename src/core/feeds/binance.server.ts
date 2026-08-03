import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import { createWsClient, type WsClient } from "../shared/ws-client.server";
import type { HealthResult } from "../health/types";
import type { FeedStats, PriceFeed, PriceSample } from "./types";

// Binance WebSocket adapter: streaming price only. No TWAP, no strategy.
//
// Runtime contract: official Binance endpoint from configuration, heartbeat
// monitoring, exponential backoff with jitter, automatic resubscribe after
// every reconnect, stale price detection, last update timestamp and sequence,
// and measured latency. A price is never fabricated or carried past staleness.

const log = createLogger("binance-feed");

interface TradeMessage {
  e?: string;
  E?: number;
  s?: string;
  p?: string;
  t?: number;
  a?: number;
}

export function createBinanceFeed(onSample: (sample: PriceSample) => void): PriceFeed {
  let client: WsClient | undefined;
  let stopped = true;
  let latest: PriceSample | null = null;
  let samples = 0;
  let parseErrors = 0;
  let lastSequence: number | null = null;
  let lastUpdateMs: number | null = null;
  let symbol = "BTCUSDT";
  let staleMs = 15_000;
  let stream = "";

  function endpoint(): string {
    const env = loadEnv();
    symbol = env.BINANCE_SYMBOL.toUpperCase();
    stream = `${symbol.toLowerCase()}@trade`;
    return `${env.BINANCE_WS_URL.replace(/\/$/, "")}/${stream}`;
  }

  function ingest(raw: string): void {
    let parsed: TradeMessage;
    try {
      parsed = JSON.parse(raw) as TradeMessage;
    } catch {
      parseErrors += 1;
      return;
    }
    if (parsed.e !== "trade" && parsed.e !== "aggTrade") return;
    const price = Number(parsed.p);
    if (!Number.isFinite(price) || price <= 0) {
      parseErrors += 1;
      return;
    }
    const observedMs = clock().now();
    const sourceMs = typeof parsed.E === "number" ? parsed.E : null;
    lastSequence = parsed.t ?? parsed.a ?? null;
    lastUpdateMs = observedMs;
    latest = {
      source: "BINANCE",
      symbol: (parsed.s ?? symbol).toUpperCase(),
      price,
      observedAt: new Date(observedMs).toISOString(),
      sourceAt: sourceMs === null ? null : new Date(sourceMs).toISOString(),
      latencyMs: sourceMs === null ? null : Math.max(0, observedMs - sourceMs),
    };
    samples += 1;
    onSample(latest);
  }

  function isStale(): boolean {
    return lastUpdateMs !== null && clock().now() - lastUpdateMs > staleMs;
  }

  return {
    name: "binance",
    source: "BINANCE",

    async start() {
      const env = loadEnv();
      staleMs = env.BINANCE_STALE_MS;
      stopped = false;
      client = createWsClient({
        name: "binance",
        // Resubscription is the stream path itself: a reconnect re-opens the
        // documented combined-stream URL for the configured symbol.
        url: endpoint,
        onMessage: ingest,
        staleMs,
        maxAttempts: env.WS_MAX_RECONNECT_ATTEMPTS,
        maxBackoffMs: env.WS_MAX_BACKOFF_MS,
      });
      client.start();
      log.info("binance feed started", { symbol, stream });
    },

    async stop() {
      stopped = true;
      client?.stop();
      client = undefined;
      log.info("binance feed stopped", { samples });
    },

    // Heartbeat watchdog. The scheduler owns the timer; the feed only reacts.
    async poll() {
      if (stopped) return;
      client?.tick();
    },

    latest: () => latest,

    stats(): FeedStats {
      const socket = client?.stats();
      const stale = isStale();
      return {
        connected: socket?.connected ?? false,
        state: stopped ? "IDLE" : stale && socket?.state === "CONNECTED" ? "STALE" : (socket?.state ?? "IDLE"),
        samples,
        errors: (socket?.errors ?? 0) + parseErrors,
        reconnects: socket?.reconnects ?? 0,
        lastError: socket?.lastError ?? null,
        lastSampleAt: latest?.observedAt ?? null,
        latencyMs: latest?.latencyMs ?? null,
        lastSequence,
        lastUpdateAt: lastUpdateMs === null ? null : new Date(lastUpdateMs).toISOString(),
        endpoint: socket?.endpoint ?? null,
      };
    },

    health(): HealthResult {
      const stats = this.stats();
      const details = {
        endpoint: stats.endpoint,
        symbol,
        stream,
        state: stats.state,
        connected: stats.connected,
        samples,
        errors: stats.errors,
        reconnects: stats.reconnects,
        lastSequence,
        ageMs: lastUpdateMs === null ? null : clock().now() - lastUpdateMs,
        price: latest?.price ?? null,
        latencyMs: latest?.latencyMs ?? null,
        staleMs,
      };
      if (stopped) {
        return { state: "DISABLED", message: "binance feed not started", details };
      }
      if (stats.state === "FAILED") {
        return {
          state: "FAILED",
          message: stats.lastError ?? "binance stream failed after its retry budget",
          details,
        };
      }
      if (stats.state === "CONNECTED" && !isStale() && latest) {
        return { state: "OK", message: `streaming ${symbol}`, details };
      }
      return {
        state: "DEGRADED",
        message:
          stats.state === "STALE"
            ? `no ${symbol} trade for ${staleMs}ms`
            : (stats.lastError ?? `binance stream ${stats.state.toLowerCase()}`),
        details,
      };
    },
  };
}
