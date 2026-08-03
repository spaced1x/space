import { ClobClient, OrderType, Side } from "@polymarket/clob-client";

import { loadEnv } from "../config/env.server";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";
import { walletSigner, walletStatus } from "./wallet.server";
import type {
  VenueAdapter,
  VenueDescription,
  VenueOrderAck,
  VenueOrderRequest,
  VenueOrderStatus,
  VenueOrderStatusCode,
  VenueTrade,
} from "./venue";

// Polymarket CLOB adapter.
//
// Authentication is L1 (wallet signature) + L2 (API key / secret / passphrase),
// all loaded from .env — never from the dashboard. V1 talks to the staging CLOB
// on Amoy, V2 to the production CLOB on Polygon. Same code both ways.

const log = createLogger("polymarket-clob");

const DEFAULT_HOSTS = {
  V1_TESTNET: "https://clob-staging.polymarket.com",
  V2_MAINNET: "https://clob.polymarket.com",
} as const;

interface AdapterState {
  client: ClobClient | null;
  host: string;
  chainId: number;
  ready: boolean;
  message: string;
  submissions: number;
  errors: number;
  lastError: string | null;
  lastCallAt: string | null;
}

let state: AdapterState | undefined;

function init(): AdapterState {
  if (state) return state;
  const env = loadEnv();
  const wallet = walletStatus();
  const host = env.POLYMARKET_CLOB_URL ?? DEFAULT_HOSTS[env.SPACE_ENVIRONMENT];
  const base: AdapterState = {
    client: null,
    host,
    chainId: wallet.chainId,
    ready: false,
    message: wallet.reason,
    submissions: 0,
    errors: 0,
    lastError: null,
    lastCallAt: null,
  };

  const signer = walletSigner();
  if (!signer || !wallet.ready) {
    state = base;
    return state;
  }

  try {
    const client = new ClobClient(
      host,
      wallet.chainId,
      // The clob-client accepts an ethers v5 signer; ours is exactly that.
      signer as unknown as ConstructorParameters<typeof ClobClient>[2],
      {
        key: env.POLYMARKET_API_KEY!,
        secret: env.POLYMARKET_API_SECRET!,
        passphrase: env.POLYMARKET_API_PASSPHRASE!,
      },
      env.POLYMARKET_SIGNATURE_TYPE,
      wallet.funderAddress ?? undefined,
    );
    state = {
      ...base,
      client,
      ready: true,
      message: `authenticated against ${host} (chain ${wallet.chainId})`,
    };
    log.info("clob client constructed", { host, chainId: wallet.chainId });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    state = { ...base, message: `clob client unavailable: ${reason}`, lastError: reason };
    log.error("clob client construction failed", { reason });
  }
  return state;
}

export function resetPolymarketAdapter(): void {
  state = undefined;
}

function require_(): { client: ClobClient; state: AdapterState } {
  const current = init();
  if (!current.client) throw new Error(current.message);
  return { client: current.client, state: current };
}

