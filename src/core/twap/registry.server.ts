import { kvRepository } from "../db/repositories/kv.repository";
import { createLogger } from "../logging/logger";
import { createChainlinkTwapProvider } from "./chainlink.provider.server";
import type { TwapProvider, TwapProviderId, TwapProviderStatus } from "./provider";
import { createRtdsProvider } from "./rtds.provider.server";

// Provider registry: the single owner of provider selection. The rest of SPACE
// never learns which provider is active — it asks the TWAP service for a price.

const log = createLogger("twap-registry");
const ACTIVE_KEY = "twap.active_provider";
const DEFAULT_PROVIDER: TwapProviderId = "rtds";

let providers: TwapProvider[] = [];
let activeId: TwapProviderId = DEFAULT_PROVIDER;
let loaded = false;

function ensureProviders(): TwapProvider[] {
  if (!providers.length) {
    providers = [createRtdsProvider(), createChainlinkTwapProvider()];
  }
  return providers;
}

function isProviderId(value: string): value is TwapProviderId {
  return ensureProviders().some((provider) => provider.id === value);
}

/** Reads the persisted selection once per process; defaults to RTDS. */
export async function loadActiveProvider(): Promise<TwapProviderId> {
  ensureProviders();
  if (loaded) return activeId;
  try {
    const stored = await kvRepository.get(ACTIVE_KEY);
    if (stored && isProviderId(stored)) activeId = stored;
    else await kvRepository.set(ACTIVE_KEY, activeId);
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

/** Persisted so the selection survives a restart. No UI switching in v1.0. */
export async function setActiveProvider(id: TwapProviderId): Promise<void> {
  if (!isProviderId(id)) throw new Error(`unknown TWAP provider: ${id}`);
  activeId = id;
  await kvRepository.set(ACTIVE_KEY, id);
  log.info("active TWAP provider changed", { provider: id });
}

export function providerStatuses(): TwapProviderStatus[] {
  return ensureProviders().map((provider) => provider.status());
}

export function resetProviderRegistry(): void {
  providers = [];
  activeId = DEFAULT_PROVIDER;
  loaded = false;
}