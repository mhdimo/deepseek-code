export const REPL_TOOL_NAME = "REPL";

export const DESCRIPTION = `Executes JavaScript/TypeScript code in a persistent Node.js interpreter context.

The interpreter context is persistent: variables, functions, imports, and state declared in one call are available in subsequent calls within the same session. Use this to perform multi-step computations, data transformations, or batch operations without re-establishing state each time.

This tool runs code inside a sandboxed node:vm context. The following globals are available by default:
- console: log/warn/error/info — captured and returned in the result
- JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, Map, Set, Symbol, RegExp, Error, and their standard methods
- setTimeout, clearTimeout, setInterval, clearInterval (timers do NOT persist between calls)
- Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController
- globalThis (the context's own global object)

Async code is supported: if the snippet evaluates to a Promise (or the last expression is awaitable), the tool awaits it and returns the resolved value.

Execution permission: this tool evaluates arbitrary code, so each call prompts the user for approval (unless execute permission is pre-granted). Prefer dedicated tools (Read, Write, Edit, Bash, Glob, Grep) when they fit — REPL is for scripting and computation, not as a replacement for file or shell operations.

# Instructions
- Provide a single JS/TS code snippet in the "code" parameter. The value of the last top-level expression is captured and returned (assignment statements and declarations like const/let/var/function return undefined).
- To see output, either return a value as the last expression or use console.log().
- State persists between calls: a variable declared with let/const at the top level in one call is NOT automatically a global (block-scoped). To persist state across calls, assign to globalThis (e.g. \`globalThis.counter = (globalThis.counter ?? 0) + 1\`) or declare without a keyword after first setting it on globalThis.
- To reset all session state, pass reset: true.
- Errors are returned with the full stack trace. Catch expected errors in your code when appropriate.
- Avoid long-running synchronous loops; the tool has a default timeout of 30 seconds.`;
