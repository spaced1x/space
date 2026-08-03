import { describeEnvReadiness, loadEnv, resolveDbPath } from "../config/env.server";
import { conformanceHealth } from "../config/environment.server";
import { databaseHealth } from "../db/database.server";
import { instanceLockHeld, lockPath } from "../db/lock.server";
import { chainCheck, walletStatus } from "../execution/wallet.server";
import { activeVenue, venueAdapter } from "../execution/adapter.server";
import { rateLimitStatus } from "../execution/rate-limit.server";
import { feeds } from "../engine/loop.server";
import { discoveryStats } from "../market/discovery.server";
import { clobMarketFeedStatus } from "../market/clob-ws.server";
import { getMarketState } from "../market/state";
import { schedulerStatus } from "../scheduler/scheduler.server";
import { strategySnapshot } from "../strategy/strategy.server";
import { telegramHealth } from "../telegram/telegram.service";
import { twapServiceSnapshot } from "../twap/service.server";
import { rtdsSocketStats } from "../twap/rtds-socket.server";
import { lastValidationReport } from "../startup/validation.server";
import { readRuntimeTarget, targetMatchesEnvironment } from "./target.server";
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

  syncConfiguration();
  syncEnvironment();
  await syncDatabase();
  syncDatabaseLock();
  syncRuntimeTarget();
  syncScheduler();
  syncWallet();
  syncRpc();
  syncGamma(env.POLYMARKET_GAMMA_URL);
  syncDiscovery();
  syncBinance(env.BINANCE_WS_URL, env.BINANCE_SYMBOL);
  syncRtds();
  syncChainlinkStreams();
  syncTwapService();
  syncProviderRegistry();
  syncTwap();
  syncClobMarketFeed();
  syncClob();
  syncVenues();
  syncTelegram();
  syncValidator();
}

function syncConfiguration(): void {
  const readiness = describeEnvReadiness();
  reportConnection("configuration", {
    state: !readiness.valid ? "FAILED" : readiness.missingForArmed.length ? "DEGRADED" : "CONNECTED",
    reason: readiness.message,
    endpoint: ".env + operations document",
    lastError: readiness.valid ? null : readiness.message,
    blocksTrading: !readiness.valid,
    recovery: readiness.valid ? "n/a" : "manual — correct .env and restart SPACE",
    action: readiness.missingForArmed.length
      ? `Set ${readiness.missingForArmed.join(", ")} in .env to allow ARM`
      : null,
    details: {
      environment: readiness.environment,
      missingForArmed: readiness.missingForArmed.join(", ") || "none",
    },
  });
}

function syncEnvironment(): void {
  const health = conformanceHealth();
  const details = (health.details ?? {}) as Record<string, unknown>;
  reportConnection("environment", {
    state:
      health.state === "OK"
        ? "CONNECTED"
        : health.state === "FAILED"
          ? "FAILED"
          : health.state === "NOT_INITIALIZED"
            ? "NOT_STARTED"
            : "DEGRADED",
    reason: health.message,
    endpoint: String(details["environment"] ?? loadEnv().SPACE_ENVIRONMENT),
    lastError: health.state === "FAILED" ? health.message : null,
    blocksTrading: health.state === "FAILED",
    recovery: "automatic — re-evaluated on every boot and before every ARM",
    action: health.state === "FAILED" ? "Align .env with the selected environment and restart" : null,
    details: { evaluatedAt: String(details["at"] ?? "never") },
  });
}

