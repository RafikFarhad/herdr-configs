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

export interface WorkspaceWorktree {
  repo_key?: string;
  repo_root?: string;
  checkout_path?: string;
  is_linked_worktree?: boolean;
}

export interface Workspace {
  workspace_id: string;
  label: string;
  focused?: boolean;
  pane_count?: number;
  worktree?: WorkspaceWorktree;
  tokens?: Record<string, string>;
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

export async function getPane(paneId: string): Promise<Pane | null> {
  try {
    const res = await request<{ pane: Pane }>("pane.get", { pane_id: paneId }, 5000);
    return res.pane ?? null;
  } catch {
    return null;
  }
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const res = await request<{ workspaces: Workspace[] }>("workspace.list");
  return res.workspaces ?? [];
}

export async function createWorkspace(
  cwd: string,
  label: string,
  env: Record<string, string> = {},
  focus = false,
): Promise<{ workspaceId: string; rootPaneId: string | null }> {
  const res = await request<{ workspace: Workspace; root_pane?: Pane }>("workspace.create", { cwd, label, env, focus });
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

export async function worktreeOpen(repoRoot: string, path: string, label: string): Promise<string | null> {
  const res = await request<{ workspace?: Workspace }>("worktree.open", { cwd: repoRoot, path, label, focus: false }, 30000);
  return res.workspace?.workspace_id ?? findWorkspaceId(res);
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

export async function waitAgent(target: string, until: string[], timeoutMs: number): Promise<string | null> {
  const res = await request<{ agent?: { agent_status?: string } }>("agent.wait", { target, until, timeout_ms: timeoutMs }, timeoutMs + 5000);
  return res.agent?.agent_status ?? null;
}

export async function promptAgent(target: string, text: string): Promise<void> {
  await request("agent.prompt", { target, text }, 30000);
}

export async function typeAndEnter(paneId: string, text: string): Promise<void> {
  await request("pane.send_input", { pane_id: paneId, text, keys: ["enter"] }, 10000);
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

export async function splitPane(paneId: string, direction: "right" | "down", cwd: string, env: Record<string, string> = {}): Promise<string> {
  const res = await request<{ pane: Pane }>("pane.split", { target_pane_id: paneId, direction, cwd, env, focus: false });
  return res.pane.pane_id;
}

export async function renameTab(tabId: string, label: string): Promise<void> {
  await request("tab.rename", { tab_id: tabId, label });
}

export async function reportWorkspaceTokens(workspaceId: string, tokens: Record<string, string | null>): Promise<void> {
  await request("workspace.report_metadata", { workspace_id: workspaceId, source: "herdr-deck", tokens });
}

export async function paneShellPid(paneId: string): Promise<number | null> {
  const res = await request<{ process_info?: { shell_pid?: number } }>("pane.process_info", { pane_id: paneId });
  return res.process_info?.shell_pid ?? null;
}

export async function closePane(paneId: string): Promise<void> {
  await request("pane.close", { pane_id: paneId }).catch(() => {});
}

export async function closeWorkspace(workspaceId: string): Promise<void> {
  await request("workspace.close", { workspace_id: workspaceId });
}

export type EventHandler = (ev: HerdrEvent) => void;

function isHerdrEvent(msg: Record<string, unknown>): msg is Record<string, unknown> & HerdrEvent {
  return typeof msg.event === "string" && typeof msg.data === "object" && msg.data !== null;
}

export type Subscription = string | ({ type: string } & Record<string, unknown>);

export async function subscribe(types: Subscription[], onEvent: EventHandler, onClose: (err?: Error) => void): Promise<{ close(): void }> {
  let buf = "";
  let started = false;
  const id = nextId();
  const sock = await Bun.connect({
    unix: socketPath(),
    socket: {
      open(s) {
        const subscriptions = types.map((t) => (typeof t === "string" ? { type: t } : t));
        s.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n");
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
