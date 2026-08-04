import { createFileRoute } from "@tanstack/react-router";

import { getSystemSnapshot } from "../../../lib/system.functions";

/**
 * Public runtime snapshot endpoint. This is the canonical read surface for any
 * dashboard that is not served by the same process (e.g. a remote VPS runtime
 * viewed from a local operator console, or a health monitor). It returns exactly
 * the same payload as the `getSystemSnapshot` server function.
 */
export const Route = createFileRoute("/api/runtime/snapshot")({
  server: {
    handlers: {
      GET: async () => {
        const snapshot = await getSystemSnapshot();
        return Response.json(snapshot, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
