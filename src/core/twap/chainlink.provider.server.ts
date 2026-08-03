import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { createChainlinkFeed } from "../feeds/chainlink.server";
import type { PriceFeed, PriceSample } from "../feeds/types";
import { createLogger } from "../logging/logger";
import type {
  TwapProvider,
  TwapProviderDescription,
  TwapProviderState,
  TwapProviderStatus,
  TwapSample,
} from "./provider";

// Chainlink settlement provider. It wraps the existing Chainlink integration
// (the on-chain BTC/USD aggregator read through POLYGON_RPC_URL) behind the
// provider contract, and recognises Chainlink Data Streams configuration for
// the day those credentials arrive. It is the second provider: registered,
// observable, and awaiting credentials until an operator enables it.

const log = createLogger("twap-chainlink");
const STALE_MS = 120_000;

interface ChainlinkConfig {
  enabled: boolean;
  streamId: string;
  wsUrl: string;
  httpUrl: string;
  apiKey: string;
  apiSecret: string;
  rpcUrl: string;
  aggregator: string;
  environment: string;
}

function readConfig(): ChainlinkConfig {
  const env = loadEnv();
  return {
    enabled: env.CHAINLINK_ENABLED,
    streamId: env.CHAINLINK_STREAM_ID ?? "",
    wsUrl: env.CHAINLINK_WS_URL ?? "",
    httpUrl: env.CHAINLINK_HTTP_URL ?? "",
    apiKey: env.CHAINLINK_API_KEY ?? "",
    apiSecret: env.CHAINLINK_API_SECRET ?? "",
    rpcUrl: env.POLYGON_RPC_URL ?? "",
    aggregator: env.CHAINLINK_BTC_USD_FEED,
    environment: env.SPACE_ENVIRONMENT,
  };
}

/** Data Streams mode is selected by configuration, never by code. */
function streamsMode(config: ChainlinkConfig): boolean {
  return Boolean(config.streamId || config.wsUrl || config.httpUrl);
}

function missingConfiguration(config: ChainlinkConfig): string[] {
  const missing: string[] = [];
  if (streamsMode(config)) {
    if (!config.streamId) missing.push("CHAINLINK_STREAM_ID");
    if (!config.httpUrl && !config.wsUrl) missing.push("CHAINLINK_HTTP_URL");
    if (!config.apiKey) missing.push("CHAINLINK_API_KEY");
    if (!config.apiSecret) missing.push("CHAINLINK_API_SECRET");
    return missing;
  }
  if (!config.rpcUrl) missing.push("POLYGON_RPC_URL");
  return missing;
}

export function createChainlinkTwapProvider(): TwapProvider {
  let config = readConfig();
  let feed: PriceFeed | undefined;
  let started = false;
  let latest: TwapSample | null = null;
  let samples = 0;
  let errors = 0;
  let lastSuccessAt: number | null = null;
  let lastMessageAt: number | null = null;
  let lastError: string | null = null;

  function accept(sample: PriceSample): void {
    const observedMs = Date.parse(sample.observedAt);
    const sourceMs = sample.sourceAt === null ? null : Date.parse(sample.sourceAt);
    latest = {
      price: sample.price,
      atMs: Number.isFinite(sourceMs ?? NaN) ? (sourceMs as number) : observedMs,
      latencyMs: sample.latencyMs,
      sequence: null,
    };
    samples += 1;
    lastSuccessAt = observedMs;
    lastMessageAt = observedMs;
    lastError = null;
  }

  function describe(): TwapProviderDescription {
    return {
      endpoint: streamsMode(config)
        ? config.wsUrl || config.httpUrl || null
        : config.rpcUrl
          ? `${config.aggregator} @ Polygon RPC`
          : null,
      environment: config.environment,
      symbol: "BTC/USD",
      authType: streamsMode(config) ? "api_key" : "none",
      transport: streamsMode(config) ? (config.wsUrl ? "websocket" : "https") : "json-rpc",
    };
  }

  function resolveState(): { state: TwapProviderState; reason: string; action: string | null } {
    if (!config.enabled) {
      return {
        state: "DISABLED",
        reason: "Chainlink is registered but disabled by configuration",
        action: "Set CHAINLINK_ENABLED=true to make Chainlink selectable",
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
    if (streamsMode(config)) {
      return {
        state: "WAITING",
        reason: "Chainlink Data Streams credentials present, stream not yet established",
        action: "Verify CHAINLINK_STREAM_ID and the Data Streams endpoint",
      };
    }
    if (!started) return { state: "WAITING", reason: "provider not started", action: null };
    if (!latest) {
      return {
        state: lastError ? "FAILED" : "WAITING",
        reason: lastError ?? "awaiting first Chainlink answer",
        action: lastError ? "Verify POLYGON_RPC_URL reachability" : null,
      };
    }
    const ageMs = clock().now() - latest.atMs;
    if (ageMs > STALE_MS) {
      return {
        state: "WAITING",
        reason: `last aggregator answer is ${Math.round(ageMs / 1000)}s old`,
        action: null,
      };
    }
    return { state: "CONNECTED", reason: "BTC/USD aggregator answer fresh", action: null };
  }

  return {
    id: "chainlink",
    label: "Chainlink",
    describe,

    async start() {
      config = readConfig();
      if (!config.enabled || streamsMode(config) || missingConfiguration(config).length) {
        started = false;
        log.warn("chainlink provider idle", {
          enabled: config.enabled,
          missing: missingConfiguration(config),
        });
        return;
      }
      feed = createChainlinkFeed((sample) => accept(sample));
      await feed.start();
      started = true;
    },

    async stop() {
      started = false;
      await feed?.stop();
      feed = undefined;
    },

    async poll() {
      if (!started || !feed) return;
      await feed.poll();
      const stats = feed.stats();
      if (stats.lastError) {
        errors = stats.errors;
        lastError = stats.lastError;
      }
      lastMessageAt = clock().now();
    },

    latest: () => latest,

    status(): TwapProviderStatus {
      const resolved = resolveState();
      const description = describe();
      return {
        id: "chainlink",
        label: "Chainlink",
        state: resolved.state,
        reason: resolved.reason,
        action: resolved.action,
        tradingImpact:
          resolved.state === "CONNECTED"
            ? "None — able to serve settlement prices when selected"
            : "No impact while Chainlink is not the active provider",
        endpoint: description.endpoint,
        environment: description.environment,
        symbol: description.symbol,
        authType: description.authType,
        transport: description.transport,
        price: latest?.price ?? null,
        freshnessMs: latest === null ? null : clock().now() - latest.atMs,
        latencyMs: latest?.latencyMs ?? null,
        reconnects: 0,
        samples,
        errors,
        sequence: null,
        sequenceGaps: 0,
        lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
        lastMessageAt: lastMessageAt === null ? null : new Date(lastMessageAt).toISOString(),
        lastError,
      };
    },
  };
}