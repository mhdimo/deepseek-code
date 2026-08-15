
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSkillMarkdown } from "../../skills/skillService.js";

/**
 * Workflows — declarative multi-phase subagent orchestration, ported from
 * Claude Code's integration surface. A workflow is a markdown file with
 * frontmatter (name, description) and a body of `## Phase: <title>` sections;
 * each section lists steps that run in parallel:
 *
 *   - agent: plan · name: research · desc: map the codebase · prompt: ...
 *
 * `{input}` substitutes the invocation args; `{N.result}` / `{name.result}`
 * substitute an earlier step's response (steps are numbered 1-based across
 * the whole workflow).
 */

export type WorkflowSource = "project" | "user" | "bundled";

export interface WorkflowStep {
  agent: "code" | "plan" | "review";
  name?: string;
  description?: string;
  prompt: string;
}

export interface WorkflowPhase {
  title: string;
  steps: WorkflowStep[];
}

export interface Workflow {
  name: string;
  description: string;
  path: string;
  source: WorkflowSource;
  phases: WorkflowPhase[];
}

const STEP_RE =
  /^-\s*agent:\s*(code|plan|review)\s*(?:·\s*name:\s*([A-Za-z0-9_-]+))?\s*(?:·\s*desc:\s*([^·]*?))?\s*·\s*prompt:\s*(.+)$/;

function parsePhases(body: string): WorkflowPhase[] {
  const phases: WorkflowPhase[] = [];
  let current: WorkflowPhase | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const phaseMatch = line.match(/^##\s+Phase:\s*(.+)$/i);
    if (phaseMatch) {
      current = { title: phaseMatch[1]!.trim(), steps: [] };
      phases.push(current);
      continue;
    }
    if (!current) continue;
    if (!line.startsWith("-")) continue;
    const m = line.match(STEP_RE);
    if (!m) continue;
    current.steps.push({
      agent: m[1]! as WorkflowStep["agent"],
      name: m[2],
      description: m[3]?.trim() || undefined,
      prompt: m[4]!.trim().replace(/\\n/g, "\n"),
    });
  }
  return phases.filter((p) => p.steps.length > 0);
}

function loadWorkflowFile(path: string, source: WorkflowSource): Workflow | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const { name, description, body } = parseSkillMarkdown(raw);
    const phases = parsePhases(body);
    if (phases.length === 0) return null;
    const fallbackName = path.split("/").slice(-2, -1)[0] ?? path;
    const resolvedName = (name || fallbackName).toLowerCase();
    if (!resolvedName) return null;
    return {
      name: resolvedName,
      description: description || `${phases.length}-phase workflow`,
      path,
      source,
      phases,
    };
  } catch {
    return null;
  }
}

function loadWorkflowsFromDir(dir: string, source: WorkflowSource): Workflow[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Workflow[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const wf = loadWorkflowFile(join(dir, entry.name), source);
    if (wf) out.push(wf);
  }
  return out;
}

function bundledWorkflowsDir(): string {
  // Built binary: dist/workflows (copied by `bun run build`). Dev: source dir.
  const primary = join(import.meta.dir, "workflows");
  const fallback = join(process.cwd(), "src", "workflows", "bundled");
  return existsSync(primary) ? primary : existsSync(fallback) ? fallback : primary;
}

let cached: Workflow[] | null = null;

/** Discovered workflows: project `.claude/workflows/` > user
 *  `~/.claude/workflows/` > bundled (first match wins by name). */
export function listWorkflows(): Workflow[] {
  if (cached !== null) return cached;
  const byName = new Map<string, Workflow>();
  const sources: Array<[string, WorkflowSource]> = [
    [join(process.cwd(), ".claude", "workflows"), "project"],
    [join(homedir(), ".claude", "workflows"), "user"],
    [bundledWorkflowsDir(), "bundled"],
  ];
  for (const [dir, source] of sources) {
    for (const wf of loadWorkflowsFromDir(dir, source)) {
      if (!byName.has(wf.name)) byName.set(wf.name, wf);
    }
  }
  cached = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return cached;
}

export function getWorkflow(name: string): Workflow | null {
  const trimmed = name.trim().replace(/^\//, "").toLowerCase();
  return listWorkflows().find((wf) => wf.name === trimmed) ?? null;
}

export function clearWorkflowsCache(): void {
  cached = null;
}

/** Substitute `{input}`, `{N.result}`, and `{name.result}` references in a
 *  step prompt. Unknown references are left intact (visible in the prompt,
 *  cheaper than silently dropping them). */
export function substituteVars(
  text: string,
  vars: { input: string; results: Map<string, string> },
): string {
  return text
    .replace(/\{input\}/g, vars.input)
    .replace(/\{([A-Za-z0-9_-]+)\.result\}/g, (whole, ref: string) => {
      const value = vars.results.get(ref) ?? vars.results.get(ref.toLowerCase());
      return value !== undefined ? value : whole;
    });
}

/** Number every step 1-based across the workflow and index the results map
 *  by both number and name. */
export function flattenSteps(workflow: Workflow): Array<{
  step: WorkflowStep;
  phaseTitle: string;
  number: number;
}> {
  const out: Array<{ step: WorkflowStep; phaseTitle: string; number: number }> = [];
  let n = 0;
  for (const phase of workflow.phases) {
    for (const step of phase.steps) {
      n++;
      out.push({ step, phaseTitle: phase.title, number: n });
    }
  }
  return out;
}
