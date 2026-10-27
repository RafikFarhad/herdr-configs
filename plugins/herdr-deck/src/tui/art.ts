import type { Part, Style } from "./term";

export type CardState = "needs" | "error" | "working" | "warning" | "open" | "parked" | "new" | "done";

export const QUIET_STATES: CardState[] = ["parked", "new", "done"];

export const STATE_COLOR: Record<CardState, Style> = {
  needs: "red",
  error: "red",
  working: "green",
  warning: "yellow",
  open: "blue",
  parked: "dim",
  new: "dim",
  done: "dim",
};

export const ART_WIDTH = 9;
export const ART_HEIGHT = 3;

const LEVELS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const PHASES = [0, 2.1, 4.4, 1.2];
const SPEEDS = [0.55, 0.8, 0.65, 0.95];

function equalizer(frame: number): Part[][] {
  const heights = PHASES.map((phase, i) => {
    const wave = 0.5 + 0.5 * Math.sin(frame * SPEEDS[i] + phase);
    return Math.round(3 + wave * 21);
  });
  const rows: Part[][] = [];
  for (let r = 0; r < ART_HEIGHT; r++) {
    const floor = (ART_HEIGHT - 1 - r) * 8;
    const styles: Style[] = r === 0 ? ["green", "bold"] : ["green"];
    const parts: Part[] = [" "];
    for (const h of heights) {
      const units = Math.max(0, Math.min(8, h - floor));
      parts.push([LEVELS[units], ...styles], " ");
    }
    rows.push(parts);
  }
  return rows;
}

function bubble(frame: number): Part[][] {
  const on = Math.floor(frame / 4) % 2 === 0;
  const frameStyle: Style[] = on ? ["red", "bold"] : ["red"];
  const mark = on ? "?" : "!";
  return [
    [[" .-----. ", ...frameStyle]],
    [[" |  ", ...frameStyle], [mark, on ? "yellow" : "red", "bold"], ["  | ", ...frameStyle]],
    [[" '--v--' ", ...frameStyle]],
  ];
}

const ERROR: Part[][] = [
  [[" ┌─────┐ ", "red"]],
  [[" │  ", "red"], ["X", "red", "bold"], ["  │ ", "red"]],
  [[" └─────┘ ", "red"]],
];

const WARNING: Part[][] = [
  [["    ▲    ", "yellow"]],
  [["   ╱", "yellow"], ["!", "yellow", "bold"], ["╲   ", "yellow"]],
  [["  ▔▔▔▔▔  ", "yellow"]],
];

const OPEN: Part[][] = [[["         "]], [["   ", "blue"], ["◌", "blue"], ["     ", "blue"]], [["         "]]];

const DONE: Part[][] = [
  [[" \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2557", "green"]],
  [[" \u2551", "green"], [" DONE ", "green", "bold"], ["\u2551", "green"]],
  [[" \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d", "green"]],
];

const NEW: Part[][] = [[["    +    ", "dim"]], [["  --+--  ", "dim"]], [["    +    ", "dim"]]];

function parked(age: string): Part[][] {
  const text = age.length > 5 ? age.slice(0, 5) : age;
  const left = Math.floor((5 - text.length) / 2);
  const inner = " ".repeat(left) + text + " ".repeat(5 - text.length - left);
  return [[[" .-----. ", "dim"]], [[" |", "dim"], [inner, "bold"], ["| ", "dim"]], [[" '-----' ", "dim"]]];
}

export function art(state: CardState, frame: number, age = ""): Part[][] {
  if (state === "parked") return parked(age);
  if (state === "new") return NEW;
  if (state === "needs") return bubble(frame);
  if (state === "working") return equalizer(frame);
  if (state === "error") return ERROR;
  if (state === "warning") return WARNING;
  if (state === "open") return OPEN;
  return DONE;
}

export function animated(state: CardState): boolean {
  return state === "working" || state === "needs";
}
