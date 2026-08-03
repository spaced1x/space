# SPACE — Dual Runtime Operator Terminal (V1 + V2)

Architecture stays frozen. No changes to Strategy, Risk, Execution, Replay algorithms, Statistics reductions, Scheduler or trading logic. This milestone completes the operator runtime so both environments are first-class, permanently visible, and fully isolated.

## 1. Two permanent runtime panels

Mission Control renders exactly two runtime panels, always, side by side:

```text
+-------------------------------+  +-------------------------------+
| V1 TESTNET  (Paper)  [blue]   |  | V2 MAINNET  (Live)  [red]     |
| Lifecycle / Health / Env      |  | Lifecycle / Health / Env      |
| DB  Wallet  RPC  Provider     |  | DB  Wallet  RPC  Provider     |
| Market / Position / TWAP      |  | Market / Position / TWAP      |
| Last Start / Stop / Error     |  | Last Start / Stop / Error     |
| Build / Runtime Version       |  | Build / Runtime Version       |
| [START V1]  [STOP V1]         |  | [START V2]  [STOP V2]         |
+-------------------------------+  +-------------------------------+
```

Neither panel ever disappears. The panel for the environment that is not running shows its last persisted state, clearly marked STOPPED, with no invented values — unknown fields read "no data yet" with a reason.

## 2. Identical information for both environments

Both panels drive the same components already in the terminal: runtime banner, health, connections (all twelve subsystems), Current Trading Target, Current Position, Current TWAP, TWAP Provider, Binance, Gamma, Wallet, Polygon RPC, Polymarket CLOB, Telegram, Connection History, Runtime Configuration, Diagnostics. Layouts are identical; only environment, database, credentials, wallet, RPC, RTDS, Chainlink, CLOB and runtime state differ.

## 3. Isolation

Each environment owns `space-v1.db` + `space-v1.db.lock` and `space-v2.db` + `space-v2.db.lock`. Replay, statistics, runtime events, diagnostics, runtime configuration, provider selection, runtime history, TWAP history and connection history all live in that environment's database. Nothing is shared, nothing leaks, and switching preserves each side exactly as it was left.

## 4. START / STOP and switching

Only one runtime executes at a time. Pressing START on an environment runs the mandatory sequence:

```text
Graceful Shutdown -> Persist Runtime -> Restart -> Boot Selected Runtime
  -> Reconnect -> Restore Dashboard
```

No hot swap: adapters, sockets, timers, DB handle and lock are fully torn down before the new environment boots. Default is an in-process full re-init; setting `SPACE_SWITCH_MODE=exit` instead performs the graceful shutdown then exits cleanly so PM2 respawns the process under the new target. The persisted `data/runtime-target.json` (versioned) is written before the restart, so the selection survives a crash or a VPS reboot.

STOP performs graceful shutdown and persistence, leaving the runtime STOPPED and its panel populated from its database.

## 5. Diagnostics and identity

Diagnostics are environment-aware: viewing V1 shows only V1 history, viewing V2 only V2. Environment identity (V1 TESTNET / Paper / blue, V2 MAINNET / Live / red) appears on every screen, banner and runtime card, alongside database, provider, wallet, RPC and which runtime is currently active.

## Technical section

- `src/core/runtime/target.server.ts` — keep the versioned target; add `switchRuntime(environment, actor)` performing shutdown -> persist -> write target -> re-init (or exit under `SPACE_SWITCH_MODE=exit`).
- New `src/core/runtime/supervisor.server.ts` — owns start/stop/switch: closes scheduler timers, engine loop, Binance/RTDS/Chainlink sockets, CLOB and Telegram clients, releases the DB lock and closes the driver, resets the boot promise, then re-runs `boot()`. Guarantees no duplicated timers or sockets.
- `src/core/db/database.server.ts` — make the singleton resettable (`closeDatabase()`), keyed by the path from `resolveDbPath(env)`.
- New `src/core/runtime/peek.server.ts` — opens the inactive `space-vX.db` read-only (no migrations, no lock) and returns its last persisted runtime snapshot, connection history, diagnostics, market/TWAP state and config version. Returns an explicit "database not created yet" marker when absent.
- `src/lib/system.functions.ts` — `getSystemSnapshot` returns `{ active, inactive, activeEnvironment }` so both panels come from one read surface.
- Commands: add `RUNTIME_START` / `RUNTIME_STOP` with an environment argument, routed through the existing CommandBus with audit rows — no direct calls from the UI.
- UI: generalise `runtime-panel.tsx` / `mission-control.tsx` into an environment-parameterised panel rendered twice. No redesign, no removed fields, no simplified cards; existing components (`connection-card`, `connection-history`, `twap-provider-card`, `trading-target-card`, `empty-state`) are reused per environment.
- Diagnostics route gains an environment selector bound to the same two snapshots.

## Verification

Both panels permanently visible; identical layouts; isolated databases, histories, provider selections and diagnostics; START/STOP for V1 and V2; switch survives a restart; no duplicated timers or WebSockets (asserted by counting active handles after three switch cycles); no stale snapshots; no placeholder values; `tsc` clean; tests green; production build passes.