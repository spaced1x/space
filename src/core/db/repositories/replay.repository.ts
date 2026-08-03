import { requireDriver } from "../database.server";

// Strict repository rule: SQL text exists only inside db/repositories/**.
//
// Read-only projections used by Replay and Statistics. Both features are
// reconstructions: they never touch runtime memory, only persisted rows.

export interface DiscoveryRow {
  condition_id: string;
  slug: string;
  horizon: string;
  question: string;
  status: string;
  ptb: number | null;
  close_at: string | null;
  settlement_at: string | null;
  up_token_id: string | null;
  down_token_id: string | null;
  discovered_at: string;
  updated_at: string;
}

export interface WindowRow {
  id: string;
  condition_id: string;
  slug: string;
  horizon: string;
  seconds: number;
  buffer: number;
  enabled: number;
  opens_at: string;
  expires_at: string;
  state: string;
  reason: string;
  triggered_at: string | null;
  settlement_twap_at_trigger: number | null;
  intent_id: string | null;
  updated_at: string;
}

export interface FrozenRow {
  window_id: string;
  condition_id: string;
  horizon: string;
  seconds: number;
  opening_twap: number;
  ptb: number;
  direction: string;
  buffer: number;
  frozen_trigger: number;
  window_open_time: string;
}

export interface TransitionRow {
  window_id: string;
  condition_id: string;
  state: string;
  reason: string;
  occurred_at: string;
}

export interface IntentRow {
  id: string;
  created_at: string;
  condition_id: string;
  slug: string;
  horizon: string;
  window_seconds: number;
  direction: string;
  opening_twap: number;
  settlement_twap: number;
  ptb: number;
  buffer: number;
  frozen_trigger: number;
  trigger_time: string;
  reason: string;
}

export interface RiskRow {
  intent_id: string;
  status: string;
  code: string;
  reason: string;
  attempt: number;
  occurred_at: string;
}

export interface OrderEventRow {
  order_id: string;
  intent_id: string;
  state: string;
  reason: string;
  attempt: number;
  payload: string;
  occurred_at: string;
}

export const replayRepository = {
  async upsertDiscovery(row: DiscoveryRow): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO market_discoveries (
         condition_id, slug, horizon, question, status, ptb, close_at,
         settlement_at, up_token_id, down_token_id, discovered_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(condition_id) DO UPDATE SET
         status = excluded.status,
         ptb = COALESCE(excluded.ptb, market_discoveries.ptb),
         close_at = excluded.close_at,
         settlement_at = excluded.settlement_at,
         up_token_id = COALESCE(excluded.up_token_id, market_discoveries.up_token_id),
         down_token_id = COALESCE(excluded.down_token_id, market_discoveries.down_token_id),
         updated_at = excluded.updated_at`,
      [
        row.condition_id,
        row.slug,
        row.horizon,
        row.question,
        row.status,
        row.ptb,
        row.close_at,
        row.settlement_at,
        row.up_token_id,
        row.down_token_id,
        row.discovered_at,
        row.updated_at,
      ],
    );
  },

  async discoveries(limit = 50): Promise<DiscoveryRow[]> {
    const driver = await requireDriver();
    return driver.all<DiscoveryRow>(
      `SELECT * FROM market_discoveries ORDER BY COALESCE(settlement_at, discovered_at) DESC LIMIT ?`,
      [limit],
    );
  },

  async discovery(conditionId: string): Promise<DiscoveryRow | undefined> {
    const driver = await requireDriver();
    return driver.get<DiscoveryRow>(`SELECT * FROM market_discoveries WHERE condition_id = ?`, [
      conditionId,
    ]);
  },

  async windowConditions(limit = 50): Promise<
    { condition_id: string; slug: string; horizon: string; opens_at: string; windows: number }[]
  > {
    const driver = await requireDriver();
    return driver.all(
      `SELECT condition_id, slug, horizon, MIN(opens_at) AS opens_at, COUNT(*) AS windows
       FROM strategy_windows GROUP BY condition_id ORDER BY opens_at DESC LIMIT ?`,
      [limit],
    );
  },

  async windows(conditionId: string): Promise<WindowRow[]> {
    const driver = await requireDriver();
    return driver.all<WindowRow>(
      `SELECT * FROM strategy_windows WHERE condition_id = ? ORDER BY seconds DESC`,
      [conditionId],
    );
  },

  async frozen(conditionId: string): Promise<FrozenRow[]> {
    const driver = await requireDriver();
    return driver.all<FrozenRow>(`SELECT * FROM frozen_triggers WHERE condition_id = ?`, [
      conditionId,
    ]);
  },

  async transitions(conditionId: string): Promise<TransitionRow[]> {
    const driver = await requireDriver();
    return driver.all<TransitionRow>(
      `SELECT window_id, condition_id, state, reason, occurred_at
       FROM window_transitions WHERE condition_id = ? ORDER BY id ASC`,
      [conditionId],
    );
  },

  async intents(conditionId: string): Promise<IntentRow[]> {
    const driver = await requireDriver();
    return driver.all<IntentRow>(
      `SELECT * FROM execution_intents WHERE condition_id = ? ORDER BY created_at ASC`,
      [conditionId],
    );
  },

  async allIntents(limit = 500): Promise<IntentRow[]> {
    const driver = await requireDriver();
    return driver.all<IntentRow>(
      `SELECT * FROM execution_intents ORDER BY created_at DESC LIMIT ?`,
      [limit],
    );
  },

  async risk(conditionId: string): Promise<RiskRow[]> {
    const driver = await requireDriver();
    return driver.all<RiskRow>(
      `SELECT r.intent_id, r.status, r.code, r.reason, r.attempt, r.occurred_at
       FROM risk_decisions r
       JOIN execution_intents i ON i.id = r.intent_id
       WHERE i.condition_id = ? ORDER BY r.id ASC`,
      [conditionId],
    );
  },

  async allRisk(limit = 1000): Promise<RiskRow[]> {
    const driver = await requireDriver();
    return driver.all<RiskRow>(
      `SELECT intent_id, status, code, reason, attempt, occurred_at
       FROM risk_decisions ORDER BY id DESC LIMIT ?`,
      [limit],
    );
  },

  async orderEvents(conditionId: string): Promise<OrderEventRow[]> {
    const driver = await requireDriver();
    return driver.all<OrderEventRow>(
      `SELECT e.order_id, e.intent_id, e.state, e.reason, e.attempt, e.payload, e.occurred_at
       FROM order_events e
       JOIN orders o ON o.id = e.order_id
       WHERE o.condition_id = ? ORDER BY e.id ASC`,
      [conditionId],
    );
  },
};
