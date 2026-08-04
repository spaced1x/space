# SPACE — Final Release Candidate

Architecture is frozen. This phase proves the repository is production-ready, closes the remaining Phase 4 work, and removes accumulated debt. No subsystem is redesigned unless a verified defect is found.

## 1. Repository audit (report + safe removals)

A full pass over every module, route, migration, env var, test and document, producing `docs/audit/REPOSITORY_AUDIT.md`:

- unused modules, exports, imports, helpers, duplicate implementations
- duplicate ownership: schedulers, timers, sockets, pollers, snapshot producers, connection trackers, resource accounting, config loading
- unused environment variables and obsolete `.env.example` keys
- dependency hygiene (unused packages, advisories)

Confirmed-unused **code** is deleted. **Database schema is never touched automatically**: obsolete tables/columns go into `docs/audit/DATABASE_CLEANUP.md` with the reason, dependents, and removal impact, awaiting explicit approval. Migrations stay append-only.

## 2. Remaining Phase 4 closure

| Item | Deliverable |
| --- | --- |
| Environment manifest | `ENVIRONMENT_MANIFEST` derived from the Zod schema (name, required/optional, secret flag, default, description), surfaced in Diagnostics with secret values masked |
| `.env.example` | Regenerated from the manifest, so it can never drift again; `DB_PATH` documented as an override that pins one environment |
| Configuration validation | Startup validation reads the manifest; unknown/misspelled `SPACE_*` keys reported |
| Accelerated soak harness | `bun run soak:accelerated` — compressed clock ticks through the real scheduler, TWAP, strategy, paper venue and metrics paths, sampling the existing stability instrumentation. Emits a verdict + JSON record |
| Leak detection | Thresholds for heap slope, timers, sockets, DB handles, listeners; WARN/FAIL verdict |
| Release gate / report | See section 4 |

Soak policy: the accelerated harness is mandatory in the gate; a real VPS soak record upgrades the report but does not block.

## 3. Runtime, dashboard and security verification

- **Runtime**: cold boot, warm restart, PM2 restart/reload, SIGTERM, SIGINT, uncaught exception, unhandled rejection, DB recovery, environment switch — each verified to return to a healthy runtime with no operator intervention, and each recorded in the runtime audit report.
- **Connections**: every adapter (Gamma, RTDS, Binance, Chainlink, Polygon RPC, Wallet, Telegram, CLOB REST, CLOB market WS, SQLite, scheduler) checked against the official documented endpoint, plus heartbeat, reconnect, retry, timeout, shutdown and resource release. Any legacy or unused adapter is deleted.
- **Snapshot**: one producer, one owner per field, deterministic, no mutation during generation, version correct.
- **Dashboard**: every page driven through a headless browser against the **production build** (`bun run build && bun run start`) — no blank cards, placeholders, undefined values, loading loops, hydration mismatches, or Preview-only behaviour. Any Preview/production discrepancy is root-caused and fixed.
- **Security**: private key, API keys, passphrase, wallet and RPC URL verified absent from logs, stack traces, snapshot, API responses and Diagnostics. A secret-scan check is added to the gate so a future leak fails the build.

## 4. Release gate (hybrid)

`bun run release:gate` runs in two stages and fails on any single failure.

```text
Stage 1 — static
  typescript · eslint · vitest · production build
  dependency audit · secret scan · migration + schema validation

Stage 2 — runtime (via public API only)
  starts the production build, or uses RUNTIME_BASE_URL for a running instance
  GET /api/runtime/health    -> health, ownership, connection conformance
  GET /api/runtime/snapshot  -> resource audit, snapshot determinism (repeat reads),
                                replay/statistics consistency, V1/V2 parity,
                                stability metrics, recovery state
```

Stage 2 never inspects internal module state, so the gate behaves identically locally and against a VPS. Output is written to `docs/releases/v1.0.0/` and recorded in `release_artifacts`.

## 5. Documentation

Rewritten to match the implementation: README, architecture, deployment (exact PM2/VPS commands and reboot recovery), recovery, database, replay, statistics, runtime, trading pipeline, environment/configuration, known limitations, troubleshooting.

## 6. Final report

`docs/releases/v1.0.0/PRODUCTION_READINESS.md`, containing the required deliverables (repository, runtime, security, performance, database integrity, connection conformance audits; VPS deployment guide; release report; limitations; changed/new/deleted files; migrations; env vars; runtime commands; external dependencies).

Verdict format: **PRODUCTION READY (Codebase) — Operational Validation Pending**, granted only if the gate, accelerated soak, tests, build, security audit, runtime validation, resource audit and parity all pass. It is followed by a Post-Release Validation Checklist with explicit acceptance criteria for the mandatory 24–48h VPS paper soak and the controlled first live trade — operational steps, not code blockers. Any genuine engineering blocker found during the audit is listed openly and downgrades the verdict.

## Clarification protocol

Anything ambiguous that would change trading behaviour, runtime ownership, persistence, or deployment assumptions is raised as a question before implementation rather than guessed.
