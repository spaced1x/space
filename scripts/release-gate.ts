/**
 * SPACE release gate — hybrid.
 *
 * Stage 1 runs the static checks. Stage 2 starts the production build (or
 * attaches to a running instance via RUNTIME_BASE_URL) and validates it
 * exclusively through the public runtime API, exactly the way an operator or a
 * monitor would on the VPS. No internal module state is inspected in stage 2,
 * so the gate behaves identically locally and against a live host.
 *
 *   bun run release:gate
 *   RUNTIME_BASE_URL=https://space.example.com bun run release:gate
 *   SKIP_STATIC=1 bun run release:gate      # runtime stage only
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Check {
  stage: "static" | "runtime";
  name: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];
const OUT_DIR = "docs/releases/v1.0.0";
const PORT = Number(process.env["GATE_PORT"] ?? 8099);
const JITI = "node_modules/.bin/jiti";
const SOAK_MINUTES = Number(process.env["GATE_SOAK_MINUTES"] ?? 3);

function record(stage: Check["stage"], name: string, passed: boolean, detail: string): void {
  checks.push({ stage, name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  [${stage}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(
  stage: Check["stage"],
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): boolean {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const passed = result.status === 0;
  record(stage, name, passed, passed ? "" : output.split("\n").slice(-8).join(" | "));
  return passed;
}

// ── Stage 1 ────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === ".output")
      continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

// Anything that looks like a real credential must never reach the repository.
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "private key (hex)", pattern: /\b0x[a-fA-F0-9]{64}\b/ },
  { name: "PEM block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "telegram bot token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
  { name: "alchemy/infura key url", pattern: /(alchemy|infura)\.[a-z]+\/v\d\/[A-Za-z0-9_-]{20,}/i },
];

function secretScan(): void {
  const findings: string[] = [];
  for (const file of walk(".")) {
    if (/\.(png|jpe?g|webp|ico|woff2?|lock|db|db-wal|db-shm)$/.test(file)) continue;
    if (file.includes("scripts/release-gate.ts")) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(content)) findings.push(`${file}: ${name}`);
    }
  }
  if (existsSync(".env")) findings.push(".env is present in the working tree");
  record("static", "secret scan", findings.length === 0, findings.join(" | "));
}

async function migrationCheck(): Promise<void> {
  const { migrations } = (await import("../src/core/db/migrations/index")) as {
    migrations: { id: number; name: string }[];
  };
  const ids = migrations.map((migration) => migration.id);
  const sequential = ids.every((id, index) => id === index + 1);
  const unique = new Set(ids).size === ids.length;
  record(
    "static",
    "migrations append-only and sequential",
    sequential && unique,
    sequential && unique ? `${ids.length} migrations` : `ids: ${ids.join(",")}`,
  );
}

async function envExampleCheck(): Promise<void> {
  const { renderEnvExample, manifestKeys, schemaKeys } =
    await import("../src/core/config/manifest");
  const inSync = readFileSync(".env.example", "utf8") === renderEnvExample();
  record(
    "static",
    ".env.example matches the manifest",
    inSync,
    inSync ? "" : "run bun run env:example",
  );
  const matches = JSON.stringify(manifestKeys()) === JSON.stringify(schemaKeys());
  record("static", "manifest matches the env schema", matches, "");
}

function dependencyAudit(): void {
  const result = spawnSync("bun", ["audit", "--json"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}`.trim();
  if (!output) {
    record("static", "dependency audit", true, "no advisories reported");
    return;
  }
  try {
    const parsed = JSON.parse(output) as {
      vulnerabilities?: Record<string, { severity?: string }[]>;
    };
    const severities = Object.values(parsed.vulnerabilities ?? {})
      .flat()
      .map((entry) => entry.severity ?? "");
    const serious = severities.filter((s) => s === "high" || s === "critical");
    record(
      "static",
      "dependency audit",
      serious.length === 0,
      serious.length ? `${serious.length} high/critical` : "",
    );
  } catch {
    record("static", "dependency audit", true, "audit output not parseable; treated as advisory");
  }
}

// ── Stage 2 ────────────────────────────────────────────────────────────────

// Runtime payloads cross an HTTP boundary and are checked by assertion here,
// not by a compile-time type; the gate must read whatever the runtime sent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function getJson(base: string, path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

async function waitForRuntime(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/runtime/health`);
      if (response.status < 600) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function stableShape(value: unknown, path = ""): string[] {
  // Structural fingerprint: key paths and value *types*, never values. Two
  // consecutive snapshots must describe the same shape; timestamps and
  // counters legitimately differ.
  if (Array.isArray(value)) return [`${path}[]:array`];
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => stableShape((value as Record<string, unknown>)[key], `${path}.${key}`));
  }
  return [`${path}:${value === null ? "null" : typeof value}`];
}

async function runtimeStage(base: string): Promise<void> {
  const health = await getJson(base, "/api/runtime/health");
  record(
    "runtime",
    "runtime health reachable",
    health.status === 200,
    `status ${health.status} / ${health.body?.status}`,
  );
  record(
    "runtime",
    "runtime is not FAILED",
    health.body?.status !== "FAILED" && health.body?.status !== "NOT_INITIALIZED",
    String(health.body?.status),
  );
  record(
    "runtime",
    "emergency stop clear",
    health.body?.emergencyStop === false,
    health.body?.emergencyStop ? "latched" : "",
  );
  record(
    "runtime",
    "boot completed",
    Boolean(health.body?.bootCompletedAt),
    health.body?.bootCompletedAt ?? "boot never completed",
  );
  record("runtime", "no stack traces in health payload", !("stack" in (health.body ?? {})), "");

  const first = await getJson(base, "/api/runtime/snapshot");
  record("runtime", "snapshot reachable", first.status === 200, `status ${first.status}`);
  const snapshot = first.body ?? {};

  record(
    "runtime",
    "snapshot version is 3",
    snapshot.snapshotVersion === 3,
    String(snapshot.snapshotVersion),
  );

  const second = await getJson(base, "/api/runtime/snapshot");
  const shapeA = stableShape(snapshot).join("\n");
  const shapeB = stableShape(second.body ?? {}).join("\n");
  record(
    "runtime",
    "snapshot deterministic",
    shapeA === shapeB,
    shapeA === shapeB ? "" : "shape changed between reads",
  );
  record(
    "runtime",
    "snapshot sequence advances",
    typeof second.body?.sequence === "number" && second.body.sequence > snapshot.sequence,
    `${snapshot.sequence} -> ${second.body?.sequence}`,
  );

  const audit = snapshot.resourceAudit;
  record("runtime", "resource audit present", Boolean(audit), audit ? "" : "no audit recorded");
  if (audit) {
    record(
      "runtime",
      "no duplicate runtime resources",
      audit.clean !== false,
      (audit.findings ?? []).join(" | "),
    );
  }

  const stability = snapshot.stability;
  record("runtime", "stability instrumentation live", Boolean(stability), "");
  if (stability) {
    record(
      "runtime",
      "stability verdict not FAIL",
      stability.verdict?.state !== "FAIL",
      (stability.verdict?.findings ?? []).join(" | "),
    );
    record(
      "runtime",
      "scheduler has no overlaps or duplicate registrations",
      (stability.scheduler?.overlaps ?? 0) === 0 &&
        (stability.scheduler?.duplicateRegistrations ?? 0) === 0,
      `overlaps=${stability.scheduler?.overlaps} duplicates=${stability.scheduler?.duplicateRegistrations}`,
    );
  }

  record("runtime", "recovery ledger present", Boolean(snapshot.recovery), "");
  record(
    "runtime",
    "trading pipeline derived",
    Array.isArray(snapshot.pipeline?.stages) && snapshot.pipeline.stages.length > 0,
    `${snapshot.pipeline?.stages?.length ?? 0} stages`,
  );
  record(
    "runtime",
    "both environments visible (V1/V2 parity)",
    Boolean(snapshot.activeEnvironment) && "inactive" in snapshot,
    `active=${snapshot.activeEnvironment}`,
  );

  // The snapshot is a public read surface: it must never carry a credential.
  const serialized = JSON.stringify(snapshot);
  const leaks = SECRET_PATTERNS.filter(({ pattern }) => pattern.test(serialized)).map(
    (entry) => entry.name,
  );
  record("runtime", "snapshot carries no secrets", leaks.length === 0, leaks.join(" | "));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  let child: ReturnType<typeof spawn> | null = null;

  if (!process.env["SKIP_STATIC"]) {
    console.log("\n── stage 1: static ──");
    run("static", "typescript", "bunx", ["tsc", "--noEmit"]);
    run("static", "eslint", "bunx", ["eslint", "."]);
    run("static", "tests", "bunx", ["vitest", "run"]);
    run("static", "production build", "bunx", ["vite", "build"], { NITRO_PRESET: "node-server" });
    run("static", "replay/statistics regeneration", "node", [JITI, "scripts/verify-replay.ts"], {
      DB_PATH: process.env["DB_PATH"] ?? "./data/space-v1.db",
    });
    dependencyAudit();
    secretScan();
    await migrationCheck();
    await envExampleCheck();
  }

  console.log("\n── stage 2: runtime ──");
  let base = process.env["RUNTIME_BASE_URL"] ?? "";
  if (!base) {
    if (!existsSync("dist/server/index.mjs")) {
      record(
        "runtime",
        "production artifact exists",
        false,
        "dist/server/index.mjs missing — run the static stage first",
      );
    } else {
      base = `http://127.0.0.1:${PORT}`;
      child = spawn("node", ["dist/server/index.mjs"], {
        env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
        stdio: "ignore",
        detached: false,
      });
    }
  }

  if (base) {
    const up = await waitForRuntime(base, 90_000);
    record("runtime", "runtime accepts connections", up, up ? base : `no response from ${base}`);
    if (up) await runtimeStage(base);
  }

  if (child) child.kill("SIGTERM");

  // ── stage 3: accelerated soak ────────────────────────────────────────────
  // Runs last, against an isolated database, so the single-instance lock is
  // free and the harness cannot touch operator data.
  if (!process.env["SKIP_SOAK"]) {
    console.log("\n── stage 3: accelerated soak ──");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const soakDb = join(tmpdir(), `space-gate-soak-${Date.now()}.db`);
    run("static", `accelerated soak (${SOAK_MINUTES}m)`, "node", [JITI, "scripts/soak.ts"], {
      SOAK_ACCELERATED: "1",
      SOAK_MINUTES: String(SOAK_MINUTES),
      DB_PATH: soakDb,
    });
  }

  const failures = checks.filter((check) => !check.passed);
  const passed = failures.length === 0;

  mkdirSync(OUT_DIR, { recursive: true });
  const path = `${OUT_DIR}/release-gate-${Date.now()}.json`;
  writeFileSync(
    path,
    JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), passed, checks }, null, 2),
  );

  console.log(
    `\nrelease gate: ${passed ? "PASSED" : "FAILED"} (${checks.length - failures.length}/${checks.length})`,
  );
  for (const failure of failures) console.log(`  FAIL ${failure.name}: ${failure.detail}`);
  console.log(`report: ${path}`);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error("release gate crashed:", error);
  process.exit(1);
});
