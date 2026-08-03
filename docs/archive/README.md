# docs/archive

Historical engineering documentation from STONE and the P4 reference bot.

**Nothing here is deleted.** This directory preserves the history of the project so any decision recorded in SPACE can be traced back to the evidence that produced it. It is reference material only — it does not describe how SPACE behaves today.

Expected contents once the STONE repository is merged into SPACE:

| Path          | Contents                                                                         |
| ------------- | -------------------------------------------------------------------------------- |
| `charter/`    | `ARC_PROJECT_CHARTER.md` and the original constraints                            |
| `adr/`        | all architecture decision records                                                |
| `milestones/` | the milestone, phase and session reports                                         |
| `audits/`     | audit and qualification reports                                                  |
| `knowledge/`  | the P4 behavioural specification — the most valuable document set in the archive |
| `p4/`         | the P4 reference source, read-only, excluded from build, lint and tests          |

The authoritative documents live in `docs/`:

- `SPACE_SPECIFICATION.md` — the single source of truth
- `SPACE_ARCHITECTURE.md` — module boundaries, ownership, runtime topology
- `SPACE_MIGRATION_REPORT.md` — the STONE analysis and migration matrix

When a document in this archive conflicts with the specification, the specification wins.
