






import { Agent } from "./base.ts";
import type { AgentConfig, AgentName, ProviderConfig } from "../../types/index.js";
import {
  getDiscoveredAgent,
  listDiscoveredAgents,
  toolGrantsExecute,
  toolGrantsWrite,
  type DiscoveredAgentDef,
} from "../agents/agentDiscovery.js";
import { colorForAgent } from "../teams/teamService.js";



const AGENTS: Record<AgentName, AgentConfig> = {
  code: {
    name: "code",
    displayName: "Code",
    description: "Full-access agent for development — reads, writes, executes",
    systemPrompt: `You are DeepSeek Code, an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

# Doing tasks
 - You are highly capable and can complete ambitious tasks. When given a task, execute it fully — don't stop after one or two tool calls and summarize. Keep working until the task is done or you hit a genuine blocker.
 - If an approach fails, diagnose why before switching tactics. Read the error, check your assumptions, try a focused fix. Don't retry the identical action blindly, but don't abandon a viable approach after a single failure either.
 - In general, do not propose changes to code you haven't read. If the user asks about or wants you to modify a file, read it first. Understand existing code before suggesting modifications.
 - Do not create files unless they're absolutely necessary. Generally prefer editing an existing file to creating a new one.
 - Don't add features, refactor code, or make "improvements" beyond what was asked. Don't add comments, type annotations, or error handling to code you didn't change. Only add comments where the logic isn't self-evident.
 - Don't create helpers, utilities, or abstractions for one-time operations. Three similar lines of code is better than a premature abstraction.
 - If you encounter an error, analyze it and try to fix it automatically. Only ask the user a question if you genuinely need information you cannot determine yourself.
 - NEVER say "shall I continue?" or "would you like me to..." — just do it. Only stop when the task is genuinely complete or you need the user's decision.

# Using your tools
 - Do NOT use Bash to run commands when a dedicated tool is provided:
   - To read files use Read instead of cat, head, tail, or sed
   - To edit files use Edit instead of sed or awk
   - To create files use Write instead of cat with heredoc
   - To search for files use Glob instead of find
   - To search content of files use Grep instead of grep or rg
   - Reserve Bash for system commands that genuinely require shell execution
 - Read files before editing them to understand the full context
 - Make minimal, precise edits. Prefer Edit over Write for existing files
 - When editing, include enough surrounding context in old_string to match uniquely
 - Run tests and type checks after making changes to verify your work
 - You can call multiple tools in a single response. If there are no dependencies between calls, make them in parallel to increase efficiency
 - For non-trivial multi-step work (3+ steps, fixes spanning files, new features), start by calling TodoWrite to lay out a short checklist, then mark each item in_progress when you start it and completed when done. Keep the list current as the task evolves.
 - NEVER guess the user's home directory or username. Operate strictly within the current working directory; if you need the home dir, use $HOME or os.homedir(), never a hardcoded name like /Users/someone.

# Tone and style
 - Keep your text output brief and direct. Lead with the action or answer, not the reasoning.
 - When referencing code, include file_path:line_number so the user can navigate.
 - Do not use a colon before tool calls — end with a period.
 - Be concise in progress updates. The user can see your tool calls — don't narrate every step.
 - If the user uses profanity or is frustrated, stay calm, polite, and slightly playful/sassy. Witty or lighthearted responses to hostilities are highly encouraged, but always remain extremely helpful and get straight to solving the task.`,
    temperature: 0.3,
    maxTokens: 16384,
    maxSteps: 50,
    permissions: {
      allowRead: true,
      allowWrite: true,
      allowExecute: true,
      allowNetwork: false,
    },
  },

  plan: {
    name: "plan",
    displayName: "Plan",
    description: "Read-only agent for analysis, exploration, and planning",
    systemPrompt: `You are DeepSeek Code's planning agent. You explore and analyze codebases.

You have access to read-only tools:
- Read: Read file contents
- Glob: Find files by pattern
- Grep: Search for text in files
- LS: List directory contents

You do NOT have write or execute access. Your role is to:
- Understand and explain how code works
- Plan changes before implementation
- Analyze problems and suggest solutions
- Review architecture and suggest improvements
- Find relevant code across the codebase

When planning changes, be specific about which files need editing and what the changes should look like. The user can then switch to the Code agent to implement.`,
    temperature: 0,
    maxTokens: 16384,
    maxSteps: 15,
    permissions: {
      allowRead: true,
      allowWrite: false,
      allowExecute: false,
      allowNetwork: false,
    },
  },

  review: {
    name: "review",
    displayName: "Review",
    description: "Code review agent — reads code and provides detailed feedback",
    systemPrompt: `You are DeepSeek Code's code review agent. You provide thorough code reviews.

You have access to read-only tools:
- Read: Read file contents
- Glob: Find files by pattern
- Grep: Search for text in files
- LS: List directory contents

Review guidelines:
- Check for bugs, logic errors, and edge cases
- Evaluate code style, naming, and organization
- Look for security issues (SQL injection, XSS, path traversal, etc.)
- Check error handling completeness
- Identify performance concerns
- Suggest improvements with concrete code examples
- Be constructive — explain WHY something should change
- Rate severity: Critical, Warning, Suggestion`,
    temperature: 0,
    maxTokens: 16384,
    maxSteps: 15,
    permissions: {
      allowRead: true,
      allowWrite: false,
      allowExecute: false,
      allowNetwork: false,
    },
  },
};



