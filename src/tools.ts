// Tool registry — assembles tools and converts to AI SDK format
//
// This is the bridge between the Tool interface and AI SDK's tool format.
// Tools use Zod internally, but we convert to jsonSchema() for DeepSeek API.

import { tool as bindingTool, type ToolDefinition } from "ai-sdk-cpp";
import type { Tool, Tools, ToolUseContext, PermissionDecision } from "./Tool.js";
import type { PermissionRuleset } from "./types/index.js";

// ─── Tool imports ─────────────────────────────────────────────────────────────
import { FileReadTool } from "./tools/FileReadTool/FileReadTool.js";
import { FileWriteTool } from "./tools/FileWriteTool/FileWriteTool.js";
import { FileEditTool } from "./tools/FileEditTool/FileEditTool.js";
import { BashTool } from "./tools/BashTool/BashTool.js";
import { GlobTool } from "./tools/GlobTool/GlobTool.js";
import { GrepTool } from "./tools/GrepTool/GrepTool.js";
import { LSTool } from "./tools/LS/LSTool.js";
import { WebFetchTool } from "./tools/WebFetchTool/WebFetchTool.js";
import { WebSearchTool } from "./tools/WebSearchTool/WebSearchTool.js";
import { NotebookEditTool } from "./tools/NotebookEditTool/NotebookEditTool.js";
import { TodoWriteTool } from "./tools/TodoWriteTool/TodoWriteTool.js";
import { TaskCreateTool } from "./tools/TaskCreateTool/TaskCreateTool.js";
import { TaskGetTool } from "./tools/TaskGetTool/TaskGetTool.js";
import { TaskUpdateTool } from "./tools/TaskUpdateTool/TaskUpdateTool.js";
import { TaskListTool } from "./tools/TaskListTool/TaskListTool.js";
import { AgentTool } from "./tools/AgentTool/AgentTool.js";
import { AskUserQuestionTool } from "./tools/AskUserQuestionTool/AskUserQuestionTool.js";
import { EnterPlanModeTool } from "./tools/EnterPlanModeTool/EnterPlanModeTool.js";
import { ExitPlanModeTool } from "./tools/ExitPlanModeTool/ExitPlanModeTool.js";

// ─── All tools ────────────────────────────────────────────────────────────────

export function getAllBaseTools(): Tools {
  return [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    BashTool,
    GlobTool,
    GrepTool,
    LSTool,
    WebFetchTool,
    WebSearchTool,
    NotebookEditTool,
    TodoWriteTool,
    TaskCreateTool,
    TaskGetTool,
    TaskUpdateTool,
    TaskListTool,
    AgentTool,
    AskUserQuestionTool,
    EnterPlanModeTool,
    ExitPlanModeTool,
  ];
}

// ─── Permission-aware filtering ───────────────────────────────────────────────

/**
 * Get tools filtered by permissions and enabled status.
 * Permission checks happen at execution time per-tool, but we pre-filter
 * tools that are completely disabled by the permission ruleset.
 */
export function getTools(permissions: PermissionRuleset): Tools {
  return getAllBaseTools().filter((tool) => tool.isEnabled());
}

// ─── AI SDK adapter ───────────────────────────────────────────────────────────

let permissionWaitMs = 0;

/**
 * Convert Tools to ai-sdk-cpp (native) tool format. Each tool's execute runs
 * the permission check + tool.call on the JS side; the C++ loop awaits it via
 * the async-tool bridge, so interactive permissions work.
 */
export function toolsToBindingFormat(
  tools: Tools,
  context: ToolUseContext,
): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const tool of tools) {
    if (!tool.isEnabled()) continue;
    const schemaObj = (tool.inputSchema as any).toJSONSchema();
    delete (schemaObj as any).$schema;
    const cleanSchema = JSON.parse(JSON.stringify(schemaObj));
    const description =
      typeof tool.description === "string" ? tool.description : tool.name;
    out.push(
      bindingTool(tool.name, cleanSchema, description, async (input: Record<string, unknown>) => {
        const decision: PermissionDecision = await tool.checkPermissions(
          input as any,
          context,
        );
        if (!decision.approved) {
          return decision.feedback
            ? `Permission denied: ${decision.feedback}`
            : "Permission denied by user.";
        }
        try {
          const result = await tool.call(input as any, context);
          return typeof result.data === "string"
            ? result.data
            : JSON.stringify(result.data, null, 2);
        } catch (error) {
          return `Error: ${(error as Error).message}`;
        }
      }),
    );
  }
  return out;
}

/**
 * Track permission wait time for accurate tool duration reporting.
 */
export function recordPermissionWait(ms: number): void {
  permissionWaitMs = ms;
}

export function getLastPermissionWaitMs(): number {
  const ms = permissionWaitMs;
  permissionWaitMs = 0;
  return ms;
}

// ─── Tool descriptions for display ────────────────────────────────────────────

export function getToolDescriptions(): Array<{ name: string; description: string }> {
  return getAllBaseTools().map((tool) => ({
    name: tool.name,
    description:
      typeof tool.description === "string" ? tool.description : tool.name,
  }));
}
