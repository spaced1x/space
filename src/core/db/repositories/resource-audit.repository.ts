import { requireDriver } from "../database.server";
import type { RuntimeResourceAudit } from "../../runtime/resources.server";

interface AuditRow {
  id: number;
  at: string;
  phase: string;
  expectation: string;
  passed: number;
  failures: string;
  checks: string;
  heap_used_bytes: number | null;
}

export const resourceAuditRepository = {
  async append(audit: RuntimeResourceAudit): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO resource_audits (at, phase, expectation, passed, failures, checks, heap_used_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        audit.at,
        audit.phase,
        audit.expectation,
        audit.passed ? 1 : 0,
        JSON.stringify(audit.failures),
        JSON.stringify(audit.checks),
        audit.heapUsedBytes,
      ],
    );
  },

  async recent(limit = 50): Promise<RuntimeResourceAudit[]> {
    const driver = await requireDriver();
    const rows = driver.all<AuditRow>(
      `SELECT id, at, phase, expectation, passed, failures, checks, heap_used_bytes
       FROM resource_audits
       ORDER BY id DESC
       LIMIT ?`,
      [limit],
    );
    return rows.reverse().map((row) => ({
      at: row.at,
      phase: row.phase as RuntimeResourceAudit["phase"],
      expectation: row.expectation as RuntimeResourceAudit["expectation"],
      passed: Boolean(row.passed),
      failures: JSON.parse(row.failures) as string[],
      checks: JSON.parse(row.checks) as RuntimeResourceAudit["checks"],
      heapUsedBytes: row.heap_used_bytes ?? 0,
    }));
  },

  async latest(): Promise<RuntimeResourceAudit | null> {
    const driver = await requireDriver();
    const row = driver.get<AuditRow>(
      `SELECT id, at, phase, expectation, passed, failures, checks, heap_used_bytes
       FROM resource_audits
       ORDER BY id DESC
       LIMIT 1`,
    );
    if (!row) return null;
    return {
      at: row.at,
      phase: row.phase as RuntimeResourceAudit["phase"],
      expectation: row.expectation as RuntimeResourceAudit["expectation"],
      passed: Boolean(row.passed),
      failures: JSON.parse(row.failures) as string[],
      checks: JSON.parse(row.checks) as RuntimeResourceAudit["checks"],
      heapUsedBytes: row.heap_used_bytes ?? 0,
    };
  },
};
