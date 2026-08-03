import { systemClock } from "../../shared/clock";
import { requireDriver } from "../database.server";

export interface TelegramOutboxRecord {
  id: number;
  created_at: string;
  chat_id: string;
  type: string;
  text: string;
  sent: number;
  error: string | null;
}

export interface TelegramInboundRecord {
  id: number;
  created_at: string;
  chat_id: string;
  username: string;
  text: string;
}

export const telegramRepository = {
  async insert(chatId: string, type: string, text: string): Promise<number> {
    const driver = await requireDriver();
    const result = driver.run(
      `INSERT INTO telegram_outbox (created_at, chat_id, type, text)
       VALUES (?, ?, ?, ?)`,
      [systemClock.iso(), chatId, type, text],
    );
    return Number(result.lastInsertRowid);
  },

  async markSent(id: number): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `UPDATE telegram_outbox SET sent = 1 WHERE id = ?`,
      [id],
    );
  },

  async markFailed(id: number, error: string): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `UPDATE telegram_outbox SET error = ? WHERE id = ?`,
      [error, id],
    );
  },

  async recent(limit = 50): Promise<TelegramOutboxRecord[]> {
    const driver = await requireDriver();
    return driver.all<TelegramOutboxRecord>(
      `SELECT id, created_at, chat_id, type, text, sent, error
       FROM telegram_outbox
       ORDER BY id DESC
       LIMIT ?`,
      [limit],
    );
  },

  async insertInbound(chatId: string, username: string, text: string): Promise<number> {
    const driver = await requireDriver();
    const result = driver.run(
      `INSERT INTO telegram_inbound (created_at, chat_id, username, text)
       VALUES (?, ?, ?, ?)`,
      [systemClock.iso(), chatId, username, text],
    );
    return Number(result.lastInsertRowid);
  },

  async recentInbound(limit = 50): Promise<TelegramInboundRecord[]> {
    const driver = await requireDriver();
    return driver.all<TelegramInboundRecord>(
      `SELECT id, created_at, chat_id, username, text
       FROM telegram_inbound
       ORDER BY id DESC
       LIMIT ?`,
      [limit],
    );
  },
};
