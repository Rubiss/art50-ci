#!/usr/bin/env bash
set -euo pipefail

case "${ART50_EXIT_CODE:-}" in
  0)
    result="PASS — every declared technical assertion passed."
    ;;
  1)
    result="FAIL — one or more declared technical assertions failed."
    ;;
  *)
    result="ERROR — the configuration or execution did not complete."
    ;;
esac

{
  echo "## art50-ci"
  echo
  echo "$result"
  echo
  echo "A result describes only the configured technical observations. It is not a legal-compliance conclusion or certification."
  if [[ -n "${ART50_ARTIFACT_URL:-}" ]]; then
    echo
    echo "[Download the retained evidence artifact](${ART50_ARTIFACT_URL})"
  fi
} >> "$GITHUB_STEP_SUMMARY"
