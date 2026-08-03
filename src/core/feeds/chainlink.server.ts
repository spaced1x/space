import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import type { HealthResult } from "../health/types";
import type { FeedStats, PriceFeed, PriceSample } from "./types";

// Chainlink adapter: latest answer, its on-chain timestamp and the round-trip
// latency. Pull feed — the scheduler decides when it runs. No strategy here.

const log = createLogger("chainlink-feed");
// latestRoundData() selector; the aggregator returns 8-decimal BTC/USD.
const SELECTOR = "0xfeaf968c";
const DECIMALS = 8n;
const STALE_MS = 120_000;

function decodeLatestRoundData(hex: string): { answer: bigint; updatedAt: number } | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length < 64 * 5) return null;
  const word = (index: number) => BigInt(`0x${body.slice(index * 64, (index + 1) * 64)}`);
  const answer = word(1);
  const updatedAt = Number(word(3));
  if (answer <= 0n || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  return { answer, updatedAt };
}

export function createChainlinkFeed(onSample: (sample: PriceSample) => void): PriceFeed {
  let stopped = true;
  let configured = false;
  let rpcUrl = "";
  let feedAddress = "";
  let latest: PriceSample | null = null;
  let reads = 0;
  let errors = 0;
  let lastError: string | null = null;

  async function read(): Promise<void> {
    const startedAt = clock().now();
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: feedAddress, data: SELECTOR }, "latest"],
      }),
    });
    if (!response.ok) throw new Error(`rpc ${response.status}`);
    const payload = (await response.json()) as { result?: string; error?: { message?: string } };
    if (payload.error) throw new Error(payload.error.message ?? "rpc error");
    const decoded = decodeLatestRoundData(payload.result ?? "");
    if (!decoded) throw new Error("unreadable latestRoundData response");

    const price = Number(decoded.answer) / Number(10n ** DECIMALS);
    const observedMs = clock().now();
    const sample: PriceSample = {
      source: "CHAINLINK",
      symbol: "BTC/USD",
      price,
      observedAt: new Date(observedMs).toISOString(),
      sourceAt: new Date(decoded.updatedAt * 1000).toISOString(),
      latencyMs: observedMs - startedAt,
    };
    latest = sample;
    reads += 1;
    lastError = null;
    onSample(sample);
  }

  return {
    name: "chainlink",
    source: "CHAINLINK",

    async start() {
      const env = loadEnv();
      rpcUrl = env.POLYGON_RPC_URL ?? "";
      feedAddress = env.CHAINLINK_BTC_USD_FEED;
      configured = rpcUrl.length > 0;
      stopped = false;
      if (!configured) {
        lastError = "POLYGON_RPC_URL not configured";
        log.warn("chainlink feed idle", { reason: lastError });
      }
    },

    async stop() {
      stopped = true;
    },

    async poll() {
      if (stopped || !configured) return;
      try {
        await read();
      } catch (error) {
        errors += 1;
        lastError = error instanceof Error ? error.message : String(error);
      }
    },

    latest: () => latest,

    stats(): FeedStats {
      return {
        connected: configured && lastError === null,
        state: stopped
          ? "IDLE"
          : !configured
            ? "IDLE"
            : lastError
              ? "RECONNECTING"
              : "CONNECTED",
        samples: reads,
        errors,
        reconnects: 0,
        lastError,
        lastSampleAt: latest?.observedAt ?? null,
        latencyMs: latest?.latencyMs ?? null,
        lastSequence: null,
        lastUpdateAt: latest?.observedAt ?? null,
        endpoint: feedAddress,
      };
    },

    health(): HealthResult {
      const details = {
        feed: feedAddress,
        configured,
        reads,
        errors,
        price: latest?.price ?? null,
        latencyMs: latest?.latencyMs ?? null,
        sourceAt: latest?.sourceAt ?? null,
      };
      if (stopped) return { state: "DISABLED", message: "chainlink feed not started", details };
      if (!configured) {
        return { state: "DISABLED", message: "no POLYGON_RPC_URL configured", details };
      }
      if (!latest) {
        return {
          state: "DEGRADED",
          message: lastError ?? "awaiting first chainlink read",
          details,
        };
      }
      const ageMs = clock().now() - Date.parse(latest.observedAt);
      const healthy = lastError === null && ageMs <= STALE_MS;
      return {
        state: healthy ? "OK" : "DEGRADED",
        message: healthy ? "BTC/USD answer fresh" : (lastError ?? `answer ${ageMs}ms old`),
        details: { ...details, ageMs },
      };
    },
  };
}