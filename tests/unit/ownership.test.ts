import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Runtime ownership verification.
//
// SPACE only behaves deterministically because every subsystem has exactly one
// owning module. A second implementation — a second scheduler timer, a second
// SQLite handle, a second boot path — is the defect class that produces
// duplicate orders and phantom telemetry. This test proves ownership from the
// source tree so a regression fails CI instead of production.

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

const files = sourceFiles("src");
const read = (file: string) => readFileSync(file, "utf8");

/** Files that declare a symbol matching the pattern. */
function declaredIn(pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(read(file))).sort();
}

interface Owner {
  subsystem: string;
  owner: string;
  /** Declaration that must exist in the owner and nowhere else. */
  pattern: RegExp;
  /** Files allowed to also match, with the reason they are legitimate. */
  allow?: string[];
}

const OWNERS: Owner[] = [
  {
    subsystem: "Boot",
    owner: "src/core/boot.server.ts",
    pattern: /export async function boot\(/,
  },
  {
    subsystem: "Shutdown",
    owner: "src/core/shutdown.server.ts",
    pattern: /export async function shutdown\(/,
  },
  {
    subsystem: "Scheduler",
    owner: "src/core/scheduler/scheduler.server.ts",
    pattern: /export async function startScheduler\(/,
  },
  {
    subsystem: "Engine loop",
    owner: "src/core/engine/loop.server.ts",
    pattern: /export function engineResources\(/,
  },
  {
    subsystem: "Snapshot",
    owner: "src/lib/system.functions.ts",
    pattern: /export const getSystemSnapshot =/,
  },
  {
    subsystem: "Resource audit",
    owner: "src/core/runtime/resources.server.ts",
    pattern: /export function auditRuntimeResources\(/,
  },
  {
    subsystem: "Startup validation",
    owner: "src/core/startup/validation.server.ts",
    pattern: /export (async )?function runStartupValidation\(/,
  },
  {
    subsystem: "Connection registry",
    owner: "src/core/runtime/connections.server.ts",
    pattern: /export function reportConnection\(/,
  },
  {
    subsystem: "Provider registry",
    owner: "src/core/twap/registry.server.ts",
    pattern: /export function listProviders\(/,
  },
  {
    subsystem: "Venue selector",
    owner: "src/core/execution/adapter.server.ts",
    pattern: /function activeVenue\(/,
  },
  {
    subsystem: "Instance lock",
    owner: "src/core/db/lock.server.ts",
    pattern: /export function lockResources\(/,
  },
  {
    subsystem: "Position derivation",
    owner: "src/core/execution/positions.ts",
    pattern: /export function derivePositionTransitions\(/,
  },
  {
    subsystem: "Sizing",
    owner: "src/core/execution/sizing.ts",
    pattern: /export function decideSize\(/,
  },
];

describe("runtime ownership", () => {
  for (const entry of OWNERS) {
    it(`${entry.subsystem} has exactly one owner`, () => {
      const found = declaredIn(entry.pattern);
      expect(found, `${entry.subsystem}: expected only ${entry.owner}`).toEqual([entry.owner]);
    });
  }
});

describe("single-implementation invariants", () => {
  it("only the sqlite driver opens a database handle", () => {
    expect(declaredIn(/new Database\(/)).toEqual(["src/core/db/drivers/sqlite.server.ts"]);
  });

  it("only the shared websocket client constructs sockets", () => {
    expect(declaredIn(/new WebSocket\(/)).toEqual(["src/core/shared/ws-client.server.ts"]);
  });

  it("no runtime module owns its own recurring timer", () => {
    // The scheduler owns cadence. Browser-side hooks are not runtime modules.
    const offenders = declaredIn(/setInterval\(/).filter((file) => file.startsWith("src/core/"));
    expect(offenders).toEqual([]);
  });

  it("no route or component boots the runtime", () => {
    const offenders = files
      .filter((file) => file.startsWith("src/routes/") || file.startsWith("src/components/"))
      .filter((file) => /\bboot\(\)/.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
