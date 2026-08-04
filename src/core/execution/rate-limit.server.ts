import { clock } from "../clock/clock.service";
import { createLogger } from "../logging/logger";

// Rate limiter for external venue endpoints.
//
// Each endpoint (Gamma discovery, CLOB submit, CLOB fills) gets its own budget.
// A 429 response consumes budget and triggers exponential backoff with jitter.
// The limiter surfaces DEGRADED health and blocks new requests until budget
// recovers, but it never auto-disarms an ARMED engine with open positions.

const log = createLogger("rate-limit");

export interface RateLimitConfig {
  /** Maximum requests allowed in the window. */
  capacity: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Initial backoff after the first 429. */
  baseBackoffMs: number;
  /** Maximum backoff ceiling. */
  maxBackoffMs: number;
}

export interface RateLimitState {
  endpoint: string;
  remaining: number;
  windowMs: number;
  backoffUntil: number;
  consecutive429: number;
  total429: number;
  last429At: string | null;
  /** Count of `Poly-RateLimit-Warning` responses seen on this endpoint. */
  warnings: number;
  lastWarningAt: string | null;
}

// Documented Polymarket budgets (docs.polymarket.com). Order and cancel get
// their own buckets because the venue meters them separately per signer.
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  /** Gamma `/markets`: 300 requests per 10 seconds. */
  gamma_discovery: { capacity: 300, windowMs: 10_000, baseBackoffMs: 1_000, maxBackoffMs: 30_000 },
  /** CLOB order placement burst budget. */
  clob_submit: { capacity: 30, windowMs: 10_000, baseBackoffMs: 500, maxBackoffMs: 30_000 },
  /** CLOB cancellations are metered separately from placements. */
  clob_cancel: { capacity: 30, windowMs: 10_000, baseBackoffMs: 500, maxBackoffMs: 30_000 },
  /** General authenticated CLOB reads (orders, trades, books). */
  clob_fills: { capacity: 100, windowMs: 10_000, baseBackoffMs: 500, maxBackoffMs: 30_000 },
};

/**
 * The venue warns before it enforces. `Poly-RateLimit-Warning: true` means the
 * caller is close to the budget; SPACE treats it as a DEGRADED signal and backs
 * off proactively instead of waiting for the first 429.
 */
export function noteRateLimitWarning(endpoint: string, headers: Headers | null): void {
  if (headers?.get("Poly-RateLimit-Warning")?.toLowerCase() !== "true") return;
  getRateLimiter(endpoint).onWarning();
}

class EndpointLimiter {
  private config: RateLimitConfig;
  private tokens: number;
  private windowStart: number;
  private backoffUntil = 0;
  private consecutive429 = 0;
  private total429 = 0;
  private last429At: string | null = null;
  private warnings = 0;
  private lastWarningAt: string | null = null;

  constructor(
    readonly endpoint: string,
    config: RateLimitConfig,
  ) {
    this.config = config;
    this.tokens = config.capacity;
    this.windowStart = clock().now();
  }

  private now() {
    return clock().now();
  }

  private refill() {
    const now = this.now();
    if (now - this.windowStart >= this.config.windowMs) {
      this.tokens = this.config.capacity;
      this.windowStart = now;
    }
  }

  /** Returns true if the request may proceed. */
  allow(): boolean {
    this.refill();
    if (this.now() < this.backoffUntil) return false;
    if (this.tokens <= 0) return false;
    this.tokens -= 1;
    return true;
  }

  /** Call when a 429 is received. Returns the backoff duration. */
  on429(): number {
    this.consecutive429 += 1;
    this.total429 += 1;
    this.last429At = clock().iso();
    const base = this.config.baseBackoffMs * 2 ** (this.consecutive429 - 1);
    const jitter = Math.random() * 0.3 * base;
    const backoff = Math.min(base + jitter, this.config.maxBackoffMs);
    this.backoffUntil = this.now() + backoff;
    log.warn("rate limit hit", {
      endpoint: this.endpoint,
      backoffMs: backoff,
      total429: this.total429,
    });
    return backoff;
  }

  /** Call when a request succeeds to decay consecutive failures. */
  onSuccess() {
    if (this.consecutive429 > 0) {
      this.consecutive429 = Math.max(0, this.consecutive429 - 1);
    }
  }

  /** Venue warned that the budget is nearly spent: slow down before the 429. */
  onWarning() {
    this.warnings += 1;
    this.lastWarningAt = clock().iso();
    this.backoffUntil = Math.max(this.backoffUntil, this.now() + this.config.baseBackoffMs);
    log.warn("venue rate limit warning", { endpoint: this.endpoint, warnings: this.warnings });
  }

  state(): RateLimitState {
    return {
      endpoint: this.endpoint,
      remaining: Math.max(0, this.tokens),
      windowMs: this.config.windowMs,
      backoffUntil: this.backoffUntil,
      consecutive429: this.consecutive429,
      total429: this.total429,
      last429At: this.last429At,
      warnings: this.warnings,
      lastWarningAt: this.lastWarningAt,
    };
  }

  isLimited(): boolean {
    return this.now() < this.backoffUntil || this.tokens <= 0;
  }
}

const limiters = new Map<string, EndpointLimiter>();

export function getRateLimiter(endpoint: string, config?: RateLimitConfig): EndpointLimiter {
  const existing = limiters.get(endpoint);
  if (existing) return existing;
  const cfg = config ??
    DEFAULT_RATE_LIMITS[endpoint] ?? {
      capacity: 60,
      windowMs: 60_000,
      baseBackoffMs: 500,
      maxBackoffMs: 30_000,
    };
  const created = new EndpointLimiter(endpoint, cfg);
  limiters.set(endpoint, created);
  return created;
}

export function resetRateLimiters(): void {
  limiters.clear();
}

export function rateLimitStatus(): RateLimitState[] {
  return [...limiters.values()].map((l) => l.state());
}

export function anyRateLimited(): boolean {
  return [...limiters.values()].some((l) => l.isLimited());
}

/**
 * Wrap a venue call with rate limiting. If the limiter blocks the call, it
 * throws a RateLimitError that the caller should treat as an indeterminate
 * state, not a failure.
 */
export class RateLimitError extends Error {
  constructor(
    readonly endpoint: string,
    readonly retryAfterMs: number,
  ) {
    super(`rate limited: ${endpoint}, retry after ${retryAfterMs}ms`);
    this.name = "RateLimitError";
  }
}

export async function withRateLimit<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
  const limiter = getRateLimiter(endpoint);
  if (!limiter.allow()) {
    throw new RateLimitError(endpoint, Math.max(0, limiter.state().backoffUntil - clock().now()));
  }
  try {
    const result = await fn();
    limiter.onSuccess();
    return result;
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 429) {
      limiter.on429();
    }
    throw error;
  }
}
