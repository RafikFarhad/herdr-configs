import type { Harness } from "../config";
import type { Repo } from "../actions";
import { shortPath } from "../model";
import { textWidth, truncate, type Key, type Part, type Style } from "./term";

export type Where = "checkout" | "worktree" | "none";
export type SessionChoice = Harness | "none";

export interface NewCardValues {
  title: string;
  description: string;
  repo: Repo | null;
  where: Where;
  session: SessionChoice;
  brief: boolean;
  startStatus: StartStatus;
}

export type StartStatus = "active" | "blocked";

const START_STATUS: [StartStatus, string][] = [
  ["active", "In progress"],
  ["blocked", "Blocked"],
];

export type FormAction =
  | { type: "none" }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "pick-repo"; filter: string }
  | { type: "edit-description" };

type FieldId = "title" | "description" | "repo" | "where" | "session" | "status" | "brief" | "create";

const WHERE: [Where, string][] = [
  ["checkout", "main checkout"],
  ["worktree", "new worktree"],
  ["none", "no space"],
];

const LABEL_W = 13;
const DESC_LINES = 3;

function cycle<T>(options: T[], current: T, delta: number): T {
  const i = Math.max(0, options.indexOf(current));
  return options[(i + delta + options.length) % options.length];
}

function width(parts: Part[]): number {
  return parts.reduce((n, p) => n + textWidth(typeof p === "string" ? p : p[0]), 0);
}

export class NewCardForm {
  values: NewCardValues;
  error: string | null = null;
  private focus: FieldId = "title";

  constructor(
    initial: Partial<NewCardValues>,
    private harnesses: Harness[],
  ) {
    this.values = {
      title: "",
      description: "",
      repo: null,
      where: "checkout",
      session: harnesses[0] ?? "none",
      brief: false,
      startStatus: "active",
      ...initial,
    };
    if (!this.values.repo) this.values.where = "none";
  }

  private enabled(id: FieldId): boolean {
    if (id === "where") return this.values.repo !== null;
    if (id === "session") return this.values.where !== "none";
    if (id === "brief" || id === "status") return this.values.where !== "none" && this.values.session !== "none";
    return true;
  }

  private fields(): FieldId[] {
    const all: FieldId[] = ["title", "description", "repo", "where", "session", "status", "brief", "create"];
    return all.filter((id) => this.enabled(id));
  }

  private sessionOptions(): SessionChoice[] {
    return [...this.harnesses, "none"];
  }

  setRepo(repo: Repo | null): void {
    this.values.repo = repo;
    if (!repo) this.values.where = "none";
    else if (this.values.where === "none") this.values.where = "checkout";
    this.error = null;
  }

  setDescription(text: string): void {
    this.values.description = text.replace(/\s+$/, "");
  }

  validate(): string | null {
    if (!this.values.title.trim()) {
      this.focus = "title";
      return "a title is required";
    }
    return null;
  }

  private move(delta: number): void {
    const list = this.fields();
    const i = Math.max(0, list.indexOf(this.focus));
    this.focus = list[Math.min(list.length - 1, Math.max(0, i + delta))];
  }

  private change(delta: number): void {
    const v = this.values;
    if (this.focus === "where") {
      const opts = WHERE.map(([id]) => id).filter((id) => v.repo || id === "none");
      v.where = cycle(opts, v.where, delta);
    } else if (this.focus === "session") v.session = cycle(this.sessionOptions(), v.session, delta);
    else if (this.focus === "status") v.startStatus = cycle(START_STATUS.map(([id]) => id), v.startStatus, delta);
    else if (this.focus === "brief") v.brief = !v.brief;
  }

