import { systemClock } from "../../shared/clock";
import { requireDriver } from "../database.server";

// Strict repository rule: SQL text exists only inside db/repositories/**.
export const kvRepository = {
  async get(key: string): Promise<string | undefined> {
    const driver = await requireDriver();
    return driver.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key])?.value;
  },

  async set(key: string, value: string): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, systemClock.iso()],
    );
  },

  async delete(key: string): Promise<void> {
    const driver = await requireDriver();
    driver.run("DELETE FROM kv WHERE key = ?", [key]);
  },
};