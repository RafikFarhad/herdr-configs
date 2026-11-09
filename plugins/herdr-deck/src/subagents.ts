import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function subagentRunsDir(): string {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  const root = configured ? resolve(configured) : join(tmpdir(), `pi-subagents-uid-${process.getuid?.() ?? 0}`);
  return join(root, "async-subagent-runs");
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function runningSubagents(): Map<string, number> {
  const counts = new Map<string, number>();
  const dir = subagentRunsDir();
  if (!existsSync(dir)) return counts;
  for (const entry of readdirSync(dir)) {
    let status: { sessionId?: unknown; state?: unknown; pid?: unknown };
    try {
      status = JSON.parse(readFileSync(join(dir, entry, "status.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof status.sessionId !== "string" || !status.sessionId) continue;
    if (status.state !== "running" && status.state !== "queued") continue;
    if (!alive(status.pid)) continue;
    counts.set(status.sessionId, (counts.get(status.sessionId) ?? 0) + 1);
  }
  return counts;
}