function mapStatus(raw: string | undefined): VenueOrderStatusCode {
  const value = (raw ?? "").toUpperCase();
  if (["LIVE", "OPEN", "DELAYED", "UNMATCHED"].includes(value)) return "OPEN";
  if (["MATCHED", "FILLED", "CONFIRMED", "MINED", "SUCCESS"].includes(value)) return "MATCHED";
  if (["CANCELED", "CANCELLED"].includes(value)) return "CANCELLED";
  if (value === "EXPIRED") return "EXPIRED";
  if (["FAILED", "RETRYING"].includes(value)) return "FAILED";
  return "UNKNOWN";
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function track<T>(fn: () => Promise<T>): Promise<T> {
  const current = init();
  current.lastCallAt = systemClock.iso();
  try {
    const result = await fn();
    current.lastError = null;
    return result;
  } catch (error) {
    current.errors += 1;
    current.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export const polymarketAdapter: VenueAdapter = {
  describe(): VenueDescription {
    const current = init();
    return {
      kind: "polymarket-clob",
      host: current.host,
      chainId: current.chainId,
      ready: current.ready,
      message: current.message,
    };
  },

  ready(): boolean {
    return init().ready;
  },

  async bestPrice(tokenId, side): Promise<number | null> {
    try {
      const { client } = require_();
      const response = await track(() => client.getPrice(tokenId, side === "BUY" ? "sell" : "buy"));
      const price = num((response as { price?: string }).price, Number.NaN);
      return Number.isFinite(price) ? price : null;
    } catch {
      // A missing book must never block execution; the caller falls back to the
      // configured limit price.
      return null;
    }
  },

  async submit(request: VenueOrderRequest): Promise<VenueOrderAck> {
    const { client, state: current } = require_();
    const side = request.side === "BUY" ? Side.BUY : Side.SELL;

    const response = await track(async () => {
      if (request.kind === "MARKET") {
        const signed = await client.createMarketOrder({
          tokenID: request.tokenId,
          side,
          // BUY market orders are denominated in collateral, SELL in shares.
          amount:
            request.side === "BUY" ? request.size * (request.price ?? 1) : request.size,
          ...(request.price !== null ? { price: request.price } : {}),
        });
        return client.postOrder(signed, OrderType.FOK);
      }
      const signed = await client.createOrder({
        tokenID: request.tokenId,
        side,
        price: request.price ?? 0,
        size: request.size,
      });
      return client.postOrder(signed, OrderType.GTC);
    });

    current.submissions += 1;
    const payload = (response ?? {}) as Record<string, unknown>;
    const venueOrderId = String(payload["orderID"] ?? payload["orderId"] ?? payload["id"] ?? "");
    if (!venueOrderId) {
      throw new Error(`venue accepted no order id: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    if (payload["success"] === false) {
      throw new Error(String(payload["errorMsg"] ?? "venue rejected the order"));
    }
    return {
      venueOrderId,
      status: mapStatus(String(payload["status"] ?? "")),
      filledSize: num(payload["makingAmount"] ?? payload["size_matched"], 0),
      raw: payload,
    };
  },

  async cancel(venueOrderId: string): Promise<void> {
    const { client } = require_();
    await track(() => client.cancelOrder({ orderID: venueOrderId }));
  },

  async status(venueOrderId: string): Promise<VenueOrderStatus | null> {
    const { client } = require_();
    try {
      const order = await track(() => client.getOrder(venueOrderId));
      if (!order) return null;
      return {
        venueOrderId,
        status: mapStatus(order.status),
        size: num(order.original_size),
        filledSize: num(order.size_matched),
        price: num(order.price, Number.NaN) || null,
      };
    } catch {
      // Unknown order ids are a normal answer after cancellation/expiry.
      return null;
    }
  },

  async trades(venueOrderId: string): Promise<VenueTrade[]> {
    const { client } = require_();
    const trades = await track(() => client.getTrades({ id: venueOrderId }));
    return (trades ?? []).map((trade) => ({
      id: String(trade.id),
      venueOrderId,
      tokenId: String(trade.asset_id),
      size: num(trade.size),
      price: num(trade.price),
      at: trade.match_time ? new Date(num(trade.match_time) * 1000).toISOString() : systemClock.iso(),
      status: String(trade.status ?? "UNKNOWN"),
    }));
  },

  health(): HealthResult {
    const current = init();
    const details = {
      host: current.host,
      chainId: current.chainId,
      submissions: current.submissions,
      errors: current.errors,
      lastError: current.lastError,
      lastCallAt: current.lastCallAt,
    };
    if (!current.ready) return { state: "DEGRADED", message: current.message, details };
    if (current.lastError) {
      return { state: "DEGRADED", message: `last call failed: ${current.lastError}`, details };
    }
    return { state: "OK", message: current.message, details };
  },
};