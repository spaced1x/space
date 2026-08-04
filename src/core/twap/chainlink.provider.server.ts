import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import { createWsClient, type WsClient } from "../shared/ws-client.server";
import type {
  TwapProvider,
  TwapProviderDescription,
  TwapProviderState,
  TwapProviderStatus,
  TwapSample,
} from "./provider";

// Chainlink Data Streams settlement provider (third provider).
//
// Transport is the official Data Streams WebSocket (report schema V2) with the
// feed ID and API credentials supplied by configuration. It stays disabled
// until an operator provides credentials; it is registered and observable in
// every runtime so the operator can see exactly why it is unavailable.

const log = createLogger("twap-chainlink-streams");

interface StreamsConfig {
  enabled: boolean;
  wsUrl: string;
  httpUrl: string;
  feedId: string;
  apiKey: string;
  apiSecret: string;
  environment: string;
}

function readConfig(): StreamsConfig {
  const env = loadEnv();
  return {
    enabled: env.CHAINLINK_STREAMS_ENABLED,
    wsUrl: env.CHAINLINK_STREAMS_WS_URL,
    httpUrl: env.CHAINLINK_STREAMS_HTTP_URL,
    feedId: env.CHAINLINK_STREAMS_FEED_ID ?? "",
    apiKey: env.CHAINLINK_STREAMS_API_KEY ?? "",
    apiSecret: env.CHAINLINK_STREAMS_API_SECRET ?? "",
    environment: env.SPACE_ENVIRONMENT,
  };
}

function missingConfiguration(config: StreamsConfig): string[] {
  const missing: string[] = [];
  if (!config.feedId) missing.push("CHAINLINK_STREAMS_FEED_ID");
  if (!config.apiKey) missing.push("CHAINLINK_STREAMS_API_KEY");
  if (!config.apiSecret) missing.push("CHAINLINK_STREAMS_API_SECRET");
  if (!config.wsUrl) missing.push("CHAINLINK_STREAMS_WS_URL");
  return missing;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    // Data Streams reports carry 18-decimal fixed-point integers.
    if (/^-?\d{15,}$/.test(trimmed)) {
      try {
        return Number(BigInt(trimmed)) / 1e18;
      } catch {
        return null;
      }
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function createChainlinkStreamsProvider(): TwapProvider {
  let config = readConfig();
  let client: WsClient | undefined;
  let started = false;
  let latest: TwapSample | null = null;
  let samples = 0;
  let errors = 0;
  let sequence = 0;
  let lastSuccessAt: number | null = null;
  let lastError: string | null = null;

  function ingest(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, boolean | number | string | object>;
    const report = (record["report"] ?? record) as Record<string, unknown>;
    const price = readNumber(report["benchmarkPrice"] ?? report["price"] ?? report["mid"]);
    if (price === null || price <= 0) return;
    const observationMs = readNumber(report["observationsTimestamp"]);
    const nowMs = clock().now();
    const atMs = observationMs === null ? nowMs : Math.round(observationMs * 1000);
    sequence += 1;
    latest = {
      price,
      atMs,
      latencyMs: Math.max(0, nowMs - atMs),
      sequence,
    };
    samples += 1;
    lastSuccessAt = nowMs;
    lastError = null;
  }

  function describe(): TwapProviderDescription {
    return {
      endpoint: config.wsUrl || config.httpUrl || null,
      environment: config.environment,
      symbol: "BTC/USD",
      authType: config.apiKey ? "api key (configured)" : "api key (not configured)",
      transport: "websocket",
    };
  }

  function resolveState(): { state: TwapProviderState; reason: string; action: string | null } {
    if (!config.enabled) {
      return {
        state: "DISABLED",
        reason: "Chainlink Data Streams is registered but disabled by configuration",
        action: "Set CHAINLINK_STREAMS_ENABLED=true once credentials exist",
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
    if (!started) return { state: "WAITING", reason: "provider not started", action: null };
    const stats = client?.stats();
    if (stats?.state === "FAILED") {
      return {
        state: "FAILED",
        reason: stats.lastError ?? "Data Streams socket failed",
        action: "Verify the feed ID and API credentials, then restart the runtime",
      };
    }
    if (stats?.state === "RECONNECTING") {
      return { state: "RECONNECTING", reason: stats.lastError ?? "reconnecting", action: null };
    }
    if (!latest) {
      return { state: "WAITING", reason: "awaiting first Data Streams report", action: null };
    }
    const ageMs = clock().now() - latest.atMs;
    if (ageMs > 60_000) {
      return {
        state: "STALE",
        reason: `last report is ${Math.round(ageMs / 1000)}s old`,
        action: null,
      };
    }
    return { state: "CONNECTED", reason: "streaming BTC/USD Data Streams reports", action: null };
  }

  return {
    id: "chainlink_streams",
    label: "Chainlink Data Streams",
    describe,

    async start() {
      config = readConfig();
      if (!config.enabled || missingConfiguration(config).length) {
        started = false;
        log.warn("chainlink data streams idle", {
          enabled: config.enabled,
          missing: missingConfiguration(config),
        });
        return;
      }
      const env = loadEnv();
      client = createWsClient({
        name: "chainlink-streams",
    faultTarget: "chainlink",
        url: () => {
          const url = new URL(config.wsUrl);
          url.pathname = url.pathname === "/" ? "/api/v1/ws" : url.pathname;
          url.searchParams.set("feedIDs", config.feedId);
          return url.toString();
        },
        onMessage: ingest,
        staleMs: 60_000,
        maxAttempts: env.WS_MAX_RECONNECT_ATTEMPTS,
        maxBackoffMs: env.WS_MAX_BACKOFF_MS,
      });
      client.start();
      started = true;
    },

    async stop() {
      started = false;
      client?.stop();
      client = undefined;
    },

    async poll() {
      if (!started) return;
      client?.tick();
      const stats = client?.stats();
      if (stats?.lastError) {
        lastError = stats.lastError;
        errors = stats.errors;
      }
    },

    latest: () => latest,

    status(): TwapProviderStatus {
      config = readConfig();
      const resolved = resolveState();
      const description = describe();
      const stats = client?.stats();
      return {
        id: "chainlink_streams",
        label: "Chainlink Data Streams",
        state: resolved.state,
        enabled: config.enabled,
        active: false,
        windowSeconds: null,
        reason: resolved.reason,
        action: resolved.action,
        tradingImpact:
          resolved.state === "CONNECTED"
            ? "None — able to serve settlement prices when promoted"
            : "No impact while this provider is not the active source",
        endpoint: description.endpoint,
        environment: description.environment,
        symbol: description.symbol,
        authType: description.authType,
        transport: description.transport,
        price: latest?.price ?? null,
        freshnessMs: latest === null ? null : clock().now() - latest.atMs,
        latencyMs: latest?.latencyMs ?? null,
        reconnects: stats?.reconnects ?? 0,
        samples,
        errors: errors || (stats?.errors ?? 0),
        sequence: latest?.sequence ?? null,
        sequenceGaps: 0,
        lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
        lastMessageAt: stats?.lastMessageAt ?? null,
        lastError: lastError ?? stats?.lastError ?? null,
      };
    },
  };
}
