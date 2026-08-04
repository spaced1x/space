import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  manifestKeys,
  renderEnvExample,
  schemaKeys,
  secretKeys,
  unknownEnvKeys,
} from "../../src/core/config/manifest";
import { ARMED_REQUIRED_KEYS } from "../../src/core/config/env.schema";
import { ENVIRONMENT_MANIFEST } from "../../src/core/config/manifest";

describe("environment manifest", () => {
  it("describes exactly the variables the schema declares", () => {
    expect(manifestKeys()).toEqual(schemaKeys());
  });

  it("marks every ARM-blocking secret as required", () => {
    const required = ENVIRONMENT_MANIFEST.filter((entry) => entry.requiredForArmed).map(
      (entry) => entry.name,
    );
    expect(required.sort()).toEqual([...ARMED_REQUIRED_KEYS].sort());
  });

  it("keeps .env.example generated from the manifest", () => {
    expect(readFileSync(".env.example", "utf8")).toBe(renderEnvExample());
  });

  it("never places a secret value in .env.example", () => {
    const rendered = renderEnvExample();
    for (const key of secretKeys()) {
      expect(rendered).toContain(`${key}=\n`);
    }
  });

  it("reports misspelled SPACE variables and ignores unrelated ones", () => {
    expect(unknownEnvKeys({ SPACE_ENVIROMENT: "V1_TESTNET", HOME: "/root" })).toEqual([
      "SPACE_ENVIROMENT",
    ]);
  });
});
