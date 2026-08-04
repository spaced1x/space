import { writeFileSync } from "node:fs";

import { renderEnvExample } from "../src/core/config/manifest";

writeFileSync(".env.example", renderEnvExample());
console.log(".env.example regenerated from src/core/config/manifest.ts");
