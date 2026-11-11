import { existsSync, readdirSync, statSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, absPath, dataDir, isSharedWorktreeDir, worktreePath, type Harness } from "./config";
import { db, type Card, type Session, type Space } from "./db";
import {
  closePane,
  closeWorkspace,
  createTab,
  createWorkspace,
  focusPane,
  getPane,
  listPanes,
  listWorkspaces,
  promptAgent,
  renameTab,
  reportWorkspaceTokens,
  splitPane,
  startAgent,
  typeAndEnter,
  waitAgent,
  worktreeCreate,
  worktreeOpen,
  type Pane,
  type Workspace,
} from "./herdr";
import { forkArgs, resumeArgs, sessionExists } from "./sessions";

export interface Repo {
  name: string;
  path: string;
}

export function listRepos(): Repo[] {
  const cfg = loadConfig();
  const sharedRoot = isSharedWorktreeDir(cfg.worktreeDir) ? absPath(cfg.worktreeDir) : null;
  const repos: Repo[] = [];
  for (const root of cfg.roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const path = join(root, entry);
      if (sharedRoot && path === sharedRoot) continue;
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

export function mainCheckout(path: string): string | null {
  const r = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!r.ok) return null;
  return basename(r.out) === ".git" ? dirname(r.out) : null;
}

function isMainCheckoutRoot(path: string): boolean {
  const dotGit = join(path, ".git");
  return existsSync(dotGit) && statSync(dotGit).isDirectory();
}

export function deckEnv(cardId: number): Record<string, string> {
  return { DECK_CARD_ID: String(cardId), DECK_DATA_DIR: dataDir };
}

async function markWorkspace(workspaceId: string | null): Promise<void> {
  if (workspaceId) await reportWorkspaceTokens(workspaceId, { deck_data: dataDir }).catch(() => {});
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
  const path = worktreePath(cfg, repo, name);
  const label = `${basename(repo)} #${card.id}`;
  if (isSharedWorktreeDir(cfg.worktreeDir)) mkdirSync(dirname(path), { recursive: true });
  else if (cfg.worktreeDir && !cfg.worktreeDir.startsWith("..")) excludeDir(repo, cfg.worktreeDir);
  let workspaceId: string | null = null;
  if (existsSync(path)) {
    workspaceId = await worktreeOpen(repo, path, label);
  } else {
    const exists = git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
    if (exists) {
      const r = git(repo, ["worktree", "add", path, branch]);
      if (!r.ok) throw new Error(`git worktree add: ${r.out}`);
      workspaceId = await worktreeOpen(repo, path, label);
    } else {
      const res = await worktreeCreate({ cwd: repo, branch, path, label, base });
      workspaceId = res.workspaceId;
    }
  }
  await markWorkspace(workspaceId);
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

export async function ensureSpaceWorkspace(space: Space): Promise<string> {
  if (space.removed_at) throw new Error(`the worktree ${space.label} was deleted when the card was done (branch ${space.branch ?? "?"} is kept)`);
  if (!existsSync(space.path)) throw new Error(`${space.path} no longer exists`);
  const workspaces = await listWorkspaces();
  if (space.workspace_id && workspaces.some((w) => w.workspace_id === space.workspace_id)) return space.workspace_id;
  const known = new Set(db().spaces().map((s) => s.workspace_id).filter((id): id is string => !!id));
  const ours = (w: Workspace): boolean => known.has(w.workspace_id) || w.tokens?.deck_data === dataDir;
  const panes = await listPanes();
  const inPath = (w: Workspace): boolean => panes.some((p) => p.workspace_id === w.workspace_id && (p.cwd === space.path || p.foreground_cwd === space.path));
  const match = workspaces.find((w) => w.worktree?.checkout_path === space.path) ?? workspaces.find((w) => ours(w) && inPath(w));
  let wsId: string | null = match?.workspace_id ?? null;
  if (!wsId && (space.kind === "worktree" || isMainCheckoutRoot(space.path))) {
    wsId = await worktreeOpen(mainCheckout(space.path) ?? space.repo_root, space.path, space.label).catch(() => null);
  }
  if (!wsId) wsId = (await createWorkspace(space.path, space.label, deckEnv(space.card_id))).workspaceId;
  await markWorkspace(wsId);
  db().setSpaceWorkspace(space.id, wsId);
  return wsId;
}

const BRIEF_READY_TIMEOUT_MS = 60000;

async function waitUntilReady(agentName: string): Promise<string | null> {
  const deadline = Date.now() + BRIEF_READY_TIMEOUT_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${agentName} was not ready within ${BRIEF_READY_TIMEOUT_MS / 1000}s`);
    try {
      return await waitAgent(agentName, ["idle", "done", "blocked"], Math.max(left, 3001));
    } catch (err) {
      if (!/not found/i.test((err as Error).message)) throw err;
      await Bun.sleep(500);
    }
  }
}

async function sendBrief(agentName: string, text: string): Promise<void> {
  const status = await waitUntilReady(agentName);
  if (status === "blocked") throw new Error("the agent is waiting at a question or approval prompt");
  await promptAgent(agentName, text);
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
  tabSuffix?: string;
}

export function tabTitle(card: Card, harness: Harness, suffix?: string): string {
  const title = card.title.trim().replace(/\s+/g, " ");
  return [`#${card.id}`, harness, title, suffix].filter((p): p is string => !!p).join(" :: ");
}

async function unusedFirstPane(wsId: string): Promise<Pane | null> {
  const panes = (await listPanes()).filter((p) => p.workspace_id === wsId);
  if (panes.length !== 1) return null;
  const root = panes[0]!;
  if (root.agent || root.agent_session) return null;
  if (db().openSessions().some((s) => s.pane_id === root.pane_id)) return null;
  return root;
}

async function addCliPane(root: Pane, cwd: string, cardId: number): Promise<void> {
  await splitPane(root.pane_id, "right", cwd, deckEnv(cardId)).catch(() => {});
}

export async function startSession(opts: StartOptions): Promise<Pane | null> {
  const wsId = await ensureSpaceWorkspace(opts.space);
  const label = tabTitle(opts.card, opts.harness, opts.tabSuffix);
  const root = await unusedFirstPane(wsId);
  if (root) await renameTab(root.tab_id, label).catch(() => {});
  const paneId = root ? root.pane_id : (await createTab(wsId, opts.space.path, label, deckEnv(opts.card.id), false)).paneId;
  db().addLaunch({ pane_id: paneId, card_id: opts.card.id, space_id: opts.space.id, parent_session_id: opts.parent?.id ?? null });
  const agentName = `deck-${opts.card.id}-${Date.now().toString(36)}`;
  try {
    await startAgent(paneId, opts.harness, agentName, opts.args ?? []);
  } catch (err) {
    db().dropLaunch(paneId);
    if (!root) await closePane(paneId);
    throw err;
  }
  if (root) await addCliPane(root, opts.space.path, opts.card.id);
  let briefError: string | null = null;
  if (opts.brief) {
    await sendBrief(agentName, cardBrief(opts.card)).catch((err: Error) => {
      briefError = err.message;
    });
  }
  db().activateCard(opts.card.id);
  const pane = (await listPanes()).find((p) => p.pane_id === paneId) ?? null;
  if (pane && opts.focus !== false) await focusPane(pane);
  if (briefError) throw new Error(`${opts.harness} started, but the brief was not sent: ${briefError}`);
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
  const pane = await startSession({ card, space, harness: session.harness, args: resumeArgs(session), tabSuffix: "resume" });
  return pane ? `resumed in ${pane.pane_id}` : "resumed";
}

export async function forkSession(session: Session): Promise<string> {
  if (!sessionExists(session)) throw new Error("the session file is gone, nothing to fork");
  const card = session.card_id ? db().card(session.card_id) : null;
  if (!card) throw new Error("file this session under a card first (m)");
  const space = spaceForSession(session) ?? (await adhocSpace(session, card));
  const pane = await startSession({ card, space, harness: session.harness, args: forkArgs(session), parent: session, tabSuffix: "fork" });
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

export interface WorktreeCheck {
  space: Space;
  exists: boolean;
  uncommitted: number;
  unpushed: number;
  neverPushed: boolean;
  openSessions: Session[];
}

export function inspectWorktrees(card: Card): WorktreeCheck[] {
  const d = db();
  const sessions = d.sessions(card.id);
  return d
    .spaces(card.id)
    .filter((s) => s.kind === "worktree" && !s.removed_at)
    .map((space) => {
      const exists = existsSync(space.path);
      const openSessions = sessions.filter((s) => s.space_id === space.id && s.pane_id !== null && s.closed_at === null);
      if (!exists) return { space, exists, uncommitted: 0, unpushed: 0, neverPushed: false, openSessions };
      const status = git(space.path, ["status", "--porcelain"]);
      const uncommitted = status.ok ? status.out.split("\n").filter((l) => l.trim()).length : 0;
      const local = git(space.path, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
      const unpushed = local.ok ? Number(local.out) || 0 : 0;
      const upstream = git(space.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      return { space, exists, uncommitted, unpushed, neverPushed: !upstream.ok, openSessions };
    });
}

export async function deleteWorktree(check: WorktreeCheck): Promise<string> {
  const { space } = check;
  for (const s of check.openSessions) {
    const result = await closeSessionGracefully(s, 5000);
    if (result === "still-running") await forceCloseSession(s);
  }
  let workspaceNote = "no workspace was open";
  if (space.workspace_id) {
    const panes = (await listPanes()).filter((p) => p.workspace_id === space.workspace_id);
    const inside = (p: Pane) => [p.cwd, p.foreground_cwd].some((c) => c === space.path || (c ?? "").startsWith(`${space.path}/`));
    if (panes.length && panes.every(inside)) {
      await closeWorkspace(space.workspace_id).catch(() => {});
      workspaceNote = "workspace closed";
    } else if (panes.length) {
      for (const p of panes.filter(inside)) await closePane(p.pane_id);
      workspaceNote = "its panes closed, the workspace has other panes so it was kept";
    }
  }
  if (check.exists) {
    const force = check.uncommitted > 0 ? ["--force"] : [];
    const r = git(space.repo_root, ["worktree", "remove", ...force, space.path]);
    if (!r.ok) throw new Error(`git worktree remove: ${r.out}`);
  }
  git(space.repo_root, ["worktree", "prune"]);
  db().markSpaceRemoved(space.id);
  return workspaceNote;
}

export function preferredSpace(card: Card): Space | null {
  const d = db();
  const spaces = d.spaces(card.id).filter((s) => !s.removed_at);
  if (!spaces.length) return null;
  const sessions = d.sessions(card.id).filter((s) => s.space_id !== null).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  const used = sessions.map((s) => spaces.find((sp) => sp.id === s.space_id)).find(Boolean);
  if (used) return used;
  return [...spaces].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
}
