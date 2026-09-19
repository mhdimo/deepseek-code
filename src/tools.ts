




import { tool as bindingTool, type ToolDefinition } from "ai-sdk-cpp";
import type { Tool, Tools, ToolUseContext, PermissionDecision } from "./Tool.js";
import type { PermissionRuleset } from "./types/index.js";
import { runPreToolUse, runHooksFireAndForget } from "./services/hooks.js";
import { parsePermissionSettings, matchDecision, loadEffectivePermissions } from "./services/permissions.js";
import { normalizePathInputs } from "./utils/toolUtils.js";
import { checkDangerousOperation } from "./services/dangerousOps.js";
import { protectedWriteReason } from "./services/protectedPaths.js";


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




/**
 * The tools this agent may be offered.
 *
 * Scoped to the agent's grants, so a read-only agent (plan, review, any
 * `.claude/agents/*.md` without write tools) is never *shown* Write, Edit or
 * Bash — enforcement alone left the model calling tools it could not use, and
 * every deny-then-retry burned a step. `allowedTools`, when set, narrows it
 * further to the names an agent definition asked for.
 */
export function getTools(permissions: PermissionRuleset, allowedTools?: readonly string[]): Tools {
  return getAllBaseTools().filter(
    (tool) =>
      tool.isEnabled() &&
      permissions[tool.requiredPermission] &&
      (!allowedTools || allowedTools.includes(tool.name)),
  );
}