async function syncDatabase(): Promise<void> {
  const env = loadEnv();
  const health = await databaseHealth();
  const details = (health.details ?? {}) as Record<string, unknown>;
  reportConnection("sqlite", {
    state: health.state === "OK" ? "CONNECTED" : health.state === "FAILED" ? "FAILED" : "DEGRADED",
    reason: health.message,
    endpoint: resolveDbPath(env),
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

function syncDatabaseLock(): void {
  const held = instanceLockHeld();
  reportConnection("database_lock", {
    state: held ? "CONNECTED" : "FAILED",
    reason: held
      ? "single-instance lock held by this process"
      : "single-instance lock is not held",
    endpoint: lockPath(),
    lastError: held ? null : "lock not acquired",
    blocksTrading: !held,
    recovery: held ? "n/a" : "manual — stop any other SPACE process and restart",
    action: held ? null : "Verify no second SPACE process is running, then restart",
    details: { held },
  });
}

function syncRuntimeTarget(): void {
  const target = readRuntimeTarget();
  const matches = targetMatchesEnvironment();
  reportConnection("runtime_target", {
    state: matches ? "CONNECTED" : "DEGRADED",
    reason: matches
      ? `runtime target agrees with the active environment (${target.environment})`
      : `target requests ${target.environment} but this process runs ${loadEnv().SPACE_ENVIRONMENT}`,
    endpoint: `runtime-target v${target.version}`,
    lastError: matches ? null : "runtime target mismatch",
    blocksTrading: false,
    recovery: matches ? "n/a" : "manual — restart the process to adopt the requested environment",
    action: matches ? null : "Restart SPACE so the requested environment takes effect",
    details: {
      targetEnvironment: target.environment,
      activeEnvironment: loadEnv().SPACE_ENVIRONMENT,
      version: target.version,
      requestedBy: target.requestedBy ?? null,
      updatedAt: target.updatedAt ?? null,
    },
  });
}

function syncRtds(): void {
  const stats = rtdsSocketStats();
  const state: Parameters<typeof reportConnection>[1]["state"] =
    stats.state === "IDLE"
      ? "NOT_STARTED"
      : stats.connected
        ? "CONNECTED"
        : stats.state === "FAILED"
          ? "FAILED"
          : stats.state === "RECONNECTING"
            ? "RECONNECTING"
            : stats.state === "STALE"
              ? "STALE"
              : "CONNECTING";

  reportConnection("rtds", {
    state,
    reason:
      stats.state === "IDLE"
        ? "No data observed yet — the RTDS socket has not been started"
        : stats.connected
          ? `${stats.topics.length} topic(s) subscribed`
          : (stats.lastError ?? `socket ${String(stats.state).toLowerCase()}`),
    endpoint: stats.endpoint,
    reconnects: stats.reconnects,
    lastSuccessAt: stats.lastMessageAt,
    lastError: stats.lastError,
    blocksTrading: !stats.connected,
    recovery: stats.budgetExhausted
      ? "manual — the retry budget is exhausted, restart SPACE"
      : "automatic — the watchdog reconnects with backoff",
    action: stats.budgetExhausted ? "Restart SPACE to rebuild the RTDS socket" : null,
    details: {
      topics: stats.topics.join(", ") || "none",
      messages: stats.messages,
      errors: stats.errors,
      attempts: stats.attempts,
      ageMs: stats.ageMs,
      lastConnectedAt: stats.lastConnectedAt,
      budgetExhausted: stats.budgetExhausted,
    },
  });
}

function syncChainlinkStreams(): void {
  const status = twapServiceSnapshot().providers.find(
    (provider) => provider.id === "chainlink_streams",
  );
  if (!status) {
    reportConnection("chainlink_streams", {
      state: "NOT_STARTED",
      reason: "No data observed yet — the Chainlink Streams provider is not registered",
      blocksTrading: false,
      recovery: "starts with the TWAP provider registry",
      action: null,
    });
    return;
  }
  reportConnection("chainlink_streams", {
    state:
      status.state === "CONNECTED"
        ? "CONNECTED"
        : status.state === "FAILED"
          ? "FAILED"
          : status.state === "DISABLED"
            ? "DISABLED"
            : status.state === "NOT_CONFIGURED"
              ? "NOT_CONFIGURED"
              : status.state === "RECONNECTING"
                ? "RECONNECTING"
                : status.state === "STALE"
                  ? "STALE"
                  : "WAITING",
    reason: status.reason,
    endpoint: status.endpoint,
    latencyMs: status.latencyMs,
    reconnects: status.reconnects,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    // Optional dependency: Chainlink Streams never blocks trading on its own.
    blocksTrading: false,
    recovery: "automatic — reconnects with backoff while enabled",
    action: status.action,
    details: {
      active: status.active,
      enabled: status.enabled,
      symbol: status.symbol,
      transport: status.transport,
      price: status.price,
      freshnessMs: status.freshnessMs,
      samples: status.samples,
      errors: status.errors,
    },
  });
}

function syncTwapService(): void {
  const service = twapServiceSnapshot();
  reportConnection("twap_service", {
    state: !service.started
      ? "NOT_STARTED"
      : service.published > 0
        ? "CONNECTED"
        : "WAITING",
    reason: !service.started
      ? "No data observed yet — the TWAP service has not started"
      : service.published > 0
        ? `${service.published} settlement sample(s) published from ${service.activeProviderId}`
        : "started, waiting for the first settlement sample from the active provider",
    endpoint: `active provider · ${service.activeProviderId}`,
    lastSuccessAt: service.lastPublishedAt,
    blocksTrading: !service.started,
    recovery: "automatic — samples resume as soon as the active provider reports",
    action: service.started ? null : "Start the runtime to bring the TWAP service up",
    details: {
      started: service.started,
      published: service.published,
      activeProvider: service.activeProviderId,
      providers: service.providers.length,
    },
  });
}

function syncProviderRegistry(): void {
  const service = twapServiceSnapshot();
  const connected = service.providers.filter((provider) => provider.state === "CONNECTED").length;
  reportConnection("twap_provider_registry", {
    state: service.providers.length === 0 ? "NOT_STARTED" : connected > 0 ? "CONNECTED" : "DEGRADED",
    reason:
      service.providers.length === 0
        ? "No data observed yet — no provider is registered"
        : `${connected}/${service.providers.length} provider(s) connected; ${service.activeProviderId} is active`,
    endpoint: service.providers.map((provider) => provider.id).join(", ") || null,
    blocksTrading: false,
    recovery: "automatic — providers reconnect independently of the active selection",
    action: connected > 0 ? null : "Review provider configuration in Operations",
    details: Object.fromEntries(
      service.providers.map((provider) => [provider.id, `${provider.state} · ${provider.reason}`]),
    ),
  });
}

function syncClobMarketFeed(): void {
  const status = clobMarketFeedStatus();
  reportConnection("clob_market_ws", {
    state:
      status.state === "IDLE"
        ? "NOT_STARTED"
        : status.connected
          ? status.subscribedAssets === 0
            ? "WAITING"
            : "CONNECTED"
          : status.state === "FAILED"
            ? "FAILED"
            : status.state === "RECONNECTING"
              ? "RECONNECTING"
              : status.state === "STALE"
                ? "STALE"
                : "CONNECTING",
    reason:
      status.state === "IDLE"
        ? "No data observed yet — the CLOB market socket has not been started"
        : status.connected
          ? status.subscribedAssets === 0
            ? "connected, waiting for a BTC market to subscribe to"
            : `streaming ${status.books} order book(s)`
          : (status.lastError ?? `socket ${String(status.state).toLowerCase()}`),
    endpoint: status.endpoint,
    reconnects: status.reconnects,
    lastSuccessAt: status.lastMessageAt,
    lastError: status.lastError,
    blocksTrading: status.state === "FAILED",
    recovery: "automatic — the watchdog reconnects and resubscribes on the next tick",
    action: status.state === "FAILED" ? "None — SPACE retries automatically" : null,
    details: {
      subscribedAssets: status.subscribedAssets,
      books: status.books,
      messages: status.messages,
      errors: status.errors,
      sequenceGaps: status.sequenceGaps,
      ageMs: status.ageMs,
    },
  });
}

function syncVenues(): void {
  const env = loadEnv();
  const paper = env.SPACE_ENVIRONMENT === "V1_TESTNET";
  const description = activeVenue().describe();
  const health = activeVenue().health();

  reportConnection("venue_selector", {
    state: "CONNECTED",
    reason: `${env.SPACE_ENVIRONMENT} resolves to the ${paper ? "paper" : "live"} executor`,
    endpoint: description.kind,
    blocksTrading: false,
    recovery: "n/a — the selector is decided by SPACE_ENVIRONMENT at boot",
    action: null,
    details: {
      environment: env.SPACE_ENVIRONMENT,
      venue: description.kind,
      chainId: description.chainId ?? null,
      ready: description.ready,
    },
  });

  reportConnection("paper_venue", {
    state: paper ? (health.state === "OK" ? "CONNECTED" : "DEGRADED") : "DISABLED",
    reason: paper
      ? health.message
      : "paper executor is not selected in this environment",
    endpoint: paper ? (description.host ?? "in-process simulator") : null,
    blocksTrading: paper && health.state === "FAILED",
    recovery: paper ? "automatic — the simulator matches against the live book" : "n/a",
    action: null,
    details: { selected: paper, ready: paper ? description.ready : false },
  });

  reportConnection("live_venue", {
    state: !paper
      ? health.state === "OK"
        ? "CONNECTED"
        : health.state === "FAILED"
          ? "FAILED"
          : "DEGRADED"
      : "DISABLED",
    reason: !paper ? health.message : "live executor is not selected in this environment",
    endpoint: !paper ? (description.host ?? null) : null,
    blocksTrading: !paper && health.state !== "OK",
    recovery: !paper ? "automatic — reconnects and re-authenticates on demand" : "n/a",
    action: null,
    details: { selected: !paper, ready: !paper ? description.ready : false },
  });
}

function syncValidator(): void {
  const report = lastValidationReport();
  if (!report) {
    reportConnection("runtime_validator", {
      state: "NOT_STARTED",
      reason: "No data observed yet — the validation gate has not run",
      blocksTrading: true,
      recovery: "runs automatically during boot and before every ARM",
      action: null,
    });
    return;
  }
  reportConnection("runtime_validator", {
    state: report.valid ? "CONNECTED" : "FAILED",
    reason: report.valid
      ? `all ${report.items.filter((item) => item.required).length} mandatory checks passed`
      : report.blockers.join("; "),
    endpoint: `${report.items.length} checks`,
    lastSuccessAt: report.valid ? report.at : undefined,
    lastError: report.valid ? null : report.blockers.join("; "),
    blocksTrading: !report.valid,
    recovery: "automatic — re-run on every boot and before every ARM",
    action: report.valid ? null : "Clear the listed blockers, then ARM again",
    details: {
      evaluatedAt: report.at,
      mandatory: report.items.filter((item) => item.required).length,
      optional: report.items.filter((item) => !item.required).length,
      blockers: report.blockers.length,
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
  const service = twapServiceSnapshot();
  const active = service.active;
  const inactive = service.providers.filter((entry) => entry.id !== service.activeProviderId);

  // The card reports the provider first (it is the dependency), then what the
  // TWAP engine has been able to build from it.
  const state =
    active === null
      ? "NOT_STARTED"
      : active.state === "CONNECTED"
        ? twap.state === "OK"
          ? "CONNECTED"
          : "CONNECTING"
        : active.state === "NOT_CONFIGURED"
          ? "NOT_CONFIGURED"
          : active.state === "FAILED"
            ? "FAILED"
            : active.state === "DISABLED"
              ? "NOT_CONFIGURED"
              : "WAITING";

  reportConnection("twap_provider", {
    state,
    reason:
      active === null
        ? "TWAP service not started"
        : active.state === "CONNECTED"
          ? `${active.label}: ${active.reason} — ${twap.message}`
          : `${active.label}: ${active.reason}`,
    endpoint: active?.endpoint ?? null,
    latencyMs: active?.latencyMs ?? null,
    reconnects: active?.reconnects ?? 0,
    lastSuccessAt: active?.lastSuccessAt ?? twap.lastUpdateAt,
    lastError: active?.lastError ?? null,
    blocksTrading: state !== "CONNECTED",
    recovery:
      active?.state === "NOT_CONFIGURED" || active?.state === "DISABLED"
        ? "manual — provider configuration required"
        : "automatic — the provider reconnects with backoff and the window rebuilds",
    action:
      active?.action ??
      (twap.state === "OK" ? null : "None — settlement samples accumulate automatically"),
    details: {
      activeProvider: active?.label ?? service.activeProviderId,
      providerState: active?.state ?? "NOT_STARTED",
      transport: active?.transport ?? null,
      symbol: active?.symbol ?? null,
      providerEnvironment: active?.environment ?? null,
      authentication: active?.authType ?? null,
      providerPrice: active?.price ?? null,
      freshnessMs: active?.freshnessMs ?? null,
      providerSamples: active?.samples ?? 0,
      providerErrors: active?.errors ?? 0,
      sequence: active?.sequence ?? null,
      sequenceGaps: active?.sequenceGaps ?? 0,
      lastMessageAt: active?.lastMessageAt ?? null,
      publishedSamples: service.published,
      tradingImpact: active?.tradingImpact ?? "Settlement TWAP unavailable",
      twapValue: twap.value,
      twapSamples: twap.samples,
      twapLengthSeconds: twap.lengthSeconds,
      windowStart: twap.startAt,
      windowEnd: twap.endAt,
      standbyProviders: inactive
        .map((entry) => `${entry.label}: ${entry.state.replace(/_/g, " ").toLowerCase()}`)
        .join(" · "),
    },
  });
}

function syncClob(): void {
  const env = loadEnv();
  const health = venueAdapter.health();
  const description = venueAdapter.describe();
  const details = (health.details ?? {}) as Record<string, unknown>;
  const wallet = walletStatus();
  const limits = rateLimitStatus();
  const submitLimiter = limits.find((entry) => entry.endpoint === "clob_submit");
  const apiKeyLoaded = Boolean(
    env.POLYMARKET_API_KEY && env.POLYMARKET_API_SECRET && env.POLYMARKET_API_PASSPHRASE,
  );
  const environmentMatch = wallet.chainId === (env.SPACE_ENVIRONMENT === "V1_TESTNET" ? 80002 : 137);

  reportConnection("clob_trading", {
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