// Injectable time source. Every module reads time through a Clock so tests and
// replay can drive deterministic time.
export interface Clock {
  now(): number;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

export function fixedClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
  };
}