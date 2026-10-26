#!/usr/bin/env bash
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$here/deck" "${DECK_MODE:-open}"
status=$?
if [ "$status" -ne 0 ]; then
  printf '\npress any key to close'
  read -r -n 1 -s _
fi
exit "$status"
