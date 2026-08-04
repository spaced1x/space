import { clock } from "../clock/clock.service";
import { loadEnv } from "../config/env.server";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import { clobMarketFeedStatus, getTokenBook, type BookLevel } from "../market/clob-ws.server";
import type {
  OpenOrderSummary,
  VenueAdapter,
  VenueDescription,
  VenueOrderAck,
  VenueOrderRequest,
  VenueOrderStatus,
  VenueOrderStatusCode,
  VenueTrade,
} from "./venue";

// Paper execution venue (V1).
//
// It implements the same VenueAdapter contract as the live CLOB adapter and
// simulates the official CLOB matching behaviour against the live public order
// book: best bid, best ask, spread, available liquidity, order size, partial
// fills, slippage, maker vs taker execution, cancellation, expiration and
// rejection. Because it goes through the identical Execution Engine, it emits
// the identical lifecycle events, so Replay, Statistics, Diagnostics and
// Positions are indistinguishable from V2 except for the venue.
//
// It never submits an order to Polymarket and never requires credentials.

const log = createLogger("paper-venue");

/** A resting paper order expires like a venue GTC order eventually would. */
const ORDER_TTL_MS = 15 * 60_000;
/** Polymarket quotes in cents; sizes below this are rejected as dust. */
const MIN_ORDER_SIZE = 5;

interface PaperOrder {
  venueOrderId: string;
  clientId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  kind: "LIMIT" | "MARKET";
  price: number | null;
  size: number;
  filledSize: number;
  status: VenueOrderStatusCode;
  createdAtMs: number;
  /** Book timestamp already evaluated for maker fills. */
  lastBookAtMs: number;
  trades: VenueTrade[];
}

const orders = new Map<string, PaperOrder>();
let sequence = 0;
let rejections = 0;
let submissions = 0;

export function resetPaperVenue(): void {
  orders.clear();
  sequence = 0;
  rejections = 0;
  submissions = 0;
}

function bookSide(tokenId: string, side: "BUY" | "SELL"): BookLevel[] {
  const book = getTokenBook(tokenId);
  if (!book) return [];
  // A BUY consumes asks, a SELL consumes bids.
  return side === "BUY" ? book.asks : book.bids;
}

/** Walks the resting liquidity and returns the executable slice. */
function match(
  levels: BookLevel[],
  side: "BUY" | "SELL",
  size: number,
  limitPrice: number | null,
): { size: number; notional: number; levelsTouched: number } {
  let remaining = size;
  let notional = 0;
  let touched = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    if (limitPrice !== null) {
      const crosses = side === "BUY" ? level.price <= limitPrice : level.price >= limitPrice;
      if (!crosses) break;
    }
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    remaining -= take;
    notional += take * level.price;
    touched += 1;
  }
  return { size: size - remaining, notional, levelsTouched: touched };
}

function recordTrade(order: PaperOrder, size: number, price: number): void {
  sequence += 1;
  order.trades.push({
    id: `paper_trade_${sequence}`,
    venueOrderId: order.venueOrderId,
    tokenId: order.tokenId,
    size,
    price,
    at: clock().iso(),
    status: "CONFIRMED",
  });
  order.filledSize += size;
}

/** Maker fills for resting orders, and expiry, are evaluated on every read. */
function progress(order: PaperOrder): void {
  if (order.status !== "OPEN") return;
  if (clock().now() - order.createdAtMs > ORDER_TTL_MS) {
    order.status = order.filledSize > 0 ? "MATCHED" : "EXPIRED";
    return;
  }
  const remaining = order.size - order.filledSize;
  if (remaining <= 0) {
    order.status = "MATCHED";
    return;
  }
  const current = getTokenBook(order.tokenId);
  if (!current) return;
  // A resting order is maker liquidity: it only fills when the market trades
  // into it, which is observable as a *newer* book that crosses its price. The
  // same book snapshot can never fill the same order twice.
  if (current.updatedAtMs <= order.lastBookAtMs) return;
  order.lastBookAtMs = current.updatedAtMs;
  const levels = bookSide(order.tokenId, order.side);
  if (!levels.length) return;
  const result = match(levels, order.side, remaining, order.price);
  if (result.size <= 0) return;
  // A resting order that the market trades into fills at its own limit price:
  // that is the maker side of the match.
  recordTrade(order, result.size, order.price ?? result.notional / result.size);
  if (order.filledSize >= order.size - 1e-9) order.status = "MATCHED";
}

