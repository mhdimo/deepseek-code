












import vm from "node:vm";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { REPL_TOOL_NAME, DESCRIPTION } from "./prompt.js";



const REPLInputSchema = z.object({
  code: z.string().describe(
    "The JavaScript/TypeScript code to execute. The value of the last top-level expression is captured and returned.",
  ),
  reset: z.boolean().optional().describe(
    "If true, discard all accumulated session state and start a fresh interpreter context.",
  ),
});







type CapturedConsole = {
  logs: string[];
};

interface REPLSession {
  context: vm.Context;
  consoleState: CapturedConsole;
}

let session: REPLSession | null = null;



function createSession(): REPLSession {
  const consoleState: CapturedConsole = { logs: [] };

  const sandbox: Record<string, unknown> = {
    
    console: {
      log: (...args: unknown[]) => consoleState.logs.push(formatArgs(args)),
      info: (...args: unknown[]) => consoleState.logs.push(formatArgs(args)),
      debug: (...args: unknown[]) => consoleState.logs.push(formatArgs(args)),
      warn: (...args: unknown[]) => consoleState.logs.push(formatArgs(args)),
      error: (...args: unknown[]) => consoleState.logs.push(formatArgs(args)),
      dir: (obj: unknown) => consoleState.logs.push(formatValue(obj)),
    },
    
    
    
    JSON,
    Math,
    Date,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    ArrayBuffer,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask: typeof queueMicrotask === "function" ? queueMicrotask : undefined,
    structuredClone:
      typeof structuredClone === "function" ? structuredClone : undefined,
  };

  const context = vm.createContext(sandbox, {
    name: "deepseek-repl",
    
    
    
    codeGeneration: { strings: true, wasm: false },
  });

  
  vm.runInContext("var globalThis = this;", context);

  return { context, consoleState };
}

function getSession(): REPLSession {
  if (!session) {
    session = createSession();
  }
  return session;
}

function resetSession(): void {
  session = createSession();
}



function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? String(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function") {
    return value.toString();
  }
  try {
    
    return JSON.stringify(
      value,
      (() => {
        const seen = new WeakSet();
        return (_key: string, val: unknown) => {
          if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
          }
          if (typeof val === "bigint") return `${val.toString()}n`;
          if (typeof val === "function") return `[Function ${val.name || "anonymous"}]`;
          if (typeof val === "symbol") return val.toString();
          return val;
        };
      })(),
      2,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : formatValue(a)))
    .join(" ");
}



const EXECUTION_TIMEOUT_MS = 30_000;


function executeCode(code: string, sessionState: REPLSession): unknown {
  const { context } = sessionState;
  
  
  const wrapped = `(async () => {\n${code}\n})()`;
  const result = vm.runInContext(wrapped, context, {
    filename: "repl-input.js",
    timeout: EXECUTION_TIMEOUT_MS,
    displayErrors: true,
  });
  return result;
}



export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: REPLInputSchema,

  userFacingName: (input) => {
    const code = (input.code ?? "").trim();
    const firstLine = code.split("\n")[0] ?? code;
    const preview =
      firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
    return preview ? `REPL: ${preview}` : "REPL";
  },

  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  maxResultSizeChars: 100_000,

  checkPermissions: async (input, context) => {
    if (!context.permissions.allowExecute) {
      return {
        approved: false,
        feedback: "Execute permission denied for this agent.",
      };
    }
    return context.requestPermission(
      "REPL",
      `Execute JS/TS in persistent interpreter:\n${input.code}`,
    );
  },

  call: async (input, _context) => {
    const { code, reset } = input;

    if (reset) {
      resetSession();
    }

    const sessionState = getSession();
    
    sessionState.consoleState.logs.length = 0;

    try {
      const result = executeCode(code, sessionState);

      
      
      let resolved: unknown = result;
      if (result && typeof (result as Promise<unknown>).then === "function") {
        resolved = await Promise.race([
          result as Promise<unknown>,
          new Promise((_r, reject) =>
            setTimeout(
              () => reject(new Error(`REPL execution timed out after ${EXECUTION_TIMEOUT_MS}ms`)),
              EXECUTION_TIMEOUT_MS,
            ),
          ),
        ]);
      }

      const logs = sessionState.consoleState.logs.join("\n");
      const valueOut =
        resolved === undefined && logs.length === 0
          ? "undefined"
          : formatValue(resolved);

      const parts: string[] = [];
      if (logs.length > 0) parts.push(logs);
      if (valueOut && valueOut !== "undefined") {
        parts.push(`=> ${valueOut}`);
      } else if (logs.length === 0) {
        parts.push("=> undefined");
      }

      return { data: parts.join("\n") || "(no output)" };
    } catch (error) {
      const err = error as Error;
      const logs = sessionState.consoleState.logs.join("\n");
      const parts: string[] = [];
      if (logs.length > 0) parts.push(logs);
      parts.push(
        `${err.name || "Error"}: ${err.message}` +
          (err.stack ? `\n${err.stack}` : ""),
      );
      return { data: parts.join("\n") };
    }
  },
});
