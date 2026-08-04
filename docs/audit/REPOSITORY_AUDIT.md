# SPACE — Repository Audit (Release Candidate)

Date: 2026-08-04. Scope: every file under `src/`, `scripts/`, `tests/`, plus the
dependency manifest. The audit was mechanical (reachability from the real entry
points: `src/server.ts`, `src/start.ts`, `src/router.tsx`, `src/routes/**`),
then each finding was confirmed by hand before anything was deleted.

## 1. Dead code removed

The project shipped with the full shadcn/ui starter kit. SPACE renders its own
terminal components under `src/components/space/**`, so 43 of those files were
unreachable from any entry point and are deleted:

- `src/components/ui/**` — all except `button.tsx` and `sonner.tsx`, which are
  the only two the operator terminal actually imports.
- `src/hooks/use-mobile.tsx` — no caller; the dashboard is desktop-first and
  uses CSS breakpoints only.

No `src/core/**` module was unreachable: every runtime subsystem has exactly one
owner and at least one live call site.

## 2. Dependencies removed

37 packages that existed only for the deleted starter kit:

`@hookform/resolvers`, `react-hook-form`, 26 `@radix-ui/*` packages (all but
`react-slot`), `cmdk`, `date-fns`, `embla-carousel-react`, `input-otp`,
`lucide-react`, `react-day-picker`, `react-resizable-panels`, `recharts`,
`vaul`.

Retained and verified in use: `@polymarket/clob-client`, `ethers`, `ws`, `zod`,
`better-sqlite3` (native, loaded lazily by the SQLite driver), `sonner`,
`class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-slot`,
plus the toolchain (`vite`, `tailwindcss`, `@tanstack/*`, `nitro`).

## 3. Defect found and fixed

`connection_timeline` inserts were failing on every boot with
`NOT NULL constraint failed: connection_timeline.environment`. The failure was
swallowed by a `.catch()` that only logged a warning, so connection history
appeared to work in-memory and was silently lost on every restart.

Fix: `connection-timeline.repository.ts` now writes `environment` on insert and
scopes both read paths (`recent`, `forConnection`) to the active environment, so
a V1 runtime never reads V2 history. Verified against the real Node artifact:
20 timeline rows persisted, zero persistence warnings in the boot log.

## 4. Build target verification

`@lovable.dev/vite-tanstack-config` forces the Cloudflare preset while building
inside the Lovable sandbox; outside it, `NITRO_PRESET` is honoured. Confirmed by
building with the sandbox markers unset:

```
preset: node-server
dist/server/index.mjs
```

This is the artifact `ecosystem.config.cjs` starts, so the VPS/PM2 path is
correct as written. The Cloudflare output produced inside the sandbox is a
preview artifact only and is never deployed.

## 5. Production artifact smoke test

`node dist/server/index.mjs` with `NODE_ENV=production`:

- boots through every stage, reaches `VALIDATING` → `READY`
- serves `/api/runtime/health` and `/api/runtime/snapshot`
- the only warnings are truthful ones about absent venue secrets
  (`POLYMARKET_*`, `WALLET_*`, `POLYGON_RPC_URL`), which correctly hold the
  engine below ARM

## 6. Verification results

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `eslint .` | 0 errors, 2 fast-refresh warnings (non-blocking) |
| Unit tests | 79 passed / 13 files |
| Cloudflare build | success |
| Node (`node-server`) build | success, `dist/server/index.mjs` present |
| Node artifact boot | success, health endpoint green |
