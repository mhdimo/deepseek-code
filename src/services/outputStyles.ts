// Named output-style registry for DeepSeek Code.
//
// Adapted from Claude Code's src/constants/outputStyles.ts, but stripped of
// plugin / policy / markdown-directory loading (those concerns belong to a
// future plugin system). This module is pure TS: a fixed registry of named
// output styles, each with a system-prompt fragment (tone/format guidance) and
// metadata (name, description, source, keepCodingInstructions).
//
// The integrator (agentSession.ts) calls composeWithSystemPrompt() to inject
// the active style fragment — resolved from settings.outputStyle — into the
// assembled system prompt before handing it to `new Agent({ instructions })`.
//
// The "default" style is the identity element: it contributes no extra text,
// so the base system prompt is unchanged when no style is active.

// ─── Types ────────────────────────────────────────────────────────────────────

/** Where an output style originates. */
export type OutputStyleSource = "built-in" | "custom";

/**
 * A named output style: a system-prompt fragment that shapes the model's
 * tone/format, plus metadata used by pickers and the composer.
 */
export interface OutputStyleConfig {
  /** Stable, human-readable identifier (e.g. "default", "explanatory"). */
  name: string;
  /** Short label shown in pickers / status UI. */
  description: string;
  /**
   * The system-prompt fragment to inject when this style is active. Should NOT
   * include a heading — composeWithSystemPrompt() wraps it in a section. For the
   * default style this is an empty string (the identity element).
   */
  prompt: string;
  /** Origin of the style. */
  source: OutputStyleSource;
  /**
   * If true, the agent's core coding/operating instructions are kept verbatim
   * and the style fragment is appended. If false, the style fragment fully
   * replaces the identity framing (the style's prompt is expected to stand on
   * its own). Default true (append). Used by composeWithSystemPrompt().
   */
  keepIdentity?: boolean;
}

// ─── Built-in styles ─────────────────────────────────────────────────────────

/**
 * Shared educational-insights fragment used by both the explanatory and
 * learning styles. Kept here (not exported) because it is internal scaffolding
 * for the two built-in teaching styles.
 */
const EXPLANATORY_INSIGHTS_FRAGMENT = `
## Insights
To encourage learning, before and after writing code, provide brief educational
explanations about your implementation choices using this fenced block:

> ★ Insight ─────────────────────────────────────
> [2-3 key educational points]
> ─────────────────────────────────────────────────

These insights live in the conversation, not in the codebase. Focus on insights
specific to this codebase or the code you just wrote, not general programming
concepts.`;

/** The canonical name of the no-op default style. */
export const DEFAULT_OUTPUT_STYLE_NAME = "default";

/**
 * The default (identity-element) style. Held as a direct const so lookups never
 * return undefined under noUncheckedIndexedAccess. Its prompt is empty, so
 * composing it leaves the base system prompt unchanged.
 */
const DEFAULT_OUTPUT_STYLE: OutputStyleConfig = {
  name: DEFAULT_OUTPUT_STYLE_NAME,
  description: "Standard responses — no extra framing.",
  prompt: "",
  source: "built-in",
  keepIdentity: true,
};

/**
 * The built-in style registry. Keys are lowercase canonical names; lookups are
 * case-insensitive (see getOutputStyle). The "default" entry aliases
 * DEFAULT_OUTPUT_STYLE.
 */
const BUILTIN_STYLES: Record<string, OutputStyleConfig> = {
  [DEFAULT_OUTPUT_STYLE_NAME]: DEFAULT_OUTPUT_STYLE,

  explanatory: {
    name: "explanatory",
    description:
      "Explain implementation choices and codebase patterns alongside the work.",
    source: "built-in",
    keepIdentity: true,
    prompt: `In addition to the software-engineering task, provide educational
insights about the codebase as you go. Be clear and educational, providing
helpful explanations while staying focused on the task. Balance educational
content with task completion: you may exceed typical length constraints when an
explanation is genuinely useful, but remain focused and relevant.
${EXPLANATORY_INSIGHTS_FRAGMENT}`,
  },

  learning: {
    name: "learning",
    description:
      "Pause and ask the user to write small pieces of code for hands-on practice.",
    source: "built-in",
    keepIdentity: true,
    prompt: `In addition to the software-engineering task, help the user learn
the codebase through hands-on practice and educational insights. Be
collaborative and encouraging. Balance task completion with learning by
requesting user input for meaningful design decisions while handling routine
implementation yourself.

# Learning Style Active
## Requesting Human Contributions
To encourage learning, ask the human to contribute 2-10 line code pieces when
generating 20+ lines involving:
- Design decisions (error handling, data structures)
- Business logic with multiple valid approaches
- Key algorithms or interface definitions

**TodoList integration**: if you use a TodoList for the task, include a specific
item like "Request human input on [decision]" when planning to ask for input.

### Request Format
\`\`\`
• **Learn by Doing**
**Context:** [what's built and why this decision matters]
**Your Task:** [specific function/section in file; mention the file and a
TODO(human) marker, not line numbers]
**Guidance:** [trade-offs and constraints to consider]
\`\`\`

### Key Guidelines
- Frame contributions as valuable design decisions, not busywork.
- First add a single TODO(human) section into the codebase with your editing
  tools before making the request. Keep exactly one such section.
- After making the request, stop and wait for the human's implementation before
  proceeding.

### After Contributions
Share one insight connecting their code to broader patterns or system effects.
Avoid praise or repetition.
${EXPLANATORY_INSIGHTS_FRAGMENT}`,
  },
};

