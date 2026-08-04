import { loadEnv } from "../../config/env.server";
import { requireDriver } from "../database.server";
import type { ConnectionTimelineEntry, ConnectionId } from "../../runtime/connections.server";

interface TimelineRow {
  id: number;
  at: string;
  connection_id: string;
  label: string;
  state: string;
  message: string;
}

// Timeline rows are environment-scoped: a V1 runtime never reads or writes V2
// history, even when both environments share a database file.
function environment(): string {
  try {
    return loadEnv().SPACE_ENVIRONMENT;
  } catch {
    return "V1_TESTNET";
  }
}

export const connectionTimelineRepository = {
  async append(entry: ConnectionTimelineEntry): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO connection_timeline (at, connection_id, label, state, message, environment)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.at, entry.id, entry.label, entry.state, entry.message, environment()],
    );
  },

  async recent(limit = 300): Promise<ConnectionTimelineEntry[]> {
    const driver = await requireDriver();
    const rows = driver.all<TimelineRow>(
      `SELECT id, at, connection_id, label, state, message
       FROM connection_timeline
       WHERE environment = ?
       ORDER BY id DESC
       LIMIT ?`,
      [environment(), limit],
    );
    return rows.reverse().map((row) => ({
      at: row.at,
      id: row.connection_id as ConnectionId,
      label: row.label,
      state: row.state as ConnectionTimelineEntry["state"],
      message: row.message,
    }));
  },

  async forConnection(id: ConnectionId, limit = 100): Promise<ConnectionTimelineEntry[]> {
    const driver = await requireDriver();
    const rows = driver.all<TimelineRow>(
      `SELECT id, at, connection_id, label, state, message
       FROM connection_timeline
       WHERE connection_id = ? AND environment = ?
       ORDER BY id DESC
       LIMIT ?`,
      [id, environment(), limit],
    );
    return rows.reverse().map((row) => ({
      at: row.at,
      id: row.connection_id as ConnectionId,
      label: row.label,
      state: row.state as ConnectionTimelineEntry["state"],
      message: row.message,
    }));
  },
};
