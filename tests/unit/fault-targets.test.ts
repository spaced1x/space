import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  FAULT_TARGETS,
  FAULT_TARGET_LABELS,
} from "../../src/core/validation/failure-simulation.server";

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

// A fault target with no call site would make every recovery drill a no-op and
// the recovery report a lie, so the catalogue is verified against the source.
describe("fault injection catalogue", () => {
  const sources = sourceFiles("src")
    .filter((file) => !file.endsWith("failure-simulation.server.ts"))
    .filter((file) => !file.endsWith("diagnostics.functions.ts"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  it("labels every target", () => {
    for (const target of FAULT_TARGETS) {
      expect(FAULT_TARGET_LABELS[target]).toBeTruthy();
    }
  });

  it("wires every target to a real call site", () => {
    const unwired = FAULT_TARGETS.filter((target) => !sources.includes(`"${target}"`));
    expect(unwired).toEqual([]);
  });
});
