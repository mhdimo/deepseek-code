/**
 * The permission gate for MCP tools.
 *
 * MCP servers attach to the native Agent as their own tool set, so their tools
 * never pass through the execute wrapper in `src/tools.ts` — the layer that
 * consults settings rules, applies the safety and capability floors, enforces
 * plan mode, raises the approval dialog and runs the Pre/PostToolUse hooks.
 * Every other tool in the app is gated by that wrapper; MCP tools were the one
 * class of tool the permission engine could not see at all, which is how a
 * server the user never wrote a rule for could read files and run commands
 * unsupervised.
 *
 * The engine exposes two hooks to close that gap (`ai::with_permissions`):
 *
 *   - `policy(tool, inputJson) -> Allow | Deny | Ask` — synchronous, no I/O.
 *     Everything the wrapper settles without asking the user happens here.
 *   - `approver(tool, inputJson, rationale) -> Allow | Deny` — awaits the
 *     interactive prompt, and is consulted only when the policy answers `Ask`.
 *
 * Both are built here rather than inline in `agentSession.ts` so the decision
 * order can be tested without a native session.
 *
 * Two things this deliberately cannot do. It cannot run the Pre/PostToolUse
 * hooks, because those need the tool's result and the engine's gate sits
 * inside `execute` — hooks for MCP tools would have to come from the SDK. And
 * it cannot tell the model *why* a call was refused: the engine reports a
 * denial as `{"error":"permission_denied","tool":…}` with no message slot, so
 * the user's reason and feedback stop at the UI.
 */
import { PermissionDecision, type Approver, type PermissionPolicy } from "ai-sdk-cpp";
import type { ToolUseContext } from "../../Tool.js";
import { loadEffectivePermissions, matchDecision, parsePermissionSettings } from "../permissions.js";
import { checkDangerousOperation } from "../dangerousOps.js";

/**
 * The tool names this app registers itself (see `getAllBaseTools`).
 *
 * An MCP server can name a tool anything, including `Bash` or `Read`. The
 * engine matches rule and gate names case-insensitively and reports only the
 * bare name, so a shadowing MCP tool is indistinguishable from the built-in
 * one at the gate — the user would be asked to approve `Bash(npm test)` and
 * something else entirely would run. Such a name is refused outright.
 *
 * Written out rather than derived from `getAllBaseTools()`: the policy runs on
 * every MCP call and must stay free of the tool registry's side effects (the
 * registry builds every tool and boots the LSP manager, retrying on failure).
 * A test asserts this list covers the live registry, so drift fails loudly.
 */
const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",
    "Grep",
    "LS",
    "WebFetch",
    "WebSearch",
    "NotebookEdit",
    "TodoWrite",
    "TaskCreate",
    "TaskGet",
    "TaskUpdate",
    "TaskList",
    "Agent",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "Config",
    "Sleep",
    "ScheduleCron",
    "EnterWorktree",
    "ExitWorktree",
    "PowerShell",
    "Brief",
    "REPL",
    "ToolSearch",
    "TaskOutput",
    "TaskStop",
    "Skill",
    "LSP",
  ].map((n) => n.toLowerCase()),
);

export interface McpPermissionGate {
  policy: PermissionPolicy;
  approver: Approver;
}

/** Parse the engine's JSON arguments. An input that does not parse is still a
 *  call to decide on — an empty object keeps every rule and floor applicable
 *  to what they can see, instead of skipping them on a parse error. */
