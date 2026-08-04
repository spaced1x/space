import { clock } from "../clock/clock.service";
import { createLogger } from "../logging/logger";
import { activeFailureScenario } from "../validation/failure-simulation.server";
import type { FaultTarget } from "../validation/failure-simulation.server";

// Reconnecting WebSocket client shared by every venue stream (Polymarket RTDS,
// the Polymarket CLOB market channel, Binance).
//
// It owns exactly one socket at a time and implements the runtime contract the
// SPACE architecture requires:
//
//   CONNECTED -> STALE -> RECONNECTING -> CONNECTED
//
// Reconnects use exponential backoff with jitter and a bounded retry budget.
// When the budget is exhausted the client reports FAILED with the exact reason
// and stops; recovery then requires an operator action or a runtime restart.

export type SocketState = "IDLE" | "CONNECTING" | "CONNECTED" | "STALE" | "RECONNECTING" | "FAILED";

export interface WsClientOptions {
  name: string;
  /** Fault-injection target so recovery drills can drop this socket on demand. */
  faultTarget?: FaultTarget;
  url: () => string;
  /** Frames sent immediately after every (re)connect. Resubscription lives here. */
  onOpen?: (send: (frame: string) => void) => void;
  onMessage: (raw: string) => void;
  /** Heartbeat frame, sent every pingMs. Return null to disable. */
  ping?: () => string | null;
  pingMs?: number;
  /** No inbound message within this window marks the socket STALE. */
  staleMs: number;
  maxAttempts: number;
  maxBackoffMs: number;
}

export interface WsClientStats {
  state: SocketState;
  endpoint: string | null;
  connected: boolean;
  attempts: number;
  reconnects: number;
  messages: number;
  errors: number;
  lastError: string | null;
  lastMessageAt: string | null;
  lastConnectedAt: string | null;
  ageMs: number | null;
  budgetExhausted: boolean;
}

export interface WsClient {
  start(): void;
  stop(): void;
  /** Watchdog step. The scheduler owns the timer; the client only reacts. */
  tick(): void;
  send(frame: string): boolean;
  stats(): WsClientStats;
  isOpen(): boolean;
}

export function createWsClient(options: WsClientOptions): WsClient {
  const log = createLogger(`ws:${options.name}`);
  let socket: WebSocket | undefined;
  let state: SocketState = "IDLE";
  let stopped = true;
  let endpoint: string | null = null;
  let attempts = 0;
  let reconnects = 0;
  let messages = 0;
  let errors = 0;
  let lastError: string | null = null;
  let lastMessageAt: number | null = null;
  let lastConnectedAt: number | null = null;
  let lastPingAt: number | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function send(frame: string): boolean {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(frame);
      return true;
    } catch (error) {
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  function closeSocket(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const current = socket;
    socket = undefined;
    if (!current) return;
    current.onopen = null;
    current.onmessage = null;
    current.onerror = null;
    current.onclose = null;
    try {
      current.close();
    } catch {
      // already closed
    }
  }

  function fail(reason: string): void {
    lastError = reason;
    state = "FAILED";
    closeSocket();
    log.error("socket failed", { reason, endpoint });
  }

  function scheduleReconnect(reason: string): void {
    if (stopped || reconnectTimer) return;
    lastError = reason;
    if (attempts >= options.maxAttempts) {
      fail(`retry budget exhausted after ${attempts} attempts: ${reason}`);
      return;
    }
    state = "RECONNECTING";
    reconnects += 1;
    attempts += 1;
    const base = Math.min(options.maxBackoffMs, 500 * 2 ** Math.min(attempts, 6));
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    log.warn("scheduling reconnect", { reason, attempt: attempts, delayMs: delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    if (reconnectTimer && typeof reconnectTimer === "object" && "unref" in reconnectTimer) {
      (reconnectTimer as { unref: () => void }).unref();
    }
  }

  function connect(): void {
    if (stopped) return;
    if (typeof WebSocket === "undefined") {
      fail("WebSocket is not available in this runtime");
      return;
    }
    let target: string;
    try {
      target = options.url();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!target) {
      fail("no endpoint configured");
      return;
    }
    endpoint = target;
    state = state === "IDLE" ? "CONNECTING" : state;
    const fault = options.faultTarget ? activeFailureScenario(options.faultTarget) : null;
    if (fault) {
      // Injected faults take the same path as a real refused connection, so the
      // drill exercises the production reconnect and backoff logic.
      errors += 1;
      scheduleReconnect(`${fault.errorMessage} (injected)`);
      return;
    }
    try {
      const next = new WebSocket(target);
      socket = next;
      next.onopen = () => {
        state = "CONNECTED";
        attempts = 0;
        lastConnectedAt = clock().now();
        lastMessageAt = clock().now();
        lastPingAt = clock().now();
        lastError = null;
        log.info("socket connected", { endpoint });
        options.onOpen?.(send);
      };
      next.onmessage = (event: MessageEvent) => {
        lastMessageAt = clock().now();
        if (state === "STALE" || state === "RECONNECTING") state = "CONNECTED";
        messages += 1;
        try {
          options.onMessage(typeof event.data === "string" ? event.data : String(event.data));
        } catch (error) {
          errors += 1;
          lastError = error instanceof Error ? error.message : String(error);
        }
      };
      next.onerror = () => {
        errors += 1;
        lastError = "socket error";
      };
      next.onclose = () => {
        if (stopped) return;
        closeSocket();
        scheduleReconnect(lastError ?? "socket closed by peer");
      };
    } catch (error) {
      errors += 1;
      scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      state = "CONNECTING";
      attempts = 0;
      connect();
    },

    stop() {
      stopped = true;
      state = "IDLE";
      closeSocket();
      log.info("socket stopped", { messages, reconnects });
    },

    tick() {
      if (stopped || state === "FAILED") return;
      const now = clock().now();
      const pingMs = options.pingMs ?? 0;
      if (pingMs > 0 && socket?.readyState === 1) {
        if (lastPingAt === null || now - lastPingAt >= pingMs) {
          const frame = options.ping?.() ?? null;
          if (frame !== null) send(frame);
          lastPingAt = now;
        }
      }
      const ageMs = lastMessageAt === null ? null : now - lastMessageAt;
      if (socket?.readyState === 1 && ageMs !== null && ageMs > options.staleMs) {
        // Documented recovery path: mark STALE, then force a reconnect so a
        // half-open socket can never masquerade as a live feed.
        if (state === "CONNECTED") {
          state = "STALE";
          log.warn("socket stale", { endpoint, ageMs });
        }
        closeSocket();
        scheduleReconnect(`no message for ${ageMs}ms`);
        return;
      }
      if (!socket && state !== "RECONNECTING") {
        scheduleReconnect(lastError ?? "socket not open");
      }
    },

    send,

    isOpen: () => socket?.readyState === 1,

    stats(): WsClientStats {
      return {
        state,
        endpoint,
        connected: socket?.readyState === 1,
        attempts,
        reconnects,
        messages,
        errors,
        lastError,
        lastMessageAt: lastMessageAt === null ? null : new Date(lastMessageAt).toISOString(),
        lastConnectedAt: lastConnectedAt === null ? null : new Date(lastConnectedAt).toISOString(),
        ageMs: lastMessageAt === null ? null : clock().now() - lastMessageAt,
        budgetExhausted: state === "FAILED",
      };
    },
  };
}
