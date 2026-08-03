import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { settlementRepository } from "../db/repositories/settlement.repository";
import { eventBus } from "../bus/events";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import { correlationId } from "../shared/ids";

// Settlement ingestion. Fills alone say what SPACE paid; only the venue's
// resolved outcome says what a position was worth. Without this loop Replay,
// Statistics, PnL and the release reports are all incomplete, so ingestion is a
// first-class runtime service with its own health.

const log = createLogger("settlement");
const STALE_MS = 600_000;

interface GammaResolution {
  conditionId?: string;
  slug?: string;
  closed?: boolean;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  umaResolutionStatus?: string;
  endDate?: string;
}

interface SettlementStats {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  runs: number;
  errors: number;
  ingested: number;
  pending: number;
  lastError: string | null;
}

const stats: SettlementStats = {
  lastRunAt: null,
  lastSuccessAt: null,
  runs: 0,
  errors: 0,
  ingested: 0,
  pending: 0,
  lastError: null,
};

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

/**
 * Resolution is read from the official outcome prices: a resolved binary market
 * pays exactly 1 on the winning side. Anything else stays UNRESOLVED and is
 * retried; SPACE never guesses a winner from its own price feeds.
 */
export function resolveOutcome(market: GammaResolution): {
  outcome: "UP" | "DOWN" | "UNRESOLVED";
  upPrice: number | null;
  downPrice: number | null;
} {
  const outcomes = asArray(market.outcomes).map((value) => value.toUpperCase());
  const prices = asArray(market.outcomePrices).map(Number);
  if (prices.length < 2 || prices.some((price) => !Number.isFinite(price))) {
    return { outcome: "UNRESOLVED", upPrice: null, downPrice: null };
  }
  // Outcome order follows the market metadata; index 0 is the UP token unless
  // the venue labels it otherwise.
  const upIndex = outcomes.findIndex((value) => value === "UP" || value === "YES");
  const up = upIndex >= 0 ? prices[upIndex]! : prices[0]!;
  const down = upIndex >= 0 ? prices[upIndex === 0 ? 1 : 0]! : prices[1]!;
  if (!market.closed) return { outcome: "UNRESOLVED", upPrice: up, downPrice: down };
  if (up >= 0.99 && down <= 0.01) return { outcome: "UP", upPrice: up, downPrice: down };
  if (down >= 0.99 && up <= 0.01) return { outcome: "DOWN", upPrice: up, downPrice: down };
  return { outcome: "UNRESOLVED", upPrice: up, downPrice: down };
}

async function fetchResolution(conditionId: string): Promise<GammaResolution | null> {
  const env = loadEnv();
  const url = new URL("/markets", env.POLYMARKET_GAMMA_URL);
  url.searchParams.set("condition_ids", conditionId);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`gamma ${response.status}`);
  const body = (await response.json()) as GammaResolution[] | { data?: GammaResolution[] };
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return rows[0] ?? null;
}

export async function ingestSettlements(): Promise<void> {
  stats.runs += 1;
  stats.lastRunAt = clock().iso();
  try {
    const pending = await settlementRepository.pending(clock().iso());
    stats.pending = pending.length;
    for (const market of pending) {
      const resolution = await fetchResolution(market.condition_id);
      if (!resolution) continue;
      const { outcome, upPrice, downPrice } = resolveOutcome(resolution);
      await settlementRepository.upsert({
        condition_id: market.condition_id,
        slug: market.slug,
        horizon: market.horizon,
        settled_at: market.settlement_at ?? resolution.endDate ?? clock().iso(),
        resolved_outcome: outcome,
        up_price: upPrice,
        down_price: downPrice,
        source: "gamma",
        recorded_at: clock().iso(),
        raw: JSON.stringify(resolution).slice(0, 4000),
      });
      if (outcome !== "UNRESOLVED") {
        stats.ingested += 1;
        eventBus.publish({
          type: "settlement.ingested",
          severity: "INFO",
          correlationId: correlationId("settlement"),
          source: "settlement",
          payload: { conditionId: market.condition_id, outcome, horizon: market.horizon },
        });
        log.info("settlement ingested", { conditionId: market.condition_id, outcome });
      }
    }
    stats.lastError = null;
    stats.lastSuccessAt = clock().iso();
  } catch (error) {
    stats.errors += 1;
    stats.lastError = error instanceof Error ? error.message : String(error);
    log.warn("settlement ingestion failed", { reason: stats.lastError });
  }
}

export function settlementHealth(): HealthResult {
  const details = { ...stats };
  if (!stats.lastSuccessAt) {
    return {
      state: "DEGRADED",
      message: stats.lastError ?? "awaiting first settlement sweep",
      details,
    };
  }
  const ageMs = clock().now() - Date.parse(stats.lastSuccessAt);
  if (stats.lastError || ageMs > STALE_MS) {
    return {
      state: "DEGRADED",
      message: stats.lastError ?? `last successful sweep ${ageMs}ms ago`,
      details: { ...details, ageMs },
    };
  }
  return { state: "OK", message: "settlements ingested", details: { ...details, ageMs } };
}

export function settlementStats(): SettlementStats {
  return { ...stats };
}