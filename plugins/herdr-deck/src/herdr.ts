import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentSessionRef {
  agent: string;
  kind: "path" | "id";
  value: string;
  source?: string;
}

export interface Pane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd?: string;
  foreground_cwd?: string;
  label?: string;
  agent?: string;
  agent_status?: string;
  agent_session?: AgentSessionRef;
  focused?: boolean;
}

export interface Workspace {
  workspace_id: string;
  label: string;
  focused?: boolean;
  pane_count?: number;
}

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export function socketPath(): string {
  return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

let counter = 0;

function nextId(): string {
  counter += 1;
  return `deck:${process.pid}:${Date.now()}:${counter}`;
}

export async function request<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15000,
): Promise<T> {
  const id = nextId();
  return new Promise<T>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (fn: () => void, sock?: { end(): void }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      sock?.end();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`herdr ${method} timed out`))), timeoutMs);
    Bun.connect({
      unix: socketPath(),
      socket: {
        open(sock) {
          sock.write(JSON.stringify({ id, method, params }) + "\n");
        },
        data(sock, chunk) {
          buf += new TextDecoder().decode(chunk);
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: { id?: string; result?: T; error?: { code: string; message: string } };
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.id !== id) continue;
            if (msg.error) finish(() => reject(new Error(`herdr ${method}: ${msg.error!.message}`)), sock);
            else finish(() => resolve(msg.result as T), sock);
          }
        },
        error(_sock, err) {
          finish(() => reject(err));
        },
        close() {
          finish(() => reject(new Error(`herdr ${method}: connection closed`)));
        },
      },
    }).catch((err) => finish(() => reject(err)));
  });
}

export async function listPanes(): Promise<Pane[]> {
  const res = await request<{ panes: Pane[] }>("pane.list");
  return res.panes ?? [];
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const res = await request<{ workspaces: Workspace[] }>("workspace.list");
  return res.workspaces ?? [];
}

export async function createWorkspace(cwd: string, label: string, focus = false): Promise<{ workspaceId: string; rootPaneId: string | null }> {
  const res = await request<{ workspace: Workspace; root_pane?: Pane }>("workspace.create", { cwd, label, focus });
  return { workspaceId: res.workspace.workspace_id, rootPaneId: res.root_pane?.pane_id ?? null };
}

export async function createTab(workspaceId: string, cwd: string, label: string, env: Record<string, string> = {}, focus = false): Promise<{ tabId: string; paneId: string }> {
  const res = await request<{ tab: { tab_id: string }; root_pane: Pane }>("tab.create", {
    workspace_id: workspaceId,
    cwd,
    label,
    env,
    focus,
  });
  return { tabId: res.tab.tab_id, paneId: res.root_pane.pane_id };
}

export async function worktreeCreate(params: {
  cwd: string;
  branch: string;
  path: string;
  label: string;
  base?: string | null;
}): Promise<{ workspaceId: string | null; path: string }> {
  const res = await request<Record<string, unknown>>(
    "worktree.create",
    { cwd: params.cwd, branch: params.branch, path: params.path, label: params.label, base: params.base ?? null, focus: false },
    60000,
  );
  return { workspaceId: findWorkspaceId(res), path: params.path };
}

export async function worktreeOpen(path: string, label: string): Promise<string | null> {
  const res = await request<Record<string, unknown>>("worktree.open", { path, label, focus: false }, 30000);
  return findWorkspaceId(res);
}

function findWorkspaceId(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.workspace_id === "string") return rec.workspace_id;
  for (const key of ["workspace", "worktree", "result"]) {
    const found = findWorkspaceId(rec[key]);
    if (found) return found;
  }
  for (const value of Object.values(rec)) {
    if (value && typeof value === "object") {
      const found = findWorkspaceId(value);
      if (found) return found;
    }
  }
  return null;
}

export async function startAgent(paneId: string, kind: string, name: string, args: string[]): Promise<void> {
  await request("agent.start", { pane_id: paneId, kind, name, args, timeout_ms: 60000 }, 70000);
}

export async function promptAgent(paneId: string, text: string): Promise<void> {
  await request("agent.prompt", { target: paneId, text }, 30000);
}

export async function focusWorkspace(workspaceId: string): Promise<void> {
  await request("workspace.focus", { workspace_id: workspaceId });
}

export async function focusTab(tabId: string): Promise<void> {
  await request("tab.focus", { tab_id: tabId });
}

export async function focusPane(pane: Pane): Promise<void> {
  await focusWorkspace(pane.workspace_id).catch(() => {});
  await focusTab(pane.tab_id).catch(() => {});
  await request("pane.focus", { pane_id: pane.pane_id });
}

export async function closePane(paneId: string): Promise<void> {
  await request("pane.close", { pane_id: paneId }).catch(() => {});
}

export type EventHandler = (ev: HerdrEvent) => void;

function isHerdrEvent(msg: Record<string, unknown>): msg is Record<string, unknown> & HerdrEvent {
  return typeof msg.event === "string" && typeof msg.data === "object" && msg.data !== null;
}

export async function subscribe(types: string[], onEvent: EventHandler, onClose: (err?: Error) => void): Promise<{ close(): void }> {
  let buf = "";
  let started = false;
  const id = nextId();
  const sock = await Bun.connect({
    unix: socketPath(),
    socket: {
      open(s) {
        s.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: types.map((type) => ({ type })) } }) + "\n");
      },
      data(_s, chunk) {
        buf += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id === id) {
            if (msg.error) onClose(new Error(`events.subscribe: ${JSON.stringify(msg.error)}`));
            else started = true;
            continue;
          }
          if (started && isHerdrEvent(msg)) onEvent(msg);
        }
      },
      error(_s, err) {
        onClose(err);
      },
      close() {
        onClose();
      },
    },
  });
  return { close: () => sock.end() };
}
