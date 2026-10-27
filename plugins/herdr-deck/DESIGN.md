# herdr-deck design

herdr-deck is a task tracker for herdr that owns your agent sessions. A card is a task. A card has spaces (a git worktree or a checkout) and every agent session you run for it, across worktrees, panes and days. It never starts work by itself, it records and reopens what you start. It is a separate plugin from herdr-board and shares nothing with it.

## Goals

1. Find what you are on at a glance: needs you, in progress, blocked, todo, done.
2. Every card knows its spaces (repo, worktree path, branch, herdr workspace).
3. Every card keeps all of its sessions (pi, claude), including forks, so you can move between worktrees and come back to any conversation later, even after its pane or workspace is gone.

Non goals for v1: auto dispatch or pipelines, multi machine, Jira or PR integration, sidebar metadata.

## Data model

SQLite at `~/.local/share/herdr-deck/deck.db` (WAL, shared by the watcher and the TUI).

| Table | Columns |
|---|---|
| `cards` | `id`, `title`, `description`, `status` (`todo`, `active`, `blocked`, `done`), `blocked_reason`, `created_at`, `updated_at`, `archived_at` |
| `spaces` | `id`, `card_id`, `kind` (`worktree`, `checkout`), `repo_root`, `path` (absolute), `branch`, `label`, `workspace_id` (last known), `created_at` |
| `sessions` | `id`, `card_id` (null = inbox), `space_id`, `harness` (`pi`, `claude`), `ref_kind` (`path`, `id`), `ref` (unique with harness), `cwd`, `title`, `parent_id`, `pane_id` (null when closed), `workspace_id`, `agent_status`, `first_seen`, `last_seen`, `closed_at`, `ignored` |
| `launches` | `pane_id`, `card_id`, `space_id`, `parent_session_id`, `created_at`: sessions the deck started and is waiting to see |

All paths are stored absolute. `~` is expanded on input and never written.

## Card status

Stored status is what you set. The displayed group adds live agent state on top:

The board is a kanban with one column per stored status: Todo, In progress, Blocked, Done. A card becomes In progress automatically when its first session is filed. `H` and `L` move a card to the previous or next column (moving into Blocked asks for a reason).

Live agent state is shown on top of that, not as a column:

| Mark | Meaning |
|---|---|
| `◆` red, "needs you" | an open session of the card is `blocked` (the agent asked something). These cards sort to the top of their column and are counted in the header. |
| `●` green | a session is `working` |
| `●` blue | a session is open and idle |

`Enter` on a card opens the card page: status, description, then every space with its sessions as a tree (forks indented under their parent).

### Swimlanes by repo

`v` switches between swimlanes and plain columns, and the choice is saved in `~/.local/share/herdr-deck/ui.json` so the deck reopens in the last view (swimlanes by default).

- Each repo is a horizontal lane across the same four columns, like epics on a Jira board. A card belongs to the repo of the space its latest session used, else its most recently created space. Cards without a space go to a last "No repo" lane.
- Lane header: repo name and path, card count, and how many need you or are working. Lanes with a card that needs you or has an error come first, then by latest activity.
- `j` `k` move down a column and continue into the next lane; `h` `l` change column and stay in the same lane when it has a card there.
- Each lane shows at most 3 Done cards, with "+N more done" for the rest (the plain columns view lists them all).

## How sessions are captured

herdr reports agent conversations per pane: the pi and claude integrations call `pane.report_agent_session`, and every `pane.updated` event carries `agent_session` (`{agent, kind, value}`) and `agent_status`.

`deck watch` is a small background process:

1. On start it reconciles with `pane.list`: every pane with an `agent_session` is upserted, and open sessions whose pane is gone are marked closed.
2. It subscribes to `pane.created`, `pane.updated`, `pane.closed`, `workspace.closed` and keeps sessions in sync.
3. A session seen for the first time is filed by, in order:
   1. a pending `launch` for that pane (the deck started it, so it knows the card, space and parent);
   2. the previous session in the same pane, when the new one is a pi fork (its session file header has `parentSession`) or a claude resume in that pane;
   3. the pane's workspace, if it is the recorded workspace of exactly one card's space;
   4. the pane's cwd, by longest matching space path, if that path belongs to exactly one card;
   5. otherwise the Inbox, where one key files it to a card.