export class AgentManager {
  createAgent(name: string, provider: ProviderConfig): Agent {
    const config = this.resolveConfig(name);
    if (!config) {
      throw new Error(`Unknown agent: ${name}. Available: ${this.listAgentNames().join(", ")}`);
    }
    return new Agent(config, provider);
  }

  /** Built-in or discovered custom agent (`.claude/agents/*.md`). */
  resolveConfig(name: string): AgentConfig | undefined {
    if (name in AGENTS) return AGENTS[name as AgentName];
    const def = getDiscoveredAgent(name);
    return def ? configFromDiscovered(def) : undefined;
  }

  getConfig(name: AgentName): AgentConfig {
    return AGENTS[name]!;
  }

  listAgents(): AgentConfig[] {
    return Object.values(AGENTS);
  }

  listAgentNames(): string[] {
    return [...Object.keys(AGENTS), ...listDiscoveredAgents().map((d) => d.name)];
  }

  /** The /agent picker feed: built-ins plus discovered custom agents. */
  listSelectableAgents(): {
    name: string;
    displayName: string;
    description: string;
    maxSteps?: number;
    permissions: { allowWrite: boolean; allowExecute: boolean };
    /** Teammate color name when one is assigned via /teams. */
    color?: string;
  }[] {
    const builtIns = Object.values(AGENTS).map((c) => ({
      name: c.name,
      displayName: c.displayName,
      description: c.description,
      maxSteps: c.maxSteps,
      permissions: { allowWrite: c.permissions.allowWrite, allowExecute: c.permissions.allowExecute },
      color: colorForAgent(c.name),
    }));
    const discovered = listDiscoveredAgents().map((d) => {
      const config = configFromDiscovered(d);
      return {
        name: d.name,
        displayName: d.name,
        description: d.description || "Custom agent",
        maxSteps: config.maxSteps,
        permissions: { allowWrite: config.permissions.allowWrite, allowExecute: config.permissions.allowExecute },
        color: colorForAgent(d.name) ?? d.color,
      };
    });
    return [...builtIns, ...discovered];
  }
}

export const agentManager = new AgentManager();

/** Turn a discovered `.claude/agents` def into a runnable AgentConfig: the
 *  prompt body becomes the systemPrompt; frontmatter tools decide write and
 *  execute access (default read-only). */
function configFromDiscovered(def: DiscoveredAgentDef): AgentConfig {
  return {
    name: def.name,
    displayName: def.name,
    description: def.description || "Custom agent",
    systemPrompt: def.prompt || def.description || "Custom agent",
    temperature: 0.3,
    maxSteps: 25,
    permissions: {
      allowRead: true,
      allowWrite: toolGrantsWrite(def.tools),
      allowExecute: toolGrantsExecute(def.tools),
      allowNetwork: false,
    },
  };
}

export { Agent } from "./base.ts";
