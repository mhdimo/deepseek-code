// Tool registry — assembles tools and converts to AI SDK format
//
// This is the bridge between the Tool interface and AI SDK's tool format.
// Tools use Zod internally, but we convert to jsonSchema() for DeepSeek API.

import { tool as bindingTool, type ToolDefinition } from "ai-sdk-cpp";
import type { Tool, Tools, ToolUseContext, PermissionDecision } from "./Tool.js";
import type { PermissionRuleset } from "./types/index.js";
import { runPreToolUse, runHooksFireAndForget } from "./services/hooks.js";
import { parsePermissionSettings, matchDecision } from "./services/permissions.js";
import { loadSettings } from "./state/storage.js";

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
import { ConfigTool } from "./tools/ConfigTool/ConfigTool.js";
import { SleepTool } from "./tools/SleepTool/SleepTool.js";
import { ScheduleCronTool } from "./tools/ScheduleCronTool/ScheduleCronTool.js";
import { EnterWorktreeTool } from "./tools/EnterWorktreeTool/EnterWorktreeTool.js";
import { ExitWorktreeTool } from "./tools/ExitWorktreeTool/ExitWorktreeTool.js";
import { PowerShellTool } from "./tools/PowerShellTool/PowerShellTool.js";
import { BriefTool } from "./tools/BriefTool/BriefTool.js";
import { REPLTool } from "./tools/REPLTool/REPLTool.js";
import { ToolSearchTool } from "./tools/ToolSearchTool/ToolSearchTool.js";
import { TaskOutputTool } from "./tools/TaskOutputTool/TaskOutputTool.js";
import { TaskStopTool } from "./tools/TaskStopTool/TaskStopTool.js";
import { SkillTool } from "./tools/SkillTool/SkillTool.js";
import { buildLSPTool } from "./tools/LSPTool/LSPTool.js";
import { initializeLspServerManager } from "./services/lsp/manager.js";

// ─── LSP tool (non-blocking) ──────────────────────────────────────────────────
//
// The LSP tool is built once via its factory and registered with the rest of
// the tools. Manager initialization is kicked off (idempotent; server
// processes spawn lazily on first use) inside a try/catch so an unavailable
// or misconfigured LSP never fails app startup — worst case the tool is
// dropped from the registry and the rest of the app is unaffected.

let lspTool: Tool | null = null;
let lspToolResolved = false;

function getLSPTool(): Tool | null {
  if (lspToolResolved) return lspTool;
  lspToolResolved = true;
  try {
    initializeLspServerManager();
    lspTool = buildLSPTool();
  } catch {
    lspTool = null;
  }
  return lspTool;
}

// ─── All tools ────────────────────────────────────────────────────────────────

export function getAllBaseTools(): Tools {
  const lsp = getLSPTool();
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
    ConfigTool,
    SleepTool,
    ScheduleCronTool,
    EnterWorktreeTool,
    ExitWorktreeTool,
    PowerShellTool,
    BriefTool,
    REPLTool,
    ToolSearchTool,
    TaskOutputTool,
    TaskStopTool,
    SkillTool,
    ...(lsp ? [lsp] : []),
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
        if (context.abortController.signal.aborted) {
          throw new Error("❌ Aborted/Cancelled by user");
        }

        let abortHandler: (() => void) | null = null;
        const abortPromise = new Promise<never>((_, reject) => {
          abortHandler = () => reject(new Error("❌ Aborted/Cancelled by user"));
          context.abortController.signal.addEventListener("abort", abortHandler);
        });

        let resultString = "";
        let isError = false;
        try {
          // Permission RULE engine (settings.permissions allow/deny/ask, in
          // Tool(spec:pattern) syntax). Consulted first so a global rule can
          // auto-allow or hard-deny without prompting. "ask"/no-match falls
          // through to the per-tool checkPermissions below.
          let ruleDenied = false;
          let ruleAllowed = false;
          try {
            const perms = loadSettings().permissions;
            if (perms && (perms.allow?.length || perms.deny?.length || perms.ask?.length)) {
              const rules = parsePermissionSettings(perms);
              const d = matchDecision(rules, tool.name, input, context.workingDir);
              if (d.decision === "deny") ruleDenied = true;
              else if (d.decision === "allow") ruleAllowed = true;
            }
          } catch {
            // best-effort — fall back to per-tool checkPermissions
          }

          if (ruleDenied) {
            resultString = `Permission denied by rule (see settings.json permissions.deny).`;
            isError = true;
          } else if (context.getPlanMode() && !tool.isReadOnly(input)) {
            resultString = `Permission denied: Tool ${tool.name} is a write/execute action, which is disabled in plan mode (read-only). Please write your plan or exit plan mode to modify files.`;
            isError = true;
          } else {
            const decision: PermissionDecision = ruleAllowed
              ? { approved: true }
              : await Promise.race([
                  tool.checkPermissions(input as any, context),
                  abortPromise,
                ]);
            if (!decision.approved) {
              resultString = decision.feedback
                ? `Permission denied: ${decision.feedback}`
                : "Permission denied by user.";
              isError = true;
            } else {
              // PreToolUse hooks — may block the tool (exit 2 / JSON decision).
              const pre = await runPreToolUse(tool.name, input, context.workingDir);
              if (pre.blocked) {
                resultString = `Blocked by PreToolUse hook: ${pre.reason ?? ""}`.trim();
                isError = true;
              } else {
                const result = await Promise.race([
                  tool.call(input as any, context),
                  abortPromise,
                ]);
                resultString = typeof result.data === "string"
                  ? result.data
                  : JSON.stringify(result.data, null, 2);
                // PostToolUse hooks — non-blocking notification.
                runHooksFireAndForget("PostToolUse", {
                  tool: tool.name,
                  input,
                  output: resultString,
                  cwd: context.workingDir,
                });
              }
            }
          }
        } catch (error) {
          isError = true;
          resultString = (error as Error).message ?? String(error);
        } finally {
          if (abortHandler) {
            context.abortController.signal.removeEventListener("abort", abortHandler);
          }
        }

        if (context.onToolResult) {
          context.onToolResult(tool.name, input, resultString, isError);
        }

        if (isError && resultString.includes("Aborted/Cancelled")) {
          throw new Error(resultString);
        }
        return resultString;
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
