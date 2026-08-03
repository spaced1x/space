# SPACE Pre-Milestone-6 Architecture Review

Design review only. No code changes. Grounded in the current `src/core` implementation
(state store, scheduler, execution engine recovery path, operations config, system info)
plus the frozen specification docs.

Each question below changes implementation if answered differently. Where a subsystem
looks settled, it is marked explicitly.

---

## 1. Runtime state and lifecycle

Confirmed by reading the runtime state store: engineStatus, mode and window flags live in
memory only and are re-initialised to BOOTING -> OBSERVE on every process start. Nothing
persists them.

1. After a crash or PM2 restart while ARMED, SPACE currently comes back in OBSERVE and stops trading until you press ARM. Intended, or should SPACE restore ARMED automatically after a clean recovery pass? *An unattended overnight crash silently stops trading.*
2. Should `mode` (STRATEGY/MANUAL) and the window enable flags survive restart? They currently reset to STRATEGY with both windows on — a restart would re-enable automatic execution after you deliberately switched to MANUAL.
3. Should PAUSED be sticky across restart, or is PAUSE strictly within-session?
4. Should there be a dead-man switch — drop from ARMED to OBSERVE after N hours with no operator contact?

## 2. Strategy Engine

5. What happens if the opening TWAP window is incomplete (Binance disconnected for part of the capture)? Skip the market, fall back to Chainlink, or accept a partial sample above a minimum-sample threshold?
6. If PTB is unavailable at window open, is the window permanently skipped or retried until the entry deadline?
7. If BTC price and PTB are exactly equal at freeze time, what direction is taken — skip, or a defined tie-break?
8. If a market resolves or is cancelled by Polymarket after a trigger is frozen but before entry, what outcome should Replay show?
9. Can a frozen trigger ever be invalidated mid-window by a large adverse move (a stale-trigger guard), or is freeze absolute?

## 3. Risk Engine

10. Are the 14 checks fixed forever, or may the Operations Desk disable individual checks? My assumption: fixed, with only thresholds configurable.
11. Should risk cap aggregate USDC exposure across open positions, not just position count? Count is the only binding limit today.
12. Should a daily loss limit auto-disarm the engine — and is it realised PnL only, or realised plus open mark-to-market?
13. If wallet balance is unknown (RPC failure), should risk reject, or allow using a stale balance up to some age?

## 4. Execution Engine

Confirmed in the execution engine: recovery never resubmits; an order without a persisted venue order id is marked FAILED, and an order the venue no longer knows is CANCELLED.

14. If the process dies between "order sent to CLOB" and "venue order id persisted", SPACE marks it FAILED locally while it may be live at the venue. Should recovery query the venue's open orders by market/wallet and adopt orphans instead of assuming none exist? *This is the largest duplicate-execution / phantom-position risk in the system.*
15. On a partial fill that times out: cancel the remainder, keep it working, or convert the remainder to market?
16. In LIMIT_THEN_MARKET, should the market fallback use the original size or only the unfilled remainder?
17. Should retries reprice against the current book, or resubmit the original price?
18. If the venue rejects for insufficient balance mid-sequence — abort the intent, or downsize and continue?
19. Should an intent whose window already expired still be executable if execution was delayed (a hard per-intent entry deadline)?

## 5. Manual Trading

20. May manual orders be placed while the engine is in OBSERVE, or only when ARMED?
21. Does MANUAL mode block automatic execution globally, or only for the market being manually traded?
22. Are manual orders subject to max-positions and daily-loss limits, or may the operator explicitly override risk (with audit)?
23. Do you want "flatten position" and "cancel all orders" actions — and do they belong in Manual Trading or Mission Control?

## 6. Recovery

24. Must reconciliation complete successfully before an ARM command is even accepted?
25. If reconciliation fails because the venue is unreachable at boot, should SPACE sit in a distinct RECOVERING/degraded state rather than plain OBSERVE?
26. Is local SQLite always authoritative for positions, or should recovery rebuild positions from venue/on-chain truth?

## 7. Feeds (Binance / Chainlink)

27. What maximum sample staleness makes price unusable — and does exceeding it block only new entries, or disarm?
28. Is Chainlink a fallback source, a cross-check, or informational only? If cross-check, what Binance/Chainlink divergence should halt trading?
29. Should a feed outage while a position is open trigger any action, or only affect entry?

## 8. Polymarket / Market Discovery

30. If discovery returns two plausible official BTC markets for the same window, what is the tie-break?
31. If discovery fails for several cycles while a position is open, keep the last known market indefinitely or expire it after N minutes?
32. How should SPACE detect settlement for PnL — poll Gamma, infer from position closure, or read on-chain?

## 9. Wallet

33. Should SPACE enforce a minimum reserve balance it will never trade below?
34. Should token allowance/approval be checked at boot, surfaced in Health, and block ARM when missing?

