import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Step {
  cmds: string[];
  key: string;
  label: string;
  wait: number;
}

const TYPING_MS = 70;
const WIDTH = 1400;
const HEIGHT = 820;
const BAR = 72;
const FONT_SIZE = 24;
const BG = "0x1e1e2e";
const KEY_BG = "0xf5c2e7";
const KEY_FG = "0x1e1e2e";
const LABEL_FG = "0xcdd6f4";
const DIM_FG = "0x6c7086";
const FPS = 20;

const root = resolve(import.meta.dir, "..");
const out = join(root, "doc", "demo.gif");
const font = Bun.spawnSync(["fc-match", "-f", "%{file}", "Noto Sans Mono:bold"]).stdout.toString().trim();

const press = (ch: string, label: string, wait = 1200): Step => ({ cmds: [`Type "${ch}"`], key: ch, label, wait });
const special = (cmd: string, key: string, label: string, wait = 1500): Step => ({ cmds: [cmd], key, label, wait });
const typed = (text: string, label: string, wait = 900): Step => ({ cmds: [`Type "${text}"`], key: text, label, wait });

const steps: Step[] = [
  { cmds: [], key: "", label: "herdr-deck: a kanban board that owns your agent sessions", wait: 3000 },
  press("j", "next card"),
  press("j", "next card"),
  press("l", "next column"),
  press("h", "previous column"),
  press("k", "previous card", 1000),
  special("Enter", "enter", "open the card page: its spaces and sessions", 2500),
  press("j", "next session"),
  press("j", "next session", 1800),
  special("Escape", "esc", "back to the board"),
  press("v", "plain columns instead of lanes by repo", 2500),
  press("h", "Todo column"),
  press("L", "move the card to the next column", 1800),
  press("H", "and back", 1800),
  press("b", "set blocked, asks for a reason", 1200),
  typed("waiting on design", "type the reason"),
  special("Enter", "enter", "the card lands in Blocked with its reason", 2500),
  press("t", "back to Todo", 1800),
  press("v", "lanes by repo again", 2000),
  press("/", "filter cards", 600),
  typed("parked", "type a filter", 600),
  special("Enter", "enter", "only matching cards are shown", 2500),
  press("/", "filter again", 400),
  special("Ctrl+U", "ctrl+u", "clear it", 400),
  special("Enter", "enter", "every card is back", 1500),
  press("n", "new card form", 1000),
  typed("Ship the demo gif", "card title", 600),
  special("Tab", "tab", "next field", 400),
  typed("Record the board with vhs", "description", 1800),
  special("Escape", "esc", "cancel", 1500),
  press("?", "every herdr and deck key", 3500),
  special("Escape", "esc", "back to the board", 1500),
];

function stepMs(step: Step): number {
  const typing = step.cmds.reduce((n, c) => {
    const m = /^Type "(.*)"$/.exec(c);
    return n + (m ? m[1]!.length * TYPING_MS : 0);
  }, 0);
  return typing + step.wait;
}

function tape(video: string): string {
  const lines = [
    `Output "${video}"`,
    "Require bun",
    'Set Shell "bash"',
    "Set FontSize 16",
    `Set Width ${WIDTH}`,
    `Set Height ${HEIGHT}`,
    "Set Padding 16",
    'Set Theme "Catppuccin Mocha"',
    `Set TypingSpeed ${TYPING_MS}ms`,
    "Set CursorBlink false",
    `Set Framerate ${FPS * 2}`,
    "Hide",
    `Type "cd ${root} && clear && plugins/herdr-deck/bin/deck demo"`,
    "Enter",
    "Sleep 2s",
    "Show",
  ];
  for (const step of steps) {
    lines.push(...step.cmds, `Sleep ${step.wait}ms`);
  }
  lines.push("Hide", 'Type "q"', "Sleep 500ms");
  return `${lines.join("\n")}\n`;
}

function filters(dir: string): string {
  const parts = [`pad=iw:ih+${BAR}:0:0:color=${BG}`];
  const charW = FONT_SIZE * 0.6;
  const y = `h-${BAR}+(${BAR}-${FONT_SIZE})/2`;
  let t = 0;
  steps.forEach((step, i) => {
    const start = t / 1000;
    t += stepMs(step);
    const end = i === steps.length - 1 ? 9999 : t / 1000;
    const on = `enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`;
    let x = 32;
    if (step.key) {
      const keyFile = join(dir, `key-${i}.txt`);
      writeFileSync(keyFile, step.key);
      parts.push(`drawtext=fontfile=${font}:textfile=${keyFile}:fontsize=${FONT_SIZE}:fontcolor=${KEY_FG}:box=1:boxcolor=${KEY_BG}:boxborderw=10:x=${x}:y=${y}:${on}`);
      x += Math.ceil(step.key.length * charW) + 44;
    }
    const labelFile = join(dir, `label-${i}.txt`);
    writeFileSync(labelFile, step.label);
    parts.push(`drawtext=fontfile=${font}:textfile=${labelFile}:fontsize=${FONT_SIZE}:fontcolor=${step.key ? LABEL_FG : DIM_FG}:x=${x}:y=${y}:${on}`);
  });
  parts.push(`fps=${FPS}`, "split[a][b]", "[a]palettegen=stats_mode=diff[p]", "[b][p]paletteuse=dither=none:diff_mode=rectangle");
  return parts.join(",");
}

function run(cmd: string[]): void {
  const res = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (res.exitCode !== 0) throw new Error(`${cmd[0]} exited with ${res.exitCode}`);
}

const dir = mkdtempSync(join(tmpdir(), "herdr-deck-gif."));
try {
  const video = join(dir, "demo.mp4");
  const tapeFile = join(dir, "demo.tape");
  writeFileSync(tapeFile, tape(video));
  run(["vhs", tapeFile]);
  run(["ffmpeg", "-v", "error", "-y", "-i", video, "-filter_complex", filters(dir), out]);
  process.stdout.write(`wrote ${out}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
