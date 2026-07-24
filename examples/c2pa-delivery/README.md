# Public C2PA delivery fixtures

These fixtures demonstrate the source-to-delivery checks in `art50-ci` v0.3.0.
All three PNG files render the same test card:

- `assets/c2pa-source.png` has an embedded source manifest.
- `assets/c2pa-delivered.png` has an embedded update manifest whose ingredient
  ancestry includes the source manifest.
- `assets/c2pa-delivered-stripped.png` contains the same visible pixels without
  a C2PA manifest.

`pass.yml` compares the local signed source with the signed bytes served from
GitHub. `stripped-fail.yml` compares that source with the manifest-free
delivery and is expected to exit with status 1.

## Reproduce

From the repository root:

```sh
npm ci
npm run build
node dist/cli.js audit --config examples/c2pa-delivery/pass.yml
node dist/cli.js audit --config examples/c2pa-delivery/stripped-fail.yml
```

The final command is intentionally failing. Regenerate the committed assets
and `SHA256SUMS.txt` with:

```sh
npm run fixtures:c2pa
```

## Test-only trust boundary

The assets are signed with the public test credentials in
`tests/fixtures/certs`, originally published under the MIT License by
`contentauth/c2pa-js`. The key is public, the signer is not a production
identity, and these fixtures must never be used as trusted production
credentials.

The passing result demonstrates embedded-manifest inspection and ancestry for
these exact bytes. It is not a signer-trust determination, authenticity
guarantee, truth assessment, legal-compliance conclusion, or proof that every
possible modification will be detected.