## 10. Database (SQLite / WAL)

35. Retention policy for price samples, events and order events — unbounded growth, or a pruning job with a configurable window?
36. Do you want scheduled automatic backups (VACUUM INTO) alongside manual export, and at what interval?
37. Is a corrupted database at boot a hard stop, or should SPACE start read-only/degraded so you can inspect it?

## 11. Backup / Export / Import

38. Should import ever be permitted into a running instance, or only at boot with the engine stopped? *Importing live would duplicate order history and corrupt recovery.*
39. Should exports ever include secrets (I assume never), and should operations config be exportable separately from trade history?
40. After restoring to a new VPS, should the instance refuse to ARM until the operator confirms the original is not still running?

## 12. Operations Desk / Configuration

41. Config applies to future markets only — should a staged change auto-promote at the next window boundary, or always require explicit promotion?
42. May config change while ARMED, or must the engine be in OBSERVE?
43. Should the promoted config version be stamped onto every intent and order so Replay can show exactly which config produced a trade? The link is implicit today.

## 13. Command Bus / Telegram

Confirmed: no Telegram module exists yet; the env vars are defined but unused.

44. Which commands may Telegram issue — full parity including ARM, or a restricted read + PAUSE/DISARM kill-switch set? Kill-switch-only is the safer default.
45. How is Telegram authorised — chat-id allowlist only, or an extra confirmation step for destructive commands?
46. If Telegram is unreachable, should Health degrade, and should SPACE refuse to ARM without a working alert channel?
47. Should commands carry a command id so duplicate Telegram delivery cannot double-execute?

## 14. Scheduler

48. If a task overruns its interval (discovery blocking for 30s), should later runs be skipped or queued? One sequential heartbeat means a slow task delays strategy evaluation.
49. Should sustained scheduler lag beyond a threshold auto-disarm?
50. How should SPACE react to a system clock jump (NTP correction) mid-window?

## 15. Statistics

51. Is PnL realised-only, and what timezone defines "today"? *UTC vs local day boundary changes every daily number and any daily loss limit.*
52. Are fees and slippage included in PnL, and what is the source of truth for them?
53. Should statistics be recomputed live from orders/fills, or snapshotted daily into immutable history?

## 16. Replay

54. Should there be a fixed outcome-code vocabulary (SKIP_NO_PTB, SKIP_QUOTA, RISK_REJECTED_*, FILLED, TIMEOUT, ...) that every subsystem must emit, so no path can produce an unexplained outcome?
55. Should Replay prove completeness — flag any window that produced no recorded decision at all?

## 17. Mission Control / Diagnostics / Settings

56. What refresh cadence, and what should the UI do when the server is unreachable — freeze with an explicit stale banner, or blank? Stale-but-unlabelled data is a real operator-confusion risk.
57. Should Mission Control keep an always-available emergency DISARM even though controls officially live in the Operations Desk?
58. Diagnostics is read-only — should it allow safe non-trading actions (reconnect feed, force discovery refresh, rotate log)?

## 18. Health

59. Which health checks are ARM-blocking versus advisory? A precise blocking list is needed.
60. If a check transitions to FAILED while ARMED, should SPACE auto-disarm or only alert?

## 19. Logging

61. Rotation is size-based today — is time-based retention (e.g. 30 days) also required for post-incident review?
62. Do you want an explicit guarantee and test that private keys and API secrets can never reach logs?

## 20. V1 / V2

63. May one installation switch V1 -> V2 in place, or must V2 start from a fresh database? *Mixing testnet and mainnet rows in one statistics table would corrupt reporting.*
64. Should the environment be visually unmistakable in the UI and included in every Telegram alert?

## 21. Deployment

65. Should PM2 restarts be capped so a crash-loop halts instead of repeatedly re-entering recovery against the venue?
66. Should SPACE hold a single-instance lock (file or DB lock) so two processes can never trade the same wallet?
67. Are off-box automated backups in scope, or is Clone -> Restore manual only?

---

## Areas I consider settled

- **Command Bus core** (serialised queue, verdicts, audit trail) — no further clarification required beyond the Telegram questions above.
- **Logging format** (structured JSON, correlation ids) — no further clarification required.
- **Repository rule** (no SQL outside repositories) — no further clarification required.
- **Engine ownership of all timers** — no further clarification required.
- **Settings workspace scope** — no further clarification required.

## Highest-priority answers before Milestone 6

Q14 (orphan venue orders on recovery), Q1/Q2 (state persistence across restart), Q51 (PnL day boundary and timezone), Q63 (V1/V2 data separation), Q66 (single-instance lock). Each of these can cause incorrect trading, duplicate execution or wrong reporting in production. The rest shape behaviour but are not correctness-critical.