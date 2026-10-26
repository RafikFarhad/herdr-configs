import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Style = "dim" | "bold" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "inverse" | "title";

const CODES: Record<Style, string> = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  inverse: "\x1b[7m",
  title: "\x1b[1;36m",
};

const RESET = "\x1b[0m";

export type Part = string | [string, ...Style[]];

function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

export function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

export function pad(s: string, width: number): string {
  const t = truncate(s, width);
  return t + " ".repeat(Math.max(0, width - textWidth(t)));
}

export function line(parts: Part[], width: number, fill?: Style[]): string {
  let out = "";
  let used = 0;
  for (const part of parts) {
    const [text, ...styles] = typeof part === "string" ? [part] : part;
    const room = width - used;
    if (room <= 0) break;
    const t = truncate(text.replace(/[\r\n\t]/g, " "), room);
    used += textWidth(t);
    const codes = [...(fill ?? []), ...styles].map((s) => CODES[s]).join("");
    out += codes ? `${codes}${t}${RESET}` : t;
  }
  if (used < width) {
    const rest = " ".repeat(width - used);
    out += fill?.length ? `${fill.map((s) => CODES[s]).join("")}${rest}${RESET}` : rest;
  }
  return out;
}

export type Key =
  | { name: "up" | "down" | "left" | "right" | "enter" | "esc" | "backspace" | "tab" | "pageup" | "pagedown" | "home" | "end" | "ctrl-c" | "ctrl-u" | "delete" }
  | { name: "char"; ch: string };

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const seq: [string, Key][] = [
      ["\x1b[A", { name: "up" }],
      ["\x1b[B", { name: "down" }],
      ["\x1b[C", { name: "right" }],
      ["\x1b[D", { name: "left" }],
      ["\x1bOA", { name: "up" }],
      ["\x1bOB", { name: "down" }],
      ["\x1bOC", { name: "right" }],
      ["\x1bOD", { name: "left" }],
      ["\x1b[5~", { name: "pageup" }],
      ["\x1b[6~", { name: "pagedown" }],
      ["\x1b[H", { name: "home" }],
      ["\x1b[F", { name: "end" }],
      ["\x1b[3~", { name: "delete" }],
    ];
    const hit = seq.find(([s]) => rest.startsWith(s));
    if (hit) {
      keys.push(hit[1]);
      i += hit[0].length;
      continue;
    }
    const ch = data[i];
    if (ch === "\x1b") {
      const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest);
      if (m) {
        i += m[0].length;
        continue;
      }
      keys.push({ name: "esc" });
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
    else if (ch === "\x7f" || ch === "\b") keys.push({ name: "backspace" });
    else if (ch === "\t") keys.push({ name: "tab" });
    else if (ch === "\x03") keys.push({ name: "ctrl-c" });
    else if (ch === "\x15") keys.push({ name: "ctrl-u" });
    else if (ch >= " ") {
      const cp = data.codePointAt(i) ?? 0;
      const full = String.fromCodePoint(cp);
      keys.push({ name: "char", ch: full });
      i += full.length;
      continue;
    }
    i += 1;
  }
  return keys;
}

export class Terminal {
  private onData: ((d: Buffer) => void) | null = null;
  private active = false;

  get width(): number {
    return process.stdout.columns || 100;
  }

  get height(): number {
    return process.stdout.rows || 30;
  }

  start(handler: (k: Key) => void, onResize: () => void): void {
    this.onData = (d) => {
      for (const k of parseKeys(d.toString("utf8"))) handler(k);
    };
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", onResize);
    this.enter();
  }

  private enter(): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    this.active = true;
  }

  private leave(): void {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    this.active = false;
  }

  draw(lines: string[]): void {
    if (!this.active) return;
    const h = this.height;
    const out = lines.slice(0, h);
    while (out.length < h) out.push(" ".repeat(this.width));
    process.stdout.write(`\x1b[H${out.join("\r\n")}`);
  }

  stop(): void {
    if (this.onData) process.stdin.off("data", this.onData);
    if (this.active) this.leave();
    process.stdin.pause();
  }

  edit(initial: string, suffix = ".md"): string | null {
    const editor = process.env.VISUAL || process.env.EDITOR || "nvim";
    const dir = mkdtempSync(join(tmpdir(), "deck-"));
    const file = join(dir, `edit${suffix}`);
    writeFileSync(file, initial);
    if (this.onData) process.stdin.off("data", this.onData);
    this.leave();
    process.stdin.pause();
    const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    let text: string | null = null;
    if (r.status === 0) text = readFileSync(file, "utf8");
    rmSync(dir, { recursive: true, force: true });
    this.enter();
    if (this.onData) process.stdin.on("data", this.onData);
    return text;
  }
}
