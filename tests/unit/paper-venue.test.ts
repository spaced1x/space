import { beforeEach, describe, expect, it, vi } from "vitest";

// The paper venue prices against the live CLOB book; the book module is mocked
// so the matching behaviour itself is what gets asserted.
const book = {
  tokenId: "t1",
  bids: [
    { price: 0.48, size: 100 },
    { price: 0.47, size: 200 },
  ],
  asks: [
    { price: 0.52, size: 50 },
    { price: 0.54, size: 150 },
  ],
  bestBid: 0.48,
  bestAsk: 0.52,
  updatedAtMs: Date.now(),
  sequence: "h1",
};

vi.mock("../../src/core/market/clob-ws.server", () => ({
  getTokenBook: (tokenId: string) => (tokenId === "t1" ? book : null),
  clobMarketFeedStatus: () => ({
    state: "CONNECTED",
    books: 1,
    subscribedAssets: 2,
    endpoint: "wss://example",
    connected: true,
    reconnects: 0,
    messages: 10,
    errors: 0,
    lastError: null,
    lastMessageAt: null,
    sequenceGaps: 0,
    ageMs: 0,
  }),
}));

const { paperAdapter, resetPaperVenue } = await import("../../src/core/execution/paper.server");

describe("paper execution venue", () => {
  beforeEach(() => {
    resetPaperVenue();
  });

  it("quotes the live book", async () => {
    expect(await paperAdapter.bestPrice("t1", "BUY")).toBe(0.52);
    expect(await paperAdapter.bestPrice("t1", "SELL")).toBe(0.48);
    expect(await paperAdapter.bestPrice("unknown", "BUY")).toBeNull();
  });

  it("fills a market order across levels with slippage", async () => {
    const ack = await paperAdapter.submit({
      clientId: "c1",
      tokenId: "t1",
      side: "BUY",
      kind: "MARKET",
      price: null,
      size: 100,
    });
    expect(ack.status).toBe("MATCHED");
    expect(ack.filledSize).toBe(100);
    const trades = await paperAdapter.trades(ack.venueOrderId);
    // 50 @ 0.52 + 50 @ 0.54 -> average 0.53, worse than the touch.
    expect(trades[0]?.price).toBeCloseTo(0.53, 6);
  });

  it("rejects a market order larger than the resting liquidity", async () => {
    await expect(
      paperAdapter.submit({
        clientId: "c2",
        tokenId: "t1",
        side: "BUY",
        kind: "MARKET",
        price: null,
        size: 10_000,
      }),
    ).rejects.toThrow(/available in the book/);
  });

  it("rejects dust, unknown books and invalid limit prices", async () => {
    const base = { tokenId: "t1", side: "BUY", kind: "LIMIT", price: 0.5 } as const;
    await expect(paperAdapter.submit({ ...base, clientId: "c3", size: 1 })).rejects.toThrow(
      /minimum/,
    );
    await expect(
      paperAdapter.submit({ ...base, clientId: "c4", tokenId: "nope", size: 50 }),
    ).rejects.toThrow(/no live order book/);
    await expect(
      paperAdapter.submit({ ...base, clientId: "c5", price: 1.4, size: 50 }),
    ).rejects.toThrow(/invalid limit price/);
  });

  it("rests the non-marketable remainder of a limit order as maker liquidity", async () => {
    const ack = await paperAdapter.submit({
      clientId: "c6",
      tokenId: "t1",
      side: "BUY",
      kind: "LIMIT",
      price: 0.52,
      size: 80,
    });
    expect(ack.status).toBe("OPEN");
    expect(ack.filledSize).toBe(50); // only the 0.52 level crosses
    const open = await paperAdapter.openOrders("t1");
    expect(open).toHaveLength(1);
    expect(open[0]?.filledSize).toBe(50);
  });

  it("cancels a resting order", async () => {
    const ack = await paperAdapter.submit({
      clientId: "c7",
      tokenId: "t1",
      side: "BUY",
      kind: "LIMIT",
      price: 0.4,
      size: 50,
    });
    expect(ack.status).toBe("OPEN");
    await paperAdapter.cancel(ack.venueOrderId);
    const status = await paperAdapter.status(ack.venueOrderId);
    expect(status?.status).toBe("CANCELLED");
  });

  it("never claims to be the live venue", () => {
    expect(paperAdapter.describe().kind).toBe("paper");
  });
});
