import { Database } from "bun:sqlite";
import { join } from "node:path";
import { dataDir, ensureDataDir, type Harness } from "./config";

export type CardStatus = "todo" | "active" | "blocked" | "done";
export type SpaceKind = "worktree" | "checkout";
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Card {
  id: number;
  title: string;
  description: string;
  status: CardStatus;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface Space {
  id: number;
  card_id: number;
  kind: SpaceKind;
  repo_root: string;
  path: string;
  branch: string | null;
  label: string;
  workspace_id: string | null;
  created_at: string;
}

export interface Session {
  id: number;
  card_id: number | null;
  space_id: number | null;
  harness: Harness;
  ref_kind: "path" | "id";
  ref: string;
  cwd: string | null;
  title: string | null;
  parent_id: number | null;
  pane_id: string | null;
  workspace_id: string | null;
  agent_status: AgentStatus | null;
  first_seen: string;
  last_seen: string;
  closed_at: string | null;
  ignored: number;
}

export interface Launch {
  pane_id: string;
  card_id: number;
  space_id: number | null;
  parent_session_id: number | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT,
  label TEXT NOT NULL,
  workspace_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(card_id, path)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  space_id INTEGER REFERENCES spaces(id) ON DELETE SET NULL,
  harness TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  parent_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  pane_id TEXT,
  workspace_id TEXT,
  agent_status TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  ignored INTEGER NOT NULL DEFAULT 0,
  UNIQUE(harness, ref)
);
CREATE INDEX IF NOT EXISTS sessions_pane ON sessions(pane_id);
CREATE INDEX IF NOT EXISTS sessions_card ON sessions(card_id);
CREATE TABLE IF NOT EXISTS launches (
  pane_id TEXT PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  space_id INTEGER REFERENCES spaces(id) ON DELETE SET NULL,
  parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

type CardField = "title" | "description" | "status" | "blocked_reason" | "archived_at";

const CARD_UPDATES: Record<CardField, string> = {
  title: "UPDATE cards SET title = ?, updated_at = datetime('now') WHERE id = ?",
  description: "UPDATE cards SET description = ?, updated_at = datetime('now') WHERE id = ?",
  status: "UPDATE cards SET status = ?, updated_at = datetime('now') WHERE id = ?",
  blocked_reason: "UPDATE cards SET blocked_reason = ?, updated_at = datetime('now') WHERE id = ?",
  archived_at: "UPDATE cards SET archived_at = ?, updated_at = datetime('now') WHERE id = ?",
};

type SessionField =
  | "card_id"
  | "space_id"
  | "cwd"
  | "title"
  | "parent_id"
  | "pane_id"
  | "workspace_id"
  | "agent_status"
  | "last_seen"
  | "closed_at"
  | "ignored";

const SESSION_UPDATES: Record<SessionField, string> = {
  card_id: "UPDATE sessions SET card_id = ? WHERE id = ?",
  space_id: "UPDATE sessions SET space_id = ? WHERE id = ?",
  cwd: "UPDATE sessions SET cwd = ? WHERE id = ?",
  title: "UPDATE sessions SET title = ? WHERE id = ?",
  parent_id: "UPDATE sessions SET parent_id = ? WHERE id = ?",
  pane_id: "UPDATE sessions SET pane_id = ? WHERE id = ?",
  workspace_id: "UPDATE sessions SET workspace_id = ? WHERE id = ?",
  agent_status: "UPDATE sessions SET agent_status = ? WHERE id = ?",
  last_seen: "UPDATE sessions SET last_seen = ? WHERE id = ?",
  closed_at: "UPDATE sessions SET closed_at = ? WHERE id = ?",
  ignored: "UPDATE sessions SET ignored = ? WHERE id = ?",
};

let instance: DeckDb | null = null;

export function db(): DeckDb {
  if (!instance) instance = new DeckDb(join(dataDir, "deck.db"));
  return instance;
}

export class DeckDb {
  readonly raw: Database;

  constructor(path: string) {
    ensureDataDir();
    this.raw = new Database(path, { create: true });
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec(SCHEMA);
  }

  cards(includeArchived = false): Card[] {
    if (includeArchived) return this.raw.query("SELECT * FROM cards ORDER BY updated_at DESC, id DESC").all() as Card[];
    return this.raw
      .query("SELECT * FROM cards WHERE archived_at IS NULL ORDER BY updated_at DESC, id DESC")
      .all() as Card[];
  }

  card(id: number): Card | null {
    return (this.raw.query("SELECT * FROM cards WHERE id = ?").get(id) as Card) ?? null;
  }

  createCard(title: string, description: string): Card {
    const row = this.raw
      .query("INSERT INTO cards (title, description) VALUES (?, ?) RETURNING *")
      .get(title, description) as Card;
    return row;
  }

  updateCard(id: number, fields: Partial<Pick<Card, CardField>>): void {
    for (const key of Object.keys(fields) as CardField[]) {
      const sql = CARD_UPDATES[key];
      if (!sql) continue;
      this.raw.query(sql).run((fields[key] ?? null) as string | null, id);
    }
  }

  touchCard(id: number): void {
    this.raw.query("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(id);
  }

  spaces(cardId?: number): Space[] {
    if (cardId === undefined) return this.raw.query("SELECT * FROM spaces ORDER BY id").all() as Space[];
    return this.raw.query("SELECT * FROM spaces WHERE card_id = ? ORDER BY id").all(cardId) as Space[];
  }

  space(id: number): Space | null {
    return (this.raw.query("SELECT * FROM spaces WHERE id = ?").get(id) as Space) ?? null;
  }

  createSpace(s: Omit<Space, "id" | "created_at" | "workspace_id"> & { workspace_id?: string | null }): Space {
    return this.raw
      .query(
        `INSERT INTO spaces (card_id, kind, repo_root, path, branch, label, workspace_id)
         VALUES ($card_id, $kind, $repo_root, $path, $branch, $label, $workspace_id)
         ON CONFLICT(card_id, path) DO UPDATE SET workspace_id = COALESCE(excluded.workspace_id, spaces.workspace_id)
         RETURNING *`,
      )
      .get({
        $card_id: s.card_id,
        $kind: s.kind,
        $repo_root: s.repo_root,
        $path: s.path,
        $branch: s.branch,
        $label: s.label,
        $workspace_id: s.workspace_id ?? null,
      }) as Space;
  }

  setSpaceWorkspace(id: number, workspaceId: string | null): void {
    this.raw.query("UPDATE spaces SET workspace_id = ? WHERE id = ?").run(workspaceId, id);
  }

  sessions(cardId: number): Session[] {
    return this.raw
      .query("SELECT * FROM sessions WHERE card_id = ? AND ignored = 0 ORDER BY first_seen, id")
      .all(cardId) as Session[];
  }

  allSessions(): Session[] {
    return this.raw.query("SELECT * FROM sessions ORDER BY id").all() as Session[];
  }

  inbox(): Session[] {
    return this.raw
      .query("SELECT * FROM sessions WHERE card_id IS NULL AND ignored = 0 ORDER BY last_seen DESC")
      .all() as Session[];
  }

  session(id: number): Session | null {
    return (this.raw.query("SELECT * FROM sessions WHERE id = ?").get(id) as Session) ?? null;
  }

  sessionByRef(harness: string, ref: string): Session | null {
    return (this.raw.query("SELECT * FROM sessions WHERE harness = ? AND ref = ?").get(harness, ref) as Session) ?? null;
  }

  openSessionOnPane(paneId: string): Session | null {
    return (
      (this.raw
        .query("SELECT * FROM sessions WHERE pane_id = ? AND closed_at IS NULL ORDER BY last_seen DESC LIMIT 1")
        .get(paneId) as Session) ?? null
    );
  }

  openSessions(): Session[] {
    return this.raw.query("SELECT * FROM sessions WHERE pane_id IS NOT NULL AND closed_at IS NULL").all() as Session[];
  }

  insertSession(s: Omit<Session, "id" | "first_seen" | "last_seen" | "closed_at" | "ignored">): Session {
    return this.raw
      .query(
        `INSERT INTO sessions (card_id, space_id, harness, ref_kind, ref, cwd, title, parent_id, pane_id, workspace_id, agent_status)
         VALUES ($card_id, $space_id, $harness, $ref_kind, $ref, $cwd, $title, $parent_id, $pane_id, $workspace_id, $agent_status)
         RETURNING *`,
      )
      .get({
        $card_id: s.card_id,
        $space_id: s.space_id,
        $harness: s.harness,
        $ref_kind: s.ref_kind,
        $ref: s.ref,
        $cwd: s.cwd,
        $title: s.title,
        $parent_id: s.parent_id,
        $pane_id: s.pane_id,
        $workspace_id: s.workspace_id,
        $agent_status: s.agent_status,
      }) as Session;
  }

  updateSession(id: number, fields: Partial<Pick<Session, SessionField>>): void {
    for (const key of Object.keys(fields) as SessionField[]) {
      const sql = SESSION_UPDATES[key];
      if (!sql) continue;
      this.raw.query(sql).run((fields[key] ?? null) as string | number | null, id);
    }
  }

  closeSessionsOnPane(paneId: string, exceptId?: number): void {
    this.raw
      .query(
        "UPDATE sessions SET pane_id = NULL, closed_at = datetime('now'), agent_status = NULL WHERE pane_id = ? AND id != ?",
      )
      .run(paneId, exceptId ?? -1);
  }

  assignSession(id: number, cardId: number | null, spaceId: number | null): void {
    this.raw.query("UPDATE sessions SET card_id = ?, space_id = ?, ignored = 0 WHERE id = ?").run(cardId, spaceId, id);
    if (cardId !== null) this.activateCard(cardId);
  }

  activateCard(cardId: number): void {
    this.raw
      .query("UPDATE cards SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'todo'")
      .run(cardId);
    this.touchCard(cardId);
  }

  addLaunch(l: Omit<Launch, "created_at">): void {
    this.raw
      .query(
        `INSERT INTO launches (pane_id, card_id, space_id, parent_session_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(pane_id) DO UPDATE SET card_id = excluded.card_id, space_id = excluded.space_id,
         parent_session_id = excluded.parent_session_id, created_at = datetime('now')`,
      )
      .run(l.pane_id, l.card_id, l.space_id, l.parent_session_id);
  }

  takeLaunch(paneId: string): Launch | null {
    const row = (this.raw.query("SELECT * FROM launches WHERE pane_id = ?").get(paneId) as Launch) ?? null;
    if (row) this.raw.query("DELETE FROM launches WHERE pane_id = ?").run(paneId);
    return row;
  }

  dropLaunch(paneId: string): void {
    this.raw.query("DELETE FROM launches WHERE pane_id = ?").run(paneId);
  }

  pruneLaunches(): void {
    this.raw.query("DELETE FROM launches WHERE created_at < datetime('now', '-1 day')").run();
  }
}
