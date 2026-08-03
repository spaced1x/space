import { dispatchCommand } from "../bus/command-bus.server";
import { activeOperations } from "../config/operations.server";
import type { TelegramPermissionMode } from "../config/operations";
import { telegramRepository } from "../db/repositories/telegram.repository";
import { createLogger } from "../logging/logger";
import { correlationId } from "../shared/ids";
import { loadEnv } from "../config/env.server";
import { sendTelegramMessage } from "./telegram.service";

// Inbound Telegram command receiver.
//
// The bot long-polls Telegram's getUpdates endpoint. Every message from the
// configured chat is validated, mapped to a SPACE command, and dispatched
// through the audited command bus. Unknown commands are ignored but logged.
// The permission mode is read from the active Operations Desk configuration.

const log = createLogger("telegram-inbound");

interface TelegramMessage {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    from?: { username?: string };
  };
}

let lastUpdateId = 0;
let running = false;
let pollTimeout: ReturnType<typeof setTimeout> | undefined;

const POLL_INTERVAL_MS = 5_000;

function config() {
  const env = loadEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return undefined;
  return { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/^\/+/, "");
}

function allowed(kind: string, mode: TelegramPermissionMode): boolean {
  if (mode === "FULL_OPERATOR") return true;
  if (mode === "SAFE_CONTROLS") {
    return ["status", "disarm", "pause", "emergency_stop", "backup"].includes(kind);
  }
  return ["status"].includes(kind);
}

async function handleMessage(text: string, username: string): Promise<void> {
  const mode = activeOperations().telegramPermissionMode;
  const cid = correlationId("tg");

  const parts = text.split(/\s+/);
  const command = normalize(parts[0] ?? "");

  switch (command) {
    case "status":
      await sendTelegramMessage(`SPACE status: ${JSON.stringify({ mode })}`, "operator");
      return;
    case "arm": {
      if (!allowed("arm", mode)) {
        await sendTelegramMessage("ARM is not allowed in the current Telegram permission mode.", "operator");
        return;
      }
      await dispatchCommand({ kind: "ARM" }, { actor: username, source: "telegram", correlationId: cid });
      return;
    }
    case "disarm":
      await dispatchCommand({ kind: "DISARM" }, { actor: username, source: "telegram", correlationId: cid });
      return;
    case "pause":
      await dispatchCommand({ kind: "PAUSE" }, { actor: username, source: "telegram", correlationId: cid });
      return;
    case "resume": {
      if (!allowed("resume", mode)) {
        await sendTelegramMessage("RESUME is not allowed in the current Telegram permission mode.", "operator");
        return;
      }
      await dispatchCommand({ kind: "RESUME" }, { actor: username, source: "telegram", correlationId: cid });
      return;
    }
    case "mode": {
      if (!allowed("set_mode", mode)) {
        await sendTelegramMessage("SET_MODE is not allowed in the current Telegram permission mode.", "operator");
        return;
      }
      const target = normalize(parts[1] ?? "");
      if (target !== "strategy" && target !== "manual") {
        await sendTelegramMessage("Usage: /mode strategy|manual", "operator");
        return;
      }
      await dispatchCommand(
        { kind: "SET_MODE", mode: target === "strategy" ? "STRATEGY" : "MANUAL" },
        { actor: username, source: "telegram", correlationId: cid },
      );
      return;
    }
    case "stop":
    case "kill":
    case "emergency_stop": {
      const reason = parts.slice(1).join(" ") || `Telegram ${command} from ${username}`;
      await dispatchCommand(
        { kind: "EMERGENCY_STOP", reason },
        { actor: username, source: "telegram", correlationId: cid },
      );
      return;
    }
    case "reset_stop":
      await dispatchCommand(
        { kind: "RESET_EMERGENCY_STOP" },
        { actor: username, source: "telegram", correlationId: cid },
      );
      return;
    case "backup": {
      if (!allowed("backup", mode)) {
        await sendTelegramMessage("BACKUP is not allowed in the current Telegram permission mode.", "operator");
        return;
      }
      await dispatchCommand({ kind: "BACKUP" }, { actor: username, source: "telegram", correlationId: cid });
      return;
    }
    case "broadcast": {
      const message = parts.slice(1).join(" ");
      if (!message) {
        await sendTelegramMessage("Usage: /broadcast <message>", "operator");
        return;
      }
      await dispatchCommand(
        { kind: "TELEGRAM_BROADCAST", message },
        { actor: username, source: "telegram", correlationId: cid },
      );
      return;
    }
    default:
      log.info("unknown telegram command ignored", { command, username });
  }
}

async function poll(): Promise<void> {
  const cfg = config();
  if (!cfg) return;

  const url = `https://api.telegram.org/bot${cfg.botToken}/getUpdates`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset: lastUpdateId ? lastUpdateId + 1 : undefined,
        limit: 10,
      }),
    });
    if (!response.ok) {
      log.warn("telegram getUpdates failed", { status: response.status });
      return;
    }
    const body = (await response.json()) as { ok: boolean; result: TelegramMessage[] };
    if (!body.ok || !Array.isArray(body.result)) return;

    for (const update of body.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      const message = update.message;
      if (!message?.text) continue;
      const chatId = String(message.chat.id);
      if (chatId !== cfg.chatId) {
        log.info("ignoring telegram message from unconfigured chat", { chatId });
        continue;
      }
      await telegramRepository.insertInbound(
        chatId,
        message.from?.username ?? "unknown",
        message.text,
      );
      await handleMessage(message.text, message.from?.username ?? "unknown");
    }
  } catch (error) {
    log.warn("telegram poll exception", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function startTelegramInbound(): void {
  if (running) return;
  const cfg = config();
  if (!cfg) {
    log.info("telegram inbound not started: bot token or chat id missing");
    return;
  }
  running = true;

  async function loop(): Promise<void> {
    if (!running) return;
    await poll();
    pollTimeout = setTimeout(() => void loop(), POLL_INTERVAL_MS);
  }

  void loop();
  log.info("telegram inbound polling started", { chatId: cfg.chatId });
}

export function stopTelegramInbound(): void {
  running = false;
  if (pollTimeout) clearTimeout(pollTimeout);
  pollTimeout = undefined;
}
