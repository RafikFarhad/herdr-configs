import { existsSync, readdirSync, statSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, absPath, type Harness } from "./config";
import { db, type Card, type Session, type Space } from "./db";
import {
  closePane,
  createTab,
  createWorkspace,
  focusPane,
  getPane,
  listPanes,
  listWorkspaces,
  promptAgent,
  startAgent,
  typeAndEnter,
  worktreeCreate,
  worktreeOpen,
  type Pane,
} from "./herdr";
import { forkArgs, resumeArgs, sessionExists } from "./sessions";

export interface Repo {
  name: string;
  path: string;
}

export function listRepos(): Repo[] {
  const cfg = loadConfig();
  const repos: Repo[] = [];
  for (const root of cfg.roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const path = join(root, entry);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      const git = join(path, ".git");
      if (existsSync(git) && statSync(git).isFile()) continue;
      repos.push({ name: entry, path });
    }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

export function slug(text: string, max = 32): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (s.slice(0, max).replace(/-+$/g, "") || "task").toLowerCase();
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || r.stderr || "").trim() };
}

export function repoRoot(path: string): string | null {
  const r = git(path, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out : null;
}

function excludeDir(repo: string, dir: string): void {
  const common = git(repo, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) return;
  const commonDir = common.out.startsWith("/") ? common.out : join(repo, common.out);
  const file = join(commonDir, "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const line = `${dir.replace(/\/+$/, "")}/`;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === line)) return;
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

export function newCard(title: string, description: string): Card {
  return db().createCard(title.trim(), description.trim());
}

export function addCheckoutSpace(card: Card, repoPath: string): Space {
  const path = absPath(repoPath);
  const root = repoRoot(path) ?? path;
  const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return db().createSpace({
    card_id: card.id,
    kind: "checkout",
    repo_root: root,
    path,
    branch: branch.ok && branch.out !== "HEAD" ? branch.out : null,
    label: basename(path),
  });
}

export async function addWorktreeSpace(card: Card, repoPath: string, base?: string | null): Promise<Space> {
  const cfg = loadConfig();
  const repo = repoRoot(absPath(repoPath));
  if (!repo) throw new Error(`${repoPath} is not a git repository`);
  const name = `${card.id}-${slug(card.title)}`;
  const branch = `${cfg.branchPrefix}${name}`.toLowerCase();
  const path = join(repo, cfg.worktreeDir, name);
  const label = `${basename(repo)} #${card.id}`;
  if (cfg.worktreeDir && !cfg.worktreeDir.startsWith("/") && !cfg.worktreeDir.startsWith("..")) excludeDir(repo, cfg.worktreeDir);
  let workspaceId: string | null = null;
  if (existsSync(path)) {
    workspaceId = await worktreeOpen(path, label);
  } else {
    const exists = git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
    if (exists) {
      const r = git(repo, ["worktree", "add", path, branch]);
      if (!r.ok) throw new Error(`git worktree add: ${r.out}`);
      workspaceId = await worktreeOpen(path, label);
    } else {
      const res = await worktreeCreate({ cwd: repo, branch, path, label, base });
      workspaceId = res.workspaceId;
    }
  }
  const space = db().createSpace({ card_id: card.id, kind: "worktree", repo_root: repo, path, branch, label, workspace_id: workspaceId });
  adoptInboxSessions(space);
  return space;
}

export function adoptInboxSessions(space: Space): number {
  let n = 0;
  for (const s of db().inbox()) {
    if (s.cwd && (s.cwd === space.path || s.cwd.startsWith(`${space.path}/`))) {
      db().assignSession(s.id, space.card_id, space.id);
      n += 1;
    }
  }
  return n;
}

async function liveWorkspaceIds(): Promise<Set<string>> {
  return new Set((await listWorkspaces()).map((w) => w.workspace_id));
}

export async function ensureSpaceWorkspace(space: Space): Promise<string> {
  if (!existsSync(space.path)) throw new Error(`${space.path} no longer exists`);
  const live = await liveWorkspaceIds();
  if (space.workspace_id && live.has(space.workspace_id)) return space.workspace_id;
  const panes = await listPanes();
  const match = panes.find((p) => (p.cwd === space.path || p.foreground_cwd === space.path) && live.has(p.workspace_id));
  let wsId: string | null = match?.workspace_id ?? null;
  if (!wsId && space.kind === "worktree") wsId = await worktreeOpen(space.path, space.label).catch(() => null);
  if (!wsId) wsId = (await createWorkspace(space.path, space.label)).workspaceId;
  db().setSpaceWorkspace(space.id, wsId);
  return wsId;
}

async function sendBrief(agentName: string, paneId: string, text: string): Promise<void> {
  try {
    await promptAgent(agentName, text);
  } catch {
    await typeAndEnter(paneId, text.replace(/\s*\n\s*/g, " ")).catch(() => {});
  }
}

export function cardBrief(card: Card): string {
  const parts = [`Task #${card.id}: ${card.title}`];
  if (card.description.trim()) parts.push("", card.description.trim());
  return parts.join("\n");
}

export interface StartOptions {
  card: Card;
  space: Space;
  harness: Harness;
  args?: string[];
  parent?: Session | null;
  brief?: boolean;
  focus?: boolean;
  tabLabel?: string;
}

export async function startSession(opts: StartOptions): Promise<Pane | null> {
  const wsId = await ensureSpaceWorkspace(opts.space);
  const label = opts.tabLabel ?? `#${opts.card.id} ${opts.harness}`;
  const { paneId } = await createTab(wsId, opts.space.path, label, { DECK_CARD_ID: String(opts.card.id) }, false);
  db().addLaunch({ pane_id: paneId, card_id: opts.card.id, space_id: opts.space.id, parent_session_id: opts.parent?.id ?? null });
  const agentName = `deck-${opts.card.id}-${Date.now().toString(36)}`;
  try {
    await startAgent(paneId, opts.harness, agentName, opts.args ?? []);
  } catch (err) {
    db().dropLaunch(paneId);
    await closePane(paneId);
    throw err;
  }
  if (opts.brief) await sendBrief(agentName, paneId, cardBrief(opts.card));
  db().activateCard(opts.card.id);
  const pane = (await listPanes()).find((p) => p.pane_id === paneId) ?? null;
  if (pane && opts.focus !== false) await focusPane(pane);
  return pane;
}

export async function livePaneFor(session: Session): Promise<Pane | null> {
  if (!session.pane_id) return null;
  const pane = (await listPanes()).find((p) => p.pane_id === session.pane_id);
  if (!pane) return null;
  if (pane.agent_session?.value && pane.agent_session.value !== session.ref) return null;
  return pane;
}

function spaceForSession(session: Session): Space | null {
  const d = db();
  if (session.space_id) {
    const s = d.space(session.space_id);
    if (s) return s;
  }
  if (session.card_id && session.cwd) {
    const spaces = d.spaces(session.card_id).filter((s) => session.cwd === s.path || session.cwd!.startsWith(`${s.path}/`));
    spaces.sort((a, b) => b.path.length - a.path.length);
    if (spaces[0]) return spaces[0];
  }
  return null;
}

async function adhocSpace(session: Session, card: Card): Promise<Space> {
  const cwd = session.cwd;
  if (!cwd || !existsSync(cwd)) throw new Error("this session has no known directory to reopen in");
  const root = repoRoot(cwd) ?? cwd;
  const space = db().createSpace({
    card_id: card.id,
    kind: existsSync(join(root, ".git")) && statSync(join(root, ".git")).isFile() ? "worktree" : "checkout",
    repo_root: root,
    path: root,
    branch: null,
    label: basename(root),
  });
  db().assignSession(session.id, card.id, space.id);
  return space;
}

export async function openSession(session: Session): Promise<string> {
  const live = await livePaneFor(session);
  if (live) {
    await focusPane(live);
    return `focused ${live.pane_id}`;
  }
  if (!sessionExists(session)) throw new Error("the session file is gone, nothing to resume");
  const card = session.card_id ? db().card(session.card_id) : null;
  if (!card) throw new Error("file this session under a card first (m)");
  const space = spaceForSession(session) ?? (await adhocSpace(session, card));
  const pane = await startSession({ card, space, harness: session.harness, args: resumeArgs(session), tabLabel: `#${card.id} ${session.harness} resume` });
  return pane ? `resumed in ${pane.pane_id}` : "resumed";
}

export async function forkSession(session: Session): Promise<string> {
  if (!sessionExists(session)) throw new Error("the session file is gone, nothing to fork");
  const card = session.card_id ? db().card(session.card_id) : null;
  if (!card) throw new Error("file this session under a card first (m)");
  const space = spaceForSession(session) ?? (await adhocSpace(session, card));
  const pane = await startSession({ card, space, harness: session.harness, args: forkArgs(session), parent: session, tabLabel: `#${card.id} ${session.harness} fork` });
  return pane ? `forked into ${pane.pane_id}` : "forked";
}

export function cardForWorkspace(workspaceId: string | null | undefined, cwd?: string | null): Card | null {
  const d = db();
  const cards = new Map(d.cards().map((c) => [c.id, c]));
  const spaces = d.spaces().filter((s) => cards.has(s.card_id));
  if (workspaceId) {
    const ids = new Set(spaces.filter((s) => s.workspace_id === workspaceId).map((s) => s.card_id));
    if (ids.size === 1) return cards.get([...ids][0]) ?? null;
  }
  if (cwd) {
    let best: Space | null = null;
    for (const s of spaces) {
      if ((cwd === s.path || cwd.startsWith(`${s.path}/`)) && (!best || s.path.length > best.path.length)) best = s;
    }
    if (best) return cards.get(best.card_id) ?? null;
  }
  return null;
}

export function sessionForPane(paneId: string | null | undefined): Session | null {
  if (!paneId) return null;
  return db().openSessionOnPane(paneId);
}

export type CloseResult = "closed" | "gone" | "still-running";

const QUIT_COMMAND: Record<string, string> = { pi: "/quit", claude: "/exit" };

export async function closeSessionGracefully(session: Session, timeoutMs = 10000): Promise<CloseResult> {
  const pane = await livePaneFor(session);
  if (!pane) return "gone";
  await typeAndEnter(pane.pane_id, QUIT_COMMAND[session.harness] ?? "/exit").catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await Bun.sleep(400);
    const now = await getPane(pane.pane_id);
    if (!now) return "closed";
    if (!now.agent) {
      await closePane(pane.pane_id);
      return "closed";
    }
  }
  return "still-running";
}

export async function forceCloseSession(session: Session): Promise<void> {
  if (session.pane_id) await closePane(session.pane_id);
}

export function preferredSpace(card: Card): Space | null {
  const d = db();
  const spaces = d.spaces(card.id);
  if (!spaces.length) return null;
  const sessions = d.sessions(card.id).filter((s) => s.space_id !== null).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  const used = sessions.map((s) => spaces.find((sp) => sp.id === s.space_id)).find(Boolean);
  if (used) return used;
  return [...spaces].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
}
