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

export const connectionTimelineRepository = {
  async append(entry: ConnectionTimelineEntry): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO connection_timeline (at, connection_id, label, state, message)
       VALUES (?, ?, ?, ?, ?)`,
      [entry.at, entry.id, entry.label, entry.state, entry.message],
    );
  },

  async recent(limit = 300): Promise<ConnectionTimelineEntry[]> {
    const driver = await requireDriver();
    const rows = driver.all<TimelineRow>(
      `SELECT id, at, connection_id, label, state, message
       FROM connection_timeline
       ORDER BY id DESC
       LIMIT ?`,
      [limit],
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
       WHERE connection_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [id, limit],
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
