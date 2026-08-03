import { systemClock } from "../../shared/clock";
import { requireDriver } from "../database.server";

export interface AuditRow {
  correlationId: string;
  actor: string;
  source: string;
  command: string;
  payload: Record<string, unknown>;
  verdict: string;
  reason: string | null;
}

export const auditRepository = {
  async append(row: AuditRow): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO audit_log (created_at, correlation_id, actor, source, command, payload, verdict, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        systemClock.iso(),
        row.correlationId,
        row.actor,
        row.source,
        row.command,
        JSON.stringify(row.payload),
        row.verdict,
        row.reason,
      ],
    );
  },

  async recent(limit = 50): Promise<Record<string, unknown>[]> {
    const driver = await requireDriver();
    return driver.all("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", [limit]);
  },
};
