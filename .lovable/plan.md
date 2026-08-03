# SPACE v1.0 — Production Conformance Remediation

Audit complete. The architecture conforms to the frozen specification; the gaps are
implementation-level. This plan closes them in the order that release safety demands.
No architectural change, no new subsystems.

## Release blockers (must close before VPS deployment)

1. **`data/space.db` is committed to git.** `.gitignore` lists `data/`, but the file was
   tracked before the rule existed. A fresh `git clone` on the VPS ships a foreign
   database with foreign migrations, orders and audit rows. Remove it from tracking
   (the file on disk stays), and add a boot assertion that refuses to start if the
   database file is newer in git than the migration set.

2. **`better-sqlite3` is an optional dependency.** If the native build fails on the VPS,
   install still succeeds, `initDatabase()` logs a warning, and SPACE boots with no
   persistence at all. Promote it to a required dependency, and make a database open
   failure a hard boot abort when `NODE_ENV=production` (authoring sandbox keeps the
   soft path).

3. **Chain ID is declared but never verified.** `CHAIN_IDS` maps V1 to 80002 and V2 to
   137, but nothing calls `eth_chainId` on `POLYGON_RPC_URL` to confirm the RPC actually
   matches `SPACE_ENVIRONMENT`. A mainnet RPC in a V1 `.env` would trade real money in
   testnet mode. Add the check to the wallet layer and expose it as a required item in
   the pre-ARM validation gate.

4. **Telegram permission gaps.** `/disarm`, `/pause`, `/reset_stop` and `/broadcast`
   dispatch without an `allowed()` check, so `READ_ONLY` mode can change engine state and
   `SAFE_CONTROLS` can clear the emergency-stop latch. Gate every command through
   `allowed()` and move the permission table into one map so no command can be added
   without a permission entry.

5. **No settlement ingestion.** Replay reconstructs market → discovery → TWAP → window →
   trigger → intent → risk → order → fill, but the settlement step is the market close
   time only; the venue's resolved outcome is never read. Realized PnL is therefore fill
   PnL, not settled PnL — Replay, Statistics and the production report are all incomplete,
   and nothing can prove whether a settlement-TWAP decision was actually correct. Add a
   `settlements` table plus a scheduler task that reads the resolved outcome for every
   closed market, and feed it into Replay, Statistics and the release report.

6. **Environment conformance gate.** Environment correctness is spread across separate
   checks today and none of them blocks ARM as a unit. Introduce one composite gate,
   evaluated at boot and re-evaluated immediately before ARM, with six items that must all
   pass: V1 Testnet resolves correctly, V2 Mainnet resolves correctly, environment
   switching yields the matching CLOB host and chain, the RPC's live `eth_chainId` matches
   the environment, the wallet address matches the environment's expected deployment, and
   the database's environment stamp equals the running environment. Stamp the environment
   into the database on migration and refuse to open a database stamped for a different
   one. Any single FAILED item blocks ARM, surfaced as one line in the pre-ARM gate.
   Blocker #3 becomes one of these six items rather than a standalone check.

## Specification conformance defects

7. **Operations Desk edits and Manual orders bypass the Command Bus.** `updateOperations`
   and `submitManualOrder` call their services directly, so neither is serialised, audited
   or correlation-stamped. Add `UPDATE_OPERATIONS` and `MANUAL_ORDER` commands and route
   both server functions through `dispatchCommand`.

7. **Statistics has no configuration-version linkage.** `config_snapshots` exist but no
   statistic is attributed to a snapshot, so a PnL number cannot be tied to the config
   that produced it. Stamp each intent with the active config version and group daily PnL
   by it.

8. **Release artifacts are not produced.** `docs/releases/v1.0.0/` does not exist: no
   production report, no test report, no signed release-gate record. The generator exists
   in `src/core/release/report.server.ts`; wire it to write the artifact set.

## Implementation bugs

9. Startup validation treats a `DEGRADED` required item as a blocker, but the wallet
   health function returns `DEGRADED` for both "no key configured" and "key invalid".
   Split those so an invalid key reports `FAILED` and reads correctly in the gate.

10. `toExecutionConfig` takes `config.windows[0].size` as the order size, so the per-window
    size configured in the Operations Desk is ignored except for the largest window.
    `sizeForWindow` already exists — the execution path must use it.

11. `src/core/validation/failure-simulation.server.ts` is referenced only by its test. Wire
    it to the Diagnostics workspace behind a non-production guard, or archive it.

## Future enhancements (v1.1+, not blocking)

- Max-exposure (notional) risk check; today only max-positions is enforced.
- Daily loss limit; today only a daily on/off switch exists.
- Gamma discovery response cache with an explicit TTL.
- Per-component reconnect metrics surfaced as a chart rather than counters.

## Verification for each change

- Fresh-clone simulation in a temp directory: clone → `bun install` → `.env` → build →
  PM2 start → health endpoint green → dashboard renders with zero console errors.
- Unit tests extended for chain-id mismatch, Telegram permission matrix, per-window sizing
  and settlement ingestion.
- Boot trace re-checked so no stage regresses in duration or ordering.
