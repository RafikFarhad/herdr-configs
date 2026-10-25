#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
herdr_dir="${HERDR_CONFIG_DIR:-$HOME/.config/herdr}"
stamp="$(date +%Y%m%d-%H%M%S)"

link() {
  local src="$1" dest="$2"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    printf 'ok      %s\n' "$dest"
    return
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    mv "$dest" "$dest.bak-$stamp"
    printf 'backup  %s -> %s.bak-%s\n' "$dest" "$dest" "$stamp"
  fi
  mkdir -p "$(dirname "$dest")"
  ln -s "$src" "$dest"
  printf 'linked  %s -> %s\n' "$dest" "$src"
}

link "$repo/herdr/config.toml" "$herdr_dir/config.toml"
link "$repo/herdr/scripts" "$herdr_dir/scripts"

for plugin in "$repo"/plugins/*/; do
  plugin="${plugin%/}"
  [ -f "$plugin/herdr-plugin.toml" ] || continue
  herdr plugin link "$plugin" >/dev/null
  printf 'plugin  %s\n' "$(basename "$plugin")"
done

herdr config check
herdr server reload-config >/dev/null && printf 'herdr config reloaded\n'