export const paperAdapter: VenueAdapter = {
  describe(): VenueDescription {
    const env = loadEnv();
    const feed = clobMarketFeedStatus();
    return {
      kind: "paper",
      host: `${env.POLYMARKET_CLOB_WS_URL} (market data only)`,
      chainId: 137,
      ready: feed.state === "CONNECTED" && feed.books > 0,
      message:
        feed.state === "CONNECTED" && feed.books > 0
          ? "paper venue pricing against the live Polymarket order book"
          : `paper venue waiting for the live order book (${String(feed.state).toLowerCase()})`,
    };
  },

  ready(): boolean {
    const feed = clobMarketFeedStatus();
    return feed.state === "CONNECTED" && feed.books > 0;
  },

  async bestPrice(tokenId, side): Promise<number | null> {
    const book = getTokenBook(tokenId);
    if (!book) return null;
    return side === "BUY" ? book.bestAsk : book.bestBid;
  },

  async submit(request: VenueOrderRequest): Promise<VenueOrderAck> {
    submissions += 1;
    sequence += 1;
    const venueOrderId = `paper_${sequence}_${request.clientId}`;
    const book = getTokenBook(request.tokenId);

    // Rejections mirror the venue's own validation.
    if (!book) {
      rejections += 1;
      throw new Error("paper venue rejected the order: no live order book for this token");
    }
    if (request.size < MIN_ORDER_SIZE) {
      rejections += 1;
      throw new Error(`paper venue rejected the order: size ${request.size} below venue minimum`);
    }
    if (
      request.kind === "LIMIT" &&
      (request.price === null || request.price <= 0 || request.price >= 1)
    ) {
      rejections += 1;
      throw new Error(`paper venue rejected the order: invalid limit price ${request.price}`);
    }

    const order: PaperOrder = {
      venueOrderId,
      clientId: request.clientId,
      tokenId: request.tokenId,
      side: request.side,
      kind: request.kind,
      price: request.price,
      size: request.size,
      filledSize: 0,
      status: "OPEN",
      createdAtMs: clock().now(),
      lastBookAtMs: book.updatedAtMs,
      trades: [],
    };

    const levels = bookSide(request.tokenId, request.side);

    if (request.kind === "MARKET") {
      // Live market orders are submitted FOK: all or nothing, with slippage
      // across every level consumed.
      const result = match(levels, request.side, request.size, null);
      if (result.size < request.size - 1e-9) {
        rejections += 1;
        order.status = "FAILED";
        orders.set(venueOrderId, order);
        throw new Error(
          `paper venue rejected the order: only ${result.size} of ${request.size} available in the book`,
        );
      }
      const averagePrice = result.notional / result.size;
      recordTrade(order, result.size, averagePrice);
      order.status = "MATCHED";
      orders.set(venueOrderId, order);
      log.info("paper market order filled", {
        venueOrderId,
        size: result.size,
        averagePrice,
        levels: result.levelsTouched,
      });
      return {
        venueOrderId,
        status: "MATCHED",
        filledSize: order.filledSize,
        raw: {
          simulated: true,
          averagePrice,
          levelsTouched: result.levelsTouched,
          liquidity: "book",
        },
      };
    }

    // LIMIT: the marketable portion executes as taker across the book (with
    // slippage), the remainder rests as maker liquidity.
    const taker = match(levels, request.side, request.size, request.price);
    if (taker.size > 0) {
      recordTrade(order, taker.size, taker.notional / taker.size);
    }
    order.status = order.filledSize >= order.size - 1e-9 ? "MATCHED" : "OPEN";
    orders.set(venueOrderId, order);
    log.info("paper limit order accepted", {
      venueOrderId,
      takerSize: taker.size,
      restingSize: order.size - order.filledSize,
      status: order.status,
    });
    return {
      venueOrderId,
      status: order.status,
      filledSize: order.filledSize,
      raw: {
        simulated: true,
        takerSize: taker.size,
        makerSize: order.size - order.filledSize,
        levelsTouched: taker.levelsTouched,
      },
    };
  },

  async cancel(venueOrderId: string): Promise<void> {
    const order = orders.get(venueOrderId);
    if (!order) return;
    if (order.status === "OPEN") {
      order.status = order.filledSize > 0 ? "MATCHED" : "CANCELLED";
    }
  },

  async status(venueOrderId: string): Promise<VenueOrderStatus | null> {
    const order = orders.get(venueOrderId);
    if (!order) return null;
    progress(order);
    return {
      venueOrderId,
      status: order.status,
      size: order.size,
      filledSize: order.filledSize,
      price: order.price,
    };
  },

  async trades(venueOrderId: string): Promise<VenueTrade[]> {
    const order = orders.get(venueOrderId);
    if (!order) return [];
    progress(order);
    return order.trades.map((trade) => ({ ...trade }));
  },

  async openOrders(tokenId: string): Promise<OpenOrderSummary[]> {
    const open: OpenOrderSummary[] = [];
    for (const order of orders.values()) {
      if (order.tokenId !== tokenId) continue;
      progress(order);
      if (order.status !== "OPEN") continue;
      open.push({
        venueOrderId: order.venueOrderId,
        clientId: order.clientId,
        tokenId: order.tokenId,
        side: order.side,
        kind: order.kind,
        price: order.price,
        size: order.size,
        filledSize: order.filledSize,
        status: order.status,
      });
    }
    return open;
  },

  health(): HealthResult {
    const feed = clobMarketFeedStatus();
    const details = {
      mode: "paper",
      submissions,
      rejections,
      orders: orders.size,
      bookState: feed.state,
      books: feed.books,
      subscribedAssets: feed.subscribedAssets,
    };
    if (feed.state === "FAILED") {
      return {
        state: "FAILED",
        message: "paper venue cannot price: the CLOB market feed failed",
        details,
      };
    }
    if (feed.state !== "CONNECTED" || feed.books === 0) {
      return {
        state: "DEGRADED",
        message: "paper venue waiting for live order book data",
        details,
      };
    }
    return { state: "OK", message: "paper venue matching against the live book", details };
  },
};
