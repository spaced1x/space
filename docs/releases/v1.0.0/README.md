# SPACE v1.0.0 — Release Artifacts

This directory is the immutable record of the v1.0.0 release. Nothing here is
generated at runtime except the JSON release reports written by the release
gate (`release-report-v1.0.0-*.json`), which are appended, never edited.

| Artifact | Purpose |
| --- | --- |
| `PRODUCTION_REPORT.md` | What v1.0.0 contains, how it is deployed, what it guarantees |
| `RELEASE_GATE.md` | The gate checklist that must pass before the version is promoted |
| `TEST_RESULTS.md` | Test and build evidence recorded for this version |
| `ROLLBACK.md` | The rollback procedure, verbatim, for use under pressure |
| `release-report-*.json` | Machine-generated snapshot produced by the release gate |

The architecture, specification and deployment documents live one level up in
`docs/` and remain the source of truth; this directory records the state of the
system at the moment v1.0.0 was cut.