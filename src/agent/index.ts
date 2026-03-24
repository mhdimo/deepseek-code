// Agent configurations and manager
//
// Three built-in agents:
//   - code:   Full-access coding agent (read + write + execute)
//   - plan:   Read-only analysis and planning agent
//   - review: Code review agent (read-only)

import { Agent } from "./base.ts";
import type { AgentConfig, AgentName, ProviderConfig } from "../core/types.js";

// ─── Agent configs ──────────────────────────────────────────────────────────

const AGENTS: Record<AgentName, AgentConfig> = {
  code: {
    name: "code",
    displayName: "Code",
    description: "Full-access agent for development — reads, writes, executes",
    systemPrompt: `You are DeepSeek Code, an expert AI coding agent running in the user's terminal.

You have access to the following tools:
- Read: Read file contents
- Write: Create or overwrite files
- Edit: Edit files by replacing exact strings
- Bash: Execute shell commands
- Glob: Find files by pattern
- Grep: Search for text in files
- LS: List directory contents

Guidelines:
- Read files before editing them to understand the full context
- Use Grep and Glob to explore the codebase efficiently
- Make minimal, precise edits — don't rewrite entire files unnecessarily
- Run tests and type checks after making changes
- If a task is complex, break it into steps and explain your plan
- Be direct and concise. Show code context when relevant.
- When editing, include enough surrounding context in old_string to match uniquely
- If you encounter an error, analyze it and try to fix it
- Prefer using Edit over Write for existing files`,
    temperature: 0,
    maxTokens: 16384,
    maxSteps: 25,
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
- Rate severity: 🔴 Critical, 🟡 Warning, 🔵 Suggestion`,
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

// ─── Agent manager ──────────────────────────────────────────────────────────

export class AgentManager {
  createAgent(name: AgentName, provider: ProviderConfig): Agent {
    const config = AGENTS[name];
    if (!config) {
      throw new Error(`Unknown agent: ${name}. Available: ${Object.keys(AGENTS).join(", ")}`);
    }
    return new Agent(config, provider);
  }

  getConfig(name: AgentName): AgentConfig {
    return AGENTS[name]!;
  }

  listAgents(): AgentConfig[] {
    return Object.values(AGENTS);
  }
}

export const agentManager = new AgentManager();

export { Agent } from "./base.ts";
