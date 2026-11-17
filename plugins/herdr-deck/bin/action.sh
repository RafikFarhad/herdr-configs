#!/usr/bin/env bash
set -uo pipefail

mode="${1:-open}"
herdr_bin="${HERDR_BIN_PATH:-herdr}"
ctx="${HERDR_PLUGIN_CONTEXT_JSON:-}"
[ -n "$ctx" ] || ctx="{}"
popup="${DECK_DATA_DIR:-$HOME/.local/share/herdr-deck}/popup.json"

open_deck() {
  "$herdr_bin" plugin pane open \
    --plugin herdr-deck \
    --entrypoint deck \
    --placement popup \
    --focus \
    --env "DECK_MODE=$mode" \
    --env "DECK_CONTEXT=$ctx"
}

field() {
  sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\)\"\{0,1\}[,}].*/\1/p" "$popup"
}

alive() {
  [ -n "$1" ] && [ "$1" != "null" ] && kill -0 "$1" 2>/dev/null
}

open_deck && exit 0
[ -f "$popup" ] || exit 1
pane="$(field pane_id)"
pid="$(field pid)"
shell_pid="$(field shell_pid)"
if [ -n "$pane" ] && [ "$pane" != "null" ]; then
  "$herdr_bin" plugin pane close "$pane" >/dev/null 2>&1
fi
alive "$pid" && kill "$pid" 2>/dev/null
alive "$shell_pid" && kill "$shell_pid" 2>/dev/null
rm -f "$popup"
sleep 0.3
open_deck
