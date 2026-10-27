import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { dataDir, ensureDataDir, loadConfig, worktreePath, type Harness } from "../config";
import { db, type Card, type CardStatus, type Session, type Space } from "../db";
import {
  addCheckoutSpace,
  addWorktreeSpace,
  cardForWorkspace,
  closeSessionGracefully,
  forceCloseSession,
  forkSession,
  listRepos,
  newCard,
  openSession,
  preferredSpace,
  sessionForPane,
  startSession,
  type Repo,
} from "../actions";
import { ago, isOpen, latestSession, liveMark, needsYou, shortPath, spaceBlocks, type SessionNode } from "../model";
import { HARNESSES } from "../sessions";
import { Terminal, line, pad, textWidth, truncate, type Key, type Part, type Style } from "./term";
import { NewCardForm, type FormAction, type NewCardValues } from "./form";
import { ART_HEIGHT, ART_WIDTH, QUIET_STATES, STATE_COLOR, animated, art, type CardState } from "./art";
import { watcherPid } from "../watcher";

interface Context {
  workspace_id?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  workspace_cwd?: string;
}

type Mode = "open" | "new-session" | "assign" | "goto";
type View = "board" | "card" | "inbox" | "keys";

interface PickItem<T> {
  label: string;
  hint?: string;
  value: T;
}

type Overlay =
  | { type: "prompt"; label: string; value: string; onDone: (v: string | null) => void }
  | { type: "picker"; title: string; items: PickItem<unknown>[]; filter: string; index: number; onDone: (v: unknown) => void }
  | { type: "confirm"; text: string; onDone: (ok: boolean) => void }
  | { type: "form"; title: string; form: NewCardForm };

interface Column {
  status: CardStatus;
  label: string;
  style: Style;
}

const COLUMNS: Column[] = [
  { status: "todo", label: "TODO", style: "title" },
  { status: "active", label: "IN PROGRESS", style: "green" },
  { status: "blocked", label: "BLOCKED", style: "yellow" },
  { status: "done", label: "DONE", style: "dim" },
];

const STATUS_LABEL: Record<CardStatus, string> = { todo: "Todo", active: "In progress", blocked: "Blocked", done: "Done" };

interface Lane {
  key: string;
  name: string;
  path: string;
  cards: CardData[];
  doneHidden: number;
}

type Grouping = "repo" | "none";

const DONE_PER_LANE = 3;

const uiFile = join(dataDir, "ui.json");

function loadGrouping(): Grouping {
  try {
    const raw = JSON.parse(readFileSync(uiFile, "utf8")) as { grouping?: string };
    return raw.grouping === "none" ? "none" : "repo";
  } catch {
    return "repo";
  }
}

function saveGrouping(grouping: Grouping): void {
  try {
    ensureDataDir();
    writeFileSync(uiFile, JSON.stringify({ grouping }));
  } catch (err) {
    process.stderr.write(`deck: cannot save view: ${(err as Error).message}\n`);
  }
}

function laneOf(sessions: Session[], spaces: Space[]): { key: string; name: string; path: string } {
  if (!spaces.length) return { key: "", name: "No repo", path: "" };
  const recent = [...sessions].filter((s) => s.space_id !== null).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  const used = recent.map((s) => spaces.find((sp) => sp.id === s.space_id)).find(Boolean);
  const space = used ?? [...spaces].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
  return { key: space.repo_root, name: basename(space.repo_root), path: space.repo_root };
}

interface CardData {
  card: Card;
  sessions: Session[];
  spaces: Space[];
  needs: boolean;
  lane: string;
  state: CardState;
  alert: string | null;
  latest: Session | null;
}

const STALE_DAYS = 3;

const DEMO = process.env.DECK_DEMO === "1";

const STATE_RANK: Record<CardState, number> = { needs: 0, error: 1, working: 2, warning: 3, open: 4, parked: 5, new: 6, done: 7 };

