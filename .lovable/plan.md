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

1. ~~After a crash or PM2 restart while ARMED, should SPACE restore ARMED automatically?~~ **Already resolved by the frozen specification (§14 Recovery: "Resume Engine — resume in OBSERVE, run Health Verification, then arm").** SPACE never self-arms. The only remaining sub-question, which does need an answer: should SPACE raise a Telegram alert when it comes back up in OBSERVE after having been ARMED, so an unattended overnight crash is not silently a trading stop?
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
19. ~~Should an intent whose window already expired still be executable?~~ **Already resolved by the frozen specification (§14: an expired window is completed with its stored outcome and never re-triggered).** No clarification required.

## 5. Manual Trading

20. May manual orders be placed while the engine is in OBSERVE, or only when ARMED?
21. Does MANUAL mode block automatic execution globally, or only for the market being manually traded?
22. Are manual orders subject to max-positions and daily-loss limits, or may the operator explicitly override risk (with audit)?
23. Do you want "flatten position" and "cancel all orders" actions — and do they belong in Manual Trading or Mission Control?

## 6. Recovery

24. Must reconciliation complete *successfully* before an ARM command is accepted? The spec orders recovery before arming but does not say whether a failed reconciliation blocks ARM outright.
25. If reconciliation fails because the venue is unreachable at boot, should SPACE sit in a distinct RECOVERING/degraded state rather than plain OBSERVE, so the operator cannot mistake it for a healthy idle engine?
26. ~~Is local SQLite or the venue authoritative for positions on recovery?~~ **Already resolved by the frozen specification (§14: "Venue truth wins; divergence is recorded and alerted").** No clarification required.

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
36. ~~Do you want scheduled automatic backups?~~ **Already resolved by the frozen specification (§15: scheduled local backups with retention, hot `VACUUM INTO` snapshot).** Only the interval and retention count still need numbers.
37. Is a corrupted database at boot a hard stop, or should SPACE start read-only/degraded so you can inspect it?

## 11. Backup / Export / Import

38. Should import ever be permitted into a running instance, or only at boot with the engine stopped? *Importing live would duplicate order history and corrupt recovery.*
39. ~~Should exports include secrets, and is config exportable separately?~~ **Already resolved by the frozen specification (§15: "Backups never contain secrets"; configuration exports as JSON independently of the database).** No clarification required.
40. After restoring to a new VPS, should the instance refuse to ARM until the operator confirms the original is not still running?

## 12. Operations Desk / Configuration

41. Config applies to future markets only — should a staged change auto-promote at the next window boundary, or always require explicit promotion?
42. May config change while ARMED, or must the engine be in OBSERVE?
43. Should the promoted config version be stamped onto every intent and order so Replay can show exactly which config produced a trade? The link is implicit today.

## 13. Command Bus / Telegram

Confirmed: no Telegram module exists yet; the env vars are defined but unused.

44. Which commands may Telegram issue — full parity including ARM, or a restricted read + PAUSE/DISARM kill-switch set? Kill-switch-only is the safer default.
45. Telegram authorisation by chat-id allow-list is **already resolved by the frozen specification (§16)**. Remaining question: should destructive commands (ARM, flatten, import) require a second confirmation step over Telegram, or is the allow-list sufficient?
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
66. PM2 fork mode with exactly 1 instance is **already resolved by the frozen specification (§21)**. Remaining question: should SPACE additionally hold its own single-instance lock (lock file or SQLite lock) so a manually started second process — or a restored clone on another VPS — can never trade the same wallet?
67. Are off-box automated backups in scope, or is Clone -> Restore manual only?

## 22. Venue rate limiting (new)

Gamma and the CLOB both rate limit, and discovery polls every 20s while execution polls fills every 1s. A 429 storm during an active window is the realistic failure mode, and the current adapters have no defined policy for it.

68. On a 429 or rate-limit error from **Gamma during discovery**: retry with exponential backoff and keep the last known market, or immediately mark discovery DEGRADED and skip the market? *Skipping loses a trading window; retrying blindly can extend the ban.*
69. On a 429 from the **CLOB during order submission**: is a retry safe given the idempotency key, and how many attempts before the intent is abandoned with a distinct outcome code? *A blind retry against a venue that actually accepted the order is a duplicate-execution path.*
70. On a 429 during **fill polling**, should SPACE back off the poll interval automatically, and should an unfilled order's timeout clock be paused while it cannot see the venue? *Otherwise a rate limit is misread as "no fill" and triggers a spurious fallback to market.*
71. Should sustained rate limiting degrade Health, and should it block ARM or auto-disarm? My assumption: degrade Health, block new entries, never auto-disarm with an open position.
72. Should SPACE apply a client-side request budget (max requests/second per venue endpoint) so it can never trip the limit in the first place, and should that budget be fixed or configurable?

## 23. Clock drift monitoring (new)

The clock service already reports `driftMs`, but nothing compares VPS time to an external reference.

73. Should SPACE periodically compare VPS time against a trusted external reference (Binance server time and/or NTP) and surface the offset in Diagnostics? *TWAP capture windows are 30s and 60s — a few seconds of drift silently corrupts every TWAP.*
74. What drift threshold is merely a warning versus ARM-blocking or auto-disarming?
75. Should SPACE ever correct for drift internally (apply an offset to its own clock), or only report it and rely on system NTP?

## 24. Operator editing session (new)

76. If the operator refreshes the browser mid-edit on the Operations Desk with unsaved changes, should those edits be restored (kept as a staged draft), silently discarded, or should the browser warn before unload? *Staged config is currently server-side; unsaved form state is not, so behaviour today is "silently discarded".*
77. Should an unsaved/staged-but-unpromoted config be visible in Diagnostics or Mission Control so the operator cannot forget a half-finished change?
78. If two browser tabs edit configuration at once, should the second save be rejected on a version mismatch, or last-write-wins?

