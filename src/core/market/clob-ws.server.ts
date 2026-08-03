import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import type { HealthResult } from "../health/types";
import { createWsClient, type WsClient } from "../shared/ws-client.server";
import { getMarketState } from "./state";

// Polymarket CLOB market data WebSocket.
//
// Official contract (docs.polymarket.com):
//   - endpoint  wss://ws-subscriptions-clob.polymarket.com/ws/market
//   - subscribe {"assets_ids": [...], "type": "market"}
//   - heartbeat: the client sends the text frame `PING` every 10 seconds
//   - the stream has no replay: every reconnect must resubscribe to every asset
//
// It is public market data: no credentials, and it runs in both V1 (paper) and
// V2 (live). The paper executor prices against this book, so a STALE or FAILED
// feed must be visible rather than silently stale.

const log = createLogger("clob-ws");

export interface BookLevel {
  price: number;
  size: number;
}

export interface TokenBook {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  updatedAtMs: number;
  /** Venue hash/sequence when the event carries one. */
  sequence: string | null;
}

const books = new Map<string, TokenBook>();
let client: WsClient | undefined;
let started = false;
let subscribed: string[] = [];
let sequenceGaps = 0;
let lastEventAtMs: number | null = null;

function levels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const parsed: BookLevel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const price = Number(record["price"]);
    const size = Number(record["size"]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    parsed.push({ price, size });
  }
  return parsed;
}

function applyBook(event: Record<string, unknown>): void {
  const tokenId = String(event["asset_id"] ?? "");
  if (!tokenId) return;
  const bids = levels(event["bids"] ?? event["buys"]).sort((a, b) => b.price - a.price);
  const asks = levels(event["asks"] ?? event["sells"]).sort((a, b) => a.price - b.price);
  const previous = books.get(tokenId);
  const sequence = typeof event["hash"] === "string" ? (event["hash"] as string) : null;
  if (previous && sequence && previous.sequence && sequence === previous.sequence) {
    // Same snapshot re-delivered: not a gap, simply idempotent.
    return;
  }
  books.set(tokenId, {
    tokenId,
    bids,
    asks,
    bestBid: bids[0]?.price ?? previous?.bestBid ?? null,
    bestAsk: asks[0]?.price ?? previous?.bestAsk ?? null,
    updatedAtMs: clock().now(),
    sequence,
  });
}

function applyPriceChange(event: Record<string, unknown>): void {
  const tokenId = String(event["asset_id"] ?? "");
  if (!tokenId) return;
  const price = Number(event["price"]);
  const size = Number(event["size"] ?? 0);
  const side = String(event["side"] ?? "").toUpperCase();
  const book = books.get(tokenId);
  if (!book || !Number.isFinite(price)) return;
  const target = side === "SELL" ? book.asks : book.bids;
  const index = target.findIndex((level) => level.price === price);
  if (size <= 0) {
    if (index >= 0) target.splice(index, 1);
  } else if (index >= 0) {
    target[index] = { price, size };
  } else {
    target.push({ price, size });
  }
  book.bids.sort((a, b) => b.price - a.price);
  book.asks.sort((a, b) => a.price - b.price);
  book.bestBid = book.bids[0]?.price ?? null;
  book.bestAsk = book.asks[0]?.price ?? null;
  book.updatedAtMs = clock().now();
}

function ingest(raw: string): void {
  const text = raw.trim();
  if (!text || text === "PONG" || text === "PING") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  lastEventAtMs = clock().now();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    const type = String(record["event_type"] ?? record["type"] ?? "");
    if (type === "book") applyBook(record);
    else if (type === "price_change") applyPriceChange(record);
    else if (type === "last_trade_price") continue;
  }
}

/** Every discovered BTC token, both outcomes of both horizons. */
export function activeTokenIds(): string[] {
  const market = getMarketState().markets;
  return Object.values(market)
    .flatMap((entry) => (entry ? [entry.upTokenId, entry.downTokenId] : []))
    .filter((id): id is string => Boolean(id));
}

