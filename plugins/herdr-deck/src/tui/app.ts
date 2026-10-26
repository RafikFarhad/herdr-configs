import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig, type Harness } from "../config";
import { db, type Card, type CardStatus, type Session, type Space } from "../db";
import {
  addCheckoutSpace,
  addWorktreeSpace,
  cardForWorkspace,
  forkSession,
  listRepos,
  newCard,
  openSession,
  sessionForPane,
  startSession,
} from "../actions";
import { ago, isOpen, latestSession, liveMark, needsYou, shortPath, spaceBlocks, type SessionNode } from "../model";
import { HARNESSES } from "../sessions";
import { Terminal, line, pad, textWidth, truncate, type Key, type Part, type Style } from "./term";

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
  | { type: "confirm"; text: string; onDone: (ok: boolean) => void };

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

interface CardData {
  card: Card;
  sessions: Session[];
  spaces: Space[];
  needs: boolean;
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

  constructor(private mode: Mode, private ctx: Context) {}

  async run(): Promise<void> {
    this.reload();
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
    this.render();
    this.startMode();
    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  private quit(): void {
    if (this.timer) clearInterval(this.timer);
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
    this.data = d
      .cards()
      .filter((c) => !f || `#${c.id} ${c.title} ${c.description}`.toLowerCase().includes(f))
      .map((card) => {
        const sessions = d.sessions(card.id);
        return { card, sessions, spaces: d.spaces(card.id), needs: card.status !== "done" && needsYou(sessions) };
      });
    this.byStatus = new Map(COLUMNS.map((c) => [c.status, [] as CardData[]]));
    for (const item of this.data) this.byStatus.get(item.card.status)?.push(item);
    for (const list of this.byStatus.values()) {
      list.sort((a, b) => Number(b.needs) - Number(a.needs) || b.card.updated_at.localeCompare(a.card.updated_at) || b.card.id - a.card.id);
    }
    const done = this.byStatus.get("done");
    if (done && done.length > 50) done.length = 50;
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

  private pick<T>(title: string, items: PickItem<T>[], onDone: (v: T | null) => void): void {
    this.overlay = { type: "picker", title, items, filter: "", index: 0, onDone: onDone as (v: unknown) => void };
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

  private newCardFlow(): void {
    this.ask("New card title", "", (title) => {
      if (!title?.trim()) return;
      const desc = this.term.edit("\n", ".md");
      const card = newCard(title, (desc ?? "").trim());
      this.openCard(card.id);
      this.newSpaceFlow(card, true);
    });
  }

  private newSpaceFlow(card: Card, optional = false, then?: (s: Space) => void): void {
    const repos = listRepos();
    const items: PickItem<string>[] = repos.map((r) => ({ label: r.name, hint: shortPath(r.path), value: r.path }));
    if (optional) items.unshift({ label: "(no space for now)", value: "" });
    this.pick(`Repo for #${card.id} ${card.title}`, items, (path) => {
      if (!path) return;
      this.pick<"worktree" | "checkout">(
        `${basename(path)}: where should the work happen?`,
        [
          { label: "new git worktree", hint: `${loadConfig().worktreeDir}/${card.id}-…`, value: "worktree" },
          { label: "the main checkout", hint: shortPath(path), value: "checkout" },
        ],
        (kind) => {
          if (!kind) return;
          void this.act(kind === "worktree" ? "creating worktree" : "adding checkout", async () => {
            const space = kind === "worktree" ? await addWorktreeSpace(card, path) : addCheckoutSpace(card, path);
            if (then) setTimeout(() => then(space), 0);
            return `space added: ${space.label}${space.branch ? ` (${space.branch})` : ""}`;
          });
        },
      );
    });
  }

  private newSessionFlow(card: Card, space: Space | null): void {
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
    if (spaces.length === 1) return chooseHarness(spaces[0]);
    const items: PickItem<number>[] = spaces.map((s) => ({ label: s.label, hint: `${s.kind} ${shortPath(s.path)}`, value: s.id }));
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
    void this.act(isOpen(s) ? "focusing latest session" : "resuming latest session", () => openSession(s), true);
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

  private onBoardKey(k: Key, ch: string): void {
    const n = this.columnCards(this.col).length;
    if (k.name === "left" || ch === "h") this.col = Math.max(0, this.col - 1);
    else if (k.name === "right" || ch === "l") this.col = Math.min(COLUMNS.length - 1, this.col + 1);
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
        return void this.act(isOpen(s) ? "focusing" : "resuming", () => openSession(s), true);
      }
      if (row?.kind === "space" && row.space) return this.newSessionFlow(card, row.space);
      return;
    } else if (ch === "f" && row?.kind === "session") {
      const s = row.node.session;
      return void this.act("forking", () => forkSession(s), true);
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
    const base: Hint[] = [["n", "new card"], ["i", `inbox${this.inbox.length ? ` (${this.inbox.length})` : ""}`], ["/", "filter"], ["?", "all keys"], ["q", "quit"]];
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
    if (needs) right.push([`◆ ${needs} need${needs === 1 ? "s" : ""} you`, "red", "bold"], "   ");
    if (this.inbox.length) right.push([`inbox ${this.inbox.length}`, "yellow"], "   ");
    if (this.filter) right.push([`filter: ${this.filter}`, "yellow"], "   ");
    const left: Part[] = [[" herdr-deck ", "title", "inverse"], ...crumbs];
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
    const out: string[] = [this.header(w, [])];
    const minW = 26;
    const fit = Math.max(1, Math.min(COLUMNS.length, Math.floor((w + 1) / (minW + 1))));
    const first = Math.max(0, Math.min(this.col - Math.floor(fit / 2), COLUMNS.length - fit));
    const cols = Array.from({ length: fit }, (_, i) => first + i);
    const colW = Math.floor((w - (fit - 1)) / fit);
    const lines: string[][] = cols.map(() => []);
    const cardH = 4;
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

  private renderCardBox(item: CardData, w: number, selected: boolean): string[] {
    const border: Style[] = selected ? ["yellow", "bold"] : ["dim"];
    const inner = w - 4;
    const mark = liveMark(item.sessions);
    const markPart: Part = item.needs ? ["◆ ", "red", "bold"] : mark === "working" ? ["● ", "green"] : mark === "open" ? ["● ", "blue"] : "";
    const idText = ` #${item.card.id} `;
    const top = line([["┌", ...border], [idText, ...(selected ? (["yellow", "bold"] as Style[]) : (["bold"] as Style[]))], ["─".repeat(Math.max(0, w - 2 - textWidth(idText))) + "┐", ...border]], w);
    const titleParts: Part[] = [markPart, [item.card.title, ...(selected ? (["bold"] as Style[]) : [])]];
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
    const bottom = line([["└" + "─".repeat(Math.max(0, w - 2)) + "┘", ...border]], w);
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

  private drawOverlay(out: string[], ov: Overlay, w: number, h: number): void {
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
