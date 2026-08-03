import { Wallet } from "ethers";

import { loadEnv } from "../config/env.server";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import type { WalletStatus } from "./types";

// The Wallet Layer.
//
// It owns the private key and is the ONLY module that reads it. Everything
// else sees a WalletStatus: presence, address, funder, chain, readiness. V1 and
// V2 differ by environment alone — same code, same engine.

const log = createLogger("wallet");

export const CHAIN_IDS = { V1_TESTNET: 80002, V2_MAINNET: 137 } as const;

let cached: { status: WalletStatus; signer: Wallet | null } | undefined;

function build(): { status: WalletStatus; signer: Wallet | null } {
  const env = loadEnv();
  const environment = env.SPACE_ENVIRONMENT;
  const chainId = CHAIN_IDS[environment];
  const hasApiCredentials = Boolean(
    env.POLYMARKET_API_KEY && env.POLYMARKET_API_SECRET && env.POLYMARKET_API_PASSPHRASE,
  );
  const funderAddress = env.POLYMARKET_FUNDER_ADDRESS ?? env.WALLET_ADDRESS ?? null;

  if (!env.WALLET_PRIVATE_KEY) {
    return {
      signer: null,
      status: {
        ready: false,
        environment,
        chainId,
        address: env.WALLET_ADDRESS ?? null,
        funderAddress,
        hasPrivateKey: false,
        hasApiCredentials,
        reason: "WALLET_PRIVATE_KEY is not configured",
      },
    };
  }

  try {
    const signer = new Wallet(env.WALLET_PRIVATE_KEY);
    const address = signer.address;
    const declared = env.WALLET_ADDRESS;
    if (declared && declared.toLowerCase() !== address.toLowerCase()) {
      return {
        signer: null,
        status: {
          ready: false,
          environment,
          chainId,
          address,
          funderAddress,
          hasPrivateKey: true,
          hasApiCredentials,
          reason: "WALLET_ADDRESS does not match the address derived from WALLET_PRIVATE_KEY",
        },
      };
    }
    return {
      signer,
      status: {
        ready: hasApiCredentials,
        environment,
        chainId,
        address,
        funderAddress,
        hasPrivateKey: true,
        hasApiCredentials,
        reason: hasApiCredentials
          ? `wallet ready on ${environment} (chain ${chainId})`
          : "Polymarket API key, secret or passphrase missing",
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error("wallet key rejected", { reason });
    return {
      signer: null,
      status: {
        ready: false,
        environment,
        chainId,
        address: null,
        funderAddress,
        hasPrivateKey: true,
        hasApiCredentials,
        reason: `WALLET_PRIVATE_KEY is invalid: ${reason}`,
      },
    };
  }
}

function current() {
  if (!cached) cached = build();
  return cached;
}

export function walletStatus(): WalletStatus {
  return current().status;
}

/** Server-only. Returns the signer or null; never the raw key. */
export function walletSigner(): Wallet | null {
  return current().signer;
}

export function resetWallet(): void {
  cached = undefined;
}

export function walletHealth(): HealthResult {
  const status = walletStatus();
  const details = {
    environment: status.environment,
    chainId: status.chainId,
    address: status.address,
    funderAddress: status.funderAddress,
    hasPrivateKey: status.hasPrivateKey,
    hasApiCredentials: status.hasApiCredentials,
    chain: lastChainCheck,
  };
  // A key that exists but cannot be parsed is a hard configuration failure, not
  // a degraded convenience: nothing can ever be signed with it.
  if (status.hasPrivateKey && !status.address) {
    return { state: "FAILED", message: status.reason, details };
  }
  if (lastChainCheck && lastChainCheck.matches === false) {
    return {
      state: "FAILED",
      message: lastChainCheck.reason,
      details,
    };
  }
  if (status.ready) return { state: "OK", message: status.reason, details };
  return { state: "DEGRADED", message: status.reason, details };
}

export interface ChainCheck {
  expectedChainId: number;
  actualChainId: number | null;
  matches: boolean | null;
  reason: string;
  checkedAt: string;
}

let lastChainCheck: ChainCheck | null = null;

export function chainCheck(): ChainCheck | null {
  return lastChainCheck;
}

/**
 * Environment conformance at the chain level: the configured RPC must actually
 * be the chain the selected environment trades on. A V2_MAINNET process pointed
 * at an Amoy RPC (or the reverse) must never be allowed to arm.
 */
export async function verifyChainId(): Promise<ChainCheck> {
  const env = loadEnv();
  const expectedChainId = CHAIN_IDS[env.SPACE_ENVIRONMENT];
  const checkedAt = new Date().toISOString();
  const rpcUrl = env.CHAINLINK_RPC_URL;
  if (!rpcUrl) {
    lastChainCheck = {
      expectedChainId,
      actualChainId: null,
      matches: null,
      reason: "no RPC URL configured; chain identity cannot be verified",
      checkedAt,
    };
    return lastChainCheck;
  }
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (!response.ok) throw new Error(`rpc ${response.status}`);
    const body = (await response.json()) as { result?: string };
    const actualChainId = body.result ? Number.parseInt(body.result, 16) : null;
    const matches = actualChainId === expectedChainId;
    lastChainCheck = {
      expectedChainId,
      actualChainId,
      matches,
      reason: matches
        ? `RPC reports chain ${actualChainId}, matching ${env.SPACE_ENVIRONMENT}`
        : `RPC reports chain ${actualChainId ?? "unknown"} but ${env.SPACE_ENVIRONMENT} requires ${expectedChainId}`,
      checkedAt,
    };
    if (!matches) log.error("chain mismatch", { reason: lastChainCheck.reason });
    return lastChainCheck;
  } catch (error) {
    lastChainCheck = {
      expectedChainId,
      actualChainId: null,
      matches: null,
      reason: `chain verification failed: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt,
    };
    return lastChainCheck;
  }
}