let permissionWaitMs = 0;


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
          throw new Error("Aborted/Cancelled by user");
        }

        let abortHandler: (() => void) | null = null;
        const abortPromise = new Promise<never>((_, reject) => {
          abortHandler = () => reject(new Error("Aborted/Cancelled by user"));
          context.abortController.signal.addEventListener("abort", abortHandler);
        });

        let resultString = "";
        let isError = false;
        // Set by every branch below that refuses the call rather than running
        // it, so the refusal can be reported to a caller that cannot see the
        // screen (see ToolUseContext.onPermissionDenied).
        let deniedBy: string | null = null;
        try {
          
          
          
          
          let ruleDenied = false;
          let ruleAllowed = false;
          try {
            const perms = loadEffectivePermissions(context.workingDir);
            if (perms && (perms.allow?.length || perms.deny?.length || perms.ask?.length)) {
              const rules = parsePermissionSettings(perms);
              const d = matchDecision(rules, tool.name, input, context.workingDir);
              if (d.decision === "deny") ruleDenied = true;
              else if (d.decision === "allow") ruleAllowed = true;
            }
          } catch {
            
          }

          // Protected paths are the other half of that idea, one step down
          // from the floor: the edit may well be wanted, but it is never
          // approved *automatically*. This does not deny anything — it only
          // stops an allow rule from short-circuiting the prompt below, so
          // `permissions.allow: ["Write"]` cannot be the reason .git/hooks or
          // ~/.zshrc changed. The prompt itself is raised by the tool's own
          // checkPermissions, which the UI also holds to this rule.
          const protectedReason = protectedWriteReason(
            tool.name,
            input as Record<string, unknown>,
            context.workingDir,
          );

          // The safety floor, evaluated ahead of every rule and prompt. It is
          // not configurable: an allow rule, a session approval or headless
          // auto-approval must not be able to reach these.
          const safetyBlock = checkDangerousOperation(
            tool.name,
            input as Record<string, unknown>,
            context.workingDir,
          );

          // The capability floor, in the same position and for the same reason
          // as the safety floor above: nothing configurable may lift it.
          // `requiredPermission` is the agent's own grant, and a settings rule
          // is written for a *tool* ("allow Bash(npm test)"), not as a grant of
          // capabilities to an agent that was configured read-only — without
          // this, `permissions.allow: ["Write"]` handed the plan agent file
          // mutation, because an allow rule short-circuits checkPermissions
          // and the per-tool guards lived inside it.
          //
          // Optional-chain on `permissions` so a context missing the field (an
          // incomplete fixture, an old caller) fails closed with a legible
          // message instead of a raw TypeError that reads as an engine bug.
          const capability: PermissionDecision | null =
            !context.permissions?.[tool.requiredPermission]
              ? {
                  approved: false,
                  feedback:
                    `the ${tool.requiredPermission} capability is not enabled for this ` +
                    `agent, so ${tool.name} is not available.`,
                }
              : (tool.checkCapability?.(input, context) ?? null);

          // Whether the call is answerable at all. The model is the one who
          // has to fix a bad input, so this sits ahead of the permission
          // prompt: a question the user cannot usefully answer is not worth
          // asking. It is evaluated here, before the chain below, but its
          // *answer* comes after the floors in that chain — a call the user
          // may never make reports that, not a detail of how it was written.
          const validation = tool.validateInput
            ? await tool.validateInput(input as any, context)
            : null;
          const invalidInput = validation && !validation.result ? validation.message : null;

          if (safetyBlock) {
            resultString =
              `Refused by the safety floor: ${safetyBlock}. ` +
              `No permission rule can override this — run it yourself if you mean it.`;
            isError = true;
            deniedBy = `safety floor: ${safetyBlock}`;
          } else if (capability && !capability.approved) {
            resultString = capability.feedback
              ? `Permission denied: ${capability.feedback}`
              : "Permission denied by capability.";
            isError = true;
            deniedBy = capability.feedback
              ? `capability: ${capability.feedback}`
              : "capability";
          } else if (ruleDenied) {
            resultString = `Permission denied by rule (see settings.json permissions.deny).`;
            isError = true;
            deniedBy = "settings.json permissions.deny";
          } else if (context.getPlanMode() && !tool.isReadOnly(input)) {
            // Ahead of the rules on purpose: plan mode is a mode, not a rule
            // the user can allowlist their way out of. This covers both states
            // behind getPlanMode() — the tool-entered one and the UI's
            // Shift+Tab one (see agentSession).
            resultString = `Permission denied: Tool ${tool.name} is a write/execute action, which is disabled in plan mode (read-only). Please write your plan, or leave plan mode (Shift+Tab) to modify files.`;
            isError = true;
            deniedBy = "plan mode";
          } else if (invalidInput) {
            resultString = invalidInput;
            isError = true;
          } else {
            const decision: PermissionDecision = ruleAllowed && !protectedReason
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
              deniedBy = decision.feedback ?? "refused by the user";
            } else {
              
              // Hooks observe resolved paths (RB-2): a hook that allowlists an
              // absolute path must not be evadable by handing it a relative or
              // `~` form of that same file. `tool.call()` below still receives
              // the original input — the model wrote one path, and it should see
              // that one echoed back.
              const observed = normalizePathInputs(context.workingDir, input);
              const pre = await runPreToolUse(tool.name, observed, context.workingDir);
              if (pre.blocked) {
                resultString = `Blocked by PreToolUse hook: ${pre.reason ?? ""}`.trim();
                isError = true;
              } else {
                // Live activity hook (sub-agent fanout lines): fires with the
                // REAL input right before execution.
                context.onToolActivity?.(tool.name, input as Record<string, unknown>);
                const result = await Promise.race([
                  tool.call(input as any, context),
                  abortPromise,
                ]);
                resultString = typeof result.data === "string"
                  ? result.data
                  : JSON.stringify(result.data, null, 2);
                
                // Every tool declares maxResultSizeChars but nothing enforced
                // it — Grep could embed up to 20MB and Glob unbounded output
                // into the model context. Cap here so the LLM never sees
                // results beyond the declared budget.
                const maxResult = tool.maxResultSizeChars ?? 100_000;
                if (resultString.length > maxResult) {
                  resultString = resultString.slice(0, maxResult) + "\n\n... (truncated at " + maxResult + " chars)";
                }
                
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

        if (deniedBy) {
          context.onPermissionDenied?.(tool.name, deniedBy);
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


export function recordPermissionWait(ms: number): void {
  permissionWaitMs = ms;
}

export function getLastPermissionWaitMs(): number {
  const ms = permissionWaitMs;
  permissionWaitMs = 0;
  return ms;
}



export function getToolDescriptions(): Array<{ name: string; description: string }> {
  return getAllBaseTools().map((tool) => ({
    name: tool.name,
    description:
      typeof tool.description === "string" ? tool.description : tool.name,
  }));
}
