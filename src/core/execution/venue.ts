import type { HealthResult } from "../health/types";
import type { OrderKind, OrderSide } from "./types";

// The venue port. The Execution Engine depends on this interface only, so the
// same engine code runs against Polymarket V1 (testnet) and V2 (mainnet) and
// against a deterministic fake in tests.

export interface VenueOrderRequest {
  clientId: string;
  tokenId: string;
  side: OrderSide;
  kind: OrderKind;
  /** Required for LIMIT; optional marketable reference for MARKET. */
  price: number | null;
  size: number;
}

export interface VenueOrderAck {
  venueOrderId: string;
  /** Venue-reported status right after submission. */
  status: VenueOrderStatusCode;
  filledSize: number;
  raw?: Record<string, unknown>;
}

export type VenueOrderStatusCode =
  "OPEN" | "MATCHED" | "CANCELLED" | "EXPIRED" | "FAILED" | "UNKNOWN";

export interface VenueOrderStatus {
  venueOrderId: string;
  status: VenueOrderStatusCode;
  size: number;
  filledSize: number;
  price: number | null;
}

export interface VenueTrade {
  /** Venue trade id — becomes the primary key of the fill. */
  id: string;
  venueOrderId: string;
  tokenId: string;
  size: number;
  price: number;
  at: string;
  status: string;
}

export interface VenueDescription {
  kind: string;
  host: string;
  chainId: number;
  ready: boolean;
  message: string;
}

export interface OpenOrderSummary {
  venueOrderId: string;
  clientId: string | null;
  tokenId: string;
  side: OrderSide;
  kind: OrderKind;
  price: number | null;
  size: number;
  filledSize: number;
  status: VenueOrderStatusCode;
}

export interface VenueAdapter {
  describe(): VenueDescription;
  ready(): boolean;
  /** Best ask for a BUY, best bid for a SELL. null when the book is unknown. */
  bestPrice(tokenId: string, side: OrderSide): Promise<number | null>;
  submit(request: VenueOrderRequest): Promise<VenueOrderAck>;
  cancel(venueOrderId: string): Promise<void>;
  status(venueOrderId: string): Promise<VenueOrderStatus | null>;
  /** Trades for one order. Used for fill detection and restart reconciliation. */
  trades(venueOrderId: string): Promise<VenueTrade[]>;
  /**
   * Open orders for a token. Required for orphan-order reconciliation on boot.
   * Returns an empty array if the venue has no matching open orders.
   */
  openOrders(tokenId: string): Promise<OpenOrderSummary[]>;
  health(): HealthResult;
}
