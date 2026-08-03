import type { HealthResult } from "../health/types";
import { telegramHealth } from "./telegram.service";

export function telegramServiceHealth(): HealthResult {
  const status = telegramHealth();
  const details = {
    configured: status.configured,
    chatId: status.chatId ?? null,
  };
  if (!status.configured) {
    return {
      state: "DISABLED",
      message: "Telegram bot token or chat id not configured",
      details,
    };
  }
  return {
    state: "OK",
    message: "Telegram configured",
    details,
  };
}
