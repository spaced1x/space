import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import {
  pollRtdsSocket,
  rtdsSocketStats,
  rtdsTopicUnavailable,
  startRtdsSocket,
  subscribeRtdsTopic,
  type RtdsUpdate,
} from "./rtds-socket.server";
import type {
  TwapProvider,
  TwapProviderDescription,
  TwapProviderId,
  TwapProviderState,
  TwapProviderStatus,
  TwapSample,
} from "./provider";

// Polymarket RTDS settlement TWAP providers.
//
// One adapter, parameterised by the documented topic and window. Both the 30s
// and the 60s provider ride the single shared RTDS socket; the price comes from
// `full_accuracy_value` (E18) and the observation time from `payload.timestamp`.
// RTDS is public: no key, no secret, no auth frame.

const log = createLogger("twap-rtds");

export interface RtdsProviderOptions {
  id: TwapProviderId;
  label: string;
  windowSeconds: 30 | 60;
  topic: () => string;
  enabled: () => boolean;
}

export function createRtdsTwapProvider(options: RtdsProviderOptions): TwapProvider {
  let unsubscribe: (() => void) | undefined;
  let started = false;
  let latest: TwapSample | null = null;
  let samples = 0;
  let errors = 0;
  let lastSuccessAt: number | null = null;
  let sequence = 0;
  let lastError: string | null = null;

  function accept(update: RtdsUpdate): void {
    const nowMs = clock().now();
    const atMs = update.sourceMs ?? nowMs;
    const referenceMs = update.publishedMs ?? update.sourceMs;
    sequence += 1;
    latest = {
      price: update.price,
      atMs,
      latencyMs: referenceMs === null ? null : Math.max(0, nowMs - referenceMs),
      sequence,
    };
    samples += 1;
    lastSuccessAt = nowMs;
    lastError = null;
  }

  function describe(): TwapProviderDescription {
    const env = loadEnv();
    return {
      endpoint: env.RTDS_WS_URL,
      environment: env.SPACE_ENVIRONMENT,
      symbol: env.RTDS_SYMBOL,
      // RTDS is documented as a public stream.
      authType: "none (public stream)",
      transport: "websocket",
    };
  }

  function resolveState(): { state: TwapProviderState; reason: string; action: string | null } {
    const env = loadEnv();
    if (!options.enabled()) {
      return {
        state: "DISABLED",
        reason: `${options.label} is disabled by configuration`,
        action: `Enable it in .env to make it selectable`,
      };
    }
    if (!env.RTDS_WS_URL) {
      return {
        state: "NOT_CONFIGURED",
        reason: "missing configuration: RTDS_WS_URL",
        action: "Set RTDS_WS_URL in .env and restart SPACE",
      };
    }
    if (!started) return { state: "WAITING", reason: "provider not started", action: null };

    const socket = rtdsSocketStats();
    if (socket.state === "FAILED") {
      return {
        state: "FAILED",
        reason: socket.lastError ?? "RTDS socket failed",
        action: "Check network egress to the RTDS endpoint, then restart the runtime",
      };
    }
    if (socket.state === "RECONNECTING") {
      return {
        state: "RECONNECTING",
        reason: socket.lastError ?? "reconnecting to RTDS",
        action: null,
      };
    }
    if (!socket.connected) {
      return { state: "WAITING", reason: "connecting to RTDS", action: null };
    }

    const unavailable = rtdsTopicUnavailable(options.topic());
    if (unavailable) {
      return {
        state: "WAITING",
        reason: `RTDS topic ${options.topic()} is not serving yet: ${unavailable}`,
        action: "No action — the topic starts publishing when Polymarket activates it",
      };
    }
    if (!latest) {
      return { state: "WAITING", reason: "subscribed, awaiting first TWAP sample", action: null };
    }
    const ageMs = clock().now() - latest.atMs;
    const staleMs = Math.max(env.RTDS_STALE_MS, options.windowSeconds * 1000 * 2);
    if (ageMs > staleMs) {
      return {
        state: "STALE",
        reason: `last ${options.windowSeconds}s TWAP sample is ${Math.round(ageMs / 1000)}s old`,
        action: null,
      };
    }
    return {
      state: "CONNECTED",
      reason: `streaming ${env.RTDS_SYMBOL} ${options.windowSeconds}s settlement TWAP`,
      action: null,
    };
  }

  return {
    id: options.id,
    label: options.label,
    describe,

    async start() {
      if (started) return;
      if (!options.enabled()) {
        log.warn("rtds provider disabled", { provider: options.id });
        return;
      }
      const env = loadEnv();
      startRtdsSocket();
      unsubscribe = subscribeRtdsTopic(options.topic(), env.RTDS_SYMBOL, accept);
      started = true;
      log.info("rtds provider started", { provider: options.id, topic: options.topic() });
    },

    async stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = undefined;
    },

    async poll() {
      if (!started) return;
      // The shared socket runs its own watchdog; providers only drive the tick.
      pollRtdsSocket();
      const socket = rtdsSocketStats();
      if (socket.lastError) {
        lastError = socket.lastError;
        errors = socket.errors;
      }
    },

    latest: () => latest,

    status(): TwapProviderStatus {
      const resolved = resolveState();
      const description = describe();
      const socket = rtdsSocketStats();
      return {
        id: options.id,
        label: options.label,
        state: resolved.state,
        enabled: options.enabled(),
        active: false,
        windowSeconds: options.windowSeconds,
        reason: resolved.reason,
        action: resolved.action,
        tradingImpact:
          resolved.state === "CONNECTED"
            ? "None — settlement TWAP is being read from the official RTDS stream"
            : "Settlement TWAP cannot be computed while this provider is the active source",
        endpoint: description.endpoint,
        environment: description.environment,
        symbol: description.symbol,
        authType: description.authType,
        transport: `websocket topic ${options.topic()}`,
        price: latest?.price ?? null,
        freshnessMs: latest === null ? null : clock().now() - latest.atMs,
        latencyMs: latest?.latencyMs ?? null,
        reconnects: socket.reconnects,
        samples,
        errors: errors || socket.errors,
        sequence: latest?.sequence ?? null,
        sequenceGaps: 0,
        lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
        lastMessageAt: socket.lastMessageAt,
        lastError: lastError ?? socket.lastError,
      };
    },
  };
}
