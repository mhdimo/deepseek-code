import { loadSettings, type EffortLevel, type PersistedSettings } from "../state/storage.js";
import type { ThinkingMode } from "../types/index.js";
import {
  resolveThemeSetting,
  syncLiveTheme,
  type ThemeSetting,
} from "../utils/theme.js";
import { bypassIsPermitted } from "../services/bypassMode.js";

/**
 * The Config tab's rows, built here rather than inline in the component.
 *
 * The row set is data, and the failure this file exists to make testable is the
 * one the panel kept growing: a row whose `onChange` writes a key nothing ever
 * reads back. A test can walk these rows and check each one reaches a value the
 * app actually consumes — which needs them built somewhere other than inside a
 * component that only renders with a TTY attached.
 */

/**
 * What a fresh session should start with. The row below writes this key, and a
 * hardcoded start value meant the write could never be read back: the setting
 * survived in the file and nowhere else, and the status bar chip contradicted
 * the file it had been written to.
 */
export function persistedThinkingMode(): ThinkingMode {
  try {
    return loadSettings().thinkingMode === "whale" ? "whale" : "off";
  } catch {
    return "off";
  }
}

export interface SettingBase {
  id: string;
  label: string;
  description: string;
}

export type BooleanSetting = SettingBase & {
  type: "boolean";
  value: boolean;
  onChange: (value: boolean) => void;
};

export type EnumSetting = SettingBase & {
  type: "enum";
  value: string;
  options: readonly string[];
  /** Long option ids get a written-out label in the value column. */
  display?: (value: string) => string;
  onChange: (value: string) => void;
};

export type TextSetting = SettingBase & {
  type: "text";
  value: string;
  /** What the inline editor opens with — for masked values, not the mask. */
  editSeed: string;
  validate?: (value: string) => boolean;
  onChange: (value: string) => void;
};

/** Read-only. The value has a home and a reader, but its editor is a command
 *  (/permissions, /statusline), so the panel shows rather than pretends. */
export type DisplaySetting = SettingBase & {
  type: "display";
  value: string;
};

export type Setting = BooleanSetting | EnumSetting | TextSetting | DisplaySetting;

/**
 * The rows whose value is read from somewhere other than the settings file.
 * The panel persists first and then hands the value to whichever of these App
 * supplied, so a toggle cannot leave the running session on the old value
 * while the file says otherwise.
 */
export interface SettingsRowHandlers {
  /** The live grant behind the Shift+Tab permission cycle — see
   *  services/bypassMode.ts. */
  onSkipPermissionsChange?: (value: boolean) => void;
  onThinkingModeChange?: (mode: ThinkingMode) => void;
  onThemeModeChange?: (setting: ThemeSetting) => void;
}

const THEME_LABELS: Record<string, string> = {
  auto: "Auto (match terminal)",
  dark: "Dark mode",
  light: "Light mode",
  "dark-daltonized": "Dark mode (colorblind-friendly)",
  "light-daltonized": "Light mode (colorblind-friendly)",
  "dark-ansi": "Dark mode (ANSI colors only)",
  "light-ansi": "Light mode (ANSI colors only)",
};

/**
 * The model row's picker options. The row accepts any id (a proxy may serve
 * one of its own), so this is the offered set rather than a whitelist.
 */
export const MODEL_OPTIONS: ReadonlyArray<{ label: string; value: string; description?: string }> = [
  {
    label: "deepseek-chat",
    value: "deepseek-chat",
    description: "General-purpose coding assistant — default",
  },
  {
    label: "deepseek-reasoner",
    value: "deepseek-reasoner",
    description: "Advanced reasoning with extended thinking",
  },
];

export const EFFORT_OPTIONS = ["off", "low", "medium", "high", "max"] as const;
export const AGENT_OPTIONS = ["code", "plan", "review"] as const;
export const THINKING_OPTIONS = ["off", "whale"] as const;
export const THEME_OPTIONS = [
  "auto",
  "dark",
  "light",
  "dark-daltonized",
  "light-daltonized",
  "dark-ansi",
  "light-ansi",
] as const;

