import { loadEnv } from "../config/env.server";
import { telegramRepository } from "../db/repositories/telegram.repository";
import { createLogger } from "../logging/logger";
import { eventBus } from "../bus/events";

const log = createLogger("telegram");

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function readConfig(): TelegramConfig | undefined {
  const env = loadEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return undefined;
  return { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
}

export function telegramHealth() {
  const config = readConfig();
  return {
    configured: !!config,
    chatId: config?.chatId,
  };
}

export async function sendTelegramMessage(text: string, type = "broadcast"): Promise<void> {
  const config = readConfig();
  const recordId = await telegramRepository.insert(
    config?.chatId ?? "not_configured",
    type,
    text,
  );
  if (!config) {
    log.warn("telegram not configured; message queued but not sent", { recordId });
    return;
  }

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "HTML",
        disable_notification: type === "heartbeat",
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = (body as { description?: string }).description ?? `HTTP ${response.status}`;
      await telegramRepository.markFailed(recordId, error);
      log.warn("telegram send failed", { recordId, error });
      return;
    }
    await telegramRepository.markSent(recordId);
    log.info("telegram sent", { recordId, chatId: config.chatId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await telegramRepository.markFailed(recordId, message);
    log.warn("telegram send exception", { recordId, message });
  }
}

export function registerTelegramEventForwarding(): void {
  // Forward ERROR and WARNING events to Telegram so the operator is notified
  // of critical runtime conditions even when away from the dashboard.
  eventBus.subscribeAll((event) => {
    if (event.severity !== "ERROR" && event.severity !== "WARNING") return;
    const text = `<b>[${event.severity}] ${event.source}</b>\n${event.type}\n${event.correlationId ?? ""}`;
    void sendTelegramMessage(text, "event");
  });
}
