import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { absPath, isSharedWorktreeDir, loadConfig, worktreePath } from "./config";
import { db, type Card, type Session, type Space } from "./db";
import { excludeDir, git, mainCheckout, markWorkspace, slug } from "./actions";
import { worktreeOpen } from "./herdr";

export type TransferMode = "move" | "copy";
export type TransferTarget = "worktree" | "checkout";

export interface TransferCheck {
  source: Space;
  problems: string[];
  notes: string[];
  head: string | null;
  branch: string | null;
  defaultBranch: string | null;
  uncommitted: number;
  main: string | null;
  targets: TransferTarget[];
  checkoutBlocked: string | null;
  openSessions: Session[];
}

const IN_PROGRESS: [string, string][] = [
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
];

function inProgress(path: string): string | null {
  for (const [name, what] of IN_PROGRESS) {
    const p = git(path, ["rev-parse", "--path-format=absolute", "--git-path", name]);
    if (p.ok && existsSync(p.out)) return what;
  }
  return null;
}

function changedCount(path: string): number {
  const r = git(path, ["status", "--porcelain"]);
  return r.ok ? r.out.split("\n").filter((l) => l.trim()).length : 0;
}

function currentBranch(path: string): string | null {
  const r = git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.ok && r.out ? r.out : null;
}

