import { systemClock } from "../../shared/clock";
import type { ExecutionIntent, WindowRecord } from "../../strategy/types";
import { requireDriver } from "../database.server";

// Strict repository rule: SQL text exists only inside db/repositories/**.
//
// Frozen triggers and execution intents are write-once. The SQL triggers in
// migration 2 enforce that at the storage layer as well, so a future bug in the
// strategy engine still cannot rewrite trading evidence.
export const strategyRepository = {
  async saveWindow(window: WindowRecord): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO strategy_windows (
         id, condition_id, slug, horizon, seconds, buffer, enabled,
         opens_at, expires_at, state, reason, triggered_at,
         settlement_twap_at_trigger, intent_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         reason = excluded.reason,
         triggered_at = excluded.triggered_at,
         settlement_twap_at_trigger = excluded.settlement_twap_at_trigger,
         intent_id = excluded.intent_id,
         updated_at = excluded.updated_at`,
      [
        window.id,
        window.conditionId,
        window.slug,
        window.horizon,
        window.seconds,
        window.buffer,
        window.enabled ? 1 : 0,
        window.opensAt,
        window.expiresAt,
        window.state,
        window.reason,
        window.triggeredAt,
        window.settlementTwapAtTrigger,
        window.intentId,
        systemClock.iso(),
      ],
    );
  },

  /** Write-once. A second call for the same window is a hard error. */
  async recordFrozenTrigger(window: WindowRecord): Promise<void> {
    if (!window.frozen) return;
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO frozen_triggers (
         window_id, condition_id, horizon, seconds, opening_twap, ptb,
         direction, buffer, frozen_trigger, window_open_time
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        window.id,
        window.conditionId,
        window.horizon,
        window.seconds,
        window.frozen.openingTwap,
        window.frozen.ptb,
        window.frozen.direction,
        window.frozen.buffer,
        window.frozen.frozenTrigger,
        window.frozen.windowOpenTime,
      ],
    );
  },

  async appendTransition(
    windowId: string,
    conditionId: string,
    state: string,
    reason: string,
    at: string,
  ): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO window_transitions (window_id, condition_id, state, reason, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
      [windowId, conditionId, state, reason, at],
    );
  },

  async insertIntent(intent: ExecutionIntent): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO execution_intents (
         id, created_at, condition_id, slug, horizon, window_seconds, direction,
         opening_twap, settlement_twap, ptb, buffer, frozen_trigger, trigger_time, reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        intent.id,
        intent.createdAt,
        intent.conditionId,
        intent.slug,
        intent.horizon,
        intent.windowSeconds,
        intent.direction,
        intent.openingTwap,
        intent.settlementTwap,
        intent.ptb,
        intent.buffer,
        intent.frozenTrigger,
        intent.triggerTime,
        intent.reason,
      ],
    );
  },

  async recentIntents(limit = 20): Promise<ExecutionIntent[]> {
    const driver = await requireDriver();
    const rows = driver.all<Record<string, never>>(
      `SELECT * FROM execution_intents ORDER BY created_at DESC LIMIT ?`,
      [limit],
    );
    return rows as unknown as ExecutionIntent[];
  },
};
