import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lock tests need a fresh DB_PATH per test so multiple lock acquisitions do
// not collide with the default ./data/space.db.lock file.

describe("single-instance lock", () => {
  let tmpDir: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "space-lock-"));
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = join(tmpDir, "space.db");
  });

  afterEach(() => {
    if (originalDbPath !== undefined) process.env.DB_PATH = originalDbPath;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("acquires and releases the lock file", async () => {
    const { acquireInstanceLock, releaseInstanceLock, instanceLockHeld } = await import(
      "../../src/core/db/lock.server"
    );
    const handle = acquireInstanceLock();
    expect(instanceLockHeld()).toBe(true);
    expect(handle.path).toContain("space.db.lock");
    releaseInstanceLock();
    expect(instanceLockHeld()).toBe(false);
  });

  it("throws when another process already holds the lock", async () => {
    const { acquireInstanceLock, releaseInstanceLock } = await import(
      "../../src/core/db/lock.server"
    );
    acquireInstanceLock();
    // Import a second copy of the module state by clearing the require cache
    // is not reliable in ESM; instead, simulate by trying to open the same
    // file with wx semantics directly.
    const fs = await import("node:fs");
    expect(() => fs.openSync(`${process.env.DB_PATH}.lock`, "wx")).toThrow();
    releaseInstanceLock();
  });
});
