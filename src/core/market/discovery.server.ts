import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { replayRepository } from "../db/repositories/replay.repository";
import { createLogger } from "../logging/logger";
import type { HealthResult } from "../health/types";
import { applyDiscovery } from "./state";
import type { DiscoveredMarket, DiscoveryStats, MarketHorizon, MarketStatus } from "./types";

// Automatic discovery of the official active BTC up/down markets. Discovery
// only: no selection prompt, no trading decision, no order data.

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

// Horizon is derived from the market's own start/end metadata, never guessed
// from the title alone.
function classify(market: GammaMarket): MarketHorizon | null {
  const start = Date.parse(market.startDate ?? market.gameStartTime ?? "");
  const end = Date.parse(market.endDate ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes === 5) return "FIVE_MINUTE";
  if (minutes === 15) return "FIFTEEN_MINUTE";
  return null;
}

function isBitcoinUpDown(market: GammaMarket): boolean {
  const text = `${market.slug ?? ""} ${market.question ?? ""}`.toLowerCase();
  const bitcoin = text.includes("bitcoin") || /\bbtc\b/.test(text);
  const updown = text.includes("up or down") || text.includes("up-or-down");
  return bitcoin && updown;
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

export function setDiscoveryEnabled(next: boolean): void {
  enabled = next;
}

export async function refreshMarkets(): Promise<void> {
  if (!enabled) return;
  const env = loadEnv();
  const nowMs = clock().now();
  const startedAt = nowMs;
  stats.refreshes += 1;
  stats.lastRefreshAt = new Date(nowMs).toISOString();

  try {
    const url = new URL("/markets", env.POLYMARKET_GAMMA_URL);
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "200");
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "true");

    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`gamma ${response.status}`);
    const body = (await response.json()) as GammaMarket[] | { data?: GammaMarket[] };
    const candidates = Array.isArray(body) ? body : (body.data ?? []);
    stats.candidatesSeen = candidates.length;

    const picked: Partial<Record<MarketHorizon, DiscoveredMarket | null>> = {
      FIVE_MINUTE: null,
      FIFTEEN_MINUTE: null,
    };

    for (const candidate of candidates) {
      if (!isBitcoinUpDown(candidate) || !candidate.conditionId) continue;
      const horizon = classify(candidate);
      if (!horizon || picked[horizon]) continue;
      const endMs = Date.parse(candidate.endDate ?? "");
      const tokens = asArray(candidate.clobTokenIds);
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
      };
    }

    stats.latencyMs = clock().now() - startedAt;
    stats.lastSuccessAt = new Date(clock().now()).toISOString();
    stats.lastError = null;
    applyDiscovery(picked, { ...stats });
    // Replay reconstructs markets from persisted rows only, so discovery
    // itself must be durable. Best effort: a runtime without SQLite still
    // trades, it simply cannot replay afterwards.
    await persistDiscovery(picked);
  } catch (error) {
    stats.errors += 1;
    stats.lastError = error instanceof Error ? error.message : String(error);
    stats.latencyMs = clock().now() - startedAt;
    applyDiscovery({}, { ...stats });
    log.warn("discovery refresh failed", { reason: stats.lastError });
  }
}

export function discoveryHealth(): HealthResult {
  const details = { ...stats, enabled };
  if (!enabled) {
    return { state: "DISABLED", message: "discovery switched off by operator", details };
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