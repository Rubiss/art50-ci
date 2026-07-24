# Changelog

## 0.2.0 — 2026-07-24

### Changed

- Audit reports and standalone provenance evidence now use
  `schemaVersion: 2`.
- Persisted local `configPath`, `target`, `resolvedTarget`, and `finalUrl`
  values use `$CONFIG_DIR/...` or `$LOCAL_FILE` instead of absolute host
  paths.
- Persisted `screenshotPath` and `evidencePath` values are relative to the
  JSON document containing them.
- Filesystem failures and diagnostic fields redact local paths without
  changing the absolute runtime objects used by the CLI.
- Deep imports can pass `{ baseDirectory }` as the third `writeReports()`
  argument for precise `$CONFIG_DIR/...` projections. Existing two-argument
  calls remain privacy-safe and use the configuration directory or current
  working directory as a fallback.

Configuration remains `version: 1`; no configuration migration is required.
Consumers of report JSON should branch on `schemaVersion` and reject unknown
versions.

### Privacy advisory for 0.1.0

Version 0.1.0 report and provenance documents could contain absolute local
paths, including a host username. Upgrade to 0.2.0 and regenerate reports
before sharing them. If a 0.1.0 report was uploaded publicly, remove or replace
that artifact.

## 0.1.0 — 2026-07-24

- Initial technical preview with browser disclosure checks, C2PA provenance
  inspection, JSON and HTML reports, screenshots, network confinement, and
  GitHub Actions guidance.
