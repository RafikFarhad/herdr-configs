import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Harness = "pi" | "claude";

export interface DeckConfig {
  roots: string[];
  branchPrefix: string;
  worktreeDir: string;
  defaultHarness: Harness;
}

const HOME = homedir();

export function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

export function absPath(p: string): string {
  return resolve(expandHome(p.trim()));
}

export const dataDir = process.env.DECK_DATA_DIR
  ? absPath(process.env.DECK_DATA_DIR)
  : join(HOME, ".local", "share", "herdr-deck");

export const configPath = process.env.DECK_CONFIG
  ? absPath(process.env.DECK_CONFIG)
  : join(HOME, ".config", "herdr-deck", "config.json");

export function ensureDataDir(): void {
  mkdirSync(dataDir, { recursive: true });
}

const defaults: DeckConfig = {
  roots: ["~/projects"],
  branchPrefix: "",
  worktreeDir: ".worktrees",
  defaultHarness: "pi",
};

export function loadConfig(): DeckConfig {
  let raw: Partial<DeckConfig> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(`invalid ${configPath}: ${(err as Error).message}`);
    }
  }
  const cfg = { ...defaults, ...raw };
  cfg.roots = (cfg.roots ?? []).map(absPath);
  if (cfg.defaultHarness !== "pi" && cfg.defaultHarness !== "claude") cfg.defaultHarness = "pi";
  return cfg;
}
