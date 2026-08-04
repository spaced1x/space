/**
 * Replay / Statistics regeneration check.
 *
 * Both screens must be pure functions of the persisted ledger. This script
 * attaches the database only — no engine, no sockets, no live memory — and
 * regenerates both twice. Identical output proves the two screens share one
 * dataset and that a restarted process reconstructs them from records alone.
 */
import { closeDatabase, initDatabase } from "../src/core/db/database.server";
import { listReplayMarkets, replayMarket } from "../src/core/replay/replay.server";
import { invalidateLedgerDataset, loadLedgerDataset } from "../src/core/stats/dataset.server";
import { statistics } from "../src/core/stats/statistics.server";

async function regenerate() {
  invalidateLedgerDataset();
  const dataset = await loadLedgerDataset(true);
  const stats = await statistics();
  const markets = await listReplayMarkets(10);
  const first = markets[0] ? await replayMarket(markets[0].conditionId) : null;
  return {
    rows: {
      orders: dataset.orders.length,
      fills: dataset.fills.length,
      intents: dataset.intents.length,
      risk: dataset.risk.length,
      settlements: dataset.settlements.length,
      orderTransitions: dataset.orderTransitions.length,
      positionTransitions: dataset.positionTransitions.length,
    },
    stats,
    markets,
    first,
  };
}

function stripVolatile(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry) =>
      key === "loadedAt" || key === "generatedAt" ? null : entry,
    ),
  );
}

async function main(): Promise<void> {
  await initDatabase();
  const a = await regenerate();
  const b = await regenerate();
  const same = JSON.stringify(stripVolatile(a)) === JSON.stringify(stripVolatile(b));
  await closeDatabase();

  console.log(`replay/statistics rows: ${JSON.stringify(a.rows)}`);
  console.log(`replay markets: ${a.markets.length}`);
  console.log(`regeneration deterministic: ${same}`);
  if (!same) {
    console.error("replay/statistics regeneration is not deterministic");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("replay verification failed:", error);
  process.exit(1);
});
