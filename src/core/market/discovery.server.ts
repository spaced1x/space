import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { replayRepository } from "../db/repositories/replay.repository";
import {
  noteRateLimitWarning,
  RateLimitError,
  withRateLimit,
} from "../execution/rate-limit.server";
import { createLogger } from "../logging/logger";
import type { HealthResult } from "../health/types";
import { applyDiscovery } from "./state";
import type { DiscoveredMarket, DiscoveryStats, MarketHorizon, MarketStatus } from "./types";

// Automatic discovery of the official active BTC up/down markets. Discovery
// only: no selection prompt, no trading decision, no order data.
//
// Gamma runtime contract: requests respect the documented budget, only
// transient failures are retried, a circuit breaker opens after repeated
// failures and closes on the first successful recovery probe, and the last
// successful discovery is always retained — a Gamma outage never clears the
// current market.

const log = createLogger("market-discovery");
const STALE_MS = 180_000;

interface GammaMarket {
  conditionId?: string;
  slug?: string;
  question?: string;
  closed?: boolean;
  active?: boolean;
  startDate?: string;
  endDate?: string;
  gameStartTime?: string;
  clobTokenIds?: string | string[];
  outcomes?: string | string[];
  liquidity?: string | number;
  liquidityNum?: number;
  volume?: string | number;
  volumeNum?: number;
  bestBid?: string | number;
  bestAsk?: string | number;
  lastTradePrice?: string | number;
  spread?: string | number;
  orderMinSize?: string | number;
  resolutionSource?: string;
  umaResolutionStatus?: string;
}

interface GammaEvent {
  slug?: string;
  closed?: boolean;
  markets?: GammaMarket[];
}

/**
 * Official BTC up/down series slug: `btc-updown-<5m|15m>-<window start epoch>`.
 * The slug is the only reliable horizon signal — `startDate` on these markets
 * is the row's creation time, not the window open, so a duration derived from
 * start/end is meaningless and previously matched nothing.
 */
const BTC_UPDOWN_SLUG = /^btc-updown-(5m|15m)-\d+$/;

function horizonFromSlug(slug: string | undefined): MarketHorizon | null {
  const match = BTC_UPDOWN_SLUG.exec(slug ?? "");
  if (!match) return null;
  return match[1] === "5m" ? "FIVE_MINUTE" : "FIFTEEN_MINUTE";
}

function asArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Venue metadata is optional and often stringified; never invent a number. */
function asNumber(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// PTB comes from official metadata when present; otherwise the strike embedded
// in the official question text. Never invented.
function extractPtb(market: GammaMarket): number | null {
  const match = /\$([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(market.question ?? "");
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function statusOf(market: GammaMarket, endMs: number, nowMs: number): MarketStatus {
  if (market.closed) return "CLOSED";
  if (!Number.isFinite(endMs)) return "UNKNOWN";
  if (nowMs >= endMs) return "CLOSED";
  if (endMs - nowMs <= 60_000) return "CLOSING";
  return "OPEN";
}

const stats: DiscoveryStats = {
  lastRefreshAt: null,
  lastSuccessAt: null,
  refreshes: 0,
  errors: 0,
  lastError: null,
  candidatesSeen: 0,
  latencyMs: null,
};

let enabled = true;

/** Circuit breaker state for the Gamma endpoint. */
let consecutiveFailures = 0;
let breakerOpenUntilMs = 0;
let breakerOpens = 0;
let lastCachedAt: string | null = null;
let transientRetries = 0;

interface GammaFailure {
  transient: boolean;
  reason: string;
}

function classifyFailure(error: unknown): GammaFailure {
  if (error instanceof RateLimitError) {
    return { transient: true, reason: error.message };
  }
  const reason = error instanceof Error ? error.message : String(error);
  const statusMatch = /gamma (\d{3})/.exec(reason);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    // 429 and 5xx are transient; other 4xx are contract errors that retrying
    // cannot fix, so they fail fast with the exact reason.
    return { transient: status === 429 || status >= 500, reason };
  }
  // Network-level failures (DNS, reset, timeout) are transient by nature.
  return { transient: true, reason };
}

async function fetchGamma(url: URL): Promise<Response> {
  const response = await withRateLimit("gamma_discovery", () =>
    fetch(url, { headers: { accept: "application/json" } }),
  );
  noteRateLimitWarning("gamma_discovery", response.headers);
  if (!response.ok) throw new Error(`gamma ${response.status}`);
  return response;
}

export function setDiscoveryEnabled(next: boolean): void {
  enabled = next;
}

export async function refreshMarkets(): Promise<void> {
  if (!enabled) return;
  const env = loadEnv();
  const nowMs = clock().now();
  if (breakerOpenUntilMs > nowMs) {
    // Breaker open: skip the call entirely, keep the cached market, and let the
    // recovery probe run when the window expires.
    return;
  }
  const startedAt = nowMs;
  stats.refreshes += 1;
  stats.lastRefreshAt = new Date(nowMs).toISOString();

  try {
    // The BTC up/down series is published as events, one event per window.
    // `/markets` caps at 100 rows and, ordered by endDate ascending, returns
    // long-dated unrelated markets only — the short-horizon crypto windows
    // never appear in that page. Events ordered by newest start always do.
    const url = new URL("/events", env.POLYMARKET_GAMMA_URL);
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "100");
    url.searchParams.set("order", "startDate");
    url.searchParams.set("ascending", "false");

    let response: Response;
    try {
      response = await fetchGamma(url);
    } catch (error) {
      const failure = classifyFailure(error);
      if (!failure.transient) throw error;
      // One immediate retry for transient failures; anything beyond that is
      // the breaker's job, not a retry storm.
      transientRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      response = await fetchGamma(url);
    }
    const body = (await response.json()) as GammaEvent[] | { data?: GammaEvent[] };
    const events = Array.isArray(body) ? body : (body.data ?? []);
    // One candidate per BTC up/down window, earliest settlement first, so each
    // horizon selects the next window that has not settled yet.
    const candidates = events
      .filter((event) => !event.closed && horizonFromSlug(event.slug) !== null)
      .flatMap((event) => (event.markets ?? []).slice(0, 1))
      .filter((market) => horizonFromSlug(market.slug) !== null)
      .sort((a, b) => Date.parse(a.endDate ?? "") - Date.parse(b.endDate ?? ""));
    stats.candidatesSeen = candidates.length;

    const picked: Partial<Record<MarketHorizon, DiscoveredMarket | null>> = {
      FIVE_MINUTE: null,
      FIFTEEN_MINUTE: null,
    };

    for (const candidate of candidates) {
      if (!candidate.conditionId) continue;
      const horizon = horizonFromSlug(candidate.slug);
      if (!horizon || picked[horizon]) continue;
      const endMs = Date.parse(candidate.endDate ?? "");
      // Never select a window that has already settled.
      if (!Number.isFinite(endMs) || endMs <= nowMs) continue;
      const tokens = asArray(candidate.clobTokenIds);
      const bestBid = asNumber(candidate.bestBid);
      const bestAsk = asNumber(candidate.bestAsk);
      picked[horizon] = {
        horizon,
        conditionId: candidate.conditionId,
        slug: candidate.slug ?? candidate.conditionId,
        question: candidate.question ?? "",
        status: statusOf(candidate, endMs, nowMs),
        ptb: extractPtb(candidate),
        closeAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
        // Settlement is the same instant the official market resolves.
        settlementAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
        upTokenId: tokens[0] ?? null,
        downTokenId: tokens[1] ?? null,
        discoveredAt: new Date(nowMs).toISOString(),
        liquidity: asNumber(candidate.liquidityNum ?? candidate.liquidity),
        volume: asNumber(candidate.volumeNum ?? candidate.volume),
        probability: asNumber(candidate.lastTradePrice),
        bestBid,
        bestAsk,
        midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
        spread: asNumber(candidate.spread) ?? (bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null),
        minOrderSize: asNumber(candidate.orderMinSize),
        resolutionSource: candidate.resolutionSource ?? candidate.umaResolutionStatus ?? null,
      };
    }

    stats.latencyMs = clock().now() - startedAt;
    stats.lastSuccessAt = new Date(clock().now()).toISOString();
    stats.lastError = null;
    consecutiveFailures = 0;
    breakerOpenUntilMs = 0;
    lastCachedAt = stats.lastSuccessAt;
    applyDiscovery(picked, { ...stats });
    // Replay reconstructs markets from persisted rows only, so discovery
    // itself must be durable. Best effort: a runtime without SQLite still
    // trades, it simply cannot replay afterwards.
    await persistDiscovery(picked);
  } catch (error) {
    const failure = classifyFailure(error);
    stats.errors += 1;
    stats.lastError = failure.reason;
    stats.latencyMs = clock().now() - startedAt;
    consecutiveFailures += 1;
    if (consecutiveFailures >= env.GAMMA_FAILURE_THRESHOLD) {
      breakerOpenUntilMs = clock().now() + env.GAMMA_RECOVERY_MS;
      breakerOpens += 1;
      log.error("gamma circuit breaker opened", {
        consecutiveFailures,
        recoveryMs: env.GAMMA_RECOVERY_MS,
        reason: failure.reason,
      });
    }
    // The cached market is deliberately preserved: applyDiscovery is called
    // with no market patch, so discovery health degrades while the current
    // market keeps trading.
    applyDiscovery({}, { ...stats });
    log.warn("discovery refresh failed", {
      reason: stats.lastError,
      transient: failure.transient,
      consecutiveFailures,
    });
  }
}

export interface GammaBreakerStatus {
  open: boolean;
  opens: number;
  consecutiveFailures: number;
  reopensInMs: number | null;
  transientRetries: number;
  cachedAt: string | null;
}

export function gammaBreakerStatus(): GammaBreakerStatus {
  const now = clock().now();
  return {
    open: breakerOpenUntilMs > now,
    opens: breakerOpens,
    consecutiveFailures,
    reopensInMs: breakerOpenUntilMs > now ? breakerOpenUntilMs - now : null,
    transientRetries,
    cachedAt: lastCachedAt,
  };
}

export function resetDiscoveryBreaker(): void {
  consecutiveFailures = 0;
  breakerOpenUntilMs = 0;
}

export function discoveryHealth(): HealthResult {
  const breaker = gammaBreakerStatus();
  const details = { ...stats, enabled, ...breaker };
  if (!enabled) {
    return { state: "DISABLED", message: "discovery switched off by operator", details };
  }
  if (breaker.open) {
    return {
      state: "DEGRADED",
      message: `Gamma circuit breaker open after ${breaker.consecutiveFailures} failures; last market retained`,
      details,
    };
  }
  if (!stats.lastSuccessAt) {
    return {
      state: "DEGRADED",
      message: stats.lastError ?? "awaiting first discovery refresh",
      details,
    };
  }
  const ageMs = clock().now() - Date.parse(stats.lastSuccessAt);
  if (stats.lastError || ageMs > STALE_MS) {
    return {
      state: "DEGRADED",
      message: stats.lastError ?? `last successful refresh ${ageMs}ms ago`,
      details: { ...details, ageMs },
    };
  }
  return {
    state: "OK",
    message: "official BTC markets tracked",
    details: { ...details, ageMs },
  };
}

export function discoveryStats(): DiscoveryStats {
  return { ...stats };
}

async function persistDiscovery(
  picked: Partial<Record<MarketHorizon, DiscoveredMarket | null>>,
): Promise<void> {
  try {
    for (const market of Object.values(picked)) {
      if (!market) continue;
      await replayRepository.upsertDiscovery({
        condition_id: market.conditionId,
        slug: market.slug,
        horizon: market.horizon,
        question: market.question,
        status: market.status,
        ptb: market.ptb,
        close_at: market.closeAt,
        settlement_at: market.settlementAt,
        up_token_id: market.upTokenId,
        down_token_id: market.downTokenId,
        discovered_at: market.discoveredAt,
        updated_at: clock().iso(),
      });
    }
  } catch (error) {
    log.warn("discovery not persisted", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}