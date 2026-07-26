# Changelog

## Unreleased

## 0.4.0 — 2026-07-26

### Added

- Trusted npm publishing that validates a published GitHub release tag against
  `package.json`, runs the full release checks, and publishes the public package
  with OIDC authentication and automatically generated provenance.
- A browser obstruction demonstration, reproducible with the published v0.3.0
  CLI, that compares broken and fixed cookie-overlay fixtures and retains
  matching JSON, HTML, screenshots, and hashes.
- End-to-end coverage of the built CLI across the browser failure matrix plus
  a deterministic screenshot-storage failure.
- A clean-repository adoption workflow that installs the published npm package,
  configures one declared check, runs it, validates its evidence, and enforces
  a ten-minute ceiling.

### Changed

- Updated the C2PA runtime, Commander, Zod, TypeScript, and Vitest dependency
  lines and raised the supported Node.js floor to 22.12.0.
- Overrode the C2PA runtime's legacy archive dependency with `unzipper@0.12.5`,
  removing the vulnerable `fstream`, `rimraf`, `glob`, `minimatch`, and
  `brace-expansion` transitive chain.

## 0.3.0 — 2026-07-24

### Added

- A root-level composite GitHub Action that installs its lockfile-pinned
  JavaScript runtime from the tagged source, verifies the platform-specific
  C2PA native archive against a release-pinned SHA-256 digest, runs declared
  checks in any-language repositories, and uploads JSON, HTML, screenshot, and
  provenance evidence
  before returning the CLI's result.
- Action inputs for configuration, output, artifact retention, optional
  Chromium installation, and newline-delimited exact private-origin grants.
- Action outputs for the CLI exit code, report directory, and GitHub artifact
  identifier, URL, and digest.
- Input- and filesystem-boundary tests plus deterministic pass/fail action
  smoke jobs in an isolated non-Node consumer workspace.

The initial composite action supports GitHub-hosted Linux runners. It requires
a new or empty repository-relative report directory, does not need npm
authentication, and does not modify the caller's package manifest or lockfile.

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