function parseInput(inputJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(inputJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * What the approval dialog shows.
 *
 * The first line becomes the `ToolName(args)` header (clamped to 60 chars by
 * the fallback dialog), the rest render dim — so the arguments go first, then
 * where the tool came from, then the engine's rationale.
 */
function describeCall(
  input: Record<string, unknown>,
  serverName: string | undefined,
  rationale: string,
): string {
  const args = Object.keys(input).length > 0 ? JSON.stringify(input) : "";
  return [
    args,
    serverName ? `MCP tool from server "${serverName}"` : "MCP tool",
    rationale,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Build the policy/approver pair for one MCP server's tool set.
 *
 * `serverName` is display-only — it names the server in the prompt, so a user
 * approving `create_issue` can see which of their servers is asking.
 */
export function createMcpPermissionGate(
  context: ToolUseContext,
  serverName?: string,
): McpPermissionGate {
  // Naming a tool after a built-in is worth telling the user about, but only
  // once: the policy runs on every call and the model can call it repeatedly.
  const reported = new Set<string>();

  const policy: PermissionPolicy = (tool, inputJson) => {
    const input = parseInput(inputJson);
    const lowered = tool.toLowerCase();

    // A name this app already owns is never an MCP tool.
    if (BUILTIN_TOOL_NAMES.has(lowered)) {
      // Keyed folded, like the name matching itself: a server that spells its
      // shadowing tool two ways is still one server, and one message.
      if (!reported.has(lowered)) {
        reported.add(lowered);
        context.onSystemMessage?.(
          `${serverName ? `MCP server "${serverName}"` : "An MCP server"} declares a tool named ` +
            `"${tool}", which is also a built-in tool. It is being refused — ` +
            `the server needs to rename it.`,
        );
      }
      return PermissionDecision.Deny;
    }

    // The user's rules, consulted exactly as the TS wrapper consults them —
    // same parse, same matcher, same deny > ask > allow precedence. A rule
    // written as `mcp__server__tool` or a bare tool name (what "don't ask
    // again" persists) both land here.
    //
    // An allow rule is recorded, not returned. In the wrapper an allow rule
    // skips the *prompt* and nothing else — src/tools.ts checks its safety
    // block, capability and plan mode first — and returning Allow here would
    // make the same rule lift floors the comment below calls un-liftable. A
    // rule written to stop the questions would quietly stop the protection.
    let ruleAllowed = false;
    try {
      const perms = loadEffectivePermissions(context.workingDir);
      if (perms && (perms.allow?.length || perms.deny?.length || perms.ask?.length)) {
        const decision = matchDecision(
          parsePermissionSettings(perms),
          tool,
          input,
          context.workingDir,
        );
        if (decision.decision === "deny") return PermissionDecision.Deny;
        if (decision.decision === "allow") ruleAllowed = true;
        // An `ask` rule only says a human decides — it does not skip the
        // floors below, so this falls through rather than returning `Ask`.
      }
    } catch {
      // Settings we cannot read must not become an approval.
    }

    // The safety floor. Ahead of the prompt and of every rule, for the same
    // reason as in the wrapper: no approval, rule or auto-approve mode may
    // lift it. Credential paths are checked for any tool, not just file ones.
    if (checkDangerousOperation(tool, input, context.workingDir)) {
      return PermissionDecision.Deny;
    }

    // The capability floor. An MCP tool is opaque — the app cannot know
    // whether it reads, writes, executes or talks to the network, and the
    // server may change under it between calls — so the only grant that can
    // cover one is the broadest. A read-only agent is never handed one, which
    // is what read-only has to mean for a tool whose behaviour is unknown.
    if (!context.permissions?.allowExecute) {
      return PermissionDecision.Deny;
    }

    // Plan mode is a mode, not something to allowlist around. An MCP tool
    // cannot prove it is read-only, so it is refused while planning.
    if (context.getPlanMode()) {
      return PermissionDecision.Deny;
    }

    // Every floor has passed. Only now does an allow rule do what it was
    // written to do: answer the question the prompt would have asked.
    if (ruleAllowed) return PermissionDecision.Allow;

    // Nothing has decided: this is the user's call.
    return PermissionDecision.Ask;
  };

  const approver: Approver = async (tool, inputJson, rationale) => {
    const input = parseInput(inputJson);
    let decision: { approved: boolean; feedback?: string };
    try {
      // The bare tool name, deliberately: the dialog's "don't ask again"
      // persists an allow rule under the name it is given, and a name the
      // engine does not report — a " (MCP)" suffix, say — would never match.
      decision = await context.requestPermission(
        tool,
        describeCall(input, serverName, rationale),
        input,
      );
    } catch {
      // A prompt that could not be shown is not an approval.
      return PermissionDecision.Deny;
    }
    return decision.approved ? PermissionDecision.Allow : PermissionDecision.Deny;
  };

  return { policy, approver };
}

/** Exposed for the test that keeps the list above honest. */
export const __builtinToolNames = BUILTIN_TOOL_NAMES;
