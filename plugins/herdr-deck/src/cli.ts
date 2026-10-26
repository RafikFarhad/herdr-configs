import { existsSync } from "node:fs";
import { configPath, dataDir, loadConfig } from "./config";
import { db } from "./db";
import { listPanes } from "./herdr";
import { groupOf, isOpen } from "./model";
import { ensureWatcher, reconcile, runWatcher, watcherPid } from "./watcher";

const entry = Bun.main;

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

function parseContext(): Record<string, string> {
  const raw = process.env.DECK_CONTEXT || process.env.HERDR_PLUGIN_CONTEXT_JSON || "";
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function listCards(): void {
  const d = db();
  for (const card of d.cards()) {
    const sessions = d.sessions(card.id);
    const open = sessions.filter(isOpen).length;
    process.stdout.write(
      `#${card.id}\t${groupOf(card, sessions)}\t${card.title}\t${d.spaces(card.id).length} spaces\t${sessions.length} sessions (${open} open)\n`,
    );
  }
  const inbox = d.inbox().length;
  if (inbox) process.stdout.write(`inbox\t${inbox} unfiled session(s)\n`);
}

function showCard(id: number): void {
  const d = db();
  const card = d.card(id);
  if (!card) throw new Error(`no card #${id}`);
  process.stdout.write(`#${card.id} ${card.title} [${card.status}]\n${card.description ? `${card.description}\n` : ""}`);
  for (const sp of d.spaces(id)) {
    process.stdout.write(`  space ${sp.id} ${sp.kind} ${sp.label} ${sp.branch ?? ""} ${sp.path} ws=${sp.workspace_id ?? "-"}\n`);
  }
  for (const s of d.sessions(id)) {
    process.stdout.write(
      `  session ${s.id} ${s.harness} space=${s.space_id ?? "-"} parent=${s.parent_id ?? "-"} pane=${s.pane_id ?? "-"} ${s.agent_status ?? "closed"} ${s.title ?? ""}\n    ${s.ref}\n`,
    );
  }
}

async function doctor(): Promise<void> {
  const pid = watcherPid();
  process.stdout.write(`data      ${dataDir}\n`);
  process.stdout.write(`config    ${configPath}${existsSync(configPath) ? "" : " (not found, using defaults)"}\n`);
  const cfg = loadConfig();
  process.stdout.write(`roots     ${cfg.roots.join(", ")}\n`);
  process.stdout.write(`branch    ${cfg.branchPrefix}<id>-<slug> in <repo>/${cfg.worktreeDir}/\n`);
  process.stdout.write(`watcher   ${pid ? `running (pid ${pid})` : "not running"}\n`);
  try {
    const panes = await listPanes();
    const agents = panes.filter((p) => p.agent_session);
    process.stdout.write(`herdr     ok, ${panes.length} panes, ${agents.length} with an agent session\n`);
  } catch (err) {
    process.stdout.write(`herdr     unreachable: ${(err as Error).message}\n`);
  }
}

async function main(): Promise<void> {
  const [cmd = "tui", ...args] = process.argv.slice(2);
  switch (cmd) {
    case "tui":
    case "open":
    case "new-session":
    case "assign":
    case "goto": {
      ensureWatcher(entry);
      const { runTui } = await import("./tui/app");
      const mode = cmd === "tui" || cmd === "open" ? "open" : cmd;
      await runTui(mode as "open" | "new-session" | "assign" | "goto", parseContext());
      process.exit(0);
      return;
    }
    case "watch":
      await runWatcher();
      return;
    case "ensure-watch":
      process.stdout.write(`watcher pid ${ensureWatcher(entry)}\n`);
      return;
    case "stop-watch": {
      const pid = watcherPid();
      if (pid) process.kill(pid, "SIGTERM");
      process.stdout.write(pid ? `stopped ${pid}\n` : "not running\n");
      return;
    }
    case "sync":
      await reconcile();
      listCards();
      return;
    case "list":
      listCards();
      return;
    case "show":
      showCard(Number(args[0]));
      return;
    case "doctor":
      await doctor();
      return;
    default:
      process.stdout.write(
        "usage: deck [tui|new-session|assign|goto|watch|ensure-watch|stop-watch|sync|list|show <id>|doctor]\n",
      );
      process.exit(cmd === "help" || cmd === "--help" ? 0 : 64);
  }
}

main().catch((err) => {
  process.stderr.write(`deck: ${(err as Error).message}\n`);
  process.exit(1);
});
