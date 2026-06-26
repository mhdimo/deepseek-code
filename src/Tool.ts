// Core Tool interface and buildTool helper
//
// Simplified from Claude Code's Tool pattern. Each tool implements this interface
// and is assembled via buildTool(). Tools are converted to AI SDK format by the
// registry for use with streamText().
//
// Key difference from Claude Code: we use jsonSchema() for API-facing schemas
// (DeepSeek compatibility) but Zod internally for validation.

import type { z } from "zod";
import type { PermissionRuleset, ProviderConfig } from "./types/index.js";

// ─── Permission types ────────────────────────────────────────────────────────

export type PermissionCallback = (
  toolName: string,
  description: string,
) => Promise<PermissionDecision>;

export interface PermissionDecision {
  approved: boolean;
  feedback?: string;
}

// ─── Tool types ──────────────────────────────────────────────────────────────

export type AnyObject = z.ZodType<{ [key: string]: unknown }>;

export interface ToolResult<T = unknown> {
  data: T;
}

export interface ToolUseContext {
  /** LLM provider configuration */
  providerConfig: ProviderConfig;
  /** Working directory for file operations */
  workingDir: string;
  /** Current agent permission set */
  permissions: PermissionRuleset;
  /** Abort controller for cancelling tool execution */
  abortController: AbortController;
  /** Permission callback — prompts user for approval */
  requestPermission: PermissionCallback;
  /** Current conversation messages (read-only snapshot) */
  messages: readonly import("./types/index.js").Message[];
  /** Last permission wait time tracking */
  lastPermissionWaitMs: number;
  /** Record how long a permission prompt took */
  recordPermissionWait(ms: number): void;
  /** Consume and reset the last permission wait time */
  consumePermissionWaitMs(): number;

  // ── Shared mutable state for new tools ───────────────────────────────
  /** Todo list state (for TodoWriteTool) */
  getTodos(): import("./types/index.js").TodoItem[];
  setTodos(todos: import("./types/index.js").TodoItem[]): void;
  /** Notify the TUI that the todo list changed (drives the live TodoList panel). */
  onTodosChange?(todos: import("./types/index.js").TodoItem[]): void;
  /** Task list state (for Task* tools) */
  getTasks(): import("./types/index.js").TaskItem[];
  setTasks(tasks: import("./types/index.js").TaskItem[]): void;
  /** Plan mode toggle (for Enter/ExitPlanMode tools) */
  getPlanMode(): boolean;
  setPlanMode(mode: boolean): void;
  /** Ask user questions (for AskUserQuestionTool) */
  askUserQuestions?: (
    questions: import("./types/index.js").AskUserQuestion[],
  ) => Promise<Record<string, string>>;
  /** Callback when a tool completes execution (for real-time TUI updates) */
  onToolResult?: (toolName: string, input: any, output: string, isError: boolean) => void;
  /** Callback for live streaming output from a tool during execution */
  onToolOutput?: (toolName: string, text: string) => void;
}

// ─── Tool interface ──────────────────────────────────────────────────────────

export interface Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
> {
  readonly name: string;
  /** Description shown to the LLM. Can be a static string or async function. */
  description: string | ((input: z.infer<Input>) => Promise<string>);
  /** Zod schema for input validation */
  readonly inputSchema: Input;
  /** Main execution function */
  call(args: z.infer<Input>, context: ToolUseContext): Promise<ToolResult<Output>>;
  /** Whether this tool can run concurrently with others */
  isConcurrencySafe(input: z.infer<Input>): boolean;
  /** Whether this tool only reads data (no side effects) */
  isReadOnly(input: z.infer<Input>): boolean;
  /** Whether this tool is enabled in the current environment */
  isEnabled(): boolean;
  /** Check permissions before execution. Returns decision. */
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionDecision>;
  /** Human-readable name for display */
  userFacingName(input: z.infer<Input>): string;
  /** Max result size before truncation (chars) */
  maxResultSizeChars: number;
}

export type Tools = readonly Tool[];

// ─── buildTool helper ────────────────────────────────────────────────────────

type DefaultableToolKeys =
  | "isEnabled"
  | "isConcurrencySafe"
  | "isReadOnly"
  | "checkPermissions"
  | "userFacingName"
  | "maxResultSizeChars";

export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
> = Omit<Tool<Input, Output>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output>, DefaultableToolKeys>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any>;

/**
 * Build a complete Tool from a partial definition, filling in safe defaults.
 *
 * Defaults:
 * - isEnabled → true
 * - isConcurrencySafe → false
 * - isReadOnly → false
 * - checkPermissions → { approved: true } (allow by default)
 * - userFacingName → tool name
 * - maxResultSizeChars → 100_000
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildTool<D extends AnyToolDef>(def: D): Tool {
  return {
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    checkPermissions: async () => ({ approved: true }),
    userFacingName: () => def.name,
    maxResultSizeChars: 100_000,
    ...def,
  } as Tool;
}
