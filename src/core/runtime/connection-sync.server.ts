import { loadEnv } from "../config/env.server";
import { databaseHealth } from "../db/database.server";
import { chainCheck, walletStatus } from "../execution/wallet.server";
import { polymarketAdapter } from "../execution/polymarket.server";
import { rateLimitStatus } from "../execution/rate-limit.server";
import { feeds } from "../engine/loop.server";
import { discoveryStats } from "../market/discovery.server";
import { getMarketState } from "../market/state";
import { schedulerStatus } from "../scheduler/scheduler.server";
import { strategySnapshot } from "../strategy/strategy.server";
import { telegramHealth } from "../telegram/telegram.service";
import { reportConnection } from "./connections.server";

// Adapters already track their own statistics. This module is the single place
// that projects those live statistics into the connection registry, so the
// registry never duplicates polling and never holds a value nobody observed.

const SIGNATURE_TYPES = ["EOA", "Proxy (email/magic)", "Safe (browser proxy)"] as const;

export function signerLabel(signatureType: number): string {
  return SIGNATURE_TYPES[signatureType] ?? `type ${signatureType}`;
}

export async function syncConnections(): Promise<void> {
  const env = loadEnv();

  await syncDatabase();
  syncScheduler();
  syncWallet();
  syncRpc();
  syncGamma(env.POLYMARKET_GAMMA_URL);
  syncDiscovery();
  syncBinance(env.BINANCE_WS_URL, env.BINANCE_SYMBOL);
  syncTwap();
  syncClob();
  syncTelegram();
}

async function syncDatabase(): Promise<void> {
  const env = loadEnv();
  const health = await databaseHealth();
  const details = (health.details ?? {}) as Record<string, unknown>;
  reportConnection("sqlite", {
    state: health.state === "OK" ? "CONNECTED" : health.state === "FAILED" ? "FAILED" : "DEGRADED",
    reason: health.message,
    endpoint: env.DB_PATH,
    latencyMs: typeof details["latencyMs"] === "number" ? details["latencyMs"] : null,
    lastError: health.state === "OK" ? null : health.message,
    blocksTrading: health.state !== "OK",
    recovery: health.state === "OK" ? "n/a" : "manual — inspect the database file and restart",
    action: health.state === "OK" ? null : "Check DB_PATH is writable, then restart SPACE",
    details: {
      journalMode: String(details["journalMode"] ?? "WAL"),
      schemaVersion: (details["schemaVersion"] as number | null) ?? null,
      sizeBytes: (details["sizeBytes"] as number | null) ?? null,
      openedAt: (details["openedAt"] as string | null) ?? null,
    },
  });
}

function syncScheduler(): void {
  const status = schedulerStatus();
  const failing = status.tasks.filter((task) => task.lastError);
  reportConnection("scheduler", {
    state: !status.running ? "DISCONNECTED" : failing.length ? "DEGRADED" : "CONNECTED",
    reason: !status.running
      ? "scheduler is not running"
      : failing.length
        ? `${failing.length} task(s) reported an error`
        : `${status.tasks.length} tasks on a ${status.tickMs}ms heartbeat`,
    endpoint: `in-process · ${status.tickMs}ms tick`,
    latencyMs: status.maxTickDriftMs,
    lastError: failing[0]?.lastError ?? null,
    blocksTrading: !status.running,
    recovery: status.running ? "n/a" : "manual — restart SPACE",
    action: status.running ? null : "Restart SPACE to bring the scheduler back",
    details: {
      running: status.running,
      ticks: status.ticks,
      tasks: status.tasks.length,
      maxTickDriftMs: status.maxTickDriftMs,
      startedAt: status.startedAt,
    },
  });
}

function syncWallet(): void {
  const env = loadEnv();
  const status = walletStatus();
  const chain = chainCheck();
  const signer = signerLabel(env.POLYMARKET_SIGNATURE_TYPE);

  const state = !status.hasPrivateKey
    ? "NOT_CONFIGURED"
    : !status.address
      ? "FAILED"
      : chain?.matches === false
        ? "FAILED"
        : status.ready
          ? "CONNECTED"
          : "DEGRADED";

  reportConnection("wallet", {
    state,
    reason: status.reason,
    endpoint: status.address ?? null,
    lastError: state === "FAILED" ? status.reason : null,
    blocksTrading: state !== "CONNECTED",
    recovery:
      state === "CONNECTED" ? "n/a" : "manual — operator must supply valid wallet configuration",
    action:
      state === "CONNECTED"
        ? null
        : !status.hasPrivateKey
          ? "Configure WALLET_PRIVATE_KEY in .env and restart"
          : "Correct the wallet configuration in .env and restart",
    details: {
      address: status.address,
      signerType: signer,
      chainId: status.chainId,
      funder: status.funderAddress,
      apiCredentials: status.hasApiCredentials,
      chainVerified: chain ? chain.matches : null,
    },
  });
}

