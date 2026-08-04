import fs from "node:fs";
import nodePath from "node:path";
import { loadEnv } from "../config/env.server";
import type { SpaceEnv } from "../config/env.schema";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";

// Persisted runtime target.
//
// The active environment is chosen at process start from SPACE_ENVIRONMENT.
// When the operator requests a switch, this file is updated and the process
// is restarted under the new environment. The file is the source of truth for
// "what environment should this process be running", while the database stamp
// verifies that the opened database matches that environment.

const log = createLogger("runtime-target");

export interface RuntimeTarget {
  version: number;
  environment: SpaceEnv["SPACE_ENVIRONMENT"];
  updatedAt: string;
  requestedBy: string;
}

const TARGET_PATH = "./data/runtime-target.json";

function targetPath(): string {
  return nodePath.resolve(TARGET_PATH);
}

function ensureDir(): void {
  const dir = nodePath.dirname(targetPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read the persisted runtime target. If the file does not exist, seed it from
 * the current environment. This keeps fresh installs deterministic.
 */
export function readRuntimeTarget(): RuntimeTarget {
  ensureDir();
  const env = loadEnv();
  try {
    const raw = fs.readFileSync(targetPath(), "utf8");
    const parsed = JSON.parse(raw) as RuntimeTarget;
    if (!parsed.environment || !parsed.updatedAt || !parsed.requestedBy) {
      throw new Error("target file missing required fields");
    }
    return parsed;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") {
      log.warn("runtime target unreadable, re-seeding from environment", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const seeded: RuntimeTarget = {
      version: 1,
      environment: env.SPACE_ENVIRONMENT,
      updatedAt: systemClock.iso(),
      requestedBy: "system:seed",
    };
    writeRuntimeTarget(seeded);
    return seeded;
  }
}

export function writeRuntimeTarget(target: RuntimeTarget): void {
  ensureDir();
  fs.writeFileSync(targetPath(), JSON.stringify(target, null, 2));
}

/**
 * Request an environment switch. The file is updated immediately; the caller
 * must restart the process so the new environment takes effect.
 */
export function requestEnvironmentSwitch(
  environment: SpaceEnv["SPACE_ENVIRONMENT"],
  requestedBy: string,
): RuntimeTarget {
  const current = readRuntimeTarget();
  const next: RuntimeTarget = {
    version: current.version + 1,
    environment,
    updatedAt: systemClock.iso(),
    requestedBy,
  };
  writeRuntimeTarget(next);
  log.info("environment switch requested", {
    from: current.environment,
    to: environment,
    requestedBy,
  });
  return next;
}

/** True when the persisted target matches the active environment. */
export function targetMatchesEnvironment(): boolean {
  const env = loadEnv();
  const target = readRuntimeTarget();
  return target.environment === env.SPACE_ENVIRONMENT;
}
