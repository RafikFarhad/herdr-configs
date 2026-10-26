import { existsSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import type { Harness } from "./config";
import type { Session } from "./db";

export const HARNESSES: Harness[] = ["pi", "claude"];

export function isHarness(agent: string | undefined | null): agent is Harness {
  return agent === "pi" || agent === "claude";
}

function readHead(path: string, bytes = 256 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function jsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readHead(path).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      break;
    }
  }
  return out;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        const t = (part as { text?: unknown }).text;
        if (typeof t === "string") return t;
      }
    }
  }
  return null;
}

function clean(text: string): string | null {
  const firstLine = text
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function claudeTranscript(id: string): string | null {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  for (const match of new Glob(`*/${id}.jsonl`).scanSync({ cwd: root, absolute: true })) return match;
  return null;
}

export function sessionFile(s: Pick<Session, "harness" | "ref_kind" | "ref">): string | null {
  if (s.ref_kind === "path") return s.ref;
  if (s.harness === "claude") return claudeTranscript(s.ref);
  return null;
}

export interface SessionInfo {
  title: string | null;
  cwd: string | null;
  parentRef: string | null;
  name: string | null;
}

export function readSessionInfo(s: Pick<Session, "harness" | "ref_kind" | "ref">): SessionInfo {
  const info: SessionInfo = { title: null, cwd: null, parentRef: null, name: null };
  const file = sessionFile(s);
  if (!file) return info;
  for (const entry of jsonLines(file)) {
    if (s.harness === "pi") {
      if (entry.type === "session") {
        if (typeof entry.cwd === "string") info.cwd = entry.cwd;
        if (typeof entry.parentSession === "string") info.parentRef = entry.parentSession;
      }
      if (entry.type === "session_info" && typeof entry.name === "string") info.name = entry.name;
      if (!info.title && entry.type === "message") {
        const msg = entry.message as { role?: string; content?: unknown } | undefined;
        if (msg?.role === "user") {
          const t = textOf(msg.content);
          if (t) info.title = clean(t);
        }
      }
    } else {
      if (!info.cwd && typeof entry.cwd === "string") info.cwd = entry.cwd;
      if (!info.title && entry.type === "user" && !entry.isMeta) {
        const msg = entry.message as { role?: string; content?: unknown } | undefined;
        const t = textOf(msg?.content);
        if (t && !t.startsWith("<command-") && !t.startsWith("Caveat:")) info.title = clean(t);
      }
    }
    if (s.harness === "claude" && info.title && info.cwd) break;
  }
  if (info.name) info.title = info.name;
  return info;
}

export function resumeArgs(s: Pick<Session, "harness" | "ref">): string[] {
  return s.harness === "pi" ? ["--session", s.ref] : ["--resume", s.ref];
}

export function forkArgs(s: Pick<Session, "harness" | "ref">): string[] {
  return s.harness === "pi" ? ["--fork", s.ref] : ["--resume", s.ref, "--fork-session"];
}

export function sessionExists(s: Pick<Session, "harness" | "ref_kind" | "ref">): boolean {
  const file = sessionFile(s);
  return file ? existsSync(file) : false;
}

export function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