  key(k: Key): FormAction {
    const ch = k.name === "char" ? k.ch : "";
    this.error = null;
    if (k.name === "esc") return { type: "cancel" };
    if (k.name === "ctrl-s") return { type: "submit" };
    if (k.name === "ctrl-e") return { type: "edit-description" };
    if (k.name === "tab" || k.name === "down") {
      this.move(1);
      return { type: "none" };
    }
    if (k.name === "backtab" || k.name === "up") {
      this.move(-1);
      return { type: "none" };
    }
    const f = this.focus;
    if (f === "title" || f === "description") {
      const key = f === "title" ? "title" : "description";
      if (k.name === "enter") this.move(1);
      else if (k.name === "backspace") this.values[key] = [...this.values[key]].slice(0, -1).join("");
      else if (k.name === "ctrl-u") this.values[key] = "";
      else if (ch) this.values[key] += ch;
      return { type: "none" };
    }
    if (f === "repo") {
      if (k.name === "enter" || ch === " ") return { type: "pick-repo", filter: "" };
      if (k.name === "backspace" || k.name === "delete") this.setRepo(null);
      else if (ch) return { type: "pick-repo", filter: ch };
      return { type: "none" };
    }
    if (f === "create") {
      if (k.name === "enter" || ch === " ") return { type: "submit" };
      return { type: "none" };
    }
    if (k.name === "left") this.change(-1);
    else if (k.name === "right" || ch === " ") this.change(1);
    else if (k.name === "enter") this.move(1);
    return { type: "none" };
  }

  hints(): [string, string][] {
    const base: [string, string][] = [["tab ↑↓", "next field"]];
    if (this.focus === "repo") base.push(["enter", "pick repo"], ["type", "search"], ["⌫", "no repo"]);
    else if (this.focus === "where" || this.focus === "session" || this.focus === "status" || this.focus === "brief") base.push(["← →", "choose"]);
    else if (this.focus === "create") base.push(["enter", "create"]);
    else if (this.focus === "description") base.push(["type", "edit"], ["ctrl+e", "multi-line in editor"]);
    else base.push(["type", "edit"]);
    base.push(["ctrl+s", "create"], ["esc", "cancel"]);
    return base;
  }

  private submitLabel(): string {
    const v = this.values;
    if (v.where === "none") return "Create card";
    if (v.session === "none") return v.where === "worktree" ? "Create card and worktree" : "Create card";
    return `Create and start ${v.session}`;
  }

  private label(id: FieldId, text: string): Part[] {
    const on = this.focus === id;
    const off = !this.enabled(id);
    const marker: Part = on ? ["› ", "yellow", "bold"] : "  ";
    const style: Style[] = on ? ["yellow", "bold"] : off ? ["dim"] : ["bold"];
    return [" ", marker, [text.padEnd(LABEL_W), ...style]];
  }

  private input(id: FieldId, value: string, placeholder: string, fieldW: number): Part[] {
    const on = this.focus === id;
    const shown = truncate(value, fieldW - 1);
    const pad = Math.max(0, fieldW - textWidth(shown) - (on ? 1 : 0));
    if (!value) {
      const ph = truncate(placeholder, fieldW - (on ? 1 : 0));
      return [
        ...(on ? ([["▏", "yellow"]] as Part[]) : ([] as Part[])),
        [ph, "dim", "underline"],
        [" ".repeat(Math.max(0, fieldW - textWidth(ph) - (on ? 1 : 0))), "underline", "dim"],
      ];
    }
    return [[shown, "underline", ...(on ? (["bold"] as Style[]) : [])], ...(on ? ([["▏", "yellow"]] as Part[]) : []), [" ".repeat(pad), "underline", "dim"]];
  }

  private radios(id: FieldId, options: [string, string][], current: string): Part[] {
    const on = this.focus === id;
    const parts: Part[] = [];
    options.forEach(([value, text], i) => {
      const picked = value === current;
      const dot: Part = picked ? ["●", on ? "yellow" : "green", "bold"] : ["○", "dim"];
      const lab: Part = picked ? [` ${text}`, ...(on ? (["yellow", "bold"] as Style[]) : (["bold"] as Style[]))] : [` ${text}`, "dim"];
      parts.push(dot, lab);
      if (i < options.length - 1) parts.push("    ");
    });
    return parts;
  }

