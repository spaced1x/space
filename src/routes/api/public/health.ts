import { createFileRoute } from "@tanstack/react-router";

import { boot } from "../../../core/boot.server";
import { collectHealth } from "../../../core/health/registry";

// Consumed by Nginx and PM2. Public by design: it exposes component states and
// messages only, never configuration values or secrets.
export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
        await boot();
        const report = await collectHealth();
        return new Response(JSON.stringify(report), {
          status: report.state === "FAILED" ? 503 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
