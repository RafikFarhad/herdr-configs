# herdr-deck

herdr-deck is a local herdr plugin: a kanban task tracker that owns your agent sessions. A card is a task. A card has spaces (a git worktree or a checkout) and every agent session you run for it (pi, claude), across worktrees, panes and days, including forks. It never starts work by itself, it records and reopens what you start.

This file is the single source of truth for what herdr-deck is, how it behaves and how to work on it. Keep it current: any change to behaviour, keys, data model, config or layout updates the matching section here in the same change, and user-facing changes also update the herdr-deck section of the repo `README.md` and, when they change what the demo GIF shows, re-record it (see "Demo GIF").

## Working on herdr-deck

### Where things live

- Code: `~/projects/herdr-configs/plugins/herdr-deck` (this folder), part of the `herdr-configs` repo. herdr loads it through `herdr plugin link` (done by the repo's `install.sh`), so edits are live without a reinstall.
- Config: `~/projects/herdr-configs/herdr-deck/config.json`, symlinked to `~/.config/herdr-deck/config.json`.
- herdr config with the deck keybindings and the `$card` sidebar row: `~/projects/herdr-configs/herdr/config.toml`, symlinked to `~/.config/herdr/config.toml`.
- Data: `~/.local/share/herdr-deck/` holds `deck.db` (SQLite, WAL), `watch.pid`, `watch.log` and `ui.json`.
- herdr server log, useful to see exactly which API calls the deck made and when: `~/.config/herdr/herdr-server.log` (deck requests have ids `deck:<pid>:<ms>:<n>`).

### Stack and rules

- TypeScript on Bun, no runtime npm dependencies: `bun:sqlite`, `Bun.connect` for the herdr socket, raw ANSI terminal UI. `devDependencies` are only `typescript` and `@types/bun` for type checking. Do not add runtime packages.
- No build step: `bin/deck` runs `src/cli.ts` directly with bun. `dist/` is ignored.
- Paths are stored absolute; `~` and `$HOME` are expanded on input (`absPath` in `config.ts`) and never written.
- Schema changes: `SCHEMA` in `db.ts` uses `CREATE TABLE IF NOT EXISTS`, so new columns on existing tables must also be added in `DeckDb.migrate()` with a `PRAGMA table_info` check and `ALTER TABLE ... ADD COLUMN`. Update the `Space`/`Session`/`Card` interfaces and the `Omit<...>` lists of the insert helpers.
- Never write code comments (owner rule, applies to every file here).
- Never use em-dashes in docs or UI text.

### Checking a change

```bash
cd ~/projects/herdr-configs/plugins/herdr-deck
npx tsc --noEmit -p .            # must be clean, there are no unit tests
bin/deck doctor                  # data dir, config, worktree pattern, watcher pid, herdr reachability
bin/deck list                    # cards and inbox count
bin/deck show <id>               # one card with spaces and sessions (pane, status, session file)
bin/deck demo                    # TUI on a throwaway database with one card per state
```

- `bin/deck demo` sets `DECK_DATA_DIR` to a temp dir and `DECK_DEMO=1`, so it never touches the real `deck.db`. Use it to check board, card and art rendering.
- For anything else that needs isolation, run with `DECK_DATA_DIR=/tmp/somewhere` (and `DECK_CONFIG=...` for a test config). Panes the deck opens carry that data dir, and the real watcher ignores sessions owned by another data dir.
- The TUI is a fresh process every time the popup opens, so TUI and action changes take effect on the next open.
- The watcher is long running. After changing `watcher.ts` or anything it imports (`db.ts`, `herdr.ts`, `sessions.ts`, `prs.ts`, `sidebar.ts`, `subagents.ts`, `model.ts`, `config.ts`), restart it: `bin/deck stop-watch && bin/deck ensure-watch`. Check `~/.local/share/herdr-deck/watch.log` afterwards.
- herdr API: discover methods and parameter shapes with `herdr api schema --json` (request params are under `schemas.request.$defs`, for example `AgentStartParams`), inspect live state with `herdr api snapshot`, `herdr agent list`, `herdr pane list`, and read the agent-control guide with `herdr --skill`. Try read-only calls from the shell (`herdr agent wait <name> --timeout 4000`) before wiring them in.
- Do not commit or push unless asked; report what changed.

### Demo GIF

The README shows `doc/demo.gif` (repo root, not this folder): a recording of `bin/deck demo` with a caption bar under the terminal naming each key as it is pressed and what it does.

- Source: `doc/demo.ts`. Its `steps` list is the whole demo: each step has the VHS commands to send (`press` for one key, `special` for `Enter`/`Escape`/`Tab`/`Ctrl+U`, `typed` for text), the caption key, the caption label and the pause after it. The script writes a VHS tape to a temp dir, records it to mp4 with `vhs`, then `ffmpeg` pads a bar under the video, draws each step's caption with `drawtext` for exactly that step's time window, and writes the GIF. There is no tape file in the repo; do not add one.
- Re-record from the repo root with `bun doc/demo.ts`. Needs `vhs` (`go install github.com/charmbracelet/vhs@latest`, lands in `$(go env GOPATH)/bin`), `ttyd`, `ffmpeg` with `drawtext`, and the Noto Sans Mono font (`fc-match`). It takes about a minute and only ever touches the throwaway demo data.
- Caption timing is computed, not measured: a step lasts its typed characters times `TYPING_MS` plus its `wait`; `Enter`, `Escape`, `Tab` and `Ctrl+U` add no typing time in VHS. If a new step uses another VHS command, check that `stepMs` still matches or captions drift late. Verify after recording by extracting frames (`ffmpeg -i doc/demo.gif -vf fps=1 /tmp/f%02d.png`) and checking the caption matches the screen, especially near the end.
- Re-record in the same change when any of these change: a key or what it does on a step the demo uses, the board, card page, filter, new card form or Keys page layout, the key bar, the status art, or the demo seed data in `src/demo.ts`. Update the step labels in `doc/demo.ts` when a key's meaning changes, and add a step when a new headline feature should be shown.
- Keep the GIF small enough for the README (it is about 3 MB at `FPS` 20); lower `FPS` or trim steps rather than letting it grow far past that.

### CLI

`bin/deck <cmd>` (bun is found on `PATH`, in `~/.bun/bin`, or via `BUN_BIN`):

| Command | What it does |
|---|---|
| `tui` / `open` (default) | open the board; also starts the watcher if it is not running |
| `new-session`, `assign`, `goto` | TUI in that mode, using the herdr context (`DECK_CONTEXT` or `HERDR_PLUGIN_CONTEXT_JSON`) for the focused pane/workspace |
| `demo` | throwaway board, see above |
| `watch` | run the watcher in the foreground |
| `ensure-watch` | start the watcher detached if it is not running, print its pid |
| `stop-watch` | SIGTERM the watcher |
| `sync` | one reconcile pass against `pane.list`, then `list` |
| `list`, `show <id>`, `doctor` | read-only inspection |

### Environment variables

| Variable | Used for |
|---|---|
| `DECK_DATA_DIR` | data dir instead of `~/.local/share/herdr-deck`; also set on every pane the deck opens so the watcher knows who owns it |
| `DECK_CARD_ID` | set on every pane the deck opens; files sessions started by hand in that pane under the card |
| `DECK_CONFIG` | config file instead of `~/.config/herdr-deck/config.json` |
| `DECK_DEMO` | `1` only inside `bin/deck demo` |
| `DECK_MODE`, `DECK_CONTEXT` | passed by `bin/action.sh` to the popup: TUI mode and herdr plugin context JSON |
| `BUN_BIN` | bun binary for `bin/deck` |
| `HERDR_SOCKET_PATH` | herdr socket instead of `~/.config/herdr/herdr.sock` |
| `HERDR_CONFIG_PATH` | herdr `config.toml` read for the Keys page |
| `HERDR_BIN_PATH` | herdr binary for `bin/action.sh` |
| `PI_SUBAGENTS_TEMP_ROOT` | pi-subagents temp root for subagent run status files |
| `VISUAL` / `EDITOR` | editor for `ctrl+e` in the new card form (falls back to `nvim`) |

### Layout

```text
plugins/herdr-deck/
├── AGENTS.md              this file
├── herdr-plugin.toml      actions, popup pane, startup hook (bin/deck ensure-watch)
├── package.json           typecheck script, dev dependencies only
├── tsconfig.json
├── bin/deck               bun launcher, also runs demo on a temp data dir
├── bin/action.sh          turns a herdr plugin action plus context into a popup pane
├── bin/pane.sh            popup entrypoint, keeps the pane open on a non-zero exit
└── src/
    ├── cli.ts             subcommands
    ├── config.ts          config file, data dir, path expansion, worktree paths
    ├── db.ts              SQLite schema, migrations and queries (DeckDb, db())
    ├── herdr.ts           socket client: requests, event subscription, typed wrappers
    ├── watcher.ts         background process: session capture, filing, sidebar, PR and subagent polling
    ├── sessions.ts        session files, titles, parent refs, resume and fork arguments
    ├── actions.ts         create card, space, session; open, resume, fork, close, delete worktree
    ├── model.ts           derived state: open, working, latest session, groups, session tree
    ├── prs.ts             gh pull request lookup per space
    ├── sidebar.ts         `card` workspace metadata token
    ├── subagents.ts       running pi-subagents per pi session
    ├── demo.ts            demo seed data (also what the README GIF shows)
    └── tui/
        ├── term.ts        terminal, keys, styled parts, $EDITOR
        ├── art.ts         animated status art
        ├── form.ts        new card form
        └── app.ts         board, card page, inbox, overlays, all key handling
```

## Goals

1. Find what you are on at a glance: needs you, in progress, blocked, todo, done.
2. Every card knows its spaces (repo, worktree path, branch, herdr workspace).
3. Every card keeps all of its sessions (pi, claude), including forks, so you can move between worktrees and come back to any conversation later, even after its pane or workspace is gone.

Non goals for now: auto dispatch or pipelines, multi machine, Jira integration.

## Data model

SQLite at `~/.local/share/herdr-deck/deck.db` (WAL, `busy_timeout` 5000, foreign keys on), shared by the watcher and the TUI.

| Table | Columns |
|---|---|
| `cards` | `id`, `title`, `description`, `status` (`todo`, `active`, `blocked`, `done`), `blocked_reason`, `created_at`, `updated_at`, `archived_at` |
| `spaces` | `id`, `card_id`, `kind` (`worktree`, `checkout`), `repo_root`, `path` (absolute, unique per card), `branch`, `label`, `workspace_id` (last known), `created_at`, `removed_at` (worktree deleted on Done), `pr_number`, `pr_state`, `pr_url` |
| `sessions` | `id`, `card_id` (null = inbox), `space_id`, `harness` (`pi`, `claude`), `ref_kind` (`path`, `id`), `ref` (unique with harness), `cwd`, `title`, `parent_id`, `pane_id` (null when closed), `workspace_id`, `agent_status`, `first_seen`, `last_seen`, `closed_at`, `ignored`, `subagents` (running async pi-subagents) |
| `launches` | `pane_id`, `card_id`, `space_id`, `parent_session_id`, `created_at`: sessions the deck started and is waiting to see |

A session is open when it has a `pane_id` and no `closed_at`. It counts as working when it is open and its `agent_status` is `working` or `subagents > 0` (`isWorking` in `model.ts`).

## Card status

The board is a kanban with one column per stored status: Todo, In progress, Blocked, Done. A card becomes In progress automatically when its first session is filed. `H` and `L` move a card to the previous or next column (moving into Blocked asks for a reason).

Live agent state is shown on top of that, not as a column:

| Mark | Meaning |
|---|---|
| `◆` red, "needs you" | an open session of the card is `blocked` (the agent asked something). These cards sort to the top of their column and are counted in the header. |
| `●` green | a session is `working`, or a pi session has a background subagent running |
| `●` blue | a session is open and idle |

Card states for the status art, in sort order: needs you, error (a space folder is missing), working, warning (blocked by hand, or In progress with nothing open for 3 days), open, parked (sessions, none open), not started, done. A card that is not done but has a merged PR on one of its spaces shows `PR #N merged · d moves it to Done`.

`Enter` on a card opens the card page: status, description, then every space with its sessions as a tree (forks indented under their parent), the space state (`open`, `closed`, `deleted`) and its PR state.

### Swimlanes by repo

`v` switches between swimlanes and plain columns, and the choice is saved in `~/.local/share/herdr-deck/ui.json` so the deck reopens in the last view (swimlanes by default).

- Each repo is a horizontal lane across the same four columns, like epics on a Jira board. A card belongs to the repo of the space its latest session used, else its most recently created space. Cards without a space go to a last "No repo" lane.
- Lane header: repo name and path, card count, and how many need you or are working. Lanes with a card that needs you or has an error come first, then by latest activity.
- `j` `k` move down a column and continue into the next lane; `h` `l` change column and stay in the same lane when it has a card there.
- Each lane shows at most 3 Done cards, with "+N more done" for the rest (the plain columns view lists them all).

## How sessions are captured

herdr reports agent conversations per pane: the pi and claude integrations (`herdr integration install pi`, `herdr integration install claude`) call `pane.report_agent_session`, and every `pane.updated` event carries `agent_session` (`{agent, kind, value}`) and `agent_status`.

`deck watch` is a small background process:

1. On start it reconciles with `pane.list`: every pane with an `agent_session` is upserted, and open sessions whose pane is gone are marked closed.
2. It subscribes to `pane.created`, `pane.updated`, `pane.closed`, `pane.exited`, `pane.agent_detected`, `workspace.closed` and keeps sessions in sync. If the subscription drops it reconciles again and resubscribes after 3s.
3. A session seen for the first time is first checked for its owner: panes the deck opens carry `DECK_DATA_DIR` and `DECK_CARD_ID` in their environment (read from `/proc/<shell pid>/environ` via `pane.process_info`, so Linux only), and workspaces it opens carry a `deck_data` metadata token. A pane owned by another deck data dir (a test or demo instance) is ignored. Then it is filed by, in order:
   1. a pending `launch` for that pane (the deck started it, so it knows the card, space and parent);
   2. the parent session, when the new one is a pi fork (its session file header has `parentSession`);
   3. the pane's `DECK_CARD_ID`, for example an agent started by hand in a deck tab or its CLI pane;
   4. the previous session in the same pane (for example a claude resume in that pane);
   5. the pane's workspace, if it is the recorded workspace of exactly one card's space (only cards that are not done count here and in the next step);
   6. the pane's cwd, by longest matching space path, if that path belongs to exactly one card;
   7. otherwise the Inbox, where one key files it to a card.
4. Titles come from the first user message in the session file (pi `~/.pi/agent/sessions/**.jsonl`, claude `~/.claude/projects/*/<id>.jsonl`).

Every filing is logged to `watch.log` as `session #N <harness> <ref> -> card #M (<how>)`.

The watcher also:

- counts running async pi-subagents per pi session from `<pi-subagents temp root>/async-subagent-runs/*/status.json` (state `running` or `queued` with a live pid), on any change in that folder (recursive `fs.watch`, debounced 1s) and once a minute;
- publishes a `card` metadata token on every workspace that holds a space of a card that is not done, for example `#16 · in progress`, `#6 · working` or `#14 · needs you` (several cards on one workspace are listed side by side), every 5s when it changed; herdr shows it through `$card` in `ui.sidebar.spaces`;
- looks up the pull request of each space's branch every 5 minutes with `gh pr list --head <branch> --state all` (default branches are skipped) and stores its number, state and url on the space.

The watcher is started by the plugin's `[[startup]]` hook and by the TUI if it is not running (pid file `~/.local/share/herdr-deck/watch.pid`).

## Opening and resuming

Work only happens on cards that are In progress or Blocked. Opening, resuming or forking a session, and starting a new one (`o`, `Enter`, `f`, `s`, `Enter` on a space), first checks the card: if it is in Todo or Done, a picker asks to move it to In progress or Blocked (Blocked asks for a reason), and nothing opens until one is chosen. `Esc` leaves the card where it is.

`Enter` on a session:

1. Pane still alive with the same session: focus its workspace and pane.
2. Otherwise: make sure the space has an open workspace, start the harness with its resume flag in a tab and focus it (see "Tabs" under Creating things).
   - pi: `pi --session <path>`
   - claude: `claude --resume <id>`
3. If the space path no longer exists, say so and do nothing. If the space was deleted on Done, say so and name the kept branch.

`f` forks instead: pi `--fork <path>`, claude `--resume <id> --fork-session`. The new session is recorded as a child.

## Finishing a card

Moving a card to Done (`d`, `L` into Done, ...) runs two steps:

1. Open sessions: offers to close them gracefully (`/quit` for pi, `/exit` for claude); agents that do not exit within 10s can be force-closed.
2. Worktrees: for each of the card's worktree spaces it checks the folder, uncommitted changes (`git status --porcelain`), commits not on any remote (`git rev-list HEAD --not --remotes`), whether the branch has an upstream, and sessions still open inside it, then asks to delete it.
   - With uncommitted changes, unpushed commits or open sessions the dialog is marked careful, lists each warning, and only `y` confirms (Enter does not).
   - Deleting closes the sessions in it, closes its herdr workspace when every pane in it is inside the worktree (otherwise only those panes), runs `git worktree remove` (`--force` only when you accepted the uncommitted warning), prunes, and marks the space `deleted` (`spaces.removed_at`). The branch is always kept.
   - The result is stated: `worktree deleted, workspace closed (branch kept)`, `no worktree was created for this card, nothing to clean up` for cards with only checkouts or no space, or `its worktree was already deleted`.

A deleted space stays on the card page marked `deleted`.

## Creating things

- New card (`n`): one form with every field on one screen, submitted once with `ctrl+s` (or Enter on the button):
  - Title (required) and Description (typed inline, or `ctrl+e` for `$EDITOR` and multiple lines).
  - Repo: defaults to the repo of the focused pane, else the repo of the most recently created space. Enter or typing opens a fuzzy picker; backspace clears it (card only).
  - Where: `main checkout` (default), `new worktree`, or `no space`.
  - Start session: the default harness first, the other harness, or `no session`. Move to: `In progress` (default) or `Blocked` (asks for a reason on create), shown only when a session will start; a card without a session stays in Todo. Send brief: `no` (default, intentionally) or `yes`, changed with `←` `→` or space.
  - Creating with a session closes the deck and focuses the new agent; otherwise the card page opens.
- New space (`w`): pick a repo from the configured roots, then `checkout` (default) or `worktree`. Afterwards it offers to start a session there.
  - worktree: `herdr worktree create` with branch `<branchPrefix><card id>-<slug>`. If `worktreeDir` is absolute (or starts with `~` or `$HOME`) it is one shared root for all repos and the worktree goes to `<worktreeDir>/<repo>/<card id>-<slug>`; that folder is hidden from the repo picker. If it is relative it goes to `<repo>/<worktreeDir>/<card id>-<slug>` and `<worktreeDir>/` is added to `.git/info/exclude`. An existing folder is reopened, an existing branch gets `git worktree add`.
- New session (`s`): pick a space and a harness, it opens a tab in the space's workspace, starts the agent (`agent.start` with a `deck-<card id>-<base36 time>` name) and offers to send the card brief (`Task #<id>: <title>` plus the description) as the first prompt.
- Brief: sent through `agent.prompt` only after `agent.wait` sees the agent settle on `idle`, `done` or `blocked` (up to 60s, retrying while herdr does not know the agent name yet; `agent.start` can return before the agent is detected). If the agent is blocked at a question, is not ready in time, or the prompt fails, the session is still recorded and focused, and the deck stays open with `<harness> started, but the brief was not sent: <reason>`.
- Workspaces: the space's recorded workspace if it is still open; else a herdr workspace whose git checkout is exactly the space path; else a workspace the deck owns (recorded on a space or tagged `deck_data`) with a pane in that folder; else `herdr worktree open` (with the main checkout as `cwd`, which herdr requires) for worktrees and for checkouts at a repo root, so they join herdr's repo tree (the main checkout is the parent, linked worktrees nest under it); else `workspace.create`. Your own workspaces are never reused just because a pane sits in the same folder. Every workspace the deck opens or adopts is tagged with the `deck_data` token.
- Tabs: when the space's workspace still has only its untouched first pane (a fresh workspace), the session runs there: the tab is renamed to the tab title, and once the agent is up the tab is split with a shell on the right in the same folder for CLI work. Any later session in that workspace gets a tab of its own, without the split. The tab title is `#<id> :: <harness> :: <card title>`, with ` :: resume` or ` :: fork` appended for those actions (for example `#42 :: pi :: Fix login bug :: fork`); the card title is whitespace-collapsed and not truncated. It is set once when the tab is created or reused and never renamed afterwards. The split happens after the agent starts because herdr refuses to start an agent in a pane that was just resized.

## Keys

Global (herdr `config.toml`, each bound to a `herdr-deck.<action>` plugin action from `herdr-plugin.toml`):

| Key | Action |
|---|---|
| `ctrl+k` | open the deck |
| `prefix+shift+s` | new session for the card of the focused workspace |
| `prefix+shift+a` | file the focused pane's session under a card |
| `prefix+shift+f` | open the deck on the focused pane's card |

Inside the deck:

| Key | Action |
|---|---|
| `h` `l` / arrows | board: move between columns |
| `j` `k` / arrows | move between cards, or between spaces and sessions on the card page |
| `Enter` | board: open the card page. Card page: on a session focus or resume it, on a space start a session there |
| `Esc` | back (card page to board, board quits) |
| `o` | open the card's latest session: the most recently seen open one is focused, otherwise the most recent closed one is resumed |
| `H` `L` | move the card to the previous or next column |
| `n` | new card |
| `w` | new space for the card |
| `s` | new session for the card |
| `f` | fork the selected session |
| `m` | move the selected session to another card, or file an inbox session |
| `e` | edit title and description |
| `t` `p` `b` `d` | set todo, in progress, blocked (asks for reason), done |
| `x` | archive card, or ignore an inbox session |
| `i` | Inbox |
| `/` | filter |
| `v` | toggle swimlanes by repo / plain columns (remembered) |
| `?` | Keys page: the herdr keybindings from `config.toml` plus every deck key |
| `q` | quit |

Every view ends with a key bar listing the keys that apply to the current selection, so nothing has to be memorized. Confirm dialogs take `y` / Enter for yes and `n` / Esc for no; careful dialogs accept only `y`.

## Config

`~/.config/herdr-deck/config.json` (optional, defaults in brackets):

```json
{
  "roots": ["~/projects", "~/apollo"],
  "branchPrefix": "farhad/",
  "worktreeDir": "~/projects/worktrees",
  "defaultHarness": "pi"
}
```

| Key | Purpose |
|---|---|
| `roots` [`["~/projects"]`] | folders whose subfolders are offered as repos |
| `branchPrefix` [`""`] | prefix for new worktree branches |
| `worktreeDir` [`.worktrees`] | absolute (or `~`/`$HOME`): shared root `<worktreeDir>/<repo>/<id>-<slug>`; relative: inside each repo, added to `.git/info/exclude` |
| `defaultHarness` [`pi`] | `pi` or `claude`, listed first when starting a session |

## Known gaps

- `handlePane` skips an event for a pane whose new session is still being filed, so a status change in that window waits for the next event.
- A failed pane owner lookup (`paneOwner`) is cached until the pane closes.
- The "commits not on any remote" check warns after a squash merge whose remote branch was deleted, even when the PR is merged.
- If `gh` is missing, every PR poll fails and logs an error instead of being skipped.
- Owner detection by environment needs `/proc`, so on macOS it falls back to the `deck_data` workspace token.

## Later

Handoff summaries of earlier sessions, Jira links, deleting merged branches, codex support, search inside session text.
