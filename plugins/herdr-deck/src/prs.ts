import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { db, type Space } from "./db";

export interface PullRequest {
  number: number;
  state: string;
  url: string;
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function spaceBranch(space: Space): string | null {
  if (!existsSync(space.path)) return space.branch;
  const current = git(space.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = current && current !== "HEAD" ? current : space.branch;
  if (!branch || DEFAULT_BRANCHES.has(branch)) return null;
  const head = git(space.path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head && head.replace(/^origin\//, "") === branch) return null;
  return branch;
}

export async function findPullRequest(space: Space, branch: string): Promise<PullRequest | null | undefined> {
  const cwd = existsSync(space.path) ? space.path : space.repo_root;
  if (!existsSync(cwd)) return undefined;
  const proc = Bun.spawn(["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,url"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 20000);
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) return undefined;
  try {
    const list = JSON.parse(out) as PullRequest[];
    return list[0] ?? null;
  } catch {
    return undefined;
  }
}

export async function refreshPullRequests(): Promise<number> {
  const d = db();
  let changed = 0;
  for (const space of d.spaces()) {
    const card = d.card(space.card_id);
    if (!card || card.archived_at || card.status === "done") continue;
    const branch = spaceBranch(space);
    const pr = branch ? await findPullRequest(space, branch) : null;
    if (pr === undefined) continue;
    if (pr?.number === space.pr_number && pr?.state === space.pr_state && pr?.url === space.pr_url) continue;
    if (!pr && space.pr_number === null) continue;
    d.setSpacePr(space.id, pr);
    changed += 1;
  }
  return changed;
}