## 25. Host resources (new)

79. Should low disk space **block ARM**, only warn, stop after the current market completes, or continue trading? At what free-space thresholds? *SQLite WAL plus rotating logs on a small VPS will eventually fill the disk; a failed write mid-order is the worst possible moment to discover it.*
80. Should disk, memory and CPU be first-class health checks alongside the existing subsystem checks?
81. Should `max_memory_restart` be treated as an acceptable safety net, given a restart while ARMED drops SPACE back to OBSERVE and stops trading?

## 26. Long-running memory retention (new)

SPACE keeps orders, fills, intents, events and price samples in memory for the life of the process; several are unbounded.

82. What is the in-memory retention policy for price samples, market state history, the event log and the recent-rejections list — a fixed ring buffer size, a time window, or unbounded?
83. Should the in-memory order/fill maps be trimmed to open + recently-settled only, with older records served from SQLite on demand?
84. Should Replay always read from SQLite, never from an in-memory cache, so a long-running process cannot answer a replay query from stale memory?
85. Should Diagnostics expose collection sizes and process RSS so growth is observable before it becomes a restart?

## 27. Replay chain integrity (new)

86. Should Replay actively verify that every persisted market forms one complete chain — Market -> Window -> Frozen Trigger -> Execution Intent -> Risk Decision -> Order -> Fill -> Settlement -> Statistics — and flag any broken or missing link? *This is the only mechanism that would catch a silently lost write.*
87. Should chain integrity run as a scheduled background audit (and degrade Health on a break), or only on demand when the operator opens Replay?
88. When a chain is legitimately short — a window that ended `NO_TRIGGER` has no order — should that be recorded as an explicit terminal link rather than an absent one, so "incomplete" always means "broken"? The §3.3 outcome table already defines the vocabulary; the question is whether every window is *required* to carry one.

## 28. Statistics immutability and reset (new)

89. Are statistics intended to be permanently immutable? May they ever be reset or a bad day excluded from the UI, or is replacing the database the only way to clear history?
90. Should there be a distinction between "real" trading history and test/manual trades — e.g. a flag so manual or testnet trades can be excluded from headline PnL without deleting anything?
91. If a settlement is later corrected by the venue, should the original statistics row be amended in place or superseded by a correcting entry?

## 29. Environment protection (new)

92. Should a database created under V1 (Testnet) ever be openable by a V2 (Mainnet) runtime? *If not, the environment must be stamped in the database at creation and checked at boot — a mismatch should be a hard refusal to start, not a warning.*
93. Should the same protection apply in reverse (a mainnet database opened by a testnet runtime), and should the wallet address also be stamped so a restored backup cannot be run against a different wallet?
94. Should switching environment require a distinct `DB_PATH`, enforced by SPACE rather than by operator discipline?

---

## Duplicates removed

None. Reviewing all 67 original questions, no two ask the same thing. The nearest overlaps were checked and kept because they ask different things: Q4 (dead-man switch) vs Q60 (auto-disarm on health failure); Q35 (on-disk retention) vs Q82 (in-memory retention); Q38 (import into a running instance) vs Q40 (restored clone refusing to ARM).

## Already answered by the frozen specification

Marked in place above rather than deleted, so the audit trail is intact:

- **Q1** — recovery always resumes in OBSERVE and never self-arms (§14).
- **Q19** — expired windows complete with their stored outcome and are never re-triggered (§14).
- **Q26** — venue truth wins on reconciliation divergence (§14).
- **Q36** — scheduled local backups with retention using hot `VACUUM INTO` (§15); only interval/retention numbers remain.
- **Q39** — backups never contain secrets; configuration exports independently (§15).
- **Q45** — Telegram is authorised by chat-id allow-list through the same command bus and audit trail (§16); only the confirmation-step question remains.
- **Q54** — the outcome vocabulary itself is defined (§3.3 window outcomes); the open part is whether every path is *required* to emit one (now Q88).
- **Q66** — PM2 fork mode, 1 instance (§21); the separate process lock question remains.

## Note on Q14

Q14 is not an open design question in the specification — §14 already mandates querying the venue for open orders and using a deterministic `(market, window, attempt)` idempotency key. The current implementation does neither: recovery marks an order without a persisted venue id as FAILED and does not enumerate venue orders. This is a **conformance gap between frozen spec and Milestone 4 code**, and should be scheduled as a defect fix rather than treated as a new decision.

## Review status

The review is now **complete and ready for operator responses**: 94 questions across 29 subsystem groups, every subsystem in scope covered, duplicates checked, and spec-answered items marked rather than re-asked.

Highest-priority additions from this pass, alongside the original five: **Q69** (retry-on-429 during submission is a duplicate-execution path), **Q73/74** (clock drift silently corrupts TWAP), **Q79** (disk exhaustion mid-order), **Q86** (chain integrity is the only detector of a lost write) and **Q92** (testnet/mainnet database cross-contamination).

---

## Areas I consider settled

- **Command Bus core** (serialised queue, verdicts, audit trail) — no further clarification required beyond the Telegram questions above.
- **Logging format** (structured JSON, correlation ids) — no further clarification required.
- **Repository rule** (no SQL outside repositories) — no further clarification required.
- **Engine ownership of all timers** — no further clarification required.
- **Settings workspace scope** — no further clarification required.

## Highest-priority answers before Milestone 6

Q14 (orphan venue orders on recovery), Q1/Q2 (state persistence across restart), Q51 (PnL day boundary and timezone), Q63 (V1/V2 data separation), Q66 (single-instance lock). Each of these can cause incorrect trading, duplicate execution or wrong reporting in production. The rest shape behaviour but are not correctness-critical.