4. Titles come from the first user message in the session file (pi `~/.pi/agent/sessions/**.jsonl`, claude `~/.claude/projects/*/<id>.jsonl`).

The watcher is started by the plugin's `[[startup]]` hook and by the TUI if it is not running (pid file `~/.local/share/herdr-deck/watch.pid`).

## Opening and resuming

Work only happens on cards that are In progress or Blocked. Opening, resuming or forking a session, and starting a new one (`o`, `Enter`, `f`, `s`, `Enter` on a space), first checks the card: if it is in Todo or Done, a picker asks to move it to In progress or Blocked (Blocked asks for a reason), and nothing opens until one is chosen. `Esc` leaves the card where it is.

`Enter` on a session:

1. Pane still alive with the same session: focus its workspace and pane.
2. Otherwise: make sure the space has an open workspace (reuse the recorded one if alive, else `herdr worktree open` for a worktree or `workspace.create` for a checkout), create a new tab in it, start the harness with its resume flag and focus it.
   - pi: `pi --session <path>`
   - claude: `claude --resume <id>`
3. If the space path no longer exists, say so and do nothing.

`f` forks instead: pi `--fork <path>`, claude `--resume <id> --fork-session`. The new session is recorded as a child.

## Creating things

- New card (`n`): one form with every field on one screen, submitted once with `ctrl+s` (or Enter on the button):
  - Title (required) and Description (typed inline, or `ctrl+e` for `$EDITOR` and multiple lines).
  - Repo: defaults to the repo of the focused pane, else the repo of the most recently created space. Enter or typing opens a fuzzy picker; backspace clears it (card only).
  - Where: `main checkout` (default), `new worktree`, or `no space`.
  - Start session: the default harness first, the other harness, or `no session`. Move to: `In progress` (default) or `Blocked` (asks for a reason on create), shown only when a session will start; a card without a session stays in Todo. Send brief: `no` (default) or `yes`.
  - Creating with a session closes the deck and focuses the new agent; otherwise the card page opens.
- New space (`w`): pick a repo from the configured roots, then `checkout` (default) or `worktree`. Afterwards it offers to start a session there.
  - worktree: `herdr worktree create` with branch `<branchPrefix><card id>-<slug>` at `<repo>/<worktreeDir>/<card id>-<slug>`, and `<worktreeDir>/` added to `.git/info/exclude`.
- New session (`s`): pick a space and a harness, it opens a tab in the space's workspace, starts the agent and offers to send the card brief (title and description) as the first prompt.

## Keys

Global (herdr `config.toml`):

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

Every view ends with a key bar listing the keys that apply to the current selection, so nothing has to be memorized.

## Config

Optional `~/.config/herdr-deck/config.json`:

```json
{
  "roots": ["~/projects", "~/apollo"],
  "branchPrefix": "farhad/",
  "worktreeDir": ".worktrees",
  "defaultHarness": "pi"
}
```

## Layout

```text
plugins/herdr-deck/
├── herdr-plugin.toml      actions, popup pane, startup hook
├── bin/deck               bun launcher
├── bin/action.sh          turns an action plus herdr context into a popup
└── src/
    ├── cli.ts             subcommands: tui, watch, ensure-watch, list, doctor
    ├── config.ts
    ├── db.ts
    ├── herdr.ts           socket client: requests and event stream
    ├── watcher.ts
    ├── sessions.ts        titles, resume and fork arguments
    ├── actions.ts         create card, space, session, open, fork
    └── tui/               terminal, widgets, app
```

TypeScript on Bun, no npm dependencies (`bun:sqlite`, raw ANSI terminal UI).

## Later

Sidebar metadata per workspace, handoff summaries of earlier sessions, Jira and PR links, cleanup of a done card's worktrees (refusing on unpushed work), codex support, search inside session text.