function maskApiKey(key: string | undefined): string {
  if (!key) return "not set";
  if (key.length <= 12) return `${key.slice(0, 4)}…${key.slice(-4)}`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function permissionSummary(p: PersistedSettings["permissions"]): string {
  const allow = p?.allow?.length ?? 0;
  const deny = p?.deny?.length ?? 0;
  const ask = p?.ask?.length ?? 0;
  if (allow + deny + ask === 0) return "no rules";
  return `allow ${allow} · deny ${deny} · ask ${ask}`;
}

export interface SettingsRowContext {
  settings: PersistedSettings;
  persist: (partial: PersistedSettings) => void;
  handlers?: SettingsRowHandlers;
  /** Injected so the root/sandbox refusal can be exercised without being root
   *  — see services/bypassMode.ts. */
  bypassPermitted?: () => boolean;
}

export function buildSettingsRows(ctx: SettingsRowContext): Setting[] {
  const s = ctx.settings;
  const persist = ctx.persist;
  const handlers = ctx.handlers ?? {};
  const bypassPermitted = ctx.bypassPermitted ?? bypassIsPermitted;
  return [
    {
      id: "model",
      label: "Model",
      description:
        "Model used for new sessions — deepseek-chat, deepseek-reasoner, or a custom model",
      type: "text" as const,
      value: s.model || "deepseek-chat",
      editSeed: s.model ?? "",
      onChange: (v: string) => {
        const trimmed = v.trim();
        persist({ model: trimmed ? trimmed : undefined });
      },
    },
    {
      id: "effort",
      label: "Effort",
      description:
        "Reasoning effort for deepseek-reasoner: off sends nothing — the provider default applies",
      type: "enum" as const,
      value: s.effort ?? "off",
      options: EFFORT_OPTIONS,
      onChange: (v: string) => persist({ effort: v as EffortLevel }),
    },
    {
      id: "thinkingMode",
      label: "Thinking mode",
      description: "Thinking mode preference — whale or off",
      type: "enum" as const,
      value: s.thinkingMode ?? "off",
      options: THINKING_OPTIONS,
      onChange: (v: string) => {
        persist({ thinkingMode: v });
        handlers.onThinkingModeChange?.(v as ThinkingMode);
      },
    },
    {
      id: "themeMode",
      label: "Theme",
      description:
        "Color theme — auto follows the terminal. Theme changes apply immediately",
      type: "enum" as const,
      value: s.themeMode ?? "auto",
      options: THEME_OPTIONS,
      display: (v: string) => THEME_LABELS[v] ?? v,
      onChange: (v: string) => {
        const setting = v as ThemeSetting;
        persist({ themeMode: setting });
        // App's handler moves the state the Ctrl+T picker opens on as well as
        // repainting; without it the picker kept opening on the theme from
        // before the panel changed it.
        if (handlers.onThemeModeChange) handlers.onThemeModeChange(setting);
        else syncLiveTheme(resolveThemeSetting(setting));
      },
    },
    {
      id: "skipPermissions",
      label: "Skip permission prompts",
      description: bypassPermitted()
        ? "Bypass mode: no prompt before a tool call. New sessions start in it, and Shift+Tab gains the entry"
        : "Unavailable as root/sudo outside a sandbox — the startup gate refuses the grant there",
      type: "boolean" as const,
      value: s.dangerouslySkipPermissions ?? false,
      onChange: (v: boolean) => {
        // Refused rather than persisted-and-ignored: where the process may not
        // exercise the grant, the value is not merely inert — it makes the
        // *next* launch exit at the bypass gate with nothing on screen to say
        // why (services/bypassMode.ts). The row says so in place of the switch.
        if (v && !bypassPermitted()) return;
        persist({ dangerouslySkipPermissions: v });
        handlers.onSkipPermissionsChange?.(v);
      },
    },
    {
      id: "permissions",
      label: "Permissions",
      description:
        "Tool permission rules in allow/deny/ask form, set via /permissions or settings.json",
      type: "display" as const,
      value: permissionSummary(s.permissions),
    },
    {
      id: "statusLine",
      label: "Status line",
      description:
        "Custom status bar command, set via /statusline — trust-gated, 5s timeout",
      type: "display" as const,
      value: s.statusLine ? `command: ${s.statusLine.command}` : "not set",
    },
    {
      id: "apiKey",
      label: "API key",
      description:
        "DeepSeek API key — masked: first 8 + last 4 shown. Editing replaces the key",
      type: "text" as const,
      value: maskApiKey(s.apiKey),
      editSeed: "",
      onChange: (v: string) => {
        const trimmed = v.trim();
        persist({ apiKey: trimmed ? trimmed : undefined });
      },
    },
    {
      id: "baseURL",
      label: "Base URL",
      description: "API endpoint override, e.g. a proxy",
      type: "text" as const,
      value: s.baseURL || "https://api.deepseek.com/v1",
      editSeed: s.baseURL ?? "",
      onChange: (v: string) => {
        const trimmed = v.trim();
        persist({ baseURL: trimmed ? trimmed : undefined });
      },
    },
    {
      id: "defaultAgent",
      label: "Default agent",
      description: "Default agent for new sessions",
      type: "enum" as const,
      value: s.defaultAgent ?? "code",
      options: AGENT_OPTIONS,
      onChange: (v: string) => persist({ defaultAgent: v }),
    },
    {
      id: "outputStyle",
      label: "Output style",
      description: "Output style for assistant messages",
      type: "text" as const,
      value: s.outputStyle || "default",
      editSeed: s.outputStyle ?? "",
      onChange: (v: string) => {
        const trimmed = v.trim();
        persist({ outputStyle: trimmed ? trimmed : undefined });
      },
    },
    {
      id: "includeCoAuthoredBy",
      label: "Co-Authored-By",
      description: "Add a Co-Authored-By trailer to /commit messages",
      type: "boolean" as const,
      value: s.includeCoAuthoredBy ?? false,
      onChange: (v: boolean) => persist({ includeCoAuthoredBy: v }),
    },
    {
      id: "copyFullResponse",
      label: "Copy full response",
      description: "Skip the /copy picker and always copy the whole response",
      type: "boolean" as const,
      value: s.copyFullResponse ?? false,
      onChange: (v: boolean) => persist({ copyFullResponse: v }),
    },
    {
      id: "cleanupPeriodDays",
      label: "Cleanup period",
      description: "Delete saved sessions older than N days on startup (1-365)",
      type: "text" as const,
      value: String(s.cleanupPeriodDays ?? 30),
      editSeed: String(s.cleanupPeriodDays ?? 30),
      validate: (v: string) => {
        const n = Number(v.trim());
        return /^[1-9]\d*$/.test(v.trim()) && n <= 365;
      },
      onChange: (v: string) => {
        const n = Number(v.trim());
        // 0 would delete every session at the next startup, so the window
        // starts at 1 — the same range /doctor validates the file against.
        if (!Number.isInteger(n) || n < 1 || n > 365) return;
        persist({ cleanupPeriodDays: n });
      },
    },
    {
      id: "env",
      label: "Env vars",
      description: "Environment variables injected into the session / tool environment",
      type: "display" as const,
      value: `${Object.keys(s.env ?? {}).length} variable(s) configured`,
    },
  ];
}
