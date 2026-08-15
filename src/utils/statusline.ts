/**
 * Statusline helpers: the JSON contract piped to the /statusline command on
 * stdin (mirrors claude-code-main src/types/statusLine.ts + StatusLine.tsx)
 * and a minimal ANSI-to-ink mapper for rendering the command's output.
 */

// ── ANSI → ink segments ──────────────────────────────────────────────────────

/** Ink-safe color names the mapper emits (basic 16 + gray). */
export type AnsiInkColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "blackBright"
  | "redBright"
  | "greenBright"
  | "yellowBright"
  | "blueBright"
  | "magentaBright"
  | "cyanBright"
  | "whiteBright";

export interface AnsiSegment {
  text: string;
  color?: AnsiInkColor;
  backgroundColor?: AnsiInkColor;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

const FG_CODES: Record<number, AnsiInkColor> = {
  30: "black", 31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "blackBright", 91: "redBright", 92: "greenBright", 93: "yellowBright", 94: "blueBright",
  95: "magentaBright", 96: "cyanBright", 97: "whiteBright",
};

const BG_CODES: Record<number, AnsiInkColor> = {
  40: "black", 41: "red", 42: "green", 43: "yellow", 44: "blue", 45: "magenta", 46: "cyan", 47: "white",
  100: "blackBright", 101: "redBright", 102: "greenBright", 103: "yellowBright", 104: "blueBright",
  105: "magentaBright", 106: "cyanBright", 107: "whiteBright",
};

interface SgrState {
  color?: AnsiInkColor;
  backgroundColor?: AnsiInkColor;
  bold: boolean;
  dim: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
}

const RESET_STATE: SgrState = {
  color: undefined,
  backgroundColor: undefined,
  bold: false,
  dim: false,
  underline: false,
  inverse: false,
  strikethrough: false,
};

/**
 * Parse ANSI escape sequences into Ink-friendly segments. SGR colors map to
 * the basic 16 (30-37/40-47 fg/bg, 90-97/100-107 bright); styles bold/dim/
 * underline/inverse/strikethrough map to Ink Text props. Unsupported
 * sequences — 256-color (38;5;N), truecolor (38;2;R;G;B), cursor moves,
 * OSC (e.g. title) — are stripped, never rendered as raw escapes.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let state: SgrState = { ...RESET_STATE };
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const seg: AnsiSegment = { text: buf };
    if (state.color) seg.color = state.color;
    if (state.backgroundColor) seg.backgroundColor = state.backgroundColor;
    if (state.bold) seg.bold = true;
    if (state.dim) seg.dim = true;
    if (state.underline) seg.underline = true;
    if (state.inverse) seg.inverse = true;
    if (state.strikethrough) seg.strikethrough = true;
    segments.push(seg);
    buf = "";
  };

  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch !== "\x1b") {
      buf += ch;
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next === "[") {
      // CSI: scan to the final byte (@–~)
      let j = i + 2;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) break;
        j++;
      }
      if (j >= text.length) {
        i = text.length; // unterminated — drop the mangled escape remainder
        continue;
      }
      const params = text.slice(i + 2, j);
      const final = text[j];
      if (final === "m") {
        flush();
        state = applySgr(params, state);
      }
      // any other final byte (cursor moves, erase, …) → strip
      i = j + 1;
    } else if (next === "]") {
      // OSC — strip until BEL or ST
      const bel = text.indexOf("\x07", i + 2);
      const st = text.indexOf("\x1b\\", i + 2);
      const end = [bel, st].filter((n) => n !== -1).reduce((min, n) => (min === -1 ? n : Math.min(min, n)), -1);
      i = end === -1 ? text.length : end + (text[end + 1] === "\\" ? 2 : 1);
    } else {
      i++; // lone ESC — strip
    }
  }
  flush();
  return segments;
}

function applySgr(params: string, state: SgrState): SgrState {
  const next: SgrState = { ...state };
  const codes = params === "" ? [0] : params.split(";").map((p) => Number(p));
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === undefined) continue;
    if (code === 0) {
      Object.assign(next, RESET_STATE);
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 9) {
      next.strikethrough = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 27) {
      next.inverse = false;
    } else if (code === 29) {
      next.strikethrough = false;
    } else if (code === 39) {
      next.color = undefined;
    } else if (code === 49) {
      next.backgroundColor = undefined;
    } else if (FG_CODES[code]) {
      next.color = FG_CODES[code];
    } else if (BG_CODES[code]) {
      next.backgroundColor = BG_CODES[code];
    } else if (code === 38 || code === 48) {
      // Extended color (38;5;N / 38;2;R;G;B) — unsupported, consume its params
      const rest = codes.slice(i + 1);
      const consumed = rest[0] === 5 ? 2 : rest[0] === 2 ? 4 : 0;
      i += consumed;
    }
    // everything else (3=italic, 5/6=blink, 8=hidden, …) → unsupported, skip
  }
  return next;
}

// ── stdin JSON contract ──────────────────────────────────────────────────────

/**
 * JSON payload written to the /statusline command's stdin. Snake_case keys
 * match the claude-code-main reference so existing shell/awk/script statusline
 * commands keep working. Optional keys are omitted (never null) when the
 * source data is unavailable.
 */
export interface StatusLineCommandInput {
  /** Session title when one has been set. */
  session_name?: string;
  model: { id: string; display_name: string };
  workspace: {
    current_dir: string;
    project_dir: string;
    added_dirs: string[];
  };
  version: string;
  output_style: { name: string };
  cost: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    current_usage: number;
    used_percentage: number;
    remaining_percentage: number;
  };
  exceeds_200k_tokens: boolean;
  /** Only when a vim-style input mode is active. */
  vim?: { mode: string };
  /** Only when a non-default agent is active. */
  agent?: { name: string };
  /** "default" | "acceptEdits" | "plan" | "bypassPermissions". */
  permission_mode?: string;
}

