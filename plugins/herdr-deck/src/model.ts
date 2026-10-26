import type { Card, Session, Space } from "./db";

export type Group = "needs" | "active" | "blocked" | "todo" | "done";

export const GROUPS: { id: Group; label: string }[] = [
  { id: "needs", label: "NEEDS YOU" },
  { id: "active", label: "IN PROGRESS" },
  { id: "blocked", label: "BLOCKED" },
  { id: "todo", label: "TODO" },
  { id: "done", label: "DONE" },
];

export function isOpen(s: Session): boolean {
  return s.pane_id !== null && s.closed_at === null;
}

export function groupOf(card: Card, sessions: Session[]): Group {
  if (card.status === "done") return "done";
  if (sessions.some((s) => isOpen(s) && s.agent_status === "blocked")) return "needs";
  if (card.status === "blocked") return "blocked";
  if (card.status === "todo") return "todo";
  return "active";
}

export function latestSession(sessions: Session[]): Session | null {
  const byRecent = [...sessions].sort((a, b) => b.last_seen.localeCompare(a.last_seen) || b.id - a.id);
  return byRecent.find(isOpen) ?? byRecent[0] ?? null;
}

export function needsYou(sessions: Session[]): boolean {
  return sessions.some((s) => isOpen(s) && s.agent_status === "blocked");
}

export function liveMark(sessions: Session[]): "working" | "blocked" | "open" | "none" {
  const open = sessions.filter(isOpen);
  if (open.some((s) => s.agent_status === "blocked")) return "blocked";
  if (open.some((s) => s.agent_status === "working")) return "working";
  if (open.length) return "open";
  return "none";
}

export interface SessionNode {
  session: Session;
  depth: number;
}

export function orderSessions(sessions: Session[]): SessionNode[] {
  const ids = new Set(sessions.map((s) => s.id));
  const children = new Map<number, Session[]>();
  const roots: Session[] = [];
  for (const s of sessions) {
    if (s.parent_id !== null && ids.has(s.parent_id)) {
      const list = children.get(s.parent_id) ?? [];
      list.push(s);
      children.set(s.parent_id, list);
    } else {
      roots.push(s);
    }
  }
  const out: SessionNode[] = [];
  const walk = (s: Session, depth: number) => {
    out.push({ session: s, depth });
    for (const c of children.get(s.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

export interface SpaceBlock {
  space: Space | null;
  sessions: SessionNode[];
}

export function spaceBlocks(spaces: Space[], sessions: Session[]): SpaceBlock[] {
  const known = new Set(spaces.map((s) => s.id));
  const blocks: SpaceBlock[] = spaces.map((space) => ({
    space,
    sessions: orderSessions(sessions.filter((s) => s.space_id === space.id)),
  }));
  const loose = sessions.filter((s) => s.space_id === null || !known.has(s.space_id));
  if (loose.length) blocks.push({ space: null, sessions: orderSessions(loose) });
  return blocks;
}

export function ago(sqlTime: string | null): string {
  if (!sqlTime) return "";
  const t = Date.parse(`${sqlTime.replace(" ", "T")}Z`);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function shortPath(path: string | null, repoRoot?: string | null): string {
  if (!path) return "";
  const home = process.env.HOME ?? "";
  if (repoRoot && path.startsWith(`${repoRoot}/`)) return path.slice(repoRoot.length + 1);
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}