  render(inner: number): Part[][] {
    const v = this.values;
    const fieldW = Math.max(20, inner - LABEL_W - 6);
    const rows: Part[][] = [[""]];

    rows.push([...this.label("title", "Title"), ...this.input("title", v.title, "what is the task?", fieldW)]);
    rows.push([""]);

    const descLines = v.description ? v.description.split("\n") : [];
    const firstDesc = descLines[0] ?? "";
    rows.push([...this.label("description", "Description"), ...this.input("description", firstDesc, "optional: what should the agent do?", fieldW)]);
    for (let i = 1; i < DESC_LINES; i++) {
      const lineText = descLines[i];
      if (lineText === undefined) break;
      const isLast = i === DESC_LINES - 1 && descLines.length > DESC_LINES;
      const text = isLast ? `${truncate(lineText, fieldW - 14)}  (+${descLines.length - DESC_LINES} more)` : lineText;
      rows.push([" ".repeat(LABEL_W + 3), [truncate(text, fieldW), "underline"], [" ".repeat(Math.max(0, fieldW - textWidth(truncate(text, fieldW)))), "underline", "dim"]]);
    }
    rows.push([" ".repeat(LABEL_W + 3), ["ctrl+e", this.focus === "description" ? "yellow" : "dim"], [" write a longer description in your editor", "dim"]]);
    rows.push([""]);

    const repoOn = this.focus === "repo";
    const repoValue: Part[] = v.repo
      ? [[v.repo.name, "bold", ...(repoOn ? (["yellow"] as Style[]) : [])], [`   ${shortPath(v.repo.path)}`, "dim"]]
      : [["none", "dim"], ["   card only, no space", "dim"]];
    const repoHint: Part[] = repoOn ? [["   ↵ change", "yellow"]] : [["   ↵ change", "dim"]];
    rows.push([...this.label("repo", "Repo"), ...repoValue, ...repoHint]);

    if (v.repo) rows.push([...this.label("where", "Where"), ...this.radios("where", WHERE, v.where)]);
    else rows.push([...this.label("where", "Where"), ["needs a repo", "dim"]]);

    if (this.enabled("session")) {
      const opts = this.sessionOptions().map((s) => [s, s === "none" ? "no session" : s] as [string, string]);
      rows.push([...this.label("session", "Session"), ...this.radios("session", opts, v.session)]);
    } else rows.push([...this.label("session", "Session"), ["needs a space", "dim"]]);

    if (this.enabled("status")) {
      rows.push([
        ...this.label("status", "Move to"),
        ...this.radios("status", START_STATUS, v.startStatus),
        [v.startStatus === "blocked" ? "    asks for a reason on create" : "    a running session means work has started", "dim"],
      ]);
    } else rows.push([...this.label("status", "Move to"), ["Todo (no session)", "dim"]]);

    if (this.enabled("brief")) {
      rows.push([
        ...this.label("brief", "Send brief"),
        ...this.radios(
          "brief",
          [
            ["no", "no"],
            ["yes", "yes"],
          ],
          v.brief ? "yes" : "no",
        ),
        ["    send title and description as the first prompt", "dim"],
      ]);
    } else rows.push([...this.label("brief", "Send brief"), ["needs a session", "dim"]]);

    rows.push([""]);
    const createOn = this.focus === "create";
    const button: Part = [`  ${this.submitLabel()}  `, ...(createOn ? (["green", "bold", "inverse"] as Style[]) : (["green", "bold"] as Style[]))];
    const hint: Part = ["   ctrl+s", "dim"];
    const cancel: Part = ["   esc cancel", "dim"];
    const right: Part[] = [["[", createOn ? "green" : "dim"], button, ["]", createOn ? "green" : "dim"], hint, cancel];
    rows.push([" ".repeat(Math.max(1, inner - width(right) - 2)), ...right]);
    rows.push(this.error ? [[`   ${this.error}`, "red", "bold"]] : [""]);
    return rows;
  }
}
