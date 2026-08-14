

















export type OutputStyleSource = "built-in" | "custom";


export interface OutputStyleConfig {
  
  name: string;
  
  description: string;
  
  prompt: string;
  
  source: OutputStyleSource;
  
  keepIdentity?: boolean;
}




const EXPLANATORY_INSIGHTS_FRAGMENT = `
## Insights
To encourage learning, before and after writing code, provide brief educational
explanations about your implementation choices using this fenced block:

> Insight ─────────────────────────────────────
> [2-3 key educational points]
> ─────────────────────────────────────────────────

These insights live in the conversation, not in the codebase. Focus on insights
specific to this codebase or the code you just wrote, not general programming
concepts.`;


export const DEFAULT_OUTPUT_STYLE_NAME = "default";


const DEFAULT_OUTPUT_STYLE: OutputStyleConfig = {
  name: DEFAULT_OUTPUT_STYLE_NAME,
  description: "Standard responses — no extra framing.",
  prompt: "",
  source: "built-in",
  keepIdentity: true,
};


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




const customStyles: Record<string, OutputStyleConfig> = {};


export function getOutputStyle(name?: string | null): OutputStyleConfig {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return DEFAULT_OUTPUT_STYLE;
  return customStyles[key] ?? BUILTIN_STYLES[key] ?? DEFAULT_OUTPUT_STYLE;
}


export function listOutputStyles(): OutputStyleConfig[] {
  const seen = new Set<string>();
  const out: OutputStyleConfig[] = [];
  
  for (const cfg of Object.values(BUILTIN_STYLES)) {
    const k = cfg.name.toLowerCase();
    seen.add(k);
    const custom = customStyles[k];
    out.push(custom ?? cfg);
  }
  
  for (const cfg of Object.values(customStyles)) {
    const k = cfg.name.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(cfg);
    }
  }
  return out;
}


export function registerOutputStyle(config: OutputStyleConfig): void {
  if (!config || !config.name || !config.name.trim()) return;
  const key = config.name.trim().toLowerCase();
  customStyles[key] = { ...config, source: config.source ?? "custom" };
}


export function isActiveStyleCustom(name?: string | null): boolean {
  const active = getOutputStyle(name);
  return active.name.toLowerCase() !== DEFAULT_OUTPUT_STYLE_NAME;
}




function formatStyleSection(config: OutputStyleConfig): string | null {
  if (!config.prompt || !config.prompt.trim()) return null;
  return `# Output Style: ${config.name}\n${config.prompt.trim()}`;
}


export function composeWithSystemPrompt(
  systemPrompt: string,
  styleName?: string | null,
): string {
  const config = getOutputStyle(styleName);
  const section = formatStyleSection(config);
  if (!section) return systemPrompt;

  if (config.keepIdentity === false) {
    
    
    return section;
  }

  const base = (systemPrompt ?? "").trim();
  if (!base) return section;
  return `${base}\n\n${section}`;
}