function syncRpc(): void {
  const env = loadEnv();
  const chain = chainCheck();
  const configured = Boolean(env.POLYGON_RPC_URL);

  reportConnection("polygon_rpc", {
    state: !configured
      ? "NOT_CONFIGURED"
      : chain === null
        ? "WAITING"
        : chain.matches === true
          ? "CONNECTED"
          : chain.matches === false
            ? "FAILED"
            : "DEGRADED",
    reason: !configured
      ? "POLYGON_RPC_URL is unset"
      : (chain?.reason ?? "waiting for the first chain id verification"),
    endpoint: env.POLYGON_RPC_URL ?? null,
    lastError: chain && chain.matches === false ? chain.reason : null,
    lastSuccessAt: chain?.matches ? chain.checkedAt : undefined,
    blocksTrading: !configured || chain?.matches !== true,
    recovery: configured ? "automatic — re-verified before every ARM" : "manual — operator action",
    action: configured ? null : "Configure POLYGON_RPC_URL in .env and restart",
    details: {
      expectedChainId: chain?.expectedChainId ?? null,
      actualChainId: chain?.actualChainId ?? null,
      checkedAt: chain?.checkedAt ?? null,
    },
  });
}

function syncGamma(url: string): void {
  const stats = discoveryStats();
  const limiter = rateLimitStatus().find((entry) => entry.endpoint === "gamma_discovery");

  reportConnection("gamma", {
    state: stats.lastSuccessAt
      ? stats.lastError
        ? "DEGRADED"
        : "CONNECTED"
      : stats.lastError
        ? "DISCONNECTED"
        : stats.refreshes > 0
          ? "CONNECTING"
          : "NOT_STARTED",
    reason: stats.lastError
      ? `last refresh failed: ${stats.lastError}`
      : stats.lastSuccessAt
        ? `${stats.candidatesSeen} markets returned on the last refresh`
        : "waiting for the first Gamma response",
    endpoint: url,
    latencyMs: stats.latencyMs,
    lastSuccessAt: stats.lastSuccessAt,
    lastError: stats.lastError,
    blocksTrading: !stats.lastSuccessAt,
    recovery: "automatic — retried every 20 seconds",
    action: stats.lastError ? "None — SPACE retries automatically" : null,
    details: {
      refreshes: stats.refreshes,
      errors: stats.errors,
      candidatesSeen: stats.candidatesSeen,
      rateLimitRemaining: limiter?.remaining ?? null,
    },
  });
}

function syncDiscovery(): void {
  const market = getMarketState();
  const stats = discoveryStats();
  const active = market.markets.FIVE_MINUTE ?? market.markets.FIFTEEN_MINUTE;

  reportConnection("market_discovery", {
    state: !stats.lastSuccessAt ? "WAITING" : active ? "CONNECTED" : "WAITING",
    reason: !stats.lastSuccessAt
      ? "waiting for the first Gamma refresh"
      : active
        ? `tracking ${active.question || active.slug}`
        : "no active BTC up/down market is open right now",
    endpoint: active?.conditionId ?? null,
    lastSuccessAt: active ? active.discoveredAt : undefined,
    blocksTrading: !active,
    recovery: "automatic — the next market is discovered as soon as it opens",
    action: active ? null : "None — SPACE selects the next BTC market automatically",
    details: {
      fiveMinute: market.markets.FIVE_MINUTE?.slug ?? null,
      fifteenMinute: market.markets.FIFTEEN_MINUTE?.slug ?? null,
      stateVersion: market.version,
      candidatesSeen: stats.candidatesSeen,
    },
  });
}