function branchExists(repo: string, branch: string): boolean {
  return git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function defaultBranchOf(path: string): string | null {
  const head = git(path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out) return head.out.replace(/^origin\//, "");
  for (const b of ["main", "master"]) if (branchExists(path, b)) return b;
  return null;
}

function checkedOutElsewhere(repo: string, branch: string, except: string): string | null {
  const r = git(repo, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return null;
  let path: string | null = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}` && path && path !== except) return path;
  }
  return null;
}

export function inspectTransfer(source: Space, mode: TransferMode): TransferCheck {
  const check: TransferCheck = {
    source,
    problems: [],
    notes: [],
    head: null,
    branch: null,
    defaultBranch: null,
    uncommitted: 0,
    main: null,
    targets: [],
    checkoutBlocked: null,
    openSessions: db()
      .sessions(source.card_id)
      .filter((s) => s.space_id === source.id && s.pane_id !== null && s.closed_at === null),
  };
  if (source.removed_at) check.problems.push("this worktree was deleted when the card was done");
  if (source.moved_to !== null) check.problems.push("this space was already moved, act on the space it moved to");
  if (!existsSync(source.path)) check.problems.push(`${source.path} no longer exists`);
  if (check.problems.length) return check;
  const top = git(source.path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    check.problems.push("not a git repository");
    return check;
  }
  if (top.out !== source.path) check.problems.push(`the space is a subfolder of ${top.out}, only a repo root can be moved or copied`);
  const head = git(source.path, ["rev-parse", "HEAD"]);
  if (!head.ok) check.problems.push("the repository has no commits yet");
  else check.head = head.out;
  check.branch = currentBranch(source.path);
  if (!check.branch) check.problems.push("HEAD is detached, check out a branch first");
  const busy = inProgress(source.path);
  if (busy) check.problems.push(`${busy} is in progress, finish or abort it first`);
  const conflicts = git(source.path, ["diff", "--name-only", "--diff-filter=U"]);
  if (conflicts.ok && conflicts.out) check.problems.push("there are unresolved conflicts");
  check.uncommitted = changedCount(source.path);
  check.defaultBranch = defaultBranchOf(source.path);
  check.main = mainCheckout(source.path);
  check.targets.push("worktree");
  if (mode === "move") {
    if (source.kind !== "worktree" || !check.main) check.checkoutBlocked = "only a worktree can move back to the main checkout";
    else if (inProgress(check.main)) check.checkoutBlocked = "the main checkout has an operation in progress";
    else if (changedCount(check.main) > 0) check.checkoutBlocked = "the main checkout has uncommitted changes";
    else check.targets.push("checkout");
    if (check.openSessions.length) check.notes.push(`${check.openSessions.length} open session(s) on this space must close first`);
    if (source.kind === "checkout" && check.branch && check.branch === check.defaultBranch) {
      const ahead = git(source.path, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
      if (ahead.ok && Number(ahead.out) > 0) check.notes.push(`${check.branch} has ${ahead.out} commit(s) not on any remote; they come along on the new branch and stay on ${check.branch} too`);
    }
  }
  if (check.uncommitted) check.notes.push(`${check.uncommitted} uncommitted change(s) ${mode === "move" ? "move" : "are copied"} to the new folder`);
  check.notes.push("ignored files (.env, node_modules, build output) are not carried over");
  return check;
}

interface WorktreePlan {
  path: string;
  branch: string;
  label: string;
  reuse: boolean;
}

function planWorktree(card: Card, repo: string, reuseBranch: string | null): WorktreePlan {
  const cfg = loadConfig();
  const base = `${card.id}-${slug(card.title)}`;
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const path = worktreePath(cfg, repo, name);
    const branch = reuseBranch ?? `${cfg.branchPrefix}${name}`.toLowerCase();
    if (existsSync(path)) continue;
    if (!reuseBranch && branchExists(repo, branch)) continue;
    const label = `${basename(repo)} #${card.id}${n === 1 ? "" : ` (${n})`}`;
    return { path, branch, label, reuse: !!reuseBranch };
  }
  throw new Error("could not find a free worktree name");
}

function prepareDir(repo: string, path: string): void {
  const cfg = loadConfig();
  if (isSharedWorktreeDir(cfg.worktreeDir)) mkdirSync(dirname(path), { recursive: true });
  else if (cfg.worktreeDir && !cfg.worktreeDir.startsWith("..")) excludeDir(repo, cfg.worktreeDir);
}

function must(r: { ok: boolean; out: string }, what: string): string {
  if (!r.ok) throw new Error(`${what}: ${r.out}`);
  return r.out;
}

function stashTop(path: string, message: string): string {
  must(git(path, ["stash", "push", "--include-untracked", "-m", message]), "git stash push");
  const top = must(git(path, ["log", "-g", "-1", "--format=%H%x00%gs", "refs/stash"]), "read stash");
  const [oid, subject] = top.split("\u0000");
  if (!oid || !subject?.endsWith(message)) throw new Error("could not identify the backup stash");
  return oid;
}

function applyStash(path: string, oid: string): void {
  if (git(path, ["stash", "apply", "--index", oid]).ok) return;
  must(git(path, ["stash", "apply", oid]), "git stash apply");
}

function untrackedFiles(path: string): string[] {
  const r = git(path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return r.ok ? r.out.split("\u0000").filter(Boolean) : [];
}

function copyUntracked(from: string, to: string, files: string[]): void {
  for (const f of files) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    cpSync(join(from, f), join(to, f), { recursive: true, force: true, verbatimSymlinks: true });
  }
}

function addWorktree(repo: string, plan: WorktreePlan, base: string): void {
  prepareDir(repo, plan.path);
  const args = plan.reuse ? ["worktree", "add", plan.path, plan.branch] : ["worktree", "add", "-b", plan.branch, plan.path, base];
  must(git(repo, args), "git worktree add");
}

function dropWorktree(repo: string, plan: WorktreePlan): void {
  git(repo, ["worktree", "remove", "--force", plan.path]);
  git(repo, ["worktree", "prune"]);
  if (!plan.reuse) git(repo, ["branch", "-D", plan.branch]);
}

async function worktreeSpace(card: Card, repo: string, plan: WorktreePlan): Promise<Space> {
  const workspaceId = await worktreeOpen(repo, plan.path, plan.label).catch(() => null);
  await markWorkspace(workspaceId);
  return db().createSpace({ card_id: card.id, kind: "worktree", repo_root: repo, path: plan.path, branch: plan.branch, label: plan.label, workspace_id: workspaceId });
}

export interface TransferResult {
  space: Space;
  message: string;
}

export async function copyToWorktree(card: Card, check: TransferCheck): Promise<TransferResult> {
  const { source } = check;
  if (check.problems.length || !check.head) throw new Error(check.problems.join("; ") || "nothing to copy");
  const repo = check.main ?? source.repo_root;
  const plan = planWorktree(card, repo, null);
  const tracked = check.uncommitted ? must(git(source.path, ["stash", "create"]), "git stash create") : "";
  const untracked = check.uncommitted ? untrackedFiles(source.path) : [];
  addWorktree(repo, plan, check.head);
  try {
    if (tracked) applyStash(plan.path, tracked);
    copyUntracked(source.path, plan.path, untracked);
  } catch (err) {
    dropWorktree(repo, plan);
    throw err;
  }
  const space = await worktreeSpace(card, repo, plan);
  return { space, message: `copied to ${plan.label} on ${plan.branch} (${check.uncommitted ? `${check.uncommitted} change(s) copied` : "clean"}), ${source.label} is unchanged` };
}

export async function moveToWorktree(card: Card, check: TransferCheck): Promise<TransferResult> {
  const { source } = check;
  if (check.problems.length || !check.head || !check.branch) throw new Error(check.problems.join("; ") || "nothing to move");
  const repo = check.main ?? source.repo_root;
  const onDefault = check.branch === check.defaultBranch;
  const reuse = onDefault ? null : check.branch;
  if (reuse) {
    const other = checkedOutElsewhere(repo, reuse, source.path);
    if (other) throw new Error(`${reuse} is also checked out in ${other}`);
    if (source.kind === "checkout" && !check.defaultBranch) throw new Error("no default branch to switch the checkout to");
  }
  const plan = planWorktree(card, repo, reuse);
  const backup = check.uncommitted ? stashTop(source.path, `herdr-deck #${card.id}: moved to ${plan.path}`) : null;
  let freed = false;
  let added = false;
  try {
    if (reuse) {
      const free = source.kind === "checkout" ? ["switch", check.defaultBranch!] : ["switch", "--detach"];
      must(git(source.path, free), `free ${reuse} in ${source.label}`);
      freed = true;
    }
    addWorktree(repo, plan, check.head);
    added = true;
    if (backup) applyStash(plan.path, backup);
  } catch (err) {
    if (added) dropWorktree(repo, plan);
    if (freed) git(source.path, ["switch", reuse!]);
    if (backup) applyStash(source.path, backup);
    throw err;
  }
  const space = await worktreeSpace(card, repo, plan);
  db().markSpaceMoved(source.id, space.id);
  const left = reuse ? (source.kind === "checkout" ? `${source.label} is back on ${check.defaultBranch}` : `${source.label} is kept, detached`) : `${source.label} is left clean`;
  const kept = backup ? `, backup kept as stash ${backup.slice(0, 10)}` : "";
  return { space, message: `moved to ${plan.label} on ${plan.branch}, ${left}${kept}` };
}

export async function moveToCheckout(card: Card, check: TransferCheck): Promise<TransferResult> {
  const { source } = check;
  if (check.problems.length || !check.branch) throw new Error(check.problems.join("; ") || "nothing to move");
  if (check.checkoutBlocked || !check.main) throw new Error(check.checkoutBlocked ?? "no main checkout");
  const main = check.main;
  const before = currentBranch(main);
  const backup = check.uncommitted ? stashTop(source.path, `herdr-deck #${card.id}: moved to ${main}`) : null;
  let detached = false;
  let switched = false;
  try {
    must(git(source.path, ["switch", "--detach"]), `detach ${source.label}`);
    detached = true;
    must(git(main, ["switch", check.branch]), `switch the main checkout to ${check.branch}`);
    switched = true;
    if (backup) applyStash(main, backup);
  } catch (err) {
    if (switched) {
      git(main, ["reset", "--hard"]);
      git(main, ["clean", "-fd"]);
      if (before) git(main, ["switch", before]);
    }
    if (detached) git(source.path, ["switch", check.branch]);
    if (backup) applyStash(source.path, backup);
    throw err;
  }
  const space = db().createSpace({ card_id: card.id, kind: "checkout", repo_root: main, path: absPath(main), branch: check.branch, label: basename(main) });
  db().markSpaceMoved(source.id, space.id);
  const kept = backup ? `, backup kept as stash ${backup.slice(0, 10)}` : "";
  return { space, message: `moved to the main checkout ${space.label} on ${check.branch}, ${source.label} is kept, detached${kept}` };
}
