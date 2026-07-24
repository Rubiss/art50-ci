#!/usr/bin/env bash
set -euo pipefail

case "${ART50_EXIT_CODE:-}" in
  0)
    exit 0
    ;;
  1)
    exit 1
    ;;
  2)
    exit 2
    ;;
  *)
    echo "::error title=art50-ci action failed::The audit did not produce a valid exit status."
    exit 2
    ;;
esac
