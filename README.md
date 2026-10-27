# herdr-configs

Personal configuration for [herdr](https://herdr.dev), the [herdr-board](https://github.com/nelsonPires5/herdr-board) kanban plugin, and herdr-deck (a local plugin that tracks every agent session of a task), kept in one git repo and symlinked into `~/.config`.

## Layout

```text
herdr-configs/
├── install.sh                         symlinks + plugin links, safe to re-run
├── herdr/
│   ├── config.toml                    -> ~/.config/herdr/config.toml
│   └── scripts/                       -> ~/.config/herdr/scripts
│       └── open-board-workspace.sh    opens herdr-board in its own workspace
├── herdr-deck/
│   └── config.json                    -> ~/.config/herdr-deck/config.json
└── plugins/
    ├── board-new-card/                local herdr plugin: create a board card for a picked repo
    │   ├── herdr-plugin.toml
    │   ├── open.sh
    │   └── new-card.sh
    └── herdr-deck/                    local herdr plugin: task deck that owns your agent sessions
        ├── DESIGN.md
        ├── herdr-plugin.toml
        ├── bin/                       deck launcher, action and popup scripts
        └── src/                       TypeScript on Bun, no runtime dependencies
```

## Requirements

- herdr 0.9.0 or newer
- the herdr-board plugin (`herdr plugin install nelsonPires5/herdr-board`), which provides the `board` CLI in `~/.local/bin`
- `python3`, `fzf`, and an editor in `$VISUAL` or `$EDITOR` (falls back to `nvim`)
- `bun` for herdr-deck (found on `PATH`, in `~/.bun/bin`, or via `BUN_BIN`)
- the herdr pi and claude integrations (`herdr integration install pi`, `herdr integration install claude`) so panes report their agent sessions

## Install

```bash
git clone https://github.com/RafikFarhad/herdr-configs.git ~/projects/herdr-configs
~/projects/herdr-configs/install.sh
```

`install.sh` symlinks `herdr/config.toml` and `herdr/scripts` into `~/.config/herdr` (set `HERDR_CONFIG_DIR` to use another location) and `herdr-deck/config.json` into `~/.config/herdr-deck`, links every plugin under `plugins/` with `herdr plugin link`, then validates and reloads the herdr config. Anything already at a target path is renamed to `<name>.bak-<timestamp>` before linking.

## Keybindings

| Key | Action |
|---|---|
| `prefix+shift+k` | Toggle the herdr-board kanban. It lives in a dedicated `board` workspace, so it never takes over the pane you are working in. Pressing it on the board returns you to the workspace you came from. |
| `prefix+shift+c` | New board card: pick a repo with fzf, type a title, write the description in your editor. |
| `ctrl+k` | Open herdr-deck |
| `prefix+shift+s` | herdr-deck: new pi or claude session for the card of the focused workspace |
| `prefix+shift+a` | herdr-deck: file the focused pane's session under a card |
| `prefix+shift+f` | herdr-deck: open the deck on the focused pane's card |
| `prefix+k` | herdr-bar command bar |
| `prefix+p` | plugin manager |

## board-new-card

The popup lists every folder directly under `~/projects` and `~/apollo` (git worktrees are skipped). The card is created in the `Todo` column of the Global board with:

- space: `new-workspace`
- workspace name: the folder name
- cwd: the absolute folder path

With `new-workspace`, herdr-board reuses an open workspace with that name, or creates it in that folder if none is open, so closing a workspace never breaks a card.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `BOARD_NEW_CARD_COLUMN` | `Todo` | Column the card is created in. `In Progress` starts the agent right away. |
| `BOARD_NEW_CARD_BOARD` | `1` | Board id (Global board) |
| `BOARD_BIN` | `~/.local/bin/board` | Path to the `board` CLI |

## herdr-deck

A card is a task. Each card has spaces (a git worktree or a checkout) and keeps every pi and claude session you run for it, including forks, so you can move between worktrees and come back to any conversation later, even after its pane or workspace is closed. It never starts work on its own. See [plugins/herdr-deck/DESIGN.md](plugins/herdr-deck/DESIGN.md) for the full design.

- The board is a kanban with Todo, In progress, Blocked and Done columns. Cards show animated status art (waiting for you, working, error, warning, parked, not started, done).
- `v` toggles swimlanes by repo (one horizontal lane per repo, like epics in Jira) and plain columns. The choice is remembered in `~/.local/share/herdr-deck/ui.json`.
- A background watcher (`deck watch`, started with herdr and by the deck) listens to herdr events and files each new session under a card: by the deck's own launch, by the session it was forked from, by the pane's workspace, or by the pane's directory. Anything it cannot place goes to the Inbox (`i`), where one key files it.
- `Enter` on a session focuses its pane if it is still open, otherwise reopens the space and resumes the conversation (`pi --session`, `claude --resume`). `f` forks it.
- New worktree spaces are created with `herdr worktree create` at `<repo>/.worktrees/<card id>-<slug>` on branch `farhad/<card id>-<slug>`, and `.worktrees/` is added to `.git/info/exclude`.
- Data lives in `~/.local/share/herdr-deck/deck.db`. `deck doctor`, `deck list` and `deck show <id>` work from any shell via `plugins/herdr-deck/bin/deck`.

`herdr-deck/config.json`:

| Key | Purpose |
|---|---|
| `roots` | Folders whose subfolders are offered as repos |
| `branchPrefix` | Prefix for new worktree branches |
| `worktreeDir` | Worktree folder inside each repo |
| `defaultHarness` | `pi` or `claude`, listed first when starting a session |

## Notes

- Always use absolute paths for a card's cwd. herdr-board does not expand `~`, so `~/apollo/x` silently starts the agent in your home directory.
- When a card reuses an open workspace, every pane in that workspace must be in the same directory, otherwise the run fails with "multiple live pane cwd candidates". If you keep extra panes for testing in other directories, set the card to `workspace` with an explicit absolute cwd instead.
- herdr-board does not create git worktrees. Worktree isolation comes from the `In Progress` column prompt, which lives in the herdr-board database, not in this repo.
- Some tools (for example the herdr-projects plugin adding or removing its keybinding block) may rewrite `config.toml` and replace the symlink with a regular file. If `ls -la ~/.config/herdr/config.toml` no longer shows an arrow, copy the changes into the repo and re-run `install.sh`.