function subscribeFrame(assetIds: string[]): string {
  return JSON.stringify({ assets_ids: assetIds, type: "market" });
}

function resubscribe(send: (frame: string) => void): void {
  subscribed = activeTokenIds();
  if (!subscribed.length) return;
  send(subscribeFrame(subscribed));
  log.info("clob market subscriptions sent", { assets: subscribed.length });
}

export function startClobMarketFeed(): void {
  if (started) return;
  const env = loadEnv();
  started = true;
  client = createWsClient({
    name: "clob-market",
    url: () => loadEnv().POLYMARKET_CLOB_WS_URL,
    onOpen: (send) => resubscribe(send),
    onMessage: ingest,
    ping: () => "PING",
    pingMs: env.POLYMARKET_CLOB_WS_PING_MS,
    staleMs: env.POLYMARKET_CLOB_WS_STALE_MS,
    maxAttempts: env.WS_MAX_RECONNECT_ATTEMPTS,
    maxBackoffMs: env.WS_MAX_BACKOFF_MS,
  });
  client.start();
}

export function stopClobMarketFeed(): void {
  started = false;
  client?.stop();
  client = undefined;
  books.clear();
  subscribed = [];
  sequenceGaps = 0;
  lastEventAtMs = null;
}

/**
 * Watchdog + subscription reconciliation. Market discovery rolls to a new BTC
 * market every few minutes, so the feed re-subscribes whenever the active token
 * set changes.
 */
export function pollClobMarketFeed(): void {
  if (!started || !client) return;
  client.tick();
  const tokens = activeTokenIds();
  const changed =
    tokens.length !== subscribed.length || tokens.some((id) => !subscribed.includes(id));
  if (changed && client.isOpen() && tokens.length) {
    subscribed = tokens;
    client.send(subscribeFrame(tokens));
    log.info("clob market resubscribed after market change", { assets: tokens.length });
  }
}

export function getTokenBook(tokenId: string): TokenBook | null {
  return books.get(tokenId) ?? null;
}

export function clobMarketResources(): { sockets: number } {
  return { sockets: started && client ? 1 : 0 };
}

export function clobMarketFeedStatus() {
  const stats = client?.stats();
  return {
    state: stats?.state ?? "IDLE",
    endpoint: stats?.endpoint ?? null,
    connected: stats?.connected ?? false,
    reconnects: stats?.reconnects ?? 0,
    messages: stats?.messages ?? 0,
    errors: stats?.errors ?? 0,
    lastError: stats?.lastError ?? null,
    lastMessageAt: stats?.lastMessageAt ?? null,
    subscribedAssets: subscribed.length,
    books: books.size,
    sequenceGaps,
    ageMs: lastEventAtMs === null ? null : clock().now() - lastEventAtMs,
  };
}

export function clobMarketHealth(): HealthResult {
  const status = clobMarketFeedStatus();
  const details = { ...status };
  if (!started) {
    return { state: "DISABLED", message: "CLOB market feed not started", details };
  }
  if (status.state === "FAILED") {
    return {
      state: "FAILED",
      message: status.lastError ?? "CLOB market feed failed after its retry budget",
      details,
    };
  }
  if (!status.subscribedAssets) {
    return { state: "DEGRADED", message: "no BTC market discovered to subscribe to", details };
  }
  if (status.state !== "CONNECTED") {
    return {
      state: "DEGRADED",
      message: status.lastError ?? `CLOB market feed ${String(status.state).toLowerCase()}`,
      details,
    };
  }
  return { state: "OK", message: `streaming ${status.subscribedAssets} order books`, details };
}

/** Live execution requires a healthy book: a FAILED feed blocks live orders. */
export function clobMarketBlocksExecution(): string | null {
  if (!started) return null;
  const status = clobMarketFeedStatus();
  if (status.state === "FAILED") {
    return status.lastError ?? "CLOB market feed failed after its retry budget";
  }
  return null;
}