export interface StatusLineInputOptions {
  model: string;
  displayName?: string;
  currentDir: string;
  projectDir?: string;
  addedDirs?: string[];
  /** Keep in sync with package.json. */
  version?: string;
  outputStyleName?: string;
  costUsd?: number;
  durationMs?: number;
  apiDurationMs?: number;
  linesAdded?: number;
  linesRemoved?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Defaults to inputTokens + outputTokens. */
  currentUsage?: number;
  contextWindowSize?: number;
  /** 0-100; derived from currentUsage/contextWindowSize when omitted. */
  usedPercentage?: number;
  agentName?: string;
  permissionMode?: string;
  vimMode?: string;
  sessionName?: string;
}

/** Build the statusline stdin payload; omitted sources yield sane defaults. */
export function buildStatusLineCommandInput(opts: StatusLineInputOptions): StatusLineCommandInput {
  const totalInput = opts.inputTokens ?? 0;
  const totalOutput = opts.outputTokens ?? 0;
  const currentUsage = opts.currentUsage ?? totalInput + totalOutput;
  const contextWindowSize = opts.contextWindowSize ?? 1_000_000;
  const usedPercentage =
    opts.usedPercentage ??
    (contextWindowSize > 0 ? Math.min(100, (currentUsage / contextWindowSize) * 100) : 0);
  const input: StatusLineCommandInput = {
    model: { id: opts.model, display_name: opts.displayName ?? opts.model },
    workspace: {
      current_dir: opts.currentDir,
      project_dir: opts.projectDir ?? opts.currentDir,
      added_dirs: opts.addedDirs ?? [],
    },
    version: opts.version ?? "0.1.0",
    output_style: { name: opts.outputStyleName ?? "default" },
    cost: {
      total_cost_usd: opts.costUsd ?? 0,
      total_duration_ms: opts.durationMs ?? 0,
      total_api_duration_ms: opts.apiDurationMs ?? 0,
      total_lines_added: opts.linesAdded ?? 0,
      total_lines_removed: opts.linesRemoved ?? 0,
    },
    context_window: {
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      context_window_size: contextWindowSize,
      current_usage: currentUsage,
      used_percentage: Math.round(usedPercentage * 100) / 100,
      remaining_percentage: Math.round(Math.max(0, 100 - usedPercentage) * 100) / 100,
    },
    exceeds_200k_tokens: currentUsage > 200_000,
  };
  if (opts.sessionName) input.session_name = opts.sessionName;
  if (opts.agentName) input.agent = { name: opts.agentName };
  if (opts.permissionMode) input.permission_mode = opts.permissionMode;
  if (opts.vimMode) input.vim = { mode: opts.vimMode };
  return input;
}
