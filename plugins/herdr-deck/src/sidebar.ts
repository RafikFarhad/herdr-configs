import { dataDir } from "./config";
import { db, type Card } from "./db";
import { listWorkspaces, reportWorkspaceTokens } from "./herdr";
import { liveMark } from "./model";

const STATUS_TEXT: Record<Card["status"], string> = {
  todo: "todo",
  active: "in progress",
  blocked: "blocked",
  done: "done",
};

export function cardToken(card: Card): string {
  const mark = liveMark(db().sessions(card.id));
  if (card.status !== "done" && mark === "blocked") return `#${card.id} \u00b7 needs you`;
  if (card.status !== "done" && mark === "working") return `#${card.id} \u00b7 working`;
  return `#${card.id} \u00b7 ${STATUS_TEXT[card.status]}`;
}

export function desiredCardTokens(): Map<string, string> {
  const d = db();
  const byWorkspace = new Map<string, Card[]>();
  for (const space of d.spaces()) {
    if (!space.workspace_id || space.removed_at) continue;
    const card = d.card(space.card_id);
    if (!card || card.archived_at || card.status === "done") continue;
    const list = byWorkspace.get(space.workspace_id) ?? [];
    if (!list.some((c) => c.id === card.id)) list.push(card);
    byWorkspace.set(space.workspace_id, list);
  }
  const out = new Map<string, string>();
  for (const [wsId, cards] of byWorkspace) {
    cards.sort((a, b) => a.id - b.id);
    out.set(wsId, cards.map(cardToken).join("  "));
  }
  return out;
}

export async function publishCardTokens(): Promise<number> {
  const want = desiredCardTokens();
  let pushed = 0;
  for (const w of await listWorkspaces()) {
    const desired = want.get(w.workspace_id) ?? null;
    const current = w.tokens?.card ?? null;
    if (desired === current) continue;
    if (desired === null && w.tokens?.deck_data !== dataDir) continue;
    await reportWorkspaceTokens(w.workspace_id, desired === null ? { card: null } : { card: desired, deck_data: dataDir });
    pushed += 1;
  }
  return pushed;
}
