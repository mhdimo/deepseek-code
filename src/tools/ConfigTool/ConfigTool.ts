





import { z } from "zod";
import { buildTool } from "../../Tool.js";
import {
  loadSettings,
  saveSettings,
  type PersistedSettings,
} from "../../state/storage.js";
import { CONFIG_TOOL_NAME, DESCRIPTION } from "./prompt.js";



const ConfigInputSchema = z.object({
  setting: z
    .string()
    .describe(
      'The setting key to get or set (e.g. "model", "themeMode", "permissions.allow").',
    ),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      z.record(z.string(), z.string()),
      z.null(),
    ])
    .optional()
    .describe(
      'The new value. Omit to read the current value. Use null (or the string "default" for scalar keys) to clear.',
    ),
});



type SettingType = "string" | "boolean" | "number" | "stringArray" | "object";

interface SettingConfig {
  
  path: string[];
  type: SettingType;
  description: string;
  
  options?: readonly string[];
  
  sensitive?: boolean;
  
  label: string;
}

const SUPPORTED_SETTINGS: Record<string, SettingConfig> = {
  model: {
    path: ["model"],
    type: "string",
    label: "model",
    options: ["deepseek-chat", "deepseek-reasoner"],
    description: "Override the default model",
  },
  baseURL: {
    path: ["baseURL"],
    type: "string",
    label: "baseURL",
    description: "Override the API endpoint",
  },
  provider: {
    path: ["provider"],
    type: "string",
    label: "provider",
    options: ["deepseek"],
    description: "Provider type",
  },
  apiKey: {
    path: ["apiKey"],
    type: "string",
    label: "apiKey",
    sensitive: true,
    description: "Override the API key",
  },
  defaultAgent: {
    path: ["defaultAgent"],
    type: "string",
    label: "defaultAgent",
    options: ["code", "plan", "review"],
    description: "Default agent to start with",
  },
  thinkingMode: {
    path: ["thinkingMode"],
    type: "string",
    label: "thinkingMode",
    options: ["off", "whale"],
    description: "Extended-thinking mode",
  },
  themeMode: {
    path: ["themeMode"],
    type: "string",
    label: "themeMode",
    options: ["dark", "light"],
    description: "Color theme",
  },
  verbose: {
    path: ["verbose"],
    type: "boolean",
    label: "verbose",
    description: "Show detailed debug output",
  },
  spinnerTipsEnabled: {
    path: ["spinnerTipsEnabled"],
    type: "boolean",
    label: "spinnerTipsEnabled",
    description: "Show the spinner tip/elapsed line",
  },
  outputStyle: {
    path: ["outputStyle"],
    type: "string",
    label: "outputStyle",
    description: "Default output style label",
  },
  includeCoAuthoredBy: {
    path: ["includeCoAuthoredBy"],
    type: "boolean",
    label: "includeCoAuthoredBy",
    description: "Add a Co-Authored-By trailer to /commit messages",
  },
  cleanupPeriodDays: {
    path: ["cleanupPeriodDays"],
    type: "number",
    label: "cleanupPeriodDays",
    description: "Delete saved sessions older than N days on startup",
  },
  env: {
    path: ["env"],
    type: "object",
    label: "env",
    description: "Environment variables injected into the session/tool environment",
  },
  "permissions.allow": {
    path: ["permissions", "allow"],
    type: "stringArray",
    label: "permissions.allow",
    description: "Tool permission allow rules (Tool(spec:pattern))",
  },
  "permissions.deny": {
    path: ["permissions", "deny"],
    type: "stringArray",
    label: "permissions.deny",
    description: "Tool permission deny rules",
  },
  "permissions.ask": {
    path: ["permissions", "ask"],
    type: "stringArray",
    label: "permissions.ask",
    description: "Tool permission ask rules",
  },
};



function isSupported(key: string): boolean {
  return key in SUPPORTED_SETTINGS;
}

function getConfig(key: string): SettingConfig {
  return SUPPORTED_SETTINGS[key]!;
}


function getValue(settings: PersistedSettings, path: string[]): unknown {
  let current: unknown = settings;
  for (const key of path) {
    if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}


function buildNestedUpdate(path: string[], value: unknown): Record<string, unknown> {
  if (path.length === 0) return {};
  const head = path[0]!;
  const rest = path.slice(1);
  if (rest.length === 0) {
    return { [head]: value };
  }
  return { [head]: buildNestedUpdate(rest, value) };
}


function deepMergeSettings(
  base: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(update)) {
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      out[key] !== null &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = { ...(out[key] as object), ...(val as object) };
    } else {
      
      
      
      out[key] = val;
    }
  }
  return out;
}


function clearKey(path: string[]): Record<string, unknown> {
  
  const settings: Record<string, unknown> = loadSettings() as Record<string, unknown>;
  if (path.length === 1) {
    delete settings[path[0]!];
  } else {
    let current: unknown = settings;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]!;
      if (
        current &&
        typeof current === "object" &&
        key in (current as Record<string, unknown>)
      ) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return settings; 
      }
    }
    const last = path[path.length - 1]!;
    if (
      current &&
      typeof current === "object" &&
      last in (current as Record<string, unknown>)
    ) {
      delete (current as Record<string, unknown>)[last];
    }
  }
  return settings;
}


