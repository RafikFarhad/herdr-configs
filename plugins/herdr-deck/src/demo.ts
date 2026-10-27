import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config";
import { db, type AgentStatus, type CardStatus } from "./db";

interface DemoSession {
  status: AgentStatus;
  title: string;
  closedDaysAgo?: number;
}

interface DemoCard {
  title: string;
  description: string;
  status: CardStatus;
  blockedReason?: string;
  spacePath?: string;
  sessions?: DemoSession[];
  staleDays?: number;
  repo?: string;
}

const CARDS: DemoCard[] = [
  {
    repo: "web",
    title: "[demo] Needs you: the agent asked a question",
    description: "An open session is blocked waiting for your answer.",
    status: "active",
    sessions: [{ status: "blocked", title: "should I keep the old config flag?" }],
  },
  {
    repo: "web",
    title: "[demo] Working: an agent is busy",
    description: "An open session is working right now.",
    status: "active",
    sessions: [
      { status: "working", title: "implement the parser" },
      { status: "idle", title: "review the diff" },
    ],
  },
  {
    repo: "infra",
    title: "[demo] Error: the worktree was removed",
    description: "One of the card's spaces no longer exists on disk.",
    status: "active",
    spacePath: "/nonexistent/herdr-deck-demo/.worktrees/3-removed",
  },
  {
    repo: "api",
    title: "[demo] Warning: blocked on review",
    description: "Blocked by hand with a reason.",
    status: "blocked",
    blockedReason: "waiting on security review",
  },
  {
    repo: "infra",
    title: "[demo] Open: a session is idle",
    description: "An open session is idle, nothing needs attention.",
    status: "active",
    sessions: [{ status: "idle", title: "explain the retry logic" }],
  },
  {
    repo: "api",
    title: "[demo] Parked: sessions exist, none open",
    description: "Work happened, every session is closed.",
    status: "active",
    sessions: [
      { status: "idle", title: "review the migration plan", closedDaysAgo: 2 },
      { status: "idle", title: "draft the module layout", closedDaysAgo: 3 },
    ],
  },
  {
    title: "[demo] Not started: no sessions yet",
    description: "A card waiting for its first session.",
    status: "todo",
  },
  {
    repo: "web",
    title: "[demo] Done: shipped",
    description: "Finished work.",
    status: "done",
  },
];

export function seedDemo(): void {
  const d = db();
  let pane = 0;
  for (const spec of CARDS) {
    const card = d.createCard(spec.title, spec.description);
    d.updateCard(card.id, { status: spec.status, blocked_reason: spec.blockedReason ?? null });
    if (!spec.repo) continue;
    const repoDir = join(dataDir, "repos", spec.repo);
    mkdirSync(repoDir, { recursive: true });
    const path = spec.spacePath ?? repoDir;
    const space = d.createSpace({
      card_id: card.id,
      kind: spec.spacePath ? "worktree" : "checkout",
      repo_root: repoDir,
      path,
      branch: spec.spacePath ? "demo/3-removed" : null,
      label: spec.spacePath ? "removed-worktree" : spec.repo,
    });
    for (const s of spec.sessions ?? []) {
      pane += 1;
      const closed = s.closedDaysAgo !== undefined;
      const row = d.insertSession({
        card_id: card.id,
        space_id: space.id,
        harness: "pi",
        ref_kind: "path",
        ref: `/nonexistent/herdr-deck-demo/session-${card.id}-${pane}.jsonl`,
        cwd: path,
        title: s.title,
        parent_id: null,
        pane_id: closed ? null : `demo:p${pane}`,
        workspace_id: closed ? null : "demo",
        agent_status: closed ? null : s.status,
      });
      if (closed) {
        const when = new Date(Date.now() - (s.closedDaysAgo ?? 0) * 86400000).toISOString().replace("T", " ").slice(0, 19);
        d.updateSession(row.id, { last_seen: when, closed_at: when });
      }
    }
  }
}
