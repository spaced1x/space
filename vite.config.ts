// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// VPS production builds set NITRO_PRESET=node-server so the artifact is a plain
// Node server (dist/server/index.mjs) that PM2 can run. Unset (authoring
// sandbox / Lovable preview) keeps the platform's default target.
const nitroPreset = process.env["NITRO_PRESET"];

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  ...(nitroPreset
    ? {
        nitro: {
          preset: nitroPreset,
          // Keep one artifact layout everywhere so PM2 always starts
          // dist/server/index.mjs.
          output: { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" },
        },
      }
    : {}),
});
