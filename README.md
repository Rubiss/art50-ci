# art50-ci

Regression tests for AI transparency in the product people actually receive.

`art50-ci` is a local-first CLI that checks the technical expectations your
team declares for AI disclosures and C2PA provenance. It opens real preview or
production pages, observes disclosures in the initial page state, detects
sampled overlay obstruction and basic accessible-name failures, and checks
whether a source C2PA manifest label appears in the delivered manifest chain.

It produces inspectable JSON, HTML, screenshots, timestamps, and hashes. It
does **not** decide legal scope, interpret exceptions, certify compliance, or
claim that a C2PA manifest proves authenticity.

Article 50 and the Code of Practice do not require C2PA by name. This preview
supports C2PA as one configurable metadata implementation; it does not provide
complete Article 50(2) marking or detection coverage.

> **Status:** `v0.3.0` technical preview. Configuration and report schemas may
> change before `v1.0`. Report and provenance evidence documents currently use
> `schemaVersion: 2`; configuration remains `version: 1`.

## Why this exists

A disclosure can pass design review and disappear in production. A cookie
banner can cover it. A mobile layout can push it out of the initial viewport.
An image or CDN transformation can strip machine-readable provenance.

Those are delivery regressions, so they belong in CI.

The European Commission published final Article 50 guidance on 20 July 2026,
and the relevant transparency obligations apply from 2 August 2026, subject to
scope and exceptions. The official materials discuss first interaction or
exposure, clear and accessible information, intervening overlays, and labels
surviving resharing or download. They also make clear that the optional EU
icons alone do not establish compliance.

Official starting points:

