








import type { z } from "zod";
import type { AskUserQuestion, PermissionRuleset, ProviderConfig } from "./types/index.js";
import type { ReadStateStore } from "./services/readState.js";



export type PermissionCallback = (
  toolName: string,
  /** Static text or a lazy thunk. Thunks are only evaluated when the
   *  approval UI actually renders the description — auto-approve modes
   *  (headless --print, bypassPermissions, allow-rules) never touch them.
   *  Tools whose preview requires a file read + diff (Write/Edit) pass a
   *  thunk so headless runs skip that work entirely. */
  description: string | (() => string),
  /** Tool input (when the tool provides one) — the permission UI renders
   *  a faithful diff from it (file_path/old_string/new_string/content). */
  input?: unknown,
) => Promise<PermissionDecision>;

export interface PermissionDecision {
  approved: boolean;
  feedback?: string;
}

export type AskUserQuestionsCallback = (
  questions: AskUserQuestion[],
) => Promise<Record<string, string>>;



export type AnyObject = z.ZodType<{ [key: string]: unknown }>;

export interface ToolResult<T = unknown> {
  data: T;
}

/**
 * The answer to "may this call run at all", which is a different question from
 * "is the user willing" — and is asked first, so a call that cannot work never
 * reaches the prompt. The message is written for the model, since the model is
 * who reads it.
 */
export type ValidationResult =
  | { result: true }
  | { result: false; message: string };

export interface ToolUseContext {
  
  providerConfig: ProviderConfig;
  
  workingDir: string;
  
  permissions: PermissionRuleset;
  
  abortController: AbortController;
  
  requestPermission: PermissionCallback;
  
  messages: readonly import("./types/index.js").Message[];

  /**
   * What the model has been shown on disk this session — the registry Edit and
   * Write consult before touching a file, and the stale-file notice reads.
   * Required rather than optional: a context without one would silently skip
   * the read-before-edit guard, which is the failure mode this exists to stop.
   */
  readFileState: ReadStateStore;

  lastPermissionWaitMs: number;
  
  recordPermissionWait(ms: number): void;
  
  consumePermissionWaitMs(): number;

  
  
  getTodos(): import("./types/index.js").TodoItem[];
  setTodos(todos: import("./types/index.js").TodoItem[]): void;
  
  onTodosChange?(todos: import("./types/index.js").TodoItem[]): void;
  
  getTasks(): import("./types/index.js").TaskItem[];
  setTasks(tasks: import("./types/index.js").TaskItem[]): void;
  
  getPlanMode(): boolean;
  setPlanMode(mode: boolean): void;
  
  askUserQuestions?: AskUserQuestionsCallback;
  
  onToolResult?: (toolName: string, input: any, output: string, isError: boolean) => void;

  /**
   * A call the permission layer refused, with the reason the model was given.
   *
   * Only the refusals that happen *before* execution — the safety floor, the
   * capability floor, a deny rule, plan mode, and the user answering no. A
   * headless run has nobody watching and reports success by exit code, so
   * without this a `--print` job that was quietly denied half its work is
   * indistinguishable from one that did it. Interactive runs already show the
   * refusal on screen; this is the channel for the ones that do not.
   */
  onPermissionDenied?: (toolName: string, reason: string) => void;

  onToolOutput?: (toolName: string, text: string) => void;

  /** Fired with the real input right before a tool executes — sub-agents
   *  use it to stream "Reading src/foo.ts"-style live activity lines. */
  onToolActivity?: (toolName: string, input: Record<string, unknown>) => void;

  /** Surface a system message in the UI (e.g. background task completion). */
  onSystemMessage?: (content: string) => void;
}



export interface Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
> {
  readonly name: string;
  /** Static text, a per-input promise (dynamic tools), or a zero-arg thunk
   *  (lazy tools like Skill, whose listing does a filesystem scan — the
   *  thunk is evaluated on first READ via a getter, not at build time). */
  description: string | (() => string) | ((input: z.infer<Input>) => Promise<string>);
  
  readonly inputSchema: Input;
  
  call(args: z.infer<Input>, context: ToolUseContext): Promise<ToolResult<Output>>;
  
  isConcurrencySafe(input: z.infer<Input>): boolean;

  isReadOnly(input: z.infer<Input>): boolean;

  isEnabled(): boolean;

  /**
   * The ruleset flag this tool cannot run without.
   *
   * Declared rather than derived from `isReadOnly`, which takes the input and
   * answers per call — a Write with a given path, a Config read vs write. Pool
   * membership has to be decidable without an input, and it has to agree with
   * enforcement, so both read this one field: agents without the flag never
   * see the tool, and no allow rule can hand it back (see tools.ts).
   *
   * The four flags are the agent's grants, not the user's rules: `code` has
   * write and execute, `plan` and `review` have read only.
   */
  readonly requiredPermission: keyof PermissionRuleset;

  /**
   * A constraint that holds regardless of the rule engine — evaluated ahead of
   * every allow/deny/ask, so no setting can lift it. Return a decision to
   * settle the call here, or null to fall through to the rules and prompt.
   *
   * For limits that depend on the input (which sub-agent is being spawned),
   * where the static `requiredPermission` flag cannot express them. Tools that
   * deny here should say why: the message is what the model reads.
   */
  checkCapability?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): PermissionDecision | null;

  /**
   * Whether this call is answerable at all, before permissions are consulted
   * and before the user is asked. A tool that returns `result: false` here
   * settles the call: the message is handed back to the model as the tool
   * result, and nothing — no rule, no approval — runs it anyway.
   *
   * The read-before-edit guard is the reason this slot exists (see
   * `services/readState.ts`): the check needs the input *and* the session's
   * read state, which is exactly what `checkPermissions` also has, but a
   * permission answer is a yes/no about the user and gets a prompt in front of
   * it, and "you never read this file" is not something to ask a user to
   * decide.
   */
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>;

  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionDecision>;
  
  userFacingName(input: z.infer<Input>): string;
  
  maxResultSizeChars: number;
}

export type Tools = readonly Tool[];



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


// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildTool<D extends AnyToolDef>(def: D): Tool {
  // Pull description out of the spread: object spread EVALUATES accessors,
  // which would defeat lazy (thunk) descriptions. A zero-arg thunk becomes a
  // getter — first read (session build / tool listing) evaluates it; plain
  // strings and (input) => Promise functions keep their existing semantics.
  const { description, ...rest } = def as unknown as {
    description?: Tool["description"];
    [k: string]: unknown;
  };
  const tool = {
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    checkPermissions: async () => ({ approved: true }),
    userFacingName: () => def.name,
    maxResultSizeChars: 100_000,
    ...rest,
  } as unknown as Tool;
  if (typeof description === "function" && description.length === 0) {
    Object.defineProperty(tool, "description", {
      get: () => (description as () => string)(),
    });
  } else if (description !== undefined) {
    tool.description = description as string;
  }
  return tool;
}
