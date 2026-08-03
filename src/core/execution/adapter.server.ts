import { loadEnv } from "../config/env.server";
import { paperAdapter } from "./paper.server";
import { polymarketAdapter } from "./polymarket.server";
import type { VenueAdapter } from "./venue";

// The one place in SPACE that chooses a venue.
//
// V1_TESTNET -> paper executor (no order ever reaches Polymarket)
// V2_MAINNET -> live Polymarket CLOB
//
// Everything above this line — strategy, TWAP, risk, sizing, scheduler,
// replay, statistics — is byte-identical across both environments.

export function activeVenue(): VenueAdapter {
  let environment: "V1_TESTNET" | "V2_MAINNET" = "V1_TESTNET";
  try {
    environment = loadEnv().SPACE_ENVIRONMENT;
  } catch {
    environment = "V1_TESTNET";
  }
  return environment === "V2_MAINNET" ? polymarketAdapter : paperAdapter;
}

/** Stable proxy so long-lived wiring picks up an environment switch. */
export const venueAdapter: VenueAdapter = {
  describe: () => activeVenue().describe(),
  ready: () => activeVenue().ready(),
  bestPrice: (tokenId, side) => activeVenue().bestPrice(tokenId, side),
  submit: (request) => activeVenue().submit(request),
  cancel: (venueOrderId) => activeVenue().cancel(venueOrderId),
  status: (venueOrderId) => activeVenue().status(venueOrderId),
  trades: (venueOrderId) => activeVenue().trades(venueOrderId),
  openOrders: (tokenId) => activeVenue().openOrders(tokenId),
  health: () => activeVenue().health(),
};
