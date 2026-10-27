# herdr-configs

Personal configuration for [herdr](https://herdr.dev) and herdr-deck (a local plugin that tracks every agent session of a task), kept in one git repo and symlinked into `~/.config`.

## Layout

```text
herdr-configs/
├── install.sh                         symlinks + plugin links, safe to re-run
├── herdr/
│   └── config.toml                    -> ~/.config/herdr/config.toml
├── herdr-deck/
│   └── config.json                    -> ~/.config/herdr-deck/config.json
└── plugins/
    └── herdr-deck/                    local herdr plugin: task deck that owns your agent sessions
        ├── DESIGN.md
        ├── herdr-plugin.toml
        ├── bin/                       deck launcher, action and popup scripts
        └── src/                       TypeScript on Bun, no runtime dependencies
```

## Requirements

- herdr 0.9.0 or newer
- `bun` for herdr-deck (found on `PATH`, in `~/.bun/bin`, or via `BUN_BIN`)
- the herdr pi and claude integrations (`herdr integration install pi`, `herdr integration install claude`) so panes report their agent sessions
- an editor in `$VISUAL` or `$EDITOR` (falls back to `nvim`)

## Install

```bash
git clone https://github.com/RafikFarhad/herdr-configs.git ~/projects/herdr-configs
~/projects/herdr-configs/install.sh
```

`install.sh` symlinks `herdr/config.toml` into `~/.config/herdr` (set `HERDR_CONFIG_DIR` to use another location) and `herdr-deck/config.json` into `~/.config/herdr-deck`, links every plugin under `plugins/` with `herdr plugin link`, then validates and reloads the herdr config. Anything already at a target path is renamed to `<name>.bak-<timestamp>` before linking.

## Keybindings

| Key | Action |
|---|---|
| `ctrl+k` | Open herdr-deck |
| `prefix+shift+s` | herdr-deck: new pi or claude session for the card of the focused workspace |
| `prefix+shift+a` | herdr-deck: file the focused pane's session under a card |
| `prefix+shift+f` | herdr-deck: open the deck on the focused pane's card |
| `prefix+k` | herdr-bar command bar |
| `prefix+p` | plugin manager |

## herdr-deck

A card is a task. Each card has spaces (a git worktree or a checkout) and keeps every pi and claude session you run for it, including forks, so you can move between worktrees and come back to any conversation later, even after its pane or workspace is closed. It never starts work on its own. See [plugins/herdr-deck/DESIGN.md](plugins/herdr-deck/DESIGN.md) for the full design.

- The board is a kanban with Todo, In progress, Blocked and Done columns. Cards show animated status art (waiting for you, working, error, warning, parked, not started, done).
- `v` toggles swimlanes by repo (one horizontal lane per repo, like epics in Jira) and plain columns. The choice is remembered in `~/.local/share/herdr-deck/ui.json`.
- A background watcher (`deck watch`, started with herdr and by the deck) listens to herdr events and files each new session under a card: by the deck's own launch, by the session it was forked from, by the pane's workspace, or by the pane's directory. Anything it cannot place goes to the Inbox (`i`), where one key files it.
- `Enter` on a session focuses its pane if it is still open, otherwise reopens the space and resumes the conversation (`pi --session`, `claude --resume`). `f` forks it.
- New worktree spaces are created with `herdr worktree create` at `~/projects/worktrees/<repo>/<card id>-<slug>` on branch `farhad/<card id>-<slug>` (one shared folder for every repo, set by `worktreeDir`).
- Data lives in `~/.local/share/herdr-deck/deck.db`. `deck doctor`, `deck list` and `deck show <id>` work from any shell via `plugins/herdr-deck/bin/deck`, and `deck demo` opens a throwaway board with one card per state.

`herdr-deck/config.json`:

| Key | Purpose |
|---|---|
| `roots` | Folders whose subfolders are offered as repos |
| `branchPrefix` | Prefix for new worktree branches |
| `worktreeDir` | Where worktrees go. An absolute path (or one starting with `~` or `$HOME`) is a shared root: `<worktreeDir>/<repo>/<card id>-<slug>`. A relative path such as `.worktrees` puts them inside each repo and adds it to `.git/info/exclude`. |
| `defaultHarness` | `pi` or `claude`, listed first when starting a session |

## Notes

- Some tools may rewrite `config.toml` and replace the symlink with a regular file. If `ls -la ~/.config/herdr/config.toml` no longer shows an arrow, copy the changes into the repo and re-run `install.sh`.
