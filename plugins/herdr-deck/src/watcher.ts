import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { spawn } from "node:child_process";
import { dataDir, ensureDataDir } from "./config";
import { db, type Session, type Space, type AgentStatus } from "./db";
import { listPanes, listWorkspaces, request, subscribe, type Pane } from "./herdr";
import { isHarness, readSessionInfo } from "./sessions";

const pidFile = join(dataDir, "watch.pid");
const logFile = join(dataDir, "watch.log");

const AGENT_STATUSES: AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

function agentStatus(value: unknown): AgentStatus | null {
  return AGENT_STATUSES.includes(value as AgentStatus) ? (value as AgentStatus) : null;
}

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    writeFileSync(logFile, line, { flag: "a" });
  } catch (err) {
    process.stderr.write(`deck: cannot write log: ${(err as Error).message}\n`);
  }
}

export function watcherPid(): number | null {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function ensureWatcher(entry: string): number {
  const running = watcherPid();
  if (running) return running;
  ensureDataDir();
  const child = spawn(process.execPath, [entry, "watch"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child.pid ?? 0;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

interface Attribution {
  cardId: number | null;
  spaceId: number | null;
  parentId: number | null;
  how: string;
}

function spaceForCwd(cardId: number, cwd: string | null): number | null {
  if (!cwd) return null;
  let best: Space | null = null;
  for (const s of db().spaces(cardId)) {
    if (isInside(cwd, s.path) && (!best || s.path.length > best.path.length)) best = s;
  }
  return best?.id ?? null;
}

function attribute(pane: Pane, harness: string, cwd: string | null, parentRef: string | null, previous: Session | null): Attribution {
  const d = db();
  const launch = d.takeLaunch(pane.pane_id);
  if (launch && d.card(launch.card_id)) {
    return { cardId: launch.card_id, spaceId: launch.space_id, parentId: launch.parent_session_id, how: "launch" };
  }
  if (parentRef) {
    const parent = d.sessionByRef(harness, parentRef);
    if (parent) return { cardId: parent.card_id, spaceId: parent.space_id, parentId: parent.id, how: "fork" };
  }
  if (previous?.card_id) {
    return { cardId: previous.card_id, spaceId: previous.space_id, parentId: null, how: "same pane" };
  }
  const cards = d.cards().filter((c) => c.status !== "done");
  const live = new Set(cards.map((c) => c.id));
  const spaces = d.spaces().filter((s) => live.has(s.card_id));
  const byWorkspace = spaces.filter((s) => s.workspace_id === pane.workspace_id);
  const wsCards = new Set(byWorkspace.map((s) => s.card_id));
  if (wsCards.size === 1) {
    const cardId = byWorkspace[0].card_id;
    return { cardId, spaceId: spaceForCwd(cardId, cwd) ?? byWorkspace[0].id, parentId: null, how: "workspace" };
  }
  if (cwd) {
    let bestLen = -1;
    let bestCards = new Set<number>();
    let bestSpace: Space | null = null;
    for (const s of spaces) {
      if (!isInside(cwd, s.path)) continue;
      if (s.path.length > bestLen) {
        bestLen = s.path.length;
        bestCards = new Set([s.card_id]);
        bestSpace = s;
      } else if (s.path.length === bestLen) {
        bestCards.add(s.card_id);
      }
    }
    if (bestSpace && bestCards.size === 1) {
      return { cardId: bestSpace.card_id, spaceId: bestSpace.id, parentId: null, how: "cwd" };
    }
  }
  return { cardId: null, spaceId: null, parentId: null, how: "inbox" };
}

export function handlePane(pane: Pane): void {
  const d = db();
  const ref = pane.agent_session;
  const harness = ref?.agent ?? pane.agent;
  if (!ref || !isHarness(harness) || !ref.value) {
    if (!pane.agent) d.closeSessionsOnPane(pane.pane_id);
    return;
  }
  trackPane(pane.pane_id);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const status = agentStatus(pane.agent_status);
  const existing = d.sessionByRef(harness, ref.value);
  if (existing) {
    const fields: Partial<Session> = {
      pane_id: pane.pane_id,
      workspace_id: pane.workspace_id,
      agent_status: status,
      last_seen: now,
      closed_at: null,
    };
    if (!existing.title) {
      const info = readSessionInfo(existing);
      if (info.title) fields.title = info.title;
      if (!existing.cwd && info.cwd) fields.cwd = info.cwd;
    }
    d.updateSession(existing.id, fields);
    d.closeSessionsOnPane(pane.pane_id, existing.id);
    if (existing.card_id === null) {
      const launch = d.takeLaunch(pane.pane_id);
      if (launch) d.assignSession(existing.id, launch.card_id, launch.space_id);
    }
    if (existing.space_id) d.setSpaceWorkspace(existing.space_id, pane.workspace_id);
    return;
  }
  const previous = d.openSessionOnPane(pane.pane_id);
  const info = readSessionInfo({ harness, ref_kind: ref.kind, ref: ref.value });
  const cwd = info.cwd ?? pane.foreground_cwd ?? pane.cwd ?? null;
  const who = attribute(pane, harness, cwd, info.parentRef, previous);
  const created = d.insertSession({
    card_id: who.cardId,
    space_id: who.spaceId,
    harness,
    ref_kind: ref.kind,
    ref: ref.value,
    cwd,
    title: info.title,
    parent_id: who.parentId,
    pane_id: pane.pane_id,
    workspace_id: pane.workspace_id,
    agent_status: status,
  });
  d.closeSessionsOnPane(pane.pane_id, created.id);
  if (who.cardId !== null) d.activateCard(who.cardId);
  if (who.spaceId !== null) d.setSpaceWorkspace(who.spaceId, pane.workspace_id);
  log(`session #${created.id} ${harness} ${ref.value} -> ${who.cardId === null ? "inbox" : `card #${who.cardId}`} (${who.how})`);
}

export async function reconcile(): Promise<void> {
  const d = db();
  const [panes, workspaces] = await Promise.all([listPanes(), listWorkspaces()]);
  const livePanes = new Set(panes.map((p) => p.pane_id));
  for (const pane of panes) handlePane(pane);
  for (const s of d.openSessions()) {
    if (s.pane_id && !livePanes.has(s.pane_id)) d.closeSessionsOnPane(s.pane_id);
  }
  const liveWs = new Set(workspaces.map((w) => w.workspace_id));
  for (const sp of d.spaces()) {
    if (sp.workspace_id && !liveWs.has(sp.workspace_id)) d.setSpaceWorkspace(sp.id, null);
  }
  d.pruneLaunches();
}

const statusSubs = new Map<string, { close(): void }>();
let trackStatuses = false;

function onStatusChanged(data: Record<string, unknown>): void {
  const paneId = typeof data.pane_id === "string" ? data.pane_id : null;
  const status = agentStatus(data.agent_status);
  if (!paneId) return;
  const session = db().openSessionOnPane(paneId);
  if (!session) return;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  db().updateSession(session.id, { agent_status: status, last_seen: now });
}

function trackPane(paneId: string): void {
  if (!trackStatuses || statusSubs.has(paneId)) return;
  statusSubs.set(paneId, { close: () => {} });
  subscribe(
    [{ type: "pane.agent_status_changed", pane_id: paneId }],
    (ev) => {
      try {
        onStatusChanged(ev.data);
      } catch (err) {
        log(`status ${paneId}: ${(err as Error).message}`);
      }
    },
    () => {
      statusSubs.delete(paneId);
    },
  )
    .then((sub) => {
      if (statusSubs.has(paneId)) statusSubs.set(paneId, sub);
      else sub.close();
    })
    .catch((err) => {
      statusSubs.delete(paneId);
      log(`status subscribe ${paneId}: ${(err as Error).message}`);
    });
}

function untrackPane(paneId: string): void {
  const sub = statusSubs.get(paneId);
  statusSubs.delete(paneId);
  sub?.close();
}

function untrackAll(): void {
  for (const id of [...statusSubs.keys()]) untrackPane(id);
}

async function refreshPane(paneId: string): Promise<void> {
  const res = await request<{ pane: Pane }>("pane.get", { pane_id: paneId });
  if (res.pane) handlePane(res.pane);
}

function handleEvent(event: string, data: Record<string, unknown>): void {
  const d = db();
  if (event === "pane_created" || event === "pane_updated" || event === "pane_agent_detected") {
    const pane = data.pane as Pane | undefined;
    if (pane?.pane_id) handlePane(pane);
    else if (typeof data.pane_id === "string") {
      const id = data.pane_id;
      refreshPane(id).catch((err) => log(`pane.get ${id}: ${(err as Error).message}`));
    }
    return;
  }
  if (event === "pane_agent_status_changed") {
    onStatusChanged(data);
    return;
  }
  if (event === "pane_closed" || event === "pane_exited") {
    const paneId = data.pane_id as string | undefined;
    if (paneId) {
      d.closeSessionsOnPane(paneId);
      if (event === "pane_closed") {
        d.dropLaunch(paneId);
        untrackPane(paneId);
      }
    }
    return;
  }
  if (event === "workspace_closed") {
    const wsId = (data.workspace_id as string | undefined) ?? (data.workspace as { workspace_id?: string } | undefined)?.workspace_id;
    if (!wsId) return;
    for (const s of d.openSessions()) if (s.workspace_id === wsId && s.pane_id) d.closeSessionsOnPane(s.pane_id);
    for (const sp of d.spaces()) if (sp.workspace_id === wsId) d.setSpaceWorkspace(sp.id, null);
  }
}

const EVENT_TYPES = ["pane.created", "pane.updated", "pane.closed", "pane.exited", "pane.agent_detected", "workspace.closed"];

export async function runWatcher(): Promise<void> {
  ensureDataDir();
  const other = watcherPid();
  if (other && other !== process.pid) {
    process.stdout.write(`deck watch already running (pid ${other})\n`);
    return;
  }
  writeFileSync(pidFile, String(process.pid));
  let stopping = false;
  let wake: () => void = () => {};
  const cleanup = () => {
    stopping = true;
    wake();
    try {
      if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) unlinkSync(pidFile);
    } catch (err) {
      log(`cleanup: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  trackStatuses = true;
  log(`watcher started pid ${process.pid}`);

  while (!stopping) {
    let closed: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      closed = resolve;
      wake = resolve;
    });
    try {
      await reconcile();
      const sub = await subscribe(
        EVENT_TYPES,
        (ev) => {
          try {
            handleEvent(ev.event, ev.data);
          } catch (err) {
            log(`event ${ev.event}: ${(err as Error).message}`);
          }
        },
        (err) => {
          if (err) log(`subscription closed: ${err.message}`);
          closed();
        },
      );
      const timer = setInterval(() => {
        reconcile().catch((err) => log(`reconcile: ${(err as Error).message}`));
      }, 20000);
      await done;
      clearInterval(timer);
      sub.close();
      untrackAll();
    } catch (err) {
      log(`herdr unavailable: ${(err as Error).message}`);
    }
    if (!stopping) await Bun.sleep(3000);
  }
}
