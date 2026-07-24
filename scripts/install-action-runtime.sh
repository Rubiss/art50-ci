#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${GITHUB_ACTION_PATH:-}" ]]; then
  echo "::error title=art50-ci setup failed::GITHUB_ACTION_PATH is unavailable."
  exit 2
fi

SKIP_BINARY_DOWNLOAD=1 SKIP_RUST_BUILD=1 npm ci \
  --prefix "$GITHUB_ACTION_PATH" \
  --ignore-scripts \
  --no-audit \
  --no-fund
node "$GITHUB_ACTION_PATH/scripts/install-c2pa-action-binary.mjs"
npm run --prefix "$GITHUB_ACTION_PATH" build

if [[ ! -f "$GITHUB_ACTION_PATH/dist/cli.js" ]]; then
  echo "::error title=art50-ci setup failed::The tagged action did not build dist/cli.js."
  exit 2
fi

if [[ "${ART50_INSTALL_BROWSER:-}" == "true" ]]; then
  node "$GITHUB_ACTION_PATH/node_modules/playwright/cli.js" install --with-deps chromium
fi
