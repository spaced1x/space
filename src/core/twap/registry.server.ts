import { loadEnv } from "../config/env.server";
import { kvRepository } from "../db/repositories/kv.repository";
import { createLogger } from "../logging/logger";
import { createChainlinkStreamsProvider } from "./chainlink.provider.server";
import type { TwapProvider, TwapProviderId, TwapProviderStatus } from "./provider";
import { createRtdsTwapProvider } from "./rtds.provider.server";

// Provider registry: the single owner of provider selection.
//
// Promotion is an operator decision — the runtime never switches providers on
// its own. Before a promotion takes effect the registry validates the candidate
// (enabled, fresh sample, sane latency, matching symbol); a failed validation
// leaves the current provider active and reports exactly why.

const log = createLogger("twap-registry");
const DEFAULT_PROVIDER: TwapProviderId = "rtds_twap_30";

/** A promoted provider must have produced a sample no older than this. */
const MAX_FRESHNESS_MS = 120_000;
/** A promoted provider must be reachable within this observed latency. */
const MAX_LATENCY_MS = 10_000;

let providers: TwapProvider[] = [];
let activeId: TwapProviderId = DEFAULT_PROVIDER;
let loaded = false;

/** Selection is persisted per environment; V1 and V2 own separate databases. */
function activeKey(): string {
  let environment = "V1_TESTNET";
  try {
    environment = loadEnv().SPACE_ENVIRONMENT;
  } catch {
    // configuration not loaded yet: fall back to the default key
  }
  return `twap.active_provider.${environment}`;
}

function ensureProviders(): TwapProvider[] {
  if (!providers.length) {
    providers = [
      createRtdsTwapProvider({
        id: "rtds_twap_30",
        label: "Polymarket RTDS TWAP 30s",
        windowSeconds: 30,
        topic: () => loadEnv().RTDS_TWAP_30_TOPIC,
        enabled: () => loadEnv().RTDS_ENABLED && loadEnv().RTDS_TWAP_30_ENABLED,
      }),
      createRtdsTwapProvider({
        id: "rtds_twap_60",
        label: "Polymarket RTDS TWAP 60s",
        windowSeconds: 60,
        topic: () => loadEnv().RTDS_TWAP_60_TOPIC,
        enabled: () => loadEnv().RTDS_ENABLED && loadEnv().RTDS_TWAP_60_ENABLED,
      }),
      createChainlinkStreamsProvider(),
    ];
  }
  return providers;
}

function isProviderId(value: string): value is TwapProviderId {
  return ensureProviders().some((provider) => provider.id === value);
}

/** Reads the persisted selection once per runtime; defaults to RTDS TWAP 30s. */
export async function loadActiveProvider(): Promise<TwapProviderId> {
  ensureProviders();
  if (loaded) return activeId;
  try {
    const stored = await kvRepository.get(activeKey());
    if (stored && isProviderId(stored)) activeId = stored;
    else await kvRepository.set(activeKey(), activeId);
  } catch (error) {
    log.warn("could not read persisted TWAP provider", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  loaded = true;
  return activeId;
}

export function listProviders(): TwapProvider[] {
  return ensureProviders();
}

export function getActiveProvider(): TwapProvider {
  const list = ensureProviders();
  return list.find((provider) => provider.id === activeId) ?? list[0]!;
}

export function activeProviderId(): TwapProviderId {
  return activeId;
}

export interface PromotionResult {
  ok: boolean;
  activeProviderId: TwapProviderId;
  reason: string;
  checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * Validate a candidate before it may serve settlement prices. Everything is
 * measured from the provider's own reported status — never assumed.
 */
export function validatePromotion(id: TwapProviderId): PromotionResult {
  const provider = ensureProviders().find((entry) => entry.id === id);
  if (!provider) {
    return {
      ok: false,
      activeProviderId: activeId,
      reason: `unknown TWAP provider: ${id}`,
      checks: [],
    };
  }
  const status = provider.status();
  const sample = provider.latest();
  const symbol = status.symbol.trim().toLowerCase();
  const expected = (() => {
    try {
      return loadEnv().RTDS_SYMBOL.trim().toLowerCase();
    } catch {
      return symbol;
    }
  })();
  const normalise = (value: string) => value.replace(/[^a-z]/g, "");

  const checks = [
    {
      name: "enabled",
      ok: status.enabled,
      detail: status.enabled ? "provider is enabled" : "provider is disabled by configuration",
    },
    {
      name: "valid sample",
      ok: sample !== null && Number.isFinite(sample.price) && sample.price > 0,
      detail: sample ? `last price ${sample.price}` : "no sample observed yet",
    },
    {
      name: "freshness",
      ok: status.freshnessMs !== null && status.freshnessMs <= MAX_FRESHNESS_MS,
      detail:
        status.freshnessMs === null
          ? "no observed price to measure"
          : `${Math.round(status.freshnessMs / 1000)}s old (limit ${MAX_FRESHNESS_MS / 1000}s)`,
    },
    {
      name: "latency",
      ok: status.latencyMs === null ? false : status.latencyMs <= MAX_LATENCY_MS,
      detail:
        status.latencyMs === null
          ? "no latency measured"
          : `${status.latencyMs}ms (limit ${MAX_LATENCY_MS}ms)`,
    },
    {
      name: "symbol",
      ok: normalise(symbol).includes("btc") && normalise(expected).includes("btc"),
      detail: `provider symbol ${status.symbol}`,
    },
  ];

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    activeProviderId: activeId,
    reason: failed.length
      ? `promotion refused: ${failed.map((check) => `${check.name} (${check.detail})`).join("; ")}`
      : `${provider.label} passed every promotion check`,
    checks,
  };
}

/**
 * Operator-initiated promotion. Validated first, persisted after, so the
 * selection survives a restart. The runtime never calls this on its own.
 */
export async function setActiveProvider(id: TwapProviderId): Promise<PromotionResult> {
  if (!isProviderId(id)) throw new Error(`unknown TWAP provider: ${id}`);
  if (id === activeId) {
    return {
      ok: true,
      activeProviderId: activeId,
      reason: "provider is already active",
      checks: [],
    };
  }
  const validation = validatePromotion(id);
  if (!validation.ok) {
    log.warn("TWAP promotion refused", { provider: id, reason: validation.reason });
    return validation;
  }
  activeId = id;
  await kvRepository.set(activeKey(), id);
  log.info("active TWAP provider promoted", { provider: id });
  return { ...validation, activeProviderId: activeId };
}

export function providerStatuses(): TwapProviderStatus[] {
  return ensureProviders().map((provider) => ({
    ...provider.status(),
    active: provider.id === activeId,
  }));
}

export function resetProviderRegistry(): void {
  providers = [];
  activeId = DEFAULT_PROVIDER;
  loaded = false;
}