function formatValue(value: unknown): string {
  if (value === undefined) return "(not set)";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}


function coerceAndValidate(
  config: SettingConfig,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  
  if (raw === null) return { ok: true, value: null };

  if (config.type === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    if (typeof raw === "string") {
      const lower = raw.toLowerCase().trim();
      if (lower === "true") return { ok: true, value: true };
      if (lower === "false") return { ok: true, value: false };
    }
    return { ok: false, error: `${config.label} requires true or false.` };
  }

  if (config.type === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: raw };
    if (typeof raw === "string") {
      const n = Number(raw);
      if (raw.trim() !== "" && Number.isFinite(n)) return { ok: true, value: n };
    }
    return { ok: false, error: `${config.label} requires a number.` };
  }

  if (config.type === "string") {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      return { ok: false, error: `${config.label} requires a string.` };
    }
    const str = String(raw);
    
    if (str.toLowerCase().trim() === "default") return { ok: true, value: null };
    if (config.options && !config.options.includes(str)) {
      return {
        ok: false,
        error: `Invalid value "${str}". Options: ${config.options.join(", ")}`,
      };
    }
    return { ok: true, value: str };
  }

  if (config.type === "stringArray") {
    if (!Array.isArray(raw) || !raw.every((e) => typeof e === "string")) {
      return { ok: false, error: `${config.label} requires an array of strings.` };
    }
    return { ok: true, value: raw };
  }

  
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    raw === null ||
    !Object.values(raw).every((v) => typeof v === "string")
  ) {
    return {
      ok: false,
      error: `${config.label} requires an object mapping string -> string.`,
    };
  }
  return { ok: true, value: raw };
}



export const ConfigTool = buildTool({
  name: CONFIG_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: ConfigInputSchema,

  userFacingName: (input) => {
    const setting = (input?.setting as string | undefined) ?? "";
    const isRead = input?.value === undefined;
    return isRead ? `Config get ${setting}`.trim() : `Config set ${setting}`.trim();
  },

  isEnabled: () => true,
  isConcurrencySafe: () => false,
  isReadOnly: (input) => input.value === undefined,

  maxResultSizeChars: 100_000,

  checkPermissions: async (input, context) => {
    
    if (input.value === undefined) {
      return { approved: true };
    }

    
    if (!context.permissions.allowWrite) {
      return {
        approved: false,
        feedback: "Write permission denied for this agent; cannot modify settings.",
      };
    }

    const config = isSupported(input.setting) ? getConfig(input.setting) : null;
    const displayValue =
      config?.sensitive
        ? "*** (hidden)"
        : formatValue(
            typeof input.value === "string" &&
              config?.type === "string" &&
              input.value.toLowerCase().trim() === "default"
              ? "(clear / restore default)"
              : input.value,
          );

    const preview = [
      `Set setting ${input.setting}`,
      `New value: ${displayValue}`,
      "",
      "This writes to ~/.deepseek-code/settings.json.",
    ].join("\n");

    return context.requestPermission("Config", preview);
  },

  call: async (input) => {
    const { setting, value } = input;

    
    if (!isSupported(setting)) {
      return {
        data: `Error: Unknown setting "${setting}". Supported settings: ${Object.keys(SUPPORTED_SETTINGS).join(", ")}.`,
      };
    }
    const config = getConfig(setting);

    
    if (value === undefined) {
      const current = getValue(loadSettings(), config.path);
      return {
        data: `${config.label} = ${formatValue(current)}`,
      };
    }

    
    const validated = coerceAndValidate(config, value);
    if (!validated.ok) {
      return { data: `Error: ${validated.error}` };
    }
    const finalValue = validated.value;

    try {
      
      if (finalValue === null) {
        const cleared = clearKey(config.path);
        
        
        
        saveSettings(cleared as PersistedSettings);
        const after = getValue(loadSettings(), config.path);
        return {
          data: `Cleared ${config.label} (now: ${formatValue(after)}). Restart recommended for full effect.`,
        };
      }

      
      const before = getValue(loadSettings(), config.path);
      const update = buildNestedUpdate(config.path, finalValue);
      const merged = deepMergeSettings(
        loadSettings() as Record<string, unknown>,
        update,
      );
      saveSettings(merged as PersistedSettings);
      const after = getValue(loadSettings(), config.path);

      const effectNote = needsRestartNote(setting);

      return {
        data: [
          `Set ${config.label} to ${formatValue(after)} (was ${formatValue(before)}).`,
          effectNote,
        ]
          .filter(Boolean)
          .join(" "),
      };
    } catch (error) {
      return { data: `Error writing setting: ${(error as Error).message}` };
    }
  },
});



function needsRestartNote(setting: string): string | null {
  switch (setting) {
    case "model":
    case "baseURL":
    case "provider":
    case "apiKey":
      return "Takes effect on the next turn (the C++ backend re-reads provider config per query).";
    case "thinkingMode":
    case "themeMode":
    case "verbose":
    case "spinnerTipsEnabled":
      return "May require an app restart for full effect.";
    default:
      return null;
  }
}
