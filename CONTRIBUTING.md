# Contributing

Bug reports, minimal fixtures, documentation fixes, and low-false-positive
technical checks are welcome.

Before proposing a new assertion:

1. describe the observable behavior rather than a legal conclusion;
2. cite the relevant primary technical or official source;
3. include a passing and intentionally failing fixture;
4. state likely false-positive and false-negative cases; and
5. keep result wording within the project's non-certifying boundary.

Run the checks before opening a pull request:

```bash
npm install
npx playwright install chromium
npm run check
npm pack --dry-run
```

Never include customer credentials, private URLs, personal data, or sensitive
evidence in an issue or fixture.

## Publishing a release

Before the first automated npm release, configure the `art50-ci` package on
npmjs.com with a GitHub Actions trusted publisher for:

- organization or user: `Rubiss`
- repository: `art50-ci`
- workflow filename: `publish-npm.yml`
- allowed action: `npm publish`

Then update `package.json` and `package-lock.json` to the intended version and
publish a non-prerelease GitHub release whose tag is exactly `v<version>`. The
release workflow verifies that tag, runs the full test and package checks, and
publishes the package to npm using short-lived OIDC credentials. Prereleases
are intentionally not published.
