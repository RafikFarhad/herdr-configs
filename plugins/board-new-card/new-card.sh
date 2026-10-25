#!/usr/bin/env bash
set -uo pipefail

roots=("$HOME/projects" "$HOME/apollo")
board_bin="${BOARD_BIN:-$HOME/.local/bin/board}"
board_id="${BOARD_NEW_CARD_BOARD:-1}"
column="${BOARD_NEW_CARD_COLUMN:-Todo}"
editor="${VISUAL:-${EDITOR:-nvim}}"

pause() {
  printf '\n%s' "${1:-press any key to close}"
  read -r -n 1 -s _
}

fail() {
  printf '\n\033[31m%s\033[0m\n' "$1"
  pause
  exit 1
}

list_repos() {
  local root dir name
  for root in "${roots[@]}"; do
    [ -d "$root" ] || continue
    for dir in "$root"/*/; do
      dir="${dir%/}"
      [ -f "$dir/.git" ] && continue
      name="$(basename "$dir")"
      printf '%s\t%s\n' "$name" "$dir"
    done
  done | sort -f
}

pick="$(list_repos | fzf --prompt='repo> ' --delimiter=$'\t' --with-nth=1,2 --tabstop=28 --height=100% --reverse --header='pick the repo for this card (esc cancels)')" || exit 0
[ -n "$pick" ] || exit 0

name="${pick%%$'\t'*}"
dir="${pick#*$'\t'}"

printf '\033[1mrepo:\033[0m %s  (%s)\n\n' "$name" "$dir"
read -r -e -p 'title: ' title
[ -n "${title// /}" ] || fail "empty title, nothing created"

desc_file="$(mktemp "${TMPDIR:-/tmp}/board-card-XXXXXX.md")"
trap 'rm -f "$desc_file"' EXIT

printf 'opening %s for the description (the task prompt). save and quit when done.\n' "$editor"
sleep 0.4
$editor "$desc_file" </dev/tty >/dev/tty
description="$(cat "$desc_file")"

if [ -z "${description//[$' \t\n']/}" ]; then
  read -r -n 1 -p $'\nempty description: the agent will have nothing to do. create anyway? [y/N] ' ok
  printf '\n'
  [[ "$ok" =~ ^[Yy]$ ]] || fail "cancelled, nothing created"
fi

out="$("$board_bin" --board "$board_id" card create \
  --title "$title" \
  --description "$description" \
  --column "$column" \
  --space-kind new-workspace \
  --space-ref "$name" \
  --space-cwd "$dir" 2>&1)" || fail "board card create failed: $out"

printf '\n\033[32m%s\033[0m\n  workspace: %s\n  cwd:       %s\n  column:    %s\n' "$out" "$name" "$dir" "$column"
pause