function syncBinance(url: string, symbol: string): void {
  const feed = feeds().binance;
  const stats = feed?.stats() ?? null;
  const sample = feed?.latest() ?? null;

  reportConnection("binance", {
    state: !feed
      ? "NOT_STARTED"
      : stats?.connected
        ? "CONNECTED"
        : stats?.lastError
          ? "DISCONNECTED"
          : "CONNECTING",
    reason: !feed
      ? "feed adapter not constructed yet"
      : stats?.connected
        ? `${symbol} streaming`
        : (stats?.lastError ?? "opening the websocket"),
    endpoint: url,
    latencyMs: stats?.latencyMs ?? null,
    reconnects: stats?.reconnects ?? 0,
    lastSuccessAt: stats?.lastSampleAt ?? null,
    lastError: stats?.lastError ?? null,
    blocksTrading: !stats?.connected,
    recovery: "automatic — the watchdog reconnects with backoff",
    action: stats?.connected ? null : "None — monitor",
    details: {
      symbol,
      price: sample?.price ?? null,
      samples: stats?.samples ?? 0,
      errors: stats?.errors ?? 0,
    },
  });
}

function syncTwap(): void {
  const strategy = strategySnapshot();
  const twap = strategy.twap;

  reportConnection("twap_provider", {
    state:
      twap.state === "OK"
        ? "CONNECTED"
        : twap.state === "WARMING"
          ? "CONNECTING"
          : twap.state === "STALE"
            ? "DEGRADED"
            : "WAITING",
    reason: twap.message,
    endpoint: "Binance settlement TWAP",
    lastSuccessAt: twap.lastUpdateAt,
    blocksTrading: twap.state !== "OK",
    recovery: "automatic — rebuilt for every settlement window",
    action: twap.state === "OK" ? null : "None — samples accumulate automatically",
    details: {
      value: twap.value,
      samples: twap.samples,
      lengthSeconds: twap.lengthSeconds,
      windowStart: twap.startAt,
      windowEnd: twap.endAt,
    },
  });
}

function syncClob(): void {
  const env = loadEnv();
  const health = polymarketAdapter.health();
  const description = polymarketAdapter.describe();
  const details = (health.details ?? {}) as Record<string, unknown>;
  const wallet = walletStatus();
  const limits = rateLimitStatus();
  const submitLimiter = limits.find((entry) => entry.endpoint === "clob_submit");
  const apiKeyLoaded = Boolean(
    env.POLYMARKET_API_KEY && env.POLYMARKET_API_SECRET && env.POLYMARKET_API_PASSPHRASE,
  );
  const environmentMatch = wallet.chainId === (env.SPACE_ENVIRONMENT === "V1_TESTNET" ? 80002 : 137);

  reportConnection("clob", {
    state: !apiKeyLoaded
      ? "NOT_CONFIGURED"
      : description.ready
        ? health.state === "OK"
          ? "CONNECTED"
          : "DEGRADED"
        : "DISCONNECTED",
    reason: !apiKeyLoaded ? "Polymarket API credentials are not configured" : health.message,
    endpoint: description.host,
    lastError: (details["lastError"] as string | null) ?? null,
    lastSuccessAt: (details["lastCallAt"] as string | null) ?? undefined,
    blocksTrading: !description.ready,
    recovery: description.ready
      ? "automatic — rate limits recover on their own"
      : "manual — operator must configure credentials",
    action: apiKeyLoaded
      ? null
      : "Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET and POLYMARKET_API_PASSPHRASE in .env",
    details: {
      apiVersion: "CLOB v2",
      authenticated: description.ready,
      apiKeyLoaded,
      signatureType: signerLabel(env.POLYMARKET_SIGNATURE_TYPE),
      walletVerified: Boolean(wallet.address) && chainCheck()?.matches !== false,
      environmentMatch,
      lastAuthAt: (details["lastCallAt"] as string | null) ?? null,
      submissions: (details["submissions"] as number | null) ?? 0,
      rateLimitRemaining: submitLimiter?.remaining ?? null,
      rateLimitWindowMs: submitLimiter?.windowMs ?? null,
      total429: submitLimiter?.total429 ?? 0,
      chainId: description.chainId,
    },
  });
}

function syncTelegram(): void {
  const status = telegramHealth();
  reportConnection("telegram", {
    state: status.configured ? "CONNECTED" : "NOT_CONFIGURED",
    reason: status.configured
      ? `bot configured for chat ${status.chatId}`
      : "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is unset",
    endpoint: status.configured ? `chat ${status.chatId}` : null,
    blocksTrading: false,
    recovery: status.configured ? "automatic — outbox retries" : "manual — operator action",
    action: status.configured
      ? null
      : "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable alerts",
    details: { chatId: status.chatId ?? null },
  });
}