// ─── Registry API ─────────────────────────────────────────────────────────────

/**
 * Registry of custom styles layered on top of the built-ins. Custom styles with
 * the same (case-insensitive) name override built-ins. Mutated via
 * registerOutputStyle(); the integrator / a future plugin system is the only
 * intended writer.
 */
const customStyles: Record<string, OutputStyleConfig> = {};

/**
 * Resolve a style by name (case-insensitive). Returns the "default" style
 * (identity element, empty prompt) when `name` is null/undefined/unknown, so
 * callers never have to null-check. This mirrors Claude Code's fallback to
 * DEFAULT_OUTPUT_STYLE_NAME.
 */
export function getOutputStyle(name?: string | null): OutputStyleConfig {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return DEFAULT_OUTPUT_STYLE;
  return customStyles[key] ?? BUILTIN_STYLES[key] ?? DEFAULT_OUTPUT_STYLE;
}

/**
 * All registered styles, built-in first then custom (custom override by name at
 * lookup time, but the list is deduped so a custom override replaces the
 * built-in entry of the same name). Ordered for stable picker display.
 */
export function listOutputStyles(): OutputStyleConfig[] {
  const seen = new Set<string>();
  const out: OutputStyleConfig[] = [];
  // Built-ins first, in declaration order.
  for (const cfg of Object.values(BUILTIN_STYLES)) {
    const k = cfg.name.toLowerCase();
    seen.add(k);
    const custom = customStyles[k];
    out.push(custom ?? cfg);
  }
  // Then any custom styles that don't shadow a built-in, in insertion order.
  for (const cfg of Object.values(customStyles)) {
    const k = cfg.name.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(cfg);
    }
  }
  return out;
}

/**
 * Register (or override) a custom output style at runtime. Intended for a
 * future plugin system; the core TUI uses only the built-ins. Names are
 * normalized to lowercase for lookup but the original casing is preserved in
 * the returned config's `name`.
 */
export function registerOutputStyle(config: OutputStyleConfig): void {
  if (!config || !config.name || !config.name.trim()) return;
  const key = config.name.trim().toLowerCase();
  customStyles[key] = { ...config, source: config.source ?? "custom" };
}

/** True when a non-default style is active (used by UI to badge the status). */
export function isActiveStyleCustom(name?: string | null): boolean {
  const active = getOutputStyle(name);
  return active.name.toLowerCase() !== DEFAULT_OUTPUT_STYLE_NAME;
}

// ─── System-prompt composition ────────────────────────────────────────────────

/**
 * Wrap a non-default style's prompt fragment in a labeled section, mirroring
 * Claude Code's getOutputStyleSection(). Returns null for the default style so
 * the composer adds nothing.
 */
function formatStyleSection(config: OutputStyleConfig): string | null {
  if (!config.prompt || !config.prompt.trim()) return null;
  return `# Output Style: ${config.name}\n${config.prompt.trim()}`;
}

/**
 * Compose the active output style into a system prompt.
 *
 * - If the style is "default" (or keepIdentity is true), the style section is
 *   APPENDED to the base system prompt, leaving the agent identity intact.
 * - If keepIdentity is false, the style's prompt REPLACES the base system
 *   prompt entirely (the style is expected to carry its own identity framing).
 *
 * Always returns at least the base system prompt when appending; never throws.
 * This is the single entry point the integrator (agentSession.ts) calls.
 *
 * @param systemPrompt The fully-assembled base system prompt (identity + env +
 *   tools + operating rules from assembleSystemPromptSync).
 * @param styleName The active style name, typically settings.outputStyle.
 */
export function composeWithSystemPrompt(
  systemPrompt: string,
  styleName?: string | null,
): string {
  const config = getOutputStyle(styleName);
  const section = formatStyleSection(config);
  if (!section) return systemPrompt;

  if (config.keepIdentity === false) {
    // The style fully owns the framing — drop the base prompt's identity but
    // keep the labeled style section as the entire prompt.
    return section;
  }

  const base = (systemPrompt ?? "").trim();
  if (!base) return section;
  return `${base}\n\n${section}`;
}
