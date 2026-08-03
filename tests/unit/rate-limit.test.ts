import { beforeEach, describe, expect, it } from "vitest";

import {
  getRateLimiter,
  resetRateLimiters,
  withRateLimit,
  RateLimitError,
} from "../../src/core/execution/rate-limit.server";

describe("rate limiter", () => {
  beforeEach(() => {
    resetRateLimiters();
  });

  it("allows requests under the limit", () => {
    const limiter = getRateLimiter("test", { capacity: 3, windowMs: 1000, baseBackoffMs: 100, maxBackoffMs: 1000 });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
  });

  it("blocks requests over the limit", () => {
    const limiter = getRateLimiter("test", { capacity: 3, windowMs: 1000, baseBackoffMs: 100, maxBackoffMs: 1000 });
    limiter.allow();
    limiter.allow();
    limiter.allow();
    expect(limiter.allow()).toBe(false);
  });

  it("wraps calls and throws RateLimitError when blocked", async () => {
    getRateLimiter("test", { capacity: 0, windowMs: 1000, baseBackoffMs: 100, maxBackoffMs: 1000 });
    await expect(
      withRateLimit("test", async () => "ok"),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("resets across test boundaries", () => {
    const first = getRateLimiter("test", { capacity: 1, windowMs: 1000, baseBackoffMs: 100, maxBackoffMs: 1000 });
    first.allow();
    expect(first.allow()).toBe(false);
    resetRateLimiters();
    const second = getRateLimiter("test", { capacity: 1, windowMs: 1000, baseBackoffMs: 100, maxBackoffMs: 1000 });
    expect(second.allow()).toBe(true);
  });
});
