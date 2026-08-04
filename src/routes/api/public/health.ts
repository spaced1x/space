import { createFileRoute } from "@tanstack/react-router";

import { collectHealth } from "../../../core/health/registry";

// Consumed by Nginx and PM2. The runtime process owns boot (src/server.ts);
// this route only reports what the already-running runtime reports.
// Public by design: it exposes component states and
// messages only, never configuration values or secrets.
export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
        const report = await collectHealth();
        return new Response(JSON.stringify(report), {
          status: report.state === "FAILED" ? 503 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
