#!/usr/bin/env bash
set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"
state_file="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-board-launcher/return-workspace"
board_label="board"

mkdir -p "$(dirname "$state_file")"

read -r board_ws board_pane focused_ws board_focused < <(
  {
    "$herdr_bin" workspace list 2>/dev/null
    echo
    "$herdr_bin" pane list 2>/dev/null
  } | python3 -c '
import json, re, sys
ws_data, pane_data = {}, {}
for chunk in sys.stdin.read().split("\n"):
    chunk = chunk.strip()
    if not chunk:
        continue
    try:
        res = json.loads(chunk).get("result", {})
    except Exception:
        continue
    if "workspaces" in res:
        ws_data = res
    if "panes" in res:
        pane_data = res
board_ws = "-"
focused_ws = "-"
for w in ws_data.get("workspaces", []):
    if (w.get("label") or "").lower() == sys.argv[1] and board_ws == "-":
        board_ws = w["workspace_id"]
    if w.get("focused"):
        focused_ws = w["workspace_id"]
board_pane = "-"
board_focused = "0"
pattern = re.compile(r"Board( \[.*\])?")
for p in pane_data.get("panes", []):
    if pattern.fullmatch(p.get("label") or ""):
        board_pane = p["pane_id"]
        board_ws = p["workspace_id"]
        board_focused = "1" if p.get("focused") else "0"
        break
print(board_ws, board_pane, focused_ws, board_focused)
' "$board_label"
)

if [ "$board_pane" != "-" ] && [ "$board_focused" = "1" ]; then
  if [ -s "$state_file" ]; then
    target="$(cat "$state_file")"
    if [ "$target" != "$board_ws" ] && "$herdr_bin" workspace focus "$target" >/dev/null 2>&1; then
      exit 0
    fi
  fi
  exit 0
fi

if [ "$focused_ws" != "-" ] && [ "$focused_ws" != "$board_ws" ]; then
  printf '%s\n' "$focused_ws" > "$state_file"
fi

if [ "$board_pane" = "-" ]; then
  if [ "$board_ws" = "-" ]; then
    board_ws="$("$herdr_bin" workspace create --cwd "$HOME" --label "$board_label" --no-focus \
      | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["workspace"]["workspace_id"])')"
    created_root="$("$herdr_bin" pane list | python3 -c '
import json, sys
for p in json.load(sys.stdin)["result"]["panes"]:
    if p["workspace_id"] == sys.argv[1]:
        print(p["pane_id"]); break
' "$board_ws")"
  else
    created_root=""
  fi
  board_pane="$("$herdr_bin" plugin pane open --plugin herdr-board --entrypoint board \
    --placement tab --workspace "$board_ws" --no-focus \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["plugin_pane"]["pane"]["pane_id"])')"
  if [ -n "$created_root" ]; then
    "$herdr_bin" pane close "$created_root" >/dev/null 2>&1 || true
  fi
fi

"$herdr_bin" workspace focus "$board_ws" >/dev/null 2>&1
exec "$herdr_bin" plugin pane focus "$board_pane"
