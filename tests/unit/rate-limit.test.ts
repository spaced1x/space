import { beforeEach, describe, expect, it } from "vitest";

import {
  createRateLimiter,
  type RateLimiter,
} from "../../src/core/execution/rate-limit.server";

describe("rate limiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = createRateLimiter({ maxRequests: 3, windowMs: 1000, endpoint: "test" });
  });

  it("allows requests under the limit", async () => {
    for (let i = 0; i < 3; i++) {
      const result = await limiter.allow();
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks requests over the limit and reports backoff", async () => {
    for (let i = 0; i < 3; i++) await limiter.allow();
    const result = await limiter.allow();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("recovers after the window passes", async () => {
    for (let i = 0; i < 3; i++) await limiter.allow();
    limiter.reset();
    const result = await limiter.allow();
    expect(result.allowed).toBe(true);
  });
});
