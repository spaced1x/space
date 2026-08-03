import { systemClock, type Clock } from "../shared/clock";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  component: string;
  message: string;
  correlationId?: string;
  data?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(component: string, correlationId?: string): Logger;
}

const sinks: LogSink[] = [consoleSink];
let minLevel: LogLevel = "info";
let clock: Clock = systemClock;

function consoleSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
}

export function configureLogging(options: { level?: LogLevel; clock?: Clock } = {}): void {
  if (options.level) minLevel = options.level;
  if (options.clock) clock = options.clock;
}

export function addLogSink(sink: LogSink): void {
  sinks.push(sink);
}

// Secrets must never reach a log line, an event or a backup.
const REDACTED_KEY = /(secret|token|password|passphrase|private_key|privatekey|apikey|api_key)/i;

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = REDACTED_KEY.test(key)
      ? "[redacted]"
      : value && typeof value === "object" && !Array.isArray(value)
        ? redact(value as Record<string, unknown>)
        : value;
  }
  return out;
}

function emit(
  level: LogLevel,
  component: string,
  correlationId: string | undefined,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (SEVERITY[level] < SEVERITY[minLevel]) return;
  const record: LogRecord = { ts: clock.iso(), level, component, message };
  if (correlationId) record.correlationId = correlationId;
  if (data) record.data = redact(data);
  for (const sink of sinks) {
    try {
      sink(record);
    } catch {
      // A failing sink must never take the engine down.
    }
  }
}

export function createLogger(component: string, correlationId?: string): Logger {
  return {
    debug: (message, data) => emit("debug", component, correlationId, message, data),
    info: (message, data) => emit("info", component, correlationId, message, data),
    warn: (message, data) => emit("warn", component, correlationId, message, data),
    error: (message, data) => emit("error", component, correlationId, message, data),
    child: (childComponent, childCorrelationId) =>
      createLogger(`${component}.${childComponent}`, childCorrelationId ?? correlationId),
  };
}