- [Commission Article 50 guidelines](https://digital-strategy.ec.europa.eu/en/library/guidelines-transparency-obligations-providers-and-deployers-ai-systems)
- [Article 50 in Regulation (EU) 2024/1689](https://eur-lex.europa.eu/eli/reg/2024/1689/oj)
- [Code of Practice FAQ](https://digital-strategy.ec.europa.eu/en/faqs/code-practice-transparency-ai-generated-content)
- [EU icon and placement guidance](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content)

## What it checks

| Checkpoint | Observable assertion |
| --- | --- |
| Page delivery | Navigation, HTTP status, and optional readiness selector |
| Disclosure | Selector, configured text match, and expected visibility |
| Initial render | Disclosure observed in the initial page state and viewport; a technical proxy, not a legal “first exposure” determination |
| Obstruction | At least one sampled disclosure point is not covered |
| Basic accessible name | A non-empty name outside an `aria-hidden` or presentational subtree |
| Interaction checkpoint | Configured control exists, is visible, and is enabled after the initial observation; the action is not performed |
| Evidence | Page and screenshot SHA-256, timestamp, URL, viewport, and structured failures |
| C2PA | Manifest presence, embedding, active label, validation state/statuses, and declared digital source type |
| Delivery pipeline | Source active manifest label absent from the delivered manifest chain |

Every `PASS` has a deliberately narrow meaning: the configured technical
condition was observed against the tested target at that time.

## Quick start

Requirements:

- Node.js 22 or newer
- Chromium installed through Playwright for browser checks

Add the action to any GitHub repository—Node project or not—and retain the
evidence automatically:

```yaml
- uses: actions/checkout@v6
- uses: Rubiss/art50-ci@v0.3.0
  with:
    config: .art50-ci.yml
```

For a local run, install the versioned GitHub release and check the art50-ci
production site:

```bash
npm install --save-dev https://github.com/Rubiss/art50-ci/releases/download/v0.3.0/art50-ci-0.3.0.tgz
npx playwright install chromium
npx art50-ci verify https://art50-ci.rubiss89.chatgpt.site --selector '[data-product-boundary]' --text 'No legal compliance verdicts.'
```

That command writes inspectable JSON, HTML, and screenshot evidence. To
configure repeatable checks for your own product:

```bash
npx art50-ci init
# Edit the generated target, selectors, text, and provenance expectations.
npx art50-ci audit
```

Inspect a real screenshot-free run against the production site:
[rendered HTML report](https://art50-ci.rubiss89.chatgpt.site/evidence/production-site-v0.2.0.html),
[portable JSON](examples/evidence/production-site-v0.2.0.json), and the
[configuration that produced it](examples/live-site.yml).

After the npm package is published, the install command becomes:

```bash
npm install --save-dev art50-ci
```

The process exits with `0` when every declared assertion passes, `1` when an
audit completes with failed assertions, and `2` for configuration or execution
errors.

If you used `v0.1.0`, upgrade and regenerate any report artifacts before
sharing them. Version 2 report documents replace absolute local targets with
`$CONFIG_DIR/...` or `$LOCAL_FILE` and store screenshot and provenance
references relative to the JSON document that contains them.

## Configuration

`art50-ci init` creates `.art50-ci.yml`. Unknown keys and invalid values are
rejected before execution; editor support is available through the bundled
JSON Schema.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Rubiss/art50-ci/main/schema/art50-ci.schema.json
version: 1

project:
  name: acme-ai-product

browser:
  timeoutMs: 15000
  waitUntil: domcontentloaded
  viewport:
    width: 1440
    height: 1000

network:
  maxRedirects: 5
  # Private main targets are requested automatically. List any additional
  # private redirect or subresource origins here; CLI trust is still required.
  requestedPrivateOrigins: []

output:
  directory: .art50-ci/reports
  screenshots: true
  redactSelectors:
    - 'input[type="password"]'
    - '[data-sensitive]'

surfaces:
  - id: public-assistant
    name: Public assistant
    kind: chatbot
    target: https://example.com/assistant
    waitFor: '[data-app-ready]'
    firstInteraction:
      selector: '[data-testid="assistant-input"]'
      action: focus
    disclosures:
      - id: ai-interaction-notice
        description: Text selected by the product governance owner.
        selector: '[data-ai-disclosure]'
        expectedText: You are interacting with an AI system
        match: contains
        caseSensitive: false
        visible: true
        inViewport: true
        unobstructed: true
        accessible: true
        accessibleName: AI interaction notice

provenance:
  - id: launch-poster
    name: Launch poster from source to CDN
    source: ./assets/launch-poster.png
    delivered: https://cdn.example.com/media/launch-poster.png
    requireManifest: true
    requireEmbedded: true
    requireSourceManifestInDeliveredChain: true
    failOnInvalid: true
    expectedDigitalSourceType: http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia
```

Add stable attributes such as `data-ai-disclosure` rather than coupling tests
to styling classes. Configure `expectedDigitalSourceType` with the complete
C2PA/IPTC URI; comparison is exact and is evaluated independently against the
active manifest of every configured source and delivered asset. It does not
inherit a value from an earlier manifest in the chain. The source-to-delivery
check starts at the delivered active manifest and recursively follows
ingredient ancestry; an unlinked label merely present elsewhere in the
manifest store does not satisfy it. The scope and expected controls remain
your declarations.

C2PA verification in this preview is deliberately local and offline. It
verifies the manifest structure, hashes, and signatures after reading, but
does not establish certificate-chain or timestamp trust, fetch OCSP
revocation information, or fetch remote manifest stores. A `Valid` state is
therefore not a `Trusted` signer result.

### Network boundary

HTTP(S) checks are public-network-only by default. A non-public target needs
two matching declarations:

1. the exact origin must be requested by the configuration (a configured main
   target is requested automatically); and
2. the operator must grant that exact origin at runtime.

```bash
npx art50-ci audit \
  --allow-private-origin https://staging.internal.example
```

Repeat the flag for each private origin. There are no wildcard or CIDR grants,
and scheme and port are part of the match. The browser runs behind a guarded
proxy that connects to the IP vetted by the policy; provenance downloads pin
the same vetted address and recheck every redirect. Private redirect,
subresource, and WebSocket origins must also be requested and granted.

File targets and their subresources are confined to the configuration
directory. URL credentials are rejected. Query strings and fragments may be
used transiently for a request but are removed from JSON, HTML, evidence, and
console diagnostics.

## Commands

Create a starter configuration:

```bash
npx art50-ci init
npx art50-ci init ./checks
npx art50-ci init ./checks --force
```

Audit every configured browser surface and provenance asset:

```bash
npx art50-ci audit
npx art50-ci audit --config ./checks/.art50-ci.yml --output ./artifacts/art50
```

Verify one page against a configured surface:

```bash
npx art50-ci verify ./preview/index.html --surface public-assistant
npx art50-ci verify https://staging.example.com --surface public-assistant
```

Run a one-off browser assertion without a config:

```bash
npx art50-ci verify ./preview/index.html \
  --selector '[data-ai-disclosure]' \
  --text 'You are interacting with an AI system'
```

Inspect one asset for a required embedded C2PA manifest:

```bash
npx art50-ci verify ./assets/generated-image.png --c2pa
npx art50-ci verify https://cdn.example.com/generated-image.png --c2pa
```

Use `--headed` to watch browser checks locally.

## Reports

Each run writes matching JSON and HTML reports, screenshots when enabled, and
one privacy-minimised provenance summary per inspected asset:

```text
.art50-ci/reports/
├── audit-<timestamp>-<id>.json
├── audit-<timestamp>-<id>.html
├── screenshots/
│   └── public-assistant-<id>.png
└── provenance/
    ├── launch-poster-source-<timestamp>-<id>.json
    └── launch-poster-delivered-<timestamp>-<id>.json
```

The report includes its own result boundary, configuration hash, runtime and
optional GitHub commit SHA. Raw page HTML and customer media are not copied
into the report bundle. Screenshots may still contain sensitive information;
use `redactSelectors`, disable screenshots, and retain artifacts in
access-controlled storage when appropriate.

Persisted report and provenance paths are portable and privacy-minimised:
targets inside the configuration directory use `$CONFIG_DIR/...`, other local
targets use `$LOCAL_FILE`, and generated artifact references are relative to
the document containing them. Runtime API results and CLI output paths remain
absolute so local tooling can still open the generated files.

`$CONFIG_DIR`, `$REPORT_DIR`, and `$LOCAL_FILE` are privacy placeholders, not
filesystem paths to open directly. `$REPORT_DIR/...` may appear in sanitized
diagnostic text. A relative `screenshotPath` or `evidencePath` is different:
resolve it against the directory containing that JSON document.

```json
{
  "schemaVersion": 2,
  "configPath": "$CONFIG_DIR/.art50-ci.yml",
  "surfaces": [{
    "target": "$CONFIG_DIR/preview/index.html",
    "screenshotPath": "screenshots/public-assistant-example.png"
  }]
}
```

See [CHANGELOG.md](CHANGELOG.md) for report-schema compatibility notes and the
v0.1.0 privacy advisory.

## GitHub Actions

```yaml
name: AI transparency regression checks

on:
  pull_request:
  schedule:
    - cron: "17 5 * * *"

permissions:
  contents: read

jobs:
  art50:
    # Do not execute a fork's workflow/configuration with repository secrets or
    # private-origin grants. Run external contributions after trusted review.
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false

      - name: Check delivered AI transparency controls
        uses: Rubiss/art50-ci@v0.3.0
        with:
          config: .art50-ci.yml
          output: artifacts/art50
          artifact-name: art50-ci-report
          retention-days: 7
```

The action currently supports GitHub-hosted Linux runners. It installs and
builds its JavaScript runtime from the tagged, lockfile-pinned source under
`GITHUB_ACTION_PATH`, verifies the platform-specific C2PA native archive
against a release-pinned SHA-256 digest, and does not change the caller's
`package.json`, lockfile, or dependency tree. The output must be a new or empty
repository-relative directory, preventing unrelated caller files from being
included in the evidence artifact.
It installs Chromium by default, uploads evidence before returning the CLI's
`0`, `1`, or `2` status, and needs only `contents: read`. Security-sensitive
workflows can pin the action to the full release commit SHA instead of a tag.

For an already-provisioned Playwright runner, set `install-browser: "false"`.
Pass exact private origins as newline-delimited values only after trusted
review:

```yaml
with:
  config: checks/.art50-ci.yml
  private-origins: |
    https://preview.internal.example
```

Do not expose preview credentials to workflows that execute code from
untrusted forks. Application-layer network controls do not make arbitrary
fork-controlled workflow code safe. Reserve private-origin grants for a
protected branch, scheduled run, or reviewed manual workflow on an isolated
runner.

## What it does not do

`art50-ci` does not:

- determine whether a provider, deployer, system, or item of content is in
  scope;
- classify content as a deepfake or text on a matter of public interest;
- decide whether a human-review, artistic, law-enforcement, or other exception
  applies;
- assess whether wording or a selected technical control is legally
  sufficient;
- perform a complete accessibility, contrast, duration, or media-interval
  audit;
- test whether a perceptible disclosure remains inside downloaded or reshared
  media;
- detect invisible watermarks or prove that all AI-generated content can be
  detected;
- provide complete Article 50(2) marking or detection coverage;
- resolve inherited `digitalSourceType` values from C2PA v2 action templates
  or related actions (this preview reports direct serialized action fields);
- issue a certificate, legal opinion, safe harbour, or compliance badge.

The official EU icons are optional, and their presence alone is not a
compliance conclusion. C2PA observations likewise describe the inspected
bytes, not whether the content is true, lawful, or authentic.

## Development

```bash
npm install
npx playwright install chromium
npm run check
npm pack --dry-run
```

The tests execute real Chromium fixtures, cover missing and obstructed
disclosures, validate configuration boundaries, inspect a no-manifest asset,
and exercise asset-only audits.

Useful contributions include reproducible false positives, framework-specific
fixtures, safer evidence capture, and precise failure messages. Rules based on
legal interpretation should begin as a discussion; the core should remain an
observable technical assertion runner.

## License and independence

MIT.

`art50-ci` is an independent project. It is not affiliated with or endorsed by
the European Commission, the EU AI Office, the Content Authenticity
Initiative, the C2PA, or any market surveillance authority.

This software and its documentation provide general technical information,
not legal advice.
