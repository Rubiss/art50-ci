# Browser obstruction pass/fail fixture

This pair demonstrates one delivery regression with the published
`art50-ci@0.3.0` CLI:

- `broken.html` contains the declared AI notice, but a cookie overlay covers
  every sampled point. The audit exits `1` with `OBSTRUCTED`.
- `fixed.html` keeps the same notice and declared expectations while the cookie
  control stays below it. The audit exits `0`.

Both runs retain portable JSON, rendered HTML, a screenshot, timestamps, and
SHA-256 hashes. The committed reports identify tool version `0.3.0` and are
reproducible with the published package; they are not browser-only simulated
results.

Inspect the committed evidence:

- broken fixture: [HTML report](../evidence/browser-obstruction-broken-v0.3.0.html)
  · [portable JSON](../evidence/browser-obstruction-broken-v0.3.0.json)
- fixed fixture: [HTML report](../evidence/browser-obstruction-fixed-v0.3.0.html)
  · [portable JSON](../evidence/browser-obstruction-fixed-v0.3.0.json)

## Reproduce

From the repository root with Node.js 22.12.0 or later:

```sh
npm install --no-save art50-ci@0.3.0
npx playwright install chromium
npx art50-ci audit --config examples/browser-obstruction-demo/broken.yml
npx art50-ci audit --config examples/browser-obstruction-demo/fixed.yml
```

The first audit is intentionally failing. Its `PASS`/`FAIL` result means only
that the configured technical conditions were or were not observed against
these fixture pages at the recorded time. It is not a legal-compliance
conclusion, certification, or accessibility audit.
