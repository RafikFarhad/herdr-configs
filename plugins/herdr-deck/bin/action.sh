#!/usr/bin/env bash
set -uo pipefail

mode="${1:-open}"
herdr_bin="${HERDR_BIN_PATH:-herdr}"
ctx="${HERDR_PLUGIN_CONTEXT_JSON:-}"
[ -n "$ctx" ] || ctx="{}"

exec "$herdr_bin" plugin pane open \
  --plugin herdr-deck \
  --entrypoint deck \
  --placement popup \
  --focus \
  --env "DECK_MODE=$mode" \
  --env "DECK_CONTEXT=$ctx"
