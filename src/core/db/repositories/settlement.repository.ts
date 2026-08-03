import { requireDriver } from "../database.server";

// Strict repository rule: SQL text exists only inside db/repositories/**.
//
// Settlement rows are evidence of how a market actually resolved. A row may be
// rewritten only while it is still UNRESOLVED; once UP or DOWN is recorded it is
// final, which is what lets Replay and Statistics treat it as ground truth.

export interface SettlementRow {
  condition_id: string;
  slug: string;
  horizon: string;
  settled_at: string;
  resolved_outcome: "UP" | "DOWN" | "UNRESOLVED";
  up_price: number | null;
  down_price: number | null;
  source: string;
  recorded_at: string;
  raw: string | null;
}

export const settlementRepository = {
  async upsert(row: SettlementRow): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO settlements (
         condition_id, slug, horizon, settled_at, resolved_outcome,
         up_price, down_price, source, recorded_at, raw
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(condition_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         resolved_outcome = excluded.resolved_outcome,
         up_price = excluded.up_price,
         down_price = excluded.down_price,
         source = excluded.source,
         recorded_at = excluded.recorded_at,
         raw = excluded.raw
       WHERE settlements.resolved_outcome = 'UNRESOLVED'`,
      [
        row.condition_id,
        row.slug,
        row.horizon,
        row.settled_at,
        row.resolved_outcome,
        row.up_price,
        row.down_price,
        row.source,
        row.recorded_at,
        row.raw,
      ],
    );
  },

  async get(conditionId: string): Promise<SettlementRow | undefined> {
    const driver = await requireDriver();
    return driver.get<SettlementRow>("SELECT * FROM settlements WHERE condition_id = ?", [
      conditionId,
    ]);
  },

  async recent(limit = 500): Promise<SettlementRow[]> {
    const driver = await requireDriver();
    return driver.all<SettlementRow>("SELECT * FROM settlements ORDER BY settled_at DESC LIMIT ?", [
      limit,
    ]);
  },

  /**
   * Markets whose settlement time has passed and which are still missing a
   * final outcome. This is the ingestion work list.
   */
  async pending(nowIso: string, limit = 20): Promise<
    {
      condition_id: string;
      slug: string;
      horizon: string;
      settlement_at: string | null;
      up_token_id: string | null;
      down_token_id: string | null;
    }[]
  > {
    const driver = await requireDriver();
    return driver.all(
      `SELECT d.condition_id, d.slug, d.horizon, d.settlement_at, d.up_token_id, d.down_token_id
         FROM market_discoveries d
         LEFT JOIN settlements s ON s.condition_id = d.condition_id
        WHERE COALESCE(d.settlement_at, d.close_at) IS NOT NULL
          AND COALESCE(d.settlement_at, d.close_at) <= ?
          AND (s.condition_id IS NULL OR s.resolved_outcome = 'UNRESOLVED')
        ORDER BY COALESCE(d.settlement_at, d.close_at) DESC
        LIMIT ?`,
      [nowIso, limit],
    );
  },
};