function daysSince(sqlTime: string): number {
  const t = Date.parse(`${sqlTime.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 86400000;
}

function cardState(card: Card, sessions: Session[], spaces: Space[]): { state: CardState; alert: string | null } {
  const open = sessions.filter(isOpen);
  if (card.status !== "done" && open.some((s) => s.agent_status === "blocked")) return { state: "needs", alert: "waiting for you" };
  const missing = card.status === "done" ? [] : spaces.filter((s) => !existsSync(s.path));
  if (missing.length) return { state: "error", alert: `space missing: ${missing.map((s) => s.label).join(", ")}` };
  if (open.some((s) => s.agent_status === "working")) return { state: "working", alert: null };
  if (card.status === "blocked") return { state: "warning", alert: card.blocked_reason ? `blocked: ${card.blocked_reason}` : "blocked" };
  if (card.status === "active" && !open.length && daysSince(card.updated_at) >= STALE_DAYS) {
    return { state: "warning", alert: `stale: no activity for ${Math.floor(daysSince(card.updated_at))}d` };
  }
  if (open.length) return { state: "open", alert: null };
  if (card.status === "done") return { state: "done", alert: null };
  if (sessions.length) return { state: "parked", alert: null };
  return { state: "new", alert: null };
}

function lastActivity(item: CardData): string {
  const times = item.sessions.map((s) => s.last_seen).sort((a, b) => a.localeCompare(b));
  return ago(times.pop() ?? item.card.updated_at);
}

type DetailRow =
  | { kind: "space"; space: Space | null; count: number }
  | { kind: "session"; node: SessionNode; space: Space | null }
  | { kind: "note"; text: string };

type Hint = [string, string];

const KEY_SECTIONS: { title: string; keys: Hint[] }[] = [
  {
    title: "Board",
    keys: [
      ["h l ← →", "move between columns"],
      ["j k ↑ ↓", "move between cards"],
      ["enter", "open the card page"],
      ["o", "open the card's latest session: focus it if open, otherwise resume it"],
      ["H L", "move the card to the previous or next column"],
      ["n", "new card"],
      ["s", "new session for the card"],
      ["w", "new space (worktree or checkout) for the card"],
      ["e", "edit title and description"],
      ["t p b d", "set todo, in progress, blocked, done"],
      ["x", "archive the card"],
      ["i", "inbox: sessions not filed under a card"],
      ["/", "filter cards"],
      ["v", "switch view: swimlanes by repo, or plain columns"],
      ["?", "this page"],
      ["q esc", "quit"],
    ],
  },
  {
    title: "Card page",
    keys: [
      ["j k ↑ ↓", "move between spaces and sessions"],
      ["enter", "on a session: focus it, or resume it if closed. On a space: new session there"],
      ["o", "open the card's latest session"],
      ["f", "fork the selected session"],
      ["m", "move the selected session to another card"],
      ["s", "new session"],
      ["w", "new space"],
      ["e", "edit title and description"],
      ["H L", "move the card to the previous or next column"],
      ["t p b d", "set todo, in progress, blocked, done"],
      ["esc", "back to the board"],
    ],
  },
  {
    title: "Inbox",
    keys: [
      ["j k ↑ ↓", "move"],
      ["enter m", "file the session under a card"],
      ["x", "ignore the session"],
      ["esc", "back"],
    ],
  },
  {
    title: "Pickers and prompts",
    keys: [
      ["type", "filter"],
      ["↑ ↓ tab", "move"],
      ["enter", "pick"],
      ["ctrl+u", "clear"],
      ["esc", "cancel"],
    ],
  },
];

function herdrKeys(): Hint[] {
  const path = process.env.HERDR_CONFIG_PATH || join(homedir(), ".config", "herdr", "config.toml");
  if (!existsSync(path)) return [];
  try {
    const doc = Bun.TOML.parse(readFileSync(path, "utf8")) as { keys?: { command?: { key?: string; description?: string; command?: string }[] } };
    return (doc.keys?.command ?? [])
      .filter((k) => k.key)
      .map((k) => [k.key as string, k.description || k.command || ""] as Hint);
  } catch {
    return [];
  }
}

function harnessStyle(h: string): Style {
  return h === "claude" ? "magenta" : "cyan";
}

function statusStyle(s: Session): { mark: string; style: Style; text: string } {
  if (!isOpen(s)) return { mark: "○", style: "dim", text: "closed" };
  if (s.agent_status === "blocked") return { mark: "◆", style: "red", text: "needs you" };
  if (s.agent_status === "working") return { mark: "●", style: "green", text: "working" };
  return { mark: "●", style: "blue", text: s.agent_status ?? "open" };
}

function wrap(text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let rest = raw.trimEnd();
    if (!rest) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    while (rest.length) {
      if (textWidth(rest) <= width) {
        out.push(rest);
        break;
      }
      let cut = rest.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (out.length >= maxLines) break;
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  if (out.length > maxLines) return [...out.slice(0, maxLines - 1), `${truncate(out[maxLines - 1], width - 1)}…`];
  return out;
}

export class App {
  private term = new Terminal();
  private view: View = "board";
  private backTo: View = "board";
  private data: CardData[] = [];
  private byStatus = new Map<CardStatus, CardData[]>();
  private col = 1;
  private grouping: Grouping = loadGrouping();
  private lanes: Lane[] = [];
  private boardScroll = 0;
  private rowInCol = [0, 0, 0, 0];
  private colScroll = [0, 0, 0, 0];
  private selectedId: number | null = null;
  private cardId: number | null = null;
  private detail: DetailRow[] = [];
  private dCursor = 0;
  private dScroll = 0;
  private inbox: Session[] = [];
  private iCursor = 0;
  private keysScroll = 0;
  private filter = "";
  private overlay: Overlay | null = null;
  private toast: { text: string; error: boolean; at: number } | null = null;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private resolveExit: (() => void) | null = null;
  private animTimer: ReturnType<typeof setInterval> | null = null;
  private watcherUp = true;

  constructor(private mode: Mode, private ctx: Context) {}

  async run(): Promise<void> {
    this.reload();
    if (!this.columnCards(this.col).length) {
      const first = COLUMNS.findIndex((_, i) => this.columnCards(i).length > 0);
      if (first >= 0) {
        this.col = first;
        this.selectedId = this.selectedCard()?.card.id ?? null;
      }
    }
    this.term.start(
      (k) => this.onKey(k),
      () => this.render(),
    );
    this.timer = setInterval(() => {
      if (!this.busy && !this.overlay) {
        this.reload();
        this.render();
      }
    }, 1500);
    this.animTimer = setInterval(() => {
      if (this.busy || this.overlay || (this.view !== "board" && this.view !== "card")) return;
      const visible = this.view === "card" ? this.data.filter((x) => x.card.id === this.cardId) : this.data;
      if (visible.some((x) => animated(x.state))) this.render();
    }, 125);
    this.render();
    this.startMode();
    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  private quit(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.animTimer) clearInterval(this.animTimer);
    this.term.stop();
    this.resolveExit?.();
  }

  private say(text: string, error = false): void {
    this.toast = { text, error, at: Date.now() };
    this.render();
  }

  private startMode(): void {
    if (this.mode === "goto") {
      const card = cardForWorkspace(this.ctx.workspace_id, this.ctx.focused_pane_cwd) ?? this.cardOfPaneSession();
      if (card) this.openCard(card.id);
      else this.say("this pane is not part of any card", true);
      return;
    }
    if (this.mode === "assign") {
      const session = sessionForPane(this.ctx.focused_pane_id);
      if (!session) return this.say("no pi or claude session is running in the focused pane", true);
      this.fileSession(session, true);
      return;
    }
    if (this.mode === "new-session") {
      const card = cardForWorkspace(this.ctx.workspace_id, this.ctx.focused_pane_cwd) ?? this.cardOfPaneSession();
      if (card) {
        this.openCard(card.id);
        this.newSessionFlow(card, this.spaceForContext(card));
      } else {
        this.pickCard("New session for which card?", (c) => c && this.newSessionFlow(c, null));
      }
    }
  }

  private cardOfPaneSession(): Card | null {
    const s = sessionForPane(this.ctx.focused_pane_id);
    return s?.card_id ? db().card(s.card_id) : null;
  }

  private spaceForContext(card: Card): Space | null {
    const cwd = this.ctx.focused_pane_cwd;
    const spaces = db().spaces(card.id);
    if (cwd) {
      const match = spaces
        .filter((s) => cwd === s.path || cwd.startsWith(`${s.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (match) return match;
    }
    const byWs = spaces.filter((s) => s.workspace_id && s.workspace_id === this.ctx.workspace_id);
    return byWs.length === 1 ? byWs[0] : null;
  }

  private reload(): void {
    const d = db();
    const f = this.filter.toLowerCase();
    const laneInfo = new Map<string, { key: string; name: string; path: string }>();
    this.data = d
      .cards()
      .filter((c) => !f || `#${c.id} ${c.title} ${c.description}`.toLowerCase().includes(f))
      .map((card) => {
        const sessions = d.sessions(card.id);
        const spaces = d.spaces(card.id);
        const { state, alert } = cardState(card, sessions, spaces);
        const lane = laneOf(sessions, spaces);
        if (!laneInfo.has(lane.key)) laneInfo.set(lane.key, lane);
        return {
          card,
          sessions,
          spaces,
          needs: card.status !== "done" && needsYou(sessions),
          lane: lane.key,
          state,
          alert,
          latest: latestSession(sessions),
        };
      });
    this.watcherUp = DEMO || watcherPid() !== null;
    this.byStatus = new Map(COLUMNS.map((c) => [c.status, [] as CardData[]]));
    for (const item of this.data) this.byStatus.get(item.card.status)?.push(item);
    for (const list of this.byStatus.values()) {
      list.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.card.updated_at.localeCompare(a.card.updated_at) || b.card.id - a.card.id);
    }
    const done = this.byStatus.get("done");
    if (done && done.length > 50) done.length = 50;
    this.lanes = [];
    if (this.grouping === "repo") this.buildLanes(laneInfo);
    if (this.selectedId !== null) {
      const ci = COLUMNS.findIndex((c) => this.byStatus.get(c.status)?.some((x) => x.card.id === this.selectedId));
      if (ci >= 0) {
        this.col = ci;
        this.rowInCol[ci] = this.columnCards(ci).findIndex((x) => x.card.id === this.selectedId);
      }
    }
    for (let i = 0; i < COLUMNS.length; i++) {
      const n = this.columnCards(i).length;
      this.rowInCol[i] = Math.min(Math.max(0, this.rowInCol[i]), Math.max(0, n - 1));
    }
    this.selectedId = this.selectedCard()?.card.id ?? null;
    this.inbox = d.inbox();
    this.iCursor = Math.min(this.iCursor, Math.max(0, this.inbox.length - 1));
    if (this.cardId !== null) this.buildDetail();
  }

  private buildLanes(info: Map<string, { key: string; name: string; path: string }>): void {
    const byLane = new Map<string, CardData[]>();
    for (const item of this.data) {
      const list = byLane.get(item.lane) ?? [];
      list.push(item);
      byLane.set(item.lane, list);
    }
    const activity = (cards: CardData[]) =>
      cards.reduce((max, c) => {
        const t = [c.card.updated_at, ...c.sessions.map((s) => s.last_seen)].sort((a, b) => b.localeCompare(a))[0];
        return t > max ? t : max;
      }, "");
    const urgency = (cards: CardData[]) => Math.min(9, ...cards.filter((c) => c.card.status !== "done").map((c) => STATE_RANK[c.state]));
    const lanes: Lane[] = [...byLane.entries()].map(([key, cards]) => {
      const meta = info.get(key) ?? { key, name: key ? basename(key) : "No repo", path: key };
      return { ...meta, cards, doneHidden: 0 };
    });
    lanes.sort((a, b) => {
      const aNoRepo = a.key === "";
      const bNoRepo = b.key === "";
      if (aNoRepo !== bNoRepo) return aNoRepo ? 1 : -1;
      const ua = urgency(a.cards) <= 1 ? 0 : 1;
      const ub = urgency(b.cards) <= 1 ? 0 : 1;
      return ua - ub || activity(b.cards).localeCompare(activity(a.cards)) || a.name.localeCompare(b.name);
    });
    const order = new Map(lanes.map((l, i) => [l.key, i]));
    for (const [status, list] of this.byStatus) {
      list.sort((a, b) => (order.get(a.lane) ?? 0) - (order.get(b.lane) ?? 0));
      if (status !== "done") continue;
      const kept: CardData[] = [];
      const shown = new Map<string, number>();
      for (const item of list) {
        const n = shown.get(item.lane) ?? 0;
        if (n < DONE_PER_LANE) kept.push(item);
        else {
          const lane = lanes.find((l) => l.key === item.lane);
          if (lane) lane.doneHidden += 1;
        }
        shown.set(item.lane, n + 1);
      }
      list.length = 0;
      list.push(...kept);
    }
    this.lanes = lanes;
  }

  private columnCards(i: number): CardData[] {
    return this.byStatus.get(COLUMNS[i].status) ?? [];
  }

  private selectedCard(): CardData | null {
    return this.columnCards(this.col)[this.rowInCol[this.col]] ?? null;
  }

  private buildDetail(): void {
    const item = this.data.find((x) => x.card.id === this.cardId);
    const card = item?.card ?? (this.cardId !== null ? db().card(this.cardId) : null);
    if (!card) {
      this.cardId = null;
      if (this.view === "card") this.view = "board";
      return;
    }
    const sessions = item?.sessions ?? db().sessions(card.id);
    const spaces = item?.spaces ?? db().spaces(card.id);
    const prev = this.detail[this.dCursor];
    const rows: DetailRow[] = [];
    const blocks = spaceBlocks(spaces, sessions);
    if (!blocks.length) rows.push({ kind: "note", text: "no spaces or sessions yet: w adds a space, s starts a session" });
    for (const b of blocks) {
      rows.push({ kind: "space", space: b.space, count: b.sessions.length });
      for (const node of b.sessions) rows.push({ kind: "session", node, space: b.space });
    }
    this.detail = rows;
    if (prev) {
      const idx = rows.findIndex(
        (r) =>
          (r.kind === "session" && prev.kind === "session" && r.node.session.id === prev.node.session.id) ||
          (r.kind === "space" && prev.kind === "space" && (r.space?.id ?? null) === (prev.space?.id ?? null)),
      );
      if (idx >= 0) this.dCursor = idx;
    }
    this.dCursor = Math.min(Math.max(0, this.dCursor), Math.max(0, rows.length - 1));
    if (rows[this.dCursor]?.kind === "note") this.dCursor = Math.max(0, rows.findIndex((r) => r.kind !== "note"));
  }

  private openCard(id: number): void {
    this.cardId = id;
    this.selectedId = id;
    this.dCursor = 0;
    this.dScroll = 0;
    this.view = "card";
    this.reload();
    this.dCursor = Math.max(0, this.detail.findIndex((r) => r.kind === "session"));
    if (this.detail[this.dCursor]?.kind !== "session") this.dCursor = Math.max(0, this.detail.findIndex((r) => r.kind !== "note"));
    this.render();
  }

  private showKeys(): void {
    if (this.view !== "keys") this.backTo = this.view;
    this.view = "keys";
    this.keysScroll = 0;
    this.render();
  }

  private async act(label: string, fn: () => Promise<string | void>, quitAfter = false): Promise<void> {
    this.busy = true;
    this.say(`${label}…`);
    try {
      const msg = await fn();
      this.busy = false;
      this.reload();
      if (quitAfter) {
        this.quit();
        return;
      }
      this.say(msg || "done");
    } catch (err) {
      this.busy = false;
      this.reload();
      this.say((err as Error).message, true);
    }
  }

  private pick<T>(title: string, items: PickItem<T>[], onDone: (v: T | null) => void, filter = ""): void {
    this.overlay = { type: "picker", title, items, filter, index: 0, onDone: onDone as (v: unknown) => void };
    this.render();
  }

  private ask(label: string, initial: string, onDone: (v: string | null) => void): void {
    this.overlay = { type: "prompt", label, value: initial, onDone };
    this.render();
  }

  private confirm(text: string, onDone: (ok: boolean) => void): void {
    this.overlay = { type: "confirm", text, onDone };
    this.render();
  }

  private pickCard(title: string, onDone: (c: Card | null) => void, allowNew = true): void {
    const cards = db().cards().filter((c) => c.status !== "done");
    const items: PickItem<number>[] = cards.map((c) => ({ label: `#${c.id} ${c.title}`, hint: STATUS_LABEL[c.status], value: c.id }));
    if (allowNew) items.unshift({ label: "+ new card", value: -1 });
    this.pick(title, items, (id) => {
      if (id === null) return onDone(null);
      if (id === -1) {
        this.ask("Title", "", (t) => {
          if (!t?.trim()) return onDone(null);
          onDone(newCard(t, ""));
        });
        return;
      }
      onDone(db().card(id));
    });
  }

  private defaultRepo(repos: Repo[]): Repo | null {
    const cwd = this.ctx.focused_pane_cwd || this.ctx.workspace_cwd;
    if (cwd) {
      const hit = repos
        .filter((r) => cwd === r.path || cwd.startsWith(`${r.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (hit) return hit;
    }
    const recent = [...db().spaces()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
    for (const s of recent) {
      const hit = repos.find((r) => r.path === s.repo_root || s.path.startsWith(`${r.path}/`) || s.path === r.path);
      if (hit) return hit;
    }
    return null;
  }

  private newCardFlow(): void {
    const def = loadConfig().defaultHarness;
    const harnesses: Harness[] = [def, ...HARNESSES.filter((h) => h !== def)];
    const form = new NewCardForm({ repo: this.defaultRepo(listRepos()) }, harnesses);
    this.overlay = { type: "form", title: "New card", form };
    this.render();
  }

  private onFormAction(ov: Extract<Overlay, { type: "form" }>, action: FormAction): void {
    const form = ov.form;
    if (action.type === "cancel") {
      this.overlay = null;
      return this.render();
    }
    if (action.type === "edit-description") {
      const text = this.term.edit(form.values.description ? `${form.values.description}\n` : "\n", ".md");
      if (text !== null) form.setDescription(text);
      return this.render();
    }
    if (action.type === "pick-repo") {
      const repos = listRepos();
      const items: PickItem<string>[] = repos.map((r) => ({ label: r.name, hint: shortPath(r.path), value: r.path }));
      items.push({ label: "(no repo, card only)", value: "" });
      this.pick(
        "Repo for the new card",
        items,
        (path) => {
          if (path !== null) form.setRepo(repos.find((r) => r.path === path) ?? null);
          this.overlay = ov;
          this.render();
        },
        action.filter,
      );
      return;
    }
    if (action.type === "submit") {
      const err = form.validate();
      if (err) {
        form.error = err;
        return this.render();
      }
      this.overlay = null;
      this.submitNewCard(form.values);
      return;
    }
    this.render();
  }

  private submitNewCard(v: NewCardValues, blockedReason?: string): void {
    if (v.session !== "none" && v.where !== "none" && v.repo && v.startStatus === "blocked" && blockedReason === undefined) {
      return this.ask("Blocked on", "", (reason) => {
        if (reason === null) return this.say("cancelled, nothing created");
        this.submitNewCard(v, reason.trim());
      });
    }
    const card = newCard(v.title, v.description);
    this.selectedId = card.id;
    const repo = v.repo;
    if (!repo || v.where === "none") {
      this.openCard(card.id);
      return this.say(`#${card.id} created`);
    }
    const starting = v.session !== "none";
    const label = v.where === "worktree" ? "creating worktree" : "adding checkout";
    void this.act(
      starting ? `${label}, starting ${v.session}` : label,
      async () => {
        const space = v.where === "worktree" ? await addWorktreeSpace(card, repo.path) : addCheckoutSpace(card, repo.path);
        if (v.session !== "none") {
          db().updateCard(card.id, { status: v.startStatus, blocked_reason: v.startStatus === "blocked" ? blockedReason || null : null });
          await startSession({ card: db().card(card.id) ?? card, space, harness: v.session, brief: v.brief });
          return;
        }
        this.openCard(card.id);
        return `#${card.id} created in ${space.label}`;
      },
      starting,
    );
  }

  private offerSession(card: Card, space: Space): void {
    this.confirm(`Start a session in ${space.label} now?`, (ok) => {
      if (ok) this.newSessionFlow(card, space);
    });
  }

  private offerClose(card: Card): void {
    const open = db().sessions(card.id).filter(isOpen);
    if (!open.length) return;
    const working = open.filter((s) => s.agent_status === "working").length;
    const note = working ? ` (${working} still working, they will be stopped)` : "";
    this.confirm(`#${card.id} is done. Close its ${open.length} open session(s) gracefully${note}?`, (ok) => {
      if (!ok) return;
      void this.act("closing sessions", async () => {
        const results = await Promise.all(open.map((s) => closeSessionGracefully(s)));
        const stuck = open.filter((_, i) => results[i] === "still-running");
        const closed = results.filter((r) => r !== "still-running").length;
        if (stuck.length) {
          setTimeout(
            () =>
              this.confirm(`${stuck.length} session(s) did not exit within 10s. Close their panes anyway?`, (force) => {
                if (!force) return;
                void this.act("closing panes", async () => {
                  await Promise.all(stuck.map((s) => forceCloseSession(s)));
                  return `closed ${stuck.length} pane(s)`;
                });
              }),
            0,
          );
        }
        return `closed ${closed} of ${open.length} session(s)`;
      });
    });
  }

  private newSpaceFlow(card: Card, optional = false, then?: (s: Space) => void): void {
    const after = then ?? ((s: Space) => this.offerSession(card, s));
    const repos = listRepos();
    const items: PickItem<string>[] = repos.map((r) => ({ label: r.name, hint: shortPath(r.path), value: r.path }));
    if (optional) items.unshift({ label: "(no space for now)", value: "" });
    this.pick(`Repo for #${card.id} ${card.title}`, items, (path) => {
      if (!path) return;
      this.pick<"worktree" | "checkout">(
        `${basename(path)}: where should the work happen?`,
        [
          { label: "the main checkout", hint: shortPath(path), value: "checkout" },
          { label: "new git worktree", hint: shortPath(worktreePath(loadConfig(), path, `${card.id}-…`)), value: "worktree" },
        ],
        (kind) => {
          if (!kind) return;
          void this.act(kind === "worktree" ? "creating worktree" : "adding checkout", async () => {
            const space = kind === "worktree" ? await addWorktreeSpace(card, path) : addCheckoutSpace(card, path);
            setTimeout(() => after(space), 0);
            return `space added: ${space.label}${space.branch ? ` (${space.branch})` : ""}`;
          });
        },
      );
    });
  }

  private requireWorking(cardRef: Card, then: (card: Card) => void): void {
    const card = db().card(cardRef.id) ?? cardRef;
    if (card.status === "active" || card.status === "blocked") return then(card);
    const from = STATUS_LABEL[card.status];
    this.pick<CardStatus>(
      `#${card.id} is in ${from}. Move it to start working?`,
      [
        { label: "In progress", hint: "work on it now", value: "active" },
        { label: "Blocked", hint: "asks for a reason", value: "blocked" },
      ],
      (status) => {
        if (!status) return this.say(`#${card.id} stays in ${from}, nothing opened`);
        if (status === "active") {
          db().updateCard(card.id, { status: "active", blocked_reason: null });
          this.selectedId = card.id;
          this.reload();
          return then(db().card(card.id) ?? card);
        }
        this.ask("Blocked on", card.blocked_reason ?? "", (reason) => {
          if (reason === null) return this.say(`#${card.id} stays in ${from}, nothing opened`);
          db().updateCard(card.id, { status: "blocked", blocked_reason: reason.trim() || null });
          this.selectedId = card.id;
          this.reload();
          then(db().card(card.id) ?? card);
        });
      },
    );
  }

  private newSessionFlow(cardRef: Card, space: Space | null): void {
    this.requireWorking(cardRef, (card) => this.newSessionFor(card, space));
  }

  private newSessionFor(card: Card, space: Space | null): void {
    const chooseHarness = (sp: Space) => {
      const def = loadConfig().defaultHarness;
      const order: Harness[] = [def, ...HARNESSES.filter((h) => h !== def)];
      this.pick<Harness>(
        `Agent for #${card.id} in ${sp.label}`,
        order.map((h) => ({ label: h, value: h })),
        (harness) => {
          if (!harness) return;
          const go = (brief: boolean) =>
            void this.act(
              `starting ${harness}`,
              async () => {
                await startSession({ card, space: sp, harness, brief });
              },
              true,
            );
          this.confirm("Send the card title and description as the first prompt?", (ok) => go(ok));
        },
      );
    };
    if (space) return chooseHarness(space);
    const spaces = db().spaces(card.id);
    if (!spaces.length) return this.newSpaceFlow(card, false, (s) => chooseHarness(s));
    if (spaces.length === 1) return chooseHarness(spaces[0]);
    const preferred = preferredSpace(card);
    const ordered = preferred ? [preferred, ...spaces.filter((s) => s.id !== preferred.id)] : spaces;
    const items: PickItem<number>[] = ordered.map((s) => ({
      label: s.label,
      hint: `${s.kind} ${shortPath(s.path)}${preferred && s.id === preferred.id ? "  \u00b7 last used" : ""}`,
      value: s.id,
    }));
    items.push({ label: "+ new space", value: -1 });
    this.pick(`Space for the new session of #${card.id}`, items, (id) => {
      if (id === null) return;
      if (id === -1) return this.newSpaceFlow(card, false, (s) => chooseHarness(s));
      const s = db().space(id);
      if (s) chooseHarness(s);
    });
  }

  private fileSession(session: Session, quitAfter = false): void {
    this.pickCard(`File session "${session.title ?? session.ref}" under`, (card) => {
      if (!card) return;
      const spaces = db().spaces(card.id);
      const cwd = session.cwd ?? "";
      const space =
        spaces.filter((s) => cwd === s.path || cwd.startsWith(`${s.path}/`)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
      db().assignSession(session.id, card.id, space?.id ?? null);
      if (quitAfter) {
        this.quit();
        return;
      }
      this.reload();
      this.say(`filed under #${card.id} ${card.title}`);
    });
  }

  private editCard(card: Card): void {
    const text = this.term.edit(`${card.title}\n\n${card.description}\n`, ".md");
    if (text === null) return this.render();
    const [first, ...rest] = text.split("\n");
    const title = first.trim();
    if (!title) return this.say("empty title, not saved", true);
    db().updateCard(card.id, { title, description: rest.join("\n").trim() });
    this.reload();
    this.say("saved");
  }

  private setStatus(card: Card, status: CardStatus): void {
    this.selectedId = card.id;
    if (status === "blocked") {
      this.ask("Blocked on", card.blocked_reason ?? "", (reason) => {
        if (reason === null) return;
        db().updateCard(card.id, { status: "blocked", blocked_reason: reason.trim() || null });
        this.reload();
        this.say(`#${card.id} → Blocked`);
      });
      return;
    }
    db().updateCard(card.id, { status, blocked_reason: null });
    this.reload();
    this.say(`#${card.id} → ${STATUS_LABEL[status]}`);
    if (status === "done") this.offerClose(card);
  }

  private shiftCard(card: Card, delta: number): void {
    const i = COLUMNS.findIndex((c) => c.status === card.status);
    const j = Math.min(COLUMNS.length - 1, Math.max(0, i + delta));
    if (i === j) return;
    this.setStatus(card, COLUMNS[j].status);
  }

  private archive(card: Card): void {
    this.confirm(`Archive #${card.id} ${card.title}? Its sessions and worktrees stay on disk.`, (ok) => {
      if (!ok) return;
      db().updateCard(card.id, { archived_at: new Date().toISOString().replace("T", " ").slice(0, 19) });
      if (this.view === "card") this.view = "board";
      this.cardId = null;
      this.selectedId = null;
      this.reload();
      this.say("archived");
    });
  }

  private openLatest(card: Card): void {
    const sessions = this.data.find((x) => x.card.id === card.id)?.sessions ?? db().sessions(card.id);
    const s = latestSession(sessions);
    if (!s) return this.say(`#${card.id} has no sessions yet: s starts one`, true);
    this.requireWorking(card, () => void this.act(isOpen(s) ? "focusing latest session" : "resuming latest session", () => openSession(s), true));
  }

  private latestHint(card: Card): Hint[] {
    const sessions = this.data.find((x) => x.card.id === card.id)?.sessions ?? [];
    const s = latestSession(sessions);
    if (!s) return [];
    return [["o", isOpen(s) ? "focus latest session" : "resume latest session"]];
  }

  private cardCommand(ch: string, card: Card): boolean {
    if (ch === "o") this.openLatest(card);
    else if (ch === "s") this.newSessionFlow(card, this.view === "card" ? this.detailSpace() : null);
    else if (ch === "w") this.newSpaceFlow(card);
    else if (ch === "e") this.editCard(card);
    else if (ch === "t") this.setStatus(card, "todo");
    else if (ch === "p") this.setStatus(card, "active");
    else if (ch === "b") this.setStatus(card, "blocked");
    else if (ch === "d") this.setStatus(card, "done");
    else if (ch === "H") this.shiftCard(card, -1);
    else if (ch === "L") this.shiftCard(card, 1);
    else if (ch === "x") this.archive(card);
    else return false;
    return true;
  }

  private detailSpace(): Space | null {
    const r = this.detail[this.dCursor];
    if (r?.kind === "space" || r?.kind === "session") return r.space;
    return null;
  }

  private onKey(k: Key): void {
    if (k.name === "ctrl-c") return this.quit();
    if (this.overlay) return this.onOverlayKey(this.overlay, k);
    if (this.busy) return;
    const ch = k.name === "char" ? k.ch : "";
    if (ch === "q") return this.quit();
    if (ch === "?") return this.showKeys();
    if (this.view === "keys") return this.onKeysPageKey(k, ch);
    if (this.view === "inbox") return this.onInboxKey(k, ch);
    if (this.view === "card") return this.onCardPageKey(k, ch);
    return this.onBoardKey(k, ch);
  }

  private switchColumn(delta: number): void {
    const lane = this.selectedCard()?.lane;
    this.col = Math.min(COLUMNS.length - 1, Math.max(0, this.col + delta));
    if (this.grouping !== "repo" || lane === undefined) return;
    const idx = this.columnCards(this.col).findIndex((x) => x.lane === lane);
    if (idx >= 0) this.rowInCol[this.col] = idx;
  }

  private onBoardKey(k: Key, ch: string): void {
    const n = this.columnCards(this.col).length;
    if (k.name === "left" || ch === "h") this.switchColumn(-1);
    else if (k.name === "right" || ch === "l") this.switchColumn(1);
    else if (ch === "v") {
      this.grouping = this.grouping === "repo" ? "none" : "repo";
      saveGrouping(this.grouping);
      this.boardScroll = 0;
      this.reload();
      this.say(this.grouping === "repo" ? "grouped by repo" : "plain columns");
      return;
    }
    else if (k.name === "down" || ch === "j") this.rowInCol[this.col] = Math.min(Math.max(0, n - 1), this.rowInCol[this.col] + 1);
    else if (k.name === "up" || ch === "k") this.rowInCol[this.col] = Math.max(0, this.rowInCol[this.col] - 1);
    else if (k.name === "home" || ch === "g") this.rowInCol[this.col] = 0;
    else if (k.name === "end" || ch === "G") this.rowInCol[this.col] = Math.max(0, n - 1);
    else if (k.name === "enter") {
      const sel = this.selectedCard();
      if (sel) return this.openCard(sel.card.id);
      return;
    } else if (k.name === "esc") {
      if (this.filter) {
        this.filter = "";
        this.reload();
      } else return this.quit();
    } else if (ch === "n") return this.newCardFlow();
    else if (ch === "i") {
      this.backTo = "board";
      this.view = "inbox";
    } else if (ch === "r") {
      this.reload();
      return this.say("refreshed");
    } else if (ch === "/") {
      return this.ask("Filter cards", this.filter, (v) => {
        if (v === null) return;
        this.filter = v.trim();
        this.reload();
      });
    } else {
      const sel = this.selectedCard();
      if (sel && this.cardCommand(ch, sel.card)) return;
    }
    this.selectedId = this.selectedCard()?.card.id ?? null;
    this.render();
  }

  private onCardPageKey(k: Key, ch: string): void {
    const card = this.cardId !== null ? db().card(this.cardId) : null;
    if (!card) {
      this.view = "board";
      return this.render();
    }
    const row = this.detail[this.dCursor];
    const step = (delta: number) => {
      let i = this.dCursor;
      for (let n = 0; n < this.detail.length; n++) {
        i = Math.min(this.detail.length - 1, Math.max(0, i + delta));
        if (this.detail[i].kind !== "note") break;
      }
      if (this.detail[i]?.kind !== "note") this.dCursor = i;
    };
    if (k.name === "down" || ch === "j") step(1);
    else if (k.name === "up" || ch === "k") step(-1);
    else if (k.name === "esc" || k.name === "left" || ch === "h") {
      this.view = "board";
      this.cardId = null;
      this.selectedId = card.id;
      this.reload();
    } else if (k.name === "enter") {
      if (row?.kind === "session") {
        const s = row.node.session;
        return this.requireWorking(card, () => void this.act(isOpen(s) ? "focusing" : "resuming", () => openSession(s), true));
      }
      if (row?.kind === "space" && row.space) return this.newSessionFlow(card, row.space);
      return;
    } else if (ch === "f" && row?.kind === "session") {
      const s = row.node.session;
      return this.requireWorking(card, () => void this.act("forking", () => forkSession(s), true));
    } else if (ch === "m" && row?.kind === "session") {
      return this.fileSession(row.node.session);
    } else if (ch === "i") {
      this.backTo = "card";
      this.view = "inbox";
    } else if (this.cardCommand(ch, card)) return;
    this.render();
  }

  private onInboxKey(k: Key, ch: string): void {
    const s = this.inbox[this.iCursor];
    if (k.name === "down" || ch === "j") this.iCursor = Math.min(Math.max(0, this.inbox.length - 1), this.iCursor + 1);
    else if (k.name === "up" || ch === "k") this.iCursor = Math.max(0, this.iCursor - 1);
    else if (k.name === "esc" || k.name === "left" || ch === "h" || ch === "i") this.view = this.backTo === "inbox" ? "board" : this.backTo;
    else if ((k.name === "enter" || ch === "m") && s) return this.fileSession(s);
    else if (ch === "x" && s) {
      db().updateSession(s.id, { ignored: 1 });
      this.reload();
      return this.say("ignored");
    }
    this.render();
  }

  private onKeysPageKey(k: Key, ch: string): void {
    if (k.name === "down" || ch === "j") this.keysScroll += 1;
    else if (k.name === "up" || ch === "k") this.keysScroll = Math.max(0, this.keysScroll - 1);
    else if (k.name === "pagedown") this.keysScroll += 10;
    else if (k.name === "pageup") this.keysScroll = Math.max(0, this.keysScroll - 10);
    else if (k.name === "esc" || k.name === "left" || ch === "h") this.view = this.backTo === "keys" ? "board" : this.backTo;
    this.render();
  }

  private onOverlayKey(ov: Overlay, k: Key): void {
    const ch = k.name === "char" ? k.ch : "";
    if (ov.type === "form") return this.onFormAction(ov, ov.form.key(k));
    if (ov.type === "confirm") {
      if (ch === "y" || ch === "Y" || k.name === "enter") {
        this.overlay = null;
        ov.onDone(true);
      } else if (ch === "n" || ch === "N" || k.name === "esc") {
        this.overlay = null;
        ov.onDone(false);
      }
      return this.render();
    }
    if (ov.type === "prompt") {
      if (k.name === "enter") {
        this.overlay = null;
        ov.onDone(ov.value);
      } else if (k.name === "esc") {
        this.overlay = null;
        ov.onDone(null);
      } else if (k.name === "backspace") ov.value = [...ov.value].slice(0, -1).join("");
      else if (k.name === "ctrl-u") ov.value = "";
      else if (ch) ov.value += ch;
      return this.render();
    }
    const visible = this.pickerItems(ov);
    if (k.name === "enter") {
      const item = visible[ov.index];
      this.overlay = null;
      ov.onDone(item ? item.value : null);
    } else if (k.name === "esc") {
      this.overlay = null;
      ov.onDone(null);
    } else if (k.name === "down" || k.name === "tab") ov.index = Math.min(visible.length - 1, ov.index + 1);
    else if (k.name === "up") ov.index = Math.max(0, ov.index - 1);
    else if (k.name === "backspace") {
      ov.filter = [...ov.filter].slice(0, -1).join("");
      ov.index = 0;
    } else if (k.name === "ctrl-u") {
      ov.filter = "";
      ov.index = 0;
    } else if (ch) {
      ov.filter += ch;
      ov.index = 0;
    }
    this.render();
  }

  private pickerItems(ov: Extract<Overlay, { type: "picker" }>): PickItem<unknown>[] {
    const terms = ov.filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return ov.items;
    return ov.items.filter((it) => {
      const hay = `${it.label} ${it.hint ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  private hints(): Hint[] {
    if (this.busy) return [["…", "working"]];
    if (this.overlay?.type === "picker") return [["type", "filter"], ["↑↓", "move"], ["enter", "pick"], ["esc", "cancel"]];
    if (this.overlay?.type === "prompt") return [["enter", "ok"], ["esc", "cancel"], ["ctrl+u", "clear"]];
    if (this.overlay?.type === "confirm") return [["y", "yes"], ["n", "no"]];
    if (this.overlay?.type === "form") return this.overlay.form.hints();
    if (this.view === "keys") return [["j k", "scroll"], ["esc", "back"], ["q", "quit"]];
    if (this.view === "inbox") {
      if (!this.inbox.length) return [["esc", "back"], ["?", "all keys"], ["q", "quit"]];
      return [["enter", "file under a card"], ["x", "ignore"], ["j k", "move"], ["esc", "back"], ["?", "all keys"]];
    }
    if (this.view === "card") {
      const r = this.detail[this.dCursor];
      const cardRec = this.cardId !== null ? db().card(this.cardId) : null;
      const common: Hint[] = [...(cardRec ? this.latestHint(cardRec) : []), ["s", "new session"], ["w", "new space"], ["e", "edit"], ["H L", "move card"], ["t p b d", "status"], ["esc", "board"], ["?", "all keys"]];
      if (r?.kind === "session") {
        const s = r.node.session;
        return [["enter", isOpen(s) ? "focus" : "resume"], ["f", "fork"], ["m", "move to card"], ...common];
      }
      if (r?.kind === "space" && r.space) return [["enter", "new session here"], ...common];
      return common;
    }
    const sel = this.selectedCard();
    const base: Hint[] = [["v", this.grouping === "repo" ? "columns view" : "lanes by repo"], ["n", "new card"], ["i", `inbox${this.inbox.length ? ` (${this.inbox.length})` : ""}`], ["/", "filter"], ["?", "all keys"], ["q", "quit"]];
    if (!sel) return [["h l", "column"], ...base];
    return [["enter", "open card"], ...this.latestHint(sel.card), ["H L", "move card"], ["s", "new session"], ["w", "new space"], ["e", "edit"], ["t p b d", "status"], ["x", "archive"], ...base];
  }

  private keyBar(w: number): string[] {
    const lines: Part[][] = [[]];
    let used = 0;
    for (const [key, label] of this.hints()) {
      const width = textWidth(key) + 1 + textWidth(label) + 3;
      if (used + width > w - 1 && used > 0) {
        if (lines.length === 2) break;
        lines.push([]);
        used = 0;
      }
      const cur = lines[lines.length - 1];
      cur.push(used === 0 ? " " : "", [key, "yellow", "bold"], [` ${label}   `, "dim"]);
      used += width + (used === 0 ? 1 : 0);
    }
    return lines.map((parts) => line(parts, w));
  }

  private statusLine(w: number): string {
    if (this.toast && Date.now() - this.toast.at < 6000) return line([[` ${this.toast.text}`, this.toast.error ? "red" : "yellow"]], w);
    if (this.view === "card") {
      const r = this.detail[this.dCursor];
      if (r?.kind === "session") {
        const s = r.node.session;
        return line([[` ${s.harness} · ${shortPath(s.cwd)} · ${s.pane_id ? `pane ${s.pane_id}` : "closed"} · ${shortPath(s.ref)}`, "dim"]], w);
      }
      if (r?.kind === "space" && r.space) return line([[` ${r.space.path}`, "dim"]], w);
    }
    if (this.view === "inbox") {
      const s = this.inbox[this.iCursor];
      if (s) return line([[` ${s.harness} · ${shortPath(s.cwd)} · ${shortPath(s.ref)}`, "dim"]], w);
    }
    if (this.view === "board") {
      const sel = this.selectedCard();
      if (sel) {
        const d = sel.card.description.split("\n").find((l) => l.trim()) ?? "no description (e to edit)";
        return line([[` ${d}`, "dim"]], w);
      }
    }
    return line([""], w);
  }

  private header(w: number, crumbs: Part[]): string {
    const needs = this.data.filter((x) => x.needs).length;
    const right: Part[] = [];
    if (!this.watcherUp) right.push(["\u26a0 watcher not running: sessions are not being tracked (deck ensure-watch)", "red", "bold"], "   ");
    if (needs) right.push([`◆ ${needs} need${needs === 1 ? "s" : ""} you`, "red", "bold"], "   ");
    if (this.inbox.length) right.push([`inbox ${this.inbox.length}`, "yellow"], "   ");
    if (this.filter) right.push([`filter: ${this.filter}`, "yellow"], "   ");
    const left: Part[] = [[" herdr-deck ", "title", "inverse"], ...(DEMO ? ([[" DEMO: throwaway data, deleted on quit ", "magenta", "inverse"]] as Part[]) : []), ...crumbs];
    const lw = left.reduce((n, p) => n + textWidth(typeof p === "string" ? p : p[0]), 0);
    const rw = right.reduce((n, p) => n + textWidth(typeof p === "string" ? p : p[0]), 0);
    return line([...left, " ".repeat(Math.max(1, w - lw - rw)), ...right], w);
  }

  private render(): void {
    const w = this.term.width;
    const h = this.term.height;
    const bar = this.keyBar(w);
    const bodyH = Math.max(3, h - 2 - bar.length);
    let out: string[];
    if (this.view === "card") out = this.renderCardPage(w, bodyH);
    else if (this.view === "inbox") out = this.renderInbox(w, bodyH);
    else if (this.view === "keys") out = this.renderKeys(w, bodyH);
    else out = this.renderBoard(w, bodyH);
    while (out.length < bodyH + 1) out.push(" ".repeat(w));
    out = out.slice(0, bodyH + 1);
    out.push(this.statusLine(w), ...bar);
    if (this.overlay) this.drawOverlay(out, this.overlay, w, h);
    this.term.draw(out);
  }

  private renderBoard(w: number, bodyH: number): string[] {
    if (this.grouping === "repo") return this.renderLanes(w, bodyH);
    const out: string[] = [this.header(w, [])];
    const minW = 26;
    const fit = Math.max(1, Math.min(COLUMNS.length, Math.floor((w + 1) / (minW + 1))));
    const first = Math.max(0, Math.min(this.col - Math.floor(fit / 2), COLUMNS.length - fit));
    const cols = Array.from({ length: fit }, (_, i) => first + i);
    const colW = Math.floor((w - (fit - 1)) / fit);
    const lines: string[][] = cols.map(() => []);
    const cardH = this.withArt(colW) ? ART_HEIGHT + 2 : 4;
    const listH = bodyH - 2;
    const perCol = Math.max(1, Math.floor(listH / cardH));
    cols.forEach((ci, idx) => {
      const column = COLUMNS[ci];
      const cards = this.columnCards(ci);
      const focused = ci === this.col;
      const head: Part[] = [[` ${column.label} `, column.style, "bold", ...(focused ? (["inverse"] as Style[]) : [])], [` ${cards.length}`, "dim"]];
      lines[idx].push(line(head, colW));
      lines[idx].push(line([["─".repeat(colW), focused ? column.style : "dim"]], colW));
      let scroll = this.colScroll[ci];
      const sel = this.rowInCol[ci];
      if (sel < scroll) scroll = sel;
      if (sel >= scroll + perCol) scroll = sel - perCol + 1;
      this.colScroll[ci] = Math.max(0, scroll);
      if (!cards.length) lines[idx].push(line([[column.status === "todo" ? "  n adds a card" : "  empty", "dim"]], colW));
      for (let i = scroll; i < Math.min(cards.length, scroll + perCol); i++) {
        lines[idx].push(...this.renderCardBox(cards[i], colW, focused && i === sel));
      }
      if (cards.length > scroll + perCol) lines[idx].push(line([[`  ↓ ${cards.length - scroll - perCol} more`, "dim"]], colW));
      if (scroll > 0 && lines[idx].length > 2) lines[idx][2] = line([[`  ↑ ${scroll} more`, "dim"]], colW);
    });
    if (fit < COLUMNS.length) {
      const hidden: string[] = [];
      if (first > 0) hidden.push(`← ${COLUMNS.slice(0, first).map((c) => c.label.toLowerCase()).join(", ")}`);
      if (first + fit < COLUMNS.length) hidden.push(`${COLUMNS.slice(first + fit).map((c) => c.label.toLowerCase()).join(", ")} →`);
      out[0] = this.header(w, [[`  ${hidden.join("   ")}`, "dim"]]);
    }
    for (let r = 0; r < bodyH; r++) {
      out.push(lines.map((l) => l[r] ?? " ".repeat(colW)).join(" "));
    }
    return out;
  }

  private renderLanes(w: number, bodyH: number): string[] {
    const minW = 26;
    const fit = Math.max(1, Math.min(COLUMNS.length, Math.floor((w + 1) / (minW + 1))));
    const first = Math.max(0, Math.min(this.col - Math.floor(fit / 2), COLUMNS.length - fit));
    const cols = Array.from({ length: fit }, (_, i) => first + i);
    const colW = Math.floor((w - (fit - 1)) / fit);
    const cardH = this.withArt(colW) ? ART_HEIGHT + 2 : 4;
    const blank = " ".repeat(colW);
    const crumbs: Part[] = [["  lanes by repo", "dim"]];
    if (fit < COLUMNS.length) {
      const hidden: string[] = [];
      if (first > 0) hidden.push(`\u2190 ${COLUMNS.slice(0, first).map((c) => c.label.toLowerCase()).join(", ")}`);
      if (first + fit < COLUMNS.length) hidden.push(`${COLUMNS.slice(first + fit).map((c) => c.label.toLowerCase()).join(", ")} \u2192`);
      crumbs.push([`   ${hidden.join("   ")}`, "dim"]);
    }
    const out: string[] = [this.header(w, crumbs)];
    out.push(
      cols
        .map((ci) => {
          const c = COLUMNS[ci];
          const focused = ci === this.col;
          return line([[` ${c.label} `, c.style, "bold", ...(focused ? (["inverse"] as Style[]) : [])], [` ${this.columnCards(ci).length}`, "dim"]], colW);
        })
        .join(" "),
    );
    out.push(cols.map((ci) => line([["\u2500".repeat(colW), ci === this.col ? COLUMNS[ci].style : "dim"]], colW)).join(" "));
    const content: string[] = [];
    let selTop = -1;
    let selLaneTop = -1;
    const selected = this.selectedCard();
    if (!this.lanes.length) content.push(line([["  no cards yet: press n to create one", "dim"]], w));
    for (const lane of this.lanes) {
      const laneTop = content.length;
      const open = lane.cards.filter((c) => c.card.status !== "done");
      const needs = open.filter((c) => c.state === "needs").length;
      const working = open.filter((c) => c.state === "working").length;
      const isSelLane = selected?.lane === lane.key;
      const stats: Part[] = [[`   ${lane.cards.length + lane.doneHidden} card${lane.cards.length + lane.doneHidden === 1 ? "" : "s"}`, "dim"]];
      if (needs) stats.push([`  \u25c6 ${needs} need${needs === 1 ? "s" : ""} you`, "red", "bold"]);
      if (working) stats.push([`  \u25cf ${working} working`, "green"]);
      const head: Part[] = [
        ["\u258c ", isSelLane ? "yellow" : "cyan", "bold"],
        [lane.name, isSelLane ? "yellow" : "title", "bold"],
        [lane.path ? `  ${shortPath(lane.path)}` : "  cards with no space yet", "dim"],
        ...stats,
      ];
      const headW = head.reduce((n, p) => n + textWidth(typeof p === "string" ? p : p[0]), 0);
      head.push([" " + "\u2504".repeat(Math.max(0, w - headW - 1)), "dim"]);
      content.push(line(head, w));
      const perCol = cols.map((ci) => this.columnCards(ci).filter((x) => x.lane === lane.key));
      const rows = Math.max(1, ...perCol.map((list) => list.length));
      for (let r = 0; r < rows; r++) {
        const blocks = cols.map((ci, idx) => {
          const item = perCol[idx][r];
          if (!item) return Array.from({ length: r === 0 ? 1 : cardH }, (_, i) => (r === 0 && i === 0 && !perCol[idx].length ? line([["  \u00b7", "dim"]], colW) : blank));
          const isSel = ci === this.col && selected?.card.id === item.card.id;
          if (isSel) selTop = content.length;
          return this.renderCardBox(item, colW, isSel);
        });
        const height = Math.max(...blocks.map((b) => b.length));
        for (let i = 0; i < height; i++) content.push(blocks.map((b) => b[i] ?? blank).join(" "));
      }
      const doneIdx = cols.indexOf(COLUMNS.findIndex((c) => c.status === "done"));
      if (lane.doneHidden && doneIdx >= 0) {
        const cells = cols.map((_, idx) => (idx === doneIdx ? line([[`  +${lane.doneHidden} more done (v: columns view)`, "dim"]], colW) : blank));
        content.push(cells.join(" "));
      }
      content.push("");
      if (isSelLane) selLaneTop = laneTop;
    }
    const viewH = Math.max(1, bodyH - 2);
    if (selTop >= 0) {
      const want = selLaneTop >= 0 && selTop + cardH - selLaneTop <= viewH ? selLaneTop : selTop;
      if (want < this.boardScroll) this.boardScroll = want;
      if (selTop + cardH > this.boardScroll + viewH) this.boardScroll = selTop + cardH - viewH;
    }
    this.boardScroll = Math.max(0, Math.min(this.boardScroll, Math.max(0, content.length - viewH)));
    const view = content.slice(this.boardScroll, this.boardScroll + viewH).map((l) => l || " ".repeat(w));
    if (this.boardScroll > 0 && view.length) view[0] = line([[`  \u2191 ${this.boardScroll} more lines`, "dim"]], w);
    if (this.boardScroll + viewH < content.length && view.length) view[view.length - 1] = line([["  \u2193 more lanes below", "dim"]], w);
    return [...out, ...view];
  }

  private withArt(colW: number): boolean {
    return colW - 4 >= ART_WIDTH + 22;
  }

  private cardFrame(item: CardData, w: number, selected: boolean): { border: Style[]; top: string; bottom: string; quiet: boolean } {
    const quiet = QUIET_STATES.includes(item.state);
    const color = STATE_COLOR[item.state];
    const border: Style[] = selected ? ["yellow", "bold"] : quiet ? ["dim"] : [color];
    const dash = quiet ? "\u2504" : "\u2500";
    const idText = ` #${item.card.id} `;
    const idStyle: Style[] = selected ? ["yellow", "bold"] : quiet ? ["dim"] : ["bold"];
    const top = line([["\u250c", ...border], [idText, ...idStyle], [dash.repeat(Math.max(0, w - 2 - textWidth(idText))) + "\u2510", ...border]], w);
    const bottom = line([["\u2514" + dash.repeat(Math.max(0, w - 2)) + "\u2518", ...border]], w);
    return { border, top, bottom, quiet };
  }

  private renderArtCard(item: CardData, w: number, selected: boolean): string[] {
    const { border, top, bottom, quiet } = this.cardFrame(item, w, selected);
    const inner = w - 4;
    const textW = inner - ART_WIDTH - 1;
    const open = item.sessions.filter(isOpen).length;
    const alertStyle: Style = item.state === "warning" ? "yellow" : "red";
    const stats = `${item.spaces.length} space${item.spaces.length === 1 ? "" : "s"} \u00b7 ${item.sessions.length} sess${open ? ` (${open} open)` : ""} \u00b7 ${ago(item.card.updated_at)}`;
    let meta: Part[];
    if (item.alert) meta = [[item.alert, alertStyle, "bold"]];
    else if (item.state === "working") meta = [["working \u00b7 ", "green"], [stats, "dim"]];
    else if (item.state === "parked") meta = [[`parked \u00b7 ${item.sessions.length} sess, none open`, "dim"]];
    else if (item.state === "new") meta = [["not started", "dim"]];
    else meta = [[stats, "dim"]];
    const latest = item.latest;
    let latestParts: Part[];
    if (!latest && item.state === "done") latestParts = [["finished", "dim"]];
    else if (!latest) latestParts = [["s", "yellow"], [" start a session", "dim"]];
    else {
      const harnessColor: Style = quiet ? "dim" : harnessStyle(latest.harness);
      latestParts = [["\u21b3 ", "dim"], [latest.harness, harnessColor], [` ${latest.title ?? "new session"}`, "dim"]];
      if (item.state === "parked") latestParts.push(["  o", "yellow"], [" resume", "dim"]);
      else latestParts.push([` \u00b7 ${ago(latest.last_seen)}`, "dim"]);
    }
    const titleStyle: Style[] = selected ? ["bold"] : quiet ? ["dim"] : [];
    const rows: Part[][] = [[[item.card.title, ...titleStyle]], meta, latestParts];
    const icon = art(item.state, Math.floor(Date.now() / 125), lastActivity(item));
    const body = rows.map(
      (parts, i) => line([["\u2502 ", ...border]], 2) + line(parts, textW) + " " + line(icon[i] ?? [""], ART_WIDTH) + line([[" \u2502", ...border]], 2),
    );
    return [top, ...body, bottom];
  }

  private renderCardBox(item: CardData, w: number, selected: boolean): string[] {
    if (this.withArt(w)) return this.renderArtCard(item, w, selected);
    const { border, top, bottom, quiet } = this.cardFrame(item, w, selected);
    const inner = w - 4;
    const mark = liveMark(item.sessions);
    const markPart: Part = item.needs ? ["◆ ", "red", "bold"] : mark === "working" ? ["● ", "green"] : mark === "open" ? ["● ", "blue"] : "";
    const titleStyle: Style[] = selected ? ["bold"] : quiet ? ["dim"] : [];
    const titleParts: Part[] = [markPart, [item.card.title, ...titleStyle]];
    const open = item.sessions.filter(isOpen).length;
    let meta: Part[];
    if (item.card.status === "blocked" && item.card.blocked_reason) meta = [[`⟂ ${item.card.blocked_reason}`, "yellow"]];
    else if (item.needs) meta = [["needs you", "red"], [` · ${item.sessions.length} sess · ${ago(item.card.updated_at)}`, "dim"]];
    else
      meta = [
        [
          `${item.spaces.length} space${item.spaces.length === 1 ? "" : "s"} · ${item.sessions.length} sess${open ? ` (${open} open)` : ""} · ${ago(item.card.updated_at)}`,
          "dim",
        ],
      ];
    const body = (parts: Part[]) => line([["│ ", ...border]], 2) + line(parts, inner) + line([[" │", ...border]], 2);
    return [top, body(titleParts), body(meta), bottom];
  }

  private renderCardPage(w: number, bodyH: number): string[] {
    const card = this.cardId !== null ? db().card(this.cardId) : null;
    if (!card) return [this.header(w, [])];
    const item = this.data.find((x) => x.card.id === card.id);
    const col = COLUMNS.find((c) => c.status === card.status) ?? COLUMNS[0];
    const out: string[] = [this.header(w, [["  board › ", "dim"], [`#${card.id} `, "bold"], [truncate(card.title, Math.max(10, w - 50)), "bold"]])];
    const chips: Part[] = ["  ", [` ${STATUS_LABEL[card.status]} `, col.style, "inverse"]];
    if (item?.needs) chips.push("  ", [" needs you ", "red", "inverse"]);
    if (card.status === "blocked" && card.blocked_reason) chips.push("  ", [`⟂ ${card.blocked_reason}`, "yellow"]);
    const updated = ago(card.updated_at);
    chips.push([`   updated ${updated === "now" ? "just now" : `${updated} ago`} · created ${card.created_at.slice(0, 10)}`, "dim"]);
    out.push(line([""], w), line([["  ", "bold"], [card.title, "bold"]], w), line(chips, w), line([""], w));
    const desc = card.description.trim() ? wrap(card.description, w - 6, 6) : ["no description: e to edit"];
    const descStyle: Style[] = card.description.trim() ? [] : ["dim"];
    for (const d of desc) out.push(line(["    ", [d, ...descStyle]], w));
    out.push(line([""], w));
    const sessions = item?.sessions ?? [];
    out.push(
      line(
        [["  SPACES & SESSIONS", "title", "bold"], [`   ${item?.spaces.length ?? 0} space(s) · ${sessions.length} session(s) · ${sessions.filter(isOpen).length} open`, "dim"]],
        w,
      ),
    );
    out.push(line([["  " + "─".repeat(Math.max(0, w - 4)), "dim"]], w));
    const listH = Math.max(1, bodyH + 1 - out.length);
    if (this.dCursor < this.dScroll) this.dScroll = this.dCursor;
    if (this.dCursor >= this.dScroll + listH) this.dScroll = this.dCursor - listH + 1;
    this.dScroll = Math.max(0, Math.min(this.dScroll, Math.max(0, this.detail.length - listH)));
    for (let i = this.dScroll; i < Math.min(this.detail.length, this.dScroll + listH); i++) {
      out.push(this.renderDetailRow(this.detail[i], w, i === this.dCursor));
    }
    return out;
  }

  private renderDetailRow(r: DetailRow, w: number, selected: boolean): string {
    const fill: Style[] = selected ? ["inverse"] : [];
    if (r.kind === "note") return line([[`    ${r.text}`, "dim"]], w);
    if (r.kind === "space") {
      if (!r.space) return line([["  ◇ ", "dim"], ["other directories", "dim"], [`  ${r.count} session(s)`, "dim"]], w, fill);
      const sp = r.space;
      return line(
        [
          ["  ◇ ", "yellow"],
          [sp.label, "bold"],
          [`  ${sp.kind}`, "dim"],
          [sp.branch ? `  ${sp.branch}` : "", "cyan"],
          [`  ${shortPath(sp.path)}`, "dim"],
          sp.workspace_id ? ["  open", "green"] : ["  closed", "dim"],
          [`  ${r.count} session(s)`, "dim"],
        ],
        w,
        fill,
      );
    }
    const s = r.node.session;
    const st = statusStyle(s);
    const indent = "      " + "  ".repeat(r.node.depth) + (r.node.depth ? "└ " : "");
    return line(
      [
        indent,
        [`${st.mark} `, st.style],
        [`${pad(s.harness, 6)} `, harnessStyle(s.harness)],
        s.title ?? "(new session, no messages yet)",
        [`  ${st.text}`, st.style],
        [`  ${ago(s.last_seen)}`, "dim"],
        [r.node.depth ? "  fork" : "", "dim"],
      ],
      w,
      fill,
    );
  }

  private renderInbox(w: number, bodyH: number): string[] {
    const out: string[] = [this.header(w, [["  inbox", "bold"], ["  sessions not filed under a card", "dim"]])];
    out.push(line([""], w));
    if (!this.inbox.length) {
      out.push(line([["  nothing here: every session is filed", "dim"]], w));
      return out;
    }
    const listH = Math.max(1, bodyH - 1);
    const start = Math.max(0, Math.min(this.iCursor - Math.floor(listH / 2), this.inbox.length - listH));
    for (let i = start; i < Math.min(this.inbox.length, start + listH); i++) {
      const s = this.inbox[i];
      const st = statusStyle(s);
      out.push(
        line(
          [
            "  ",
            [`${st.mark} `, st.style],
            [`${pad(s.harness, 6)} `, harnessStyle(s.harness)],
            s.title ?? "(new session, no messages yet)",
            [`  ${st.text}`, st.style],
            [`  ${ago(s.last_seen)}`, "dim"],
            [`  ${shortPath(s.cwd)}`, "dim"],
          ],
          w,
          i === this.iCursor ? ["inverse"] : [],
        ),
      );
    }
    return out;
  }

  private renderKeys(w: number, bodyH: number): string[] {
    const body: string[] = [];
    const section = (title: string, keys: Hint[]) => {
      body.push(line([""], w), line([[`  ${title}`, "title", "bold"]], w), line([["  " + "─".repeat(Math.min(60, w - 4)), "dim"]], w));
      const kw = Math.min(26, Math.max(10, ...keys.map(([k]) => textWidth(k) + 2)));
      for (const [k, d] of keys) body.push(line(["    ", [pad(k, kw), "yellow", "bold"], d], w));
    };
    const global = herdrKeys();
    section("herdr keys (from ~/.config/herdr/config.toml, prefix is herdr's prefix key)", global.length ? global : [["-", "no custom keys found"]]);
    for (const s of KEY_SECTIONS) section(s.title, s.keys);
    const maxScroll = Math.max(0, body.length - bodyH);
    this.keysScroll = Math.min(this.keysScroll, maxScroll);
    return [this.header(w, [["  keys", "bold"]]), ...body.slice(this.keysScroll, this.keysScroll + bodyH)];
  }

  private drawForm(out: string[], ov: Extract<Overlay, { type: "form" }>, w: number, h: number): void {
    const boxW = Math.min(w - 4, 92);
    const left = Math.floor((w - boxW) / 2);
    const inner = boxW - 2;
    const edge: Style[] = ["cyan"];
    const titleText = ` ${ov.title} `;
    const lines: string[] = [
      line([["\u256d\u2500", ...edge], [titleText, "title", "bold", "inverse"], ["\u2500".repeat(Math.max(0, boxW - 4 - textWidth(titleText))) + "\u256e", ...edge]], boxW),
    ];
    for (const parts of ov.form.render(inner)) lines.push(line([["\u2502", ...edge]], 1) + line(parts, inner) + line([["\u2502", ...edge]], 1));
    lines.push(line([["\u2570" + "\u2500".repeat(boxW - 2) + "\u256f", ...edge]], boxW));
    const top = Math.max(1, Math.floor((h - lines.length) / 2) - 1);
    for (let i = 0; i < lines.length && top + i < out.length; i++) {
      out[top + i] = " ".repeat(left) + lines[i] + " ".repeat(Math.max(0, w - left - boxW));
    }
  }

  private drawOverlay(out: string[], ov: Overlay, w: number, h: number): void {
    if (ov.type === "form") return this.drawForm(out, ov, w, h);
    const boxW = Math.min(w - 4, 90);
    const left = Math.floor((w - boxW) / 2);
    const body: Part[][] = [];
    let title = "";
    if (ov.type === "confirm") {
      title = "confirm";
      body.push([` ${ov.text}`], [""], [["  y yes · n no", "dim"]]);
    } else if (ov.type === "prompt") {
      title = ov.label;
      body.push([` ${ov.value}`, ["█", "dim"]], [""], [["  enter ok · esc cancel · ctrl+u clear", "dim"]]);
    } else {
      title = ov.title;
      body.push([[" > ", "yellow"], ov.filter, ["█", "dim"]]);
      const items = this.pickerItems(ov);
      const maxRows = Math.max(3, Math.min(items.length, h - 10));
      const start = Math.max(0, Math.min(ov.index - Math.floor(maxRows / 2), items.length - maxRows));
      for (let i = start; i < Math.min(items.length, start + maxRows); i++) {
        const it = items[i];
        const sel = i === ov.index;
        body.push([[sel ? " ▸ " : "   ", sel ? "yellow" : "dim"], [it.label, ...(sel ? (["bold"] as Style[]) : [])], [it.hint ? `  ${it.hint}` : "", "dim"]]);
      }
      if (!items.length) body.push([["   no match", "dim"]]);
      body.push([["  type to filter · ↑↓ move · enter pick · esc cancel", "dim"]]);
    }
    const lines = [line([[`┌ ${title} `, "title"], ["─".repeat(Math.max(0, boxW - textWidth(title) - 4)) + "┐", "title"]], boxW)];
    for (const parts of body) lines.push(line([["│", "title"]], 1) + line(parts, boxW - 2) + line([["│", "title"]], 1));
    lines.push(line([["└" + "─".repeat(boxW - 2) + "┘", "title"]], boxW));
    const top = Math.max(1, Math.floor((h - lines.length) / 2));
    for (let i = 0; i < lines.length && top + i < out.length; i++) {
      out[top + i] = " ".repeat(left) + lines[i] + " ".repeat(Math.max(0, w - left - boxW));
    }
  }
}

export async function runTui(mode: Mode, ctx: Context): Promise<void> {
  const app = new App(mode, ctx);
  await app.run();
}
