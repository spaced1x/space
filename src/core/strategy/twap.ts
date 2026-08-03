import type { MarketHorizon } from "../market/types";
import type { StrategyConfig, TwapReading } from "./types";

// Settlement TWAP Engine.
//
// Official definition (specification §4.1):
//   BTC 5 minute  -> final 30 seconds
//   BTC 15 minute -> final 60 seconds
//
// Time-weighted, not sample-weighted: each observed price is held until the
// next observation, so an irregular feed cadence cannot skew the average.
// Pure: it never reads a provider, only prices handed to it by the engine.

export const SETTLEMENT_TWAP_SECONDS: Record<MarketHorizon, number> = {
  FIVE_MINUTE: 30,
  FIFTEEN_MINUTE: 60,
};

interface Sample {
  atMs: number;
  price: number;
}

export interface SettlementTwapEngine {
  ingest(price: number, atMs: number): void;
  read(nowMs: number, settlementAtMs: number | null, horizon: MarketHorizon | null): TwapReading;
  reset(): void;
  sampleCount(): number;
  lastSampleAt(): number | null;
}

const IDLE: TwapReading = {
  state: "IDLE",
  value: null,
  samples: 0,
  startAt: null,
  endAt: null,
  lengthSeconds: 0,
  lastUpdateAt: null,
  message: "no active market settlement time",
};

export function createSettlementTwap(config: StrategyConfig): SettlementTwapEngine {
  // Bounded ring: the longest settlement window is 60s, keep 5 minutes of
  // history so restarts and clock jumps cannot read past the buffer.
  const RETENTION_MS = 300_000;
  let samples: Sample[] = [];

  function prune(nowMs: number): void {
    const cutoff = nowMs - RETENTION_MS;
    if (samples.length && samples[0]!.atMs < cutoff) {
      samples = samples.filter((sample) => sample.atMs >= cutoff);
    }
  }

  return {
    ingest(price, atMs) {
      if (!Number.isFinite(price) || price <= 0) return;
      const last = samples[samples.length - 1];
      if (last && atMs <= last.atMs) return; // monotonic only: no reordering
      samples.push({ atMs, price });
      prune(atMs);
    },

    reset() {
      samples = [];
    },

    sampleCount() {
      return samples.length;
    },

    lastSampleAt() {
      return samples.length ? samples[samples.length - 1]!.atMs : null;
    },

    read(nowMs, settlementAtMs, horizon) {
      if (settlementAtMs === null || horizon === null) return IDLE;
      const lengthSeconds = SETTLEMENT_TWAP_SECONDS[horizon];
      const startMs = settlementAtMs - lengthSeconds * 1000;
      const endMs = Math.min(nowMs, settlementAtMs);
      const base = {
        lengthSeconds,
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
        lastUpdateAt: samples.length
          ? new Date(samples[samples.length - 1]!.atMs).toISOString()
          : null,
      };

      if (endMs <= startMs) {
        return {
          ...base,
          state: "WARMING",
          value: null,
          samples: 0,
          message: "settlement window has not started",
        };
      }

      const inWindow = samples.filter((sample) => sample.atMs >= startMs && sample.atMs <= endMs);
      // A sample taken before the window still sets the price at window start.
      const carry = [...samples].reverse().find((sample) => sample.atMs < startMs) ?? null;
      const effective = carry ? [{ atMs: startMs, price: carry.price }, ...inWindow] : inWindow;

      if (effective.length < config.minTwapSamples) {
        return {
          ...base,
          state: "WARMING",
          value: null,
          samples: effective.length,
          message: `warming: ${effective.length}/${config.minTwapSamples} samples`,
        };
      }

      let weighted = 0;
      let duration = 0;
      for (let index = 0; index < effective.length; index += 1) {
        const sample = effective[index]!;
        const next = effective[index + 1];
        const from = Math.max(sample.atMs, startMs);
        const to = Math.min(next ? next.atMs : endMs, endMs);
        const span = to - from;
        if (span <= 0) continue;
        weighted += sample.price * span;
        duration += span;
      }
      const value = duration > 0 ? weighted / duration : effective[effective.length - 1]!.price;

      const lastAt = samples[samples.length - 1]!.atMs;
      const ageMs = nowMs - lastAt;
      if (ageMs > config.maxTwapAgeMs) {
        return {
          ...base,
          state: "STALE",
          value,
          samples: effective.length,
          message: `last sample ${ageMs}ms old (limit ${config.maxTwapAgeMs}ms)`,
        };
      }

      return {
        ...base,
        state: "OK",
        value,
        samples: effective.length,
        message: `time-weighted over final ${lengthSeconds}s`,
      };
    },
  };
}
