








import type { z } from "zod";
import type { AskUserQuestion, PermissionRuleset, ProviderConfig } from "./types/index.js";



export type PermissionCallback = (
  toolName: string,
  description: string,
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

export interface ToolUseContext {
  
  providerConfig: ProviderConfig;
  
  workingDir: string;
  
  permissions: PermissionRuleset;
  
  abortController: AbortController;
  
  requestPermission: PermissionCallback;
  
  messages: readonly import("./types/index.js").Message[];
  
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
  
  onToolOutput?: (toolName: string, text: string) => void;
}



export interface Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
> {
  readonly name: string;
  
  description: string | ((input: z.infer<Input>) => Promise<string>);
  
  readonly inputSchema: Input;
  
  call(args: z.infer<Input>, context: ToolUseContext): Promise<ToolResult<Output>>;
  
  isConcurrencySafe(input: z.infer<Input>): boolean;
  
  isReadOnly(input: z.infer<Input>): boolean;
  
  isEnabled(): boolean;
  
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
