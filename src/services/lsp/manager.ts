// LSP (Language Server Protocol) integration manager — ported from Claude Code's
// src/services/lsp/manager.ts + LSPServerManager.ts + LSPServerInstance.ts +
// LSPClient.ts + config.ts, consolidated into a single module.
//
// Differences from the reference:
//  - No vscode-jsonrpc / vscode-languageserver-protocol dependencies: JSON-RPC
//    2.0 is implemented by hand with Content-Length framing over the server's
//    stdio (see encodeJsonRpcMessage / JsonRpcFrameParser).
//  - The server process is spawned with Bun.spawn (pipes for stdin/stdout/stderr)
//    instead of node child_process.
//  - Server configuration comes from the [lsp] section of settings.json
//    (loadSettings() in src/state/storage.ts) instead of plugin configs:
//      {
//        "lsp": {
//          "servers": { "typescript": ["typescript-language-server", ["--stdio"]] },
//          "roots":   { "typescript": "/path/to/workspace" }   // optional
//        }
//      }
//    Each entry is either a [command, args?] tuple or an object form
//    { command, args?, extensions?, rootUri?, rootPath?, env?,
//      initializationOptions?, startupTimeout? }.
//
// Degradation: if no server is configured, or a server fails to spawn or
// initialize, the manager reports a clear message to the tool instead of
// crashing. Servers start lazily on first use (ensureServerStarted).

import { basename, extname, resolve } from "path";
import { pathToFileURL } from "url";
import { loadSettings, type LspSettings } from "../../state/storage.js";

// ─── Logging ──────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function debugLog(message: string): void {
  if (process.env.DEEPSEEK_CODE_DEBUG === "1" || process.env.DEBUG) {
    console.error(`[lsp] ${message}`);
  }
}

function logError(error: unknown): void {
  console.error(`[lsp] ${errorMessage(error)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

/**
 * Race a promise against a timeout. Cleans up the timer regardless of outcome
 * to avoid unhandled rejections from orphaned setTimeout callbacks.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timer),
  );
}

// ─── Server configuration ─────────────────────────────────────────────────────

export type LspServerState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

/** Normalized configuration for a single language server. */
export interface LspServerConfig {
  /** Unique server identifier (the settings.json key). */
  name: string;
  /** Executable to spawn. */
  command: string;
  /** Command-line arguments. */
  args: string[];
  /** File extensions this server handles (lowercase, leading dot). */
  extensions: string[];
  /** Language id sent in textDocument/didOpen. */
  languageId: string;
  /** Workspace root as a filesystem path. */
  rootPath: string;
  /** Workspace root as a file:// URI. */
  rootUri: string;
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
  /** Initialization options passed in the LSP initialize request. */
  initializationOptions?: Record<string, unknown>;
  /** Milliseconds to wait for initialize before failing (default: no timeout). */
  startupTimeout?: number;
}

/**
 * Built-in language → file-extension mapping. Used to route files to servers
 * configured under [lsp].servers. Per-server "extensions" in the object form
 * override this table.
 */
const DEFAULT_LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py", ".pyi"],
  go: [".go"],
  rust: [".rs"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh"],
  c: [".c", ".h"],
  java: [".java"],
  ruby: [".rb"],
  php: [".php"],
  json: [".json", ".jsonc"],
  css: [".css", ".scss", ".less"],
  html: [".html", ".htm"],
  yaml: [".yaml", ".yml"],
  markdown: [".md"],
  lua: [".lua"],
  kotlin: [".kt", ".kts"],
  swift: [".swift"],
  csharp: [".cs"],
  dart: [".dart"],
  elixir: [".ex", ".exs"],
  haskell: [".hs"],
  clojure: [".clj", ".cljs"],
  scala: [".scala"],
  sql: [".sql"],
  shell: [".sh", ".bash", ".zsh"],
  vue: [".vue"],
  svelte: [".svelte"],
};

/**
 * Reads the [lsp] section from settings.json (loadSettings) and normalizes it
 * into per-server configs. Returns an empty record when nothing is configured
 * (the manager then degrades gracefully — no servers, no crash).
 */
export function loadLspServerConfigs(): Record<string, LspServerConfig> {
  const settings = loadSettings();
  const lsp: LspSettings | undefined = settings.lsp;
  const entries = lsp?.servers;
  if (!entries) return {};

  const roots = lsp?.roots ?? {};
  const cwd = process.cwd();
  const out: Record<string, LspServerConfig> = {};

  for (const [language, entry] of Object.entries(entries)) {
    let command: string | undefined;
    let args: string[] = [];
    let extensions: string[] | undefined;
    let rootUri: string | undefined;
    let rootPath: string | undefined;
    let env: Record<string, string> | undefined;
    let initializationOptions: Record<string, unknown> | undefined;
    let startupTimeout: number | undefined;

    if (Array.isArray(entry)) {
      // Tuple form: [command, args?]
      command = entry[0];
      args = entry[1] ?? [];
    } else if (entry && typeof entry === "object") {
      // Object form
      command = entry.command;
      args = entry.args ?? [];
      extensions = entry.extensions;
      rootUri = entry.rootUri;
      rootPath = entry.rootPath;
      env = entry.env;
      initializationOptions = entry.initializationOptions;
      startupTimeout = entry.startupTimeout;
    }

    if (!command) {
      logError(`LSP server '${language}' is missing a command — skipping`);
      continue;
    }

    const languageId = language.toLowerCase();
    const extList = extensions ?? DEFAULT_LANGUAGE_EXTENSIONS[languageId] ?? [];

    // Workspace root resolution: explicit rootPath > explicit rootUri (as a
    // plain path or file:// URI) > roots[language] > process cwd.
    const root = rootPath
      ?? (rootUri && !rootUri.startsWith("file://") ? rootUri : undefined)
      ?? roots[language]
      ?? roots[languageId]
      ?? cwd;
    const resolvedRootUri =
      rootUri && rootUri.startsWith("file://")
        ? rootUri
        : pathToFileURL(resolve(root)).href;

    out[language] = {
      name: language,
      command,
      args,
      extensions: extList.map((e) => e.toLowerCase()),
      languageId,
      rootPath: resolve(root),
      rootUri: resolvedRootUri,
      env,
      initializationOptions,
      startupTimeout,
    };
  }

  return out;
}

// ─── JSON-RPC 2.0 framing (Content-Length) ────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** A JSON-RPC error with a protocol error code attached (duck-typed, like the reference). */
export type JsonRpcProtocolError = Error & { code?: number };

/**
 * Encodes a JSON-RPC message into its wire representation:
 * "Content-Length: <bytes>\r\n\r\n<body>"
 */
export function encodeJsonRpcMessage(message: JsonRpcMessage): Buffer {
  const body = JSON.stringify(message);
  const contentLength = Buffer.byteLength(body, "utf-8");
  return Buffer.from(`Content-Length: ${contentLength}\r\n\r\n${body}`, "utf-8");
}

/**
 * Incremental parser for the LSP wire format. Feed raw bytes (in any chunk
 * sizes); complete JSON-RPC messages come out the other side.
 */
export class JsonRpcFrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  /** Hard sanity cap — a header claiming more than this is treated as garbage. */
  private static readonly MAX_CONTENT_LENGTH = 512 * 1024 * 1024;

  /**
   * Feed raw bytes; returns every complete JSON-RPC message decoded so far.
   * Malformed input is dropped (buffer resync) rather than thrown.
   */
  feed(chunk: Uint8Array): JsonRpcMessage[] {
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, Buffer.from(chunk)]);

    const messages: JsonRpcMessage[] = [];
    for (;;) {
      const boundary = findHeaderBoundary(this.buffer);
      if (!boundary) return messages;

      const header = this.buffer.subarray(0, boundary.index).toString("utf-8");
      const contentLength = parseContentLength(header);
      if (contentLength === null || contentLength > JsonRpcFrameParser.MAX_CONTENT_LENGTH) {
        // Malformed header — drop everything to resync.
        debugLog("JsonRpcFrameParser: malformed header, resyncing buffer");
        this.buffer = Buffer.alloc(0);
        return messages;
      }

      const bodyStart = boundary.index + boundary.length;
      if (this.buffer.length < bodyStart + contentLength) {
        // Incomplete body — wait for more bytes.
        return messages;
      }

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      try {
        messages.push(JSON.parse(body) as JsonRpcMessage);
      } catch {
        debugLog("JsonRpcFrameParser: failed to parse message body");
      }
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Finds the end of the header block. LSP servers may use \r\n\r\n or \n\n
 * (both appear in the wild). Returns the separator index and its length.
 */
function findHeaderBoundary(buffer: Buffer): { index: number; length: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { index: crlf, length: 4 };
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return { index: lf, length: 2 };
  return null;
}

/** Extracts Content-Length from a header block. Returns null when missing. */
function parseContentLength(header: string): number | null {
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match || match[1] === undefined) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

// ─── LSP client (one per server process) ──────────────────────────────────────

export interface LSPClient {
  readonly isInitialized: boolean;
  start(
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; cwd?: string },
  ): Promise<void>;
  initialize(params: unknown): Promise<unknown>;
  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>;
  sendNotification(method: string, params: unknown): Promise<void>;
  onNotification(method: string, handler: (params: unknown) => void): void;
  onRequest(
    method: string,
    handler: (params: unknown) => unknown | Promise<unknown>,
  ): void;
  stop(): Promise<void>;
}

/**
 * Creates an LSP client wrapper speaking JSON-RPC 2.0 over the server process's
 * stdio (Content-Length framing). Equivalent to the reference's
 * createLSPClient (which used vscode-jsonrpc).
 *
 * @param serverName - Name of the server, used in logs.
 * @param onCrash - Called when the server process exits unexpectedly, so the
 *   owner can mark it failed and restart on next use.
 */
export function createLSPClient(
  serverName: string,
  onCrash?: (error: Error) => void,
): LSPClient {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let isInitialized = false;
  let isStopping = false;
  let startFailed = false;
  let startError: Error | undefined;
  let capabilities: unknown;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const requestHandlers = new Map<
    string,
    (params: unknown) => unknown | Promise<unknown>
  >();
  const parser = new JsonRpcFrameParser();

  function checkStartFailed(): void {
    if (startFailed) {
      throw startError ?? new Error(`LSP server ${serverName} failed to start`);
    }
  }

  function writeMessage(message: JsonRpcMessage): void {
    if (!proc) return;
    try {
      proc.stdin.write(encodeJsonRpcMessage(message));
      proc.stdin.flush();
    } catch (error) {
      // Process may have exited — fail all pending requests so callers don't hang.
      if (!isStopping) {
        debugLog(`LSP server ${serverName} stdin write failed: ${errorMessage(error)}`);
      }
      failPending(new Error(`LSP server ${serverName} stdin closed`));
    }
  }

  function failPending(error: Error): void {
    for (const [, entry] of pending) {
      entry.reject(error);
    }
    pending.clear();
  }

  async function dispatchIncoming(message: JsonRpcMessage): Promise<void> {
    // Server-to-client request (e.g. workspace/configuration) — must answer.
    if ("method" in message && "id" in message && typeof message.id === "number") {
      const handler = requestHandlers.get(message.method);
      let result: unknown = null;
      let error: { code: number; message: string } | undefined;
      try {
        result = handler ? await handler(message.params) : null;
      } catch (e) {
        error = { code: -32603, message: errorMessage(e) };
      }
      if (error) {
        writeMessage({ jsonrpc: "2.0", id: message.id, error });
      } else {
        writeMessage({ jsonrpc: "2.0", id: message.id, result });
      }
      return;
    }

    // Response to one of our requests.
    if ("id" in message && typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      const response = message as JsonRpcResponse;
      if (response.error) {
        const err = new Error(
          `${response.error.message} (code ${response.error.code})`,
        ) as JsonRpcProtocolError;
        err.code = response.error.code;
        entry.reject(err);
      } else {
        entry.resolve(response.result);
      }
      return;
    }

    // Plain notification (window/logMessage, textDocument/publishDiagnostics, …)
    const notification = message as JsonRpcNotification;
    notificationHandlers.get(notification.method)?.(notification.params);
  }

  function consumeStream(stream: ReadableStream<Uint8Array>): void {
    void (async () => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const messages = parser.feed(value);
          for (const message of messages) {
            void dispatchIncoming(message);
          }
        }
      } catch {
        // Stream error — connection is dead.
      }
      if (!isStopping) {
        failPending(new Error(`LSP server ${serverName} connection closed`));
      }
    })();
  }

  async function sendRequestInternal(method: string, params: unknown): Promise<unknown> {
    if (!proc) {
      throw new Error("LSP client not started");
    }
    checkStartFailed();
    const id = nextId++;
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  return {
    get isInitialized(): boolean {
      return isInitialized;
    },

    async start(
      command: string,
      args: string[],
      options?: { env?: Record<string, string>; cwd?: string },
    ): Promise<void> {
      try {
        // Bun.spawn throws synchronously for ENOENT (command not found);
        // everything else (crash after spawn) is handled below.
        const subprocess = Bun.spawn({
          cmd: [command, ...args],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          cwd: options?.cwd,
          env: { ...process.env, ...options?.env },
        });
        proc = subprocess;

        // Capture stderr for server diagnostics and errors.
        void (async () => {
          try {
            const reader = subprocess.stderr.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const output = new TextDecoder().decode(value).trim();
              if (output) debugLog(`[LSP SERVER ${serverName}] ${output}`);
            }
          } catch {
            // stderr stream closed — fine
          }
        })();

        // Crash detection: unexpected non-zero exit (not during intentional stop).
        void subprocess
          .exited.then((code) => {
            if (code !== 0 && !isStopping) {
              isInitialized = false;
              const crashError = new Error(
                `LSP server ${serverName} crashed with exit code ${code}`,
              );
              logError(crashError);
              onCrash?.(crashError);
            }
          })
          .catch((error: unknown) => {
            if (!isStopping) {
              startFailed = true;
              startError =
                error instanceof Error ? error : new Error(String(error));
              logError(startError);
            }
          });

        // Read stdout (the JSON-RPC stream).
        consumeStream(subprocess.stdout);
        debugLog(`LSP client started for ${serverName}`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logError(new Error(`LSP server ${serverName} failed to start: ${err.message}`));
        throw err;
      }
    },

    async initialize(params: unknown): Promise<unknown> {
      checkStartFailed();
      try {
        const result = await sendRequestInternal("initialize", params);
        capabilities = result;
        // Send initialized notification (fire-and-forget; failures are logged only)
        try {
          await sendNotificationInternal("initialized", {});
        } catch {
          // ignore — server may already be gone
        }
        isInitialized = true;
        debugLog(`LSP server ${serverName} initialized`);
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logError(new Error(`LSP server ${serverName} initialize failed: ${err.message}`));
        throw err;
      }
    },

    async sendRequest<TResult>(method: string, params: unknown): Promise<TResult> {
      if (!proc) {
        throw new Error("LSP client not started");
      }
      checkStartFailed();
      if (!isInitialized) {
        throw new Error("LSP server not initialized");
      }
      try {
        return (await sendRequestInternal(method, params)) as TResult;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logError(
          new Error(`LSP server ${serverName} request ${method} failed: ${err.message}`),
        );
        throw err;
      }
    },

    async sendNotification(method: string, params: unknown): Promise<void> {
      try {
        await sendNotificationInternal(method, params);
      } catch (error) {
        // Notifications are fire-and-forget: log and continue.
        debugLog(
          `LSP server ${serverName} notification ${method} failed: ${errorMessage(error)}`,
        );
      }
    },

    onNotification(method: string, handler: (params: unknown) => void): void {
      checkStartFailed();
      notificationHandlers.set(method, handler);
    },

    onRequest(
      method: string,
      handler: (params: unknown) => unknown | Promise<unknown>,
    ): void {
      checkStartFailed();
      requestHandlers.set(method, handler);
    },

    async stop(): Promise<void> {
      let shutdownError: Error | undefined;
      isStopping = true;

      try {
        if (proc) {
          // Graceful shutdown: send shutdown request + exit notification.
          // Bounded by a timeout so a hung server can't block app exit.
          if (isInitialized) {
            try {
              await withTimeout(
                sendRequestInternal("shutdown", {}),
                5_000,
                `LSP server ${serverName} shutdown timed out`,
              );
            } catch {
              // continue to cleanup regardless
            }
          }
          try {
            writeMessage({ jsonrpc: "2.0", method: "exit" });
          } catch {
            // ignore
          }
        }
      } catch (error) {
        shutdownError = error instanceof Error ? error : new Error(String(error));
      } finally {
        if (proc) {
          try {
            proc.kill();
          } catch {
            // Process might already be dead, which is fine
          }
          proc = undefined;
        }
        isInitialized = false;
        capabilities = undefined;
        isStopping = false;
        failPending(new Error(`LSP server ${serverName} stopped`));
        debugLog(`LSP client stopped for ${serverName}`);
      }

      if (shutdownError) {
        throw shutdownError;
      }
    },
  };

  async function sendNotificationInternal(method: string, params: unknown): Promise<void> {
    if (!proc) {
      throw new Error("LSP client not started");
    }
    checkStartFailed();
    writeMessage({ jsonrpc: "2.0", method, params });
  }
}

// ─── LSP server instance (one per configured server) ──────────────────────────

/**
 * LSP error code for "content modified" — indicates the server's state changed
 * during request processing (e.g. rust-analyzer still indexing the project).
 * This is a transient error that can be retried.
 */
const LSP_ERROR_CONTENT_MODIFIED = -32801;

/**
 * Maximum number of retries for transient LSP errors like "content modified".
 */
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3;

/**
 * Base delay in milliseconds for exponential backoff on transient errors.
 * Actual delays: 500ms, 1000ms, 2000ms
 */
const RETRY_BASE_DELAY_MS = 500;

export interface LSPServerInstance {
  readonly name: string;
  readonly config: LspServerConfig;
  readonly state: LspServerState;
  readonly startTime: Date | undefined;
  readonly lastError: Error | undefined;
  readonly restartCount: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  isHealthy(): boolean;
  sendRequest<T>(method: string, params: unknown): Promise<T>;
  sendNotification(method: string, params: unknown): Promise<void>;
  onRequest(
    method: string,
    handler: (params: unknown) => unknown | Promise<unknown>,
  ): void;
}

/**
 * Creates and manages a single LSP server instance (spawn, initialize, request
 * routing, retry on transient errors, crash recovery caps). Equivalent to the
 * reference's createLSPServerInstance.
 *
 * State machine transitions:
 * - stopped → starting → running
 * - running → stopping → stopped
 * - any → error (on failure)
 * - error → starting (on retry)
 */
export function createLSPServerInstance(
  name: string,
  config: LspServerConfig,
): LSPServerInstance {
  let state: LspServerState = "stopped";
  let startTime: Date | undefined;
  let lastError: Error | undefined;
  let restartCount = 0;
  let crashRecoveryCount = 0;

  // Propagate crash state so ensureServerStarted can restart on next use.
  // Without this, state stays 'running' after crash and the server is never
  // restarted (zombie state).
  const client = createLSPClient(name, (error) => {
    state = "error";
    lastError = error;
    crashRecoveryCount++;
  });

  async function start(): Promise<void> {
    if (state === "running" || state === "starting") {
      return;
    }

    // Cap crash-recovery attempts so a persistently crashing server doesn't
    // spawn unbounded child processes on every incoming request.
    const maxRestarts = 3;
    if (state === "error" && crashRecoveryCount > maxRestarts) {
      const error = new Error(
        `LSP server '${name}' exceeded max crash recovery attempts (${maxRestarts})`,
      );
      lastError = error;
      logError(error);
      throw error;
    }

    let initPromise: Promise<unknown> | undefined;
    try {
      state = "starting";
      debugLog(`Starting LSP server instance: ${name}`);

      await client.start(config.command, config.args, {
        env: config.env,
        cwd: config.rootPath,
      });

      // Initialize with workspace info (mirrors the reference's InitializeParams).
      const initParams = {
        processId: process.pid,
        // Pass server-specific initialization options; empty object by default
        // since some servers expect this field to exist.
        initializationOptions: config.initializationOptions ?? {},
        // Modern approach (LSP 3.16+) — required for Pyright, gopls
        workspaceFolders: [
          {
            uri: config.rootUri,
            name: basename(config.rootPath),
          },
        ],
        // Deprecated fields — some servers still need these for proper URI resolution
        rootPath: config.rootPath, // Deprecated in LSP 3.8 but needed by some servers
        rootUri: config.rootUri, // Deprecated in LSP 3.16 but needed by typescript-language-server for goToDefinition

        // Client capabilities — declare what features we support
        capabilities: {
          workspace: {
            // Don't claim to support workspace/configuration since we don't
            // implement it — prevents servers from requesting config we can't provide.
            configuration: false,
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: {
                valueSet: [1, 2], // Unnecessary (1), Deprecated (2)
              },
              versionSupport: false,
              codeDescriptionSupport: true,
              dataSupport: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ["markdown", "plaintext"],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            references: {
              dynamicRegistration: false,
            },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: {
              dynamicRegistration: false,
            },
          },
          general: {
            positionEncodings: ["utf-16"],
          },
        },
      };

      initPromise = client.initialize(initParams);
      if (config.startupTimeout !== undefined) {
        await withTimeout(
          initPromise,
          config.startupTimeout,
          `LSP server '${name}' timed out after ${config.startupTimeout}ms during initialization`,
        );
      } else {
        await initPromise;
      }

      state = "running";
      startTime = new Date();
      crashRecoveryCount = 0;
      debugLog(`LSP server instance started: ${name}`);
    } catch (error) {
      // Clean up the spawned child process on timeout/error
      client.stop().catch(() => {});
      initPromise?.catch(() => {});
      const err = error instanceof Error ? error : new Error(String(error));
      state = "error";
      lastError = err;
      logError(err);
      throw err;
    }
  }

  async function stop(): Promise<void> {
    if (state === "stopped" || state === "stopping") {
      return;
    }

    try {
      state = "stopping";
      await client.stop();
      state = "stopped";
      debugLog(`LSP server instance stopped: ${name}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      state = "error";
      lastError = err;
      logError(err);
      throw err;
    }
  }

  async function restart(): Promise<void> {
    try {
      await stop();
    } catch (error) {
      throw new Error(
        `Failed to stop LSP server '${name}' during restart: ${errorMessage(error)}`,
      );
    }

    restartCount++;

    const maxRestarts = 3;
    if (restartCount > maxRestarts) {
      const error = new Error(
        `Max restart attempts (${maxRestarts}) exceeded for server '${name}'`,
      );
      logError(error);
      throw error;
    }

    try {
      await start();
    } catch (error) {
      throw new Error(
        `Failed to start LSP server '${name}' during restart (attempt ${restartCount}/${maxRestarts}): ${errorMessage(error)}`,
      );
    }
  }

  function isHealthy(): boolean {
    return state === "running" && client.isInitialized;
  }

  async function sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send request to LSP server '${name}': server is ${state}` +
          `${lastError ? `, last error: ${lastError.message}` : ""}`,
      );
      logError(error);
      throw error;
    }

    let lastAttemptError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES_FOR_TRANSIENT_ERRORS; attempt++) {
      try {
        return await client.sendRequest<T>(method, params);
      } catch (error) {
        lastAttemptError = error instanceof Error ? error : new Error(String(error));

        // Check if this is a transient "content modified" error that we should
        // retry. This commonly happens with rust-analyzer during initial
        // project indexing. We use duck typing instead of instanceof because
        // the error is constructed locally (see createLSPClient).
        const errorCode = (error as { code?: number }).code;
        const isContentModifiedError =
          typeof errorCode === "number" && errorCode === LSP_ERROR_CONTENT_MODIFIED;

        if (isContentModifiedError && attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          debugLog(
            `LSP request '${method}' to '${name}' got ContentModified error, ` +
              `retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES_FOR_TRANSIENT_ERRORS})`,
          );
          await sleep(delay);
          continue;
        }

        // Non-retryable error or max retries exceeded
        break;
      }
    }

    // All retries failed or non-retryable error
    const requestError = new Error(
      `LSP request '${method}' failed for server '${name}': ${lastAttemptError?.message ?? "unknown error"}`,
    );
    logError(requestError);
    throw requestError;
  }

  async function sendNotification(method: string, params: unknown): Promise<void> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send notification to LSP server '${name}': server is ${state}`,
      );
      logError(error);
      throw error;
    }

    try {
      await client.sendNotification(method, params);
    } catch (error) {
      const notificationError = new Error(
        `LSP notification '${method}' failed for server '${name}': ${errorMessage(error)}`,
      );
      logError(notificationError);
      throw notificationError;
    }
  }

  return {
    name,
    config,
    get state() {
      return state;
    },
    get startTime() {
      return startTime;
    },
    get lastError() {
      return lastError;
    },
    get restartCount() {
      return restartCount;
    },
    start,
    stop,
    restart,
    isHealthy,
    sendRequest,
    sendNotification,
    onRequest: client.onRequest,
  };
}

// ─── LSP server manager (routes requests per file extension) ──────────────────

export type LSPServerManager = {
  /** Initialize the manager by loading all configured LSP servers. */
  initialize(): Promise<void>;
  /** Shutdown all running servers and clear state. */
  shutdown(): Promise<void>;
  /** Get the LSP server instance for a given file path. */
  getServerForFile(filePath: string): LSPServerInstance | undefined;
  /** Ensure the appropriate LSP server is started for the given file. */
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>;
  /** Send a request to the appropriate LSP server for the given file. */
  sendRequest<T>(filePath: string, method: string, params: unknown): Promise<T | undefined>;
  /** Get all running server instances. */
  getAllServers(): Map<string, LSPServerInstance>;
  /** Synchronize file open to LSP server (sends didOpen notification). */
  openFile(filePath: string, content: string): Promise<void>;
  /** Synchronize file change to LSP server (sends didChange notification). */
  changeFile(filePath: string, content: string): Promise<void>;
  /** Synchronize file save to LSP server (sends didSave notification). */
  saveFile(filePath: string): Promise<void>;
  /** Synchronize file close to LSP server (sends didClose notification). */
  closeFile(filePath: string): Promise<void>;
  /** Check if a file is already open on a compatible LSP server. */
  isFileOpen(filePath: string): boolean;
};

/**
 * Creates an LSP server manager instance. Manages multiple LSP server instances
 * and routes requests based on file extensions. Uses the factory-function
 * pattern with closures for state encapsulation (like the reference).
 */
export function createLSPServerManager(): LSPServerManager {
  const servers: Map<string, LSPServerInstance> = new Map();
  const extensionMap: Map<string, string[]> = new Map();
  // Track which files have been opened on which servers (file:// URI → server name)
  const openedFiles: Map<string, string> = new Map();

  function fileUriFor(filePath: string): string {
    return pathToFileURL(resolve(filePath)).href;
  }

  /**
   * Initialize the manager by loading all configured LSP servers.
   * Config comes from settings.json [lsp] — see loadLspServerConfigs().
   */
  async function initialize(): Promise<void> {
    const serverConfigs = loadLspServerConfigs();
    debugLog(`[LSP SERVER MANAGER] loaded ${Object.keys(serverConfigs).length} server(s)`);

    for (const [serverName, config] of Object.entries(serverConfigs)) {
      try {
        if (!config.command) {
          throw new Error(`Server ${serverName} missing required 'command' field`);
        }

        // Map file extensions to this server.
        for (const ext of config.extensions) {
          const normalized = ext.toLowerCase();
          const serverList = extensionMap.get(normalized);
          if (serverList) {
            serverList.push(serverName);
          } else {
            extensionMap.set(normalized, [serverName]);
          }
        }

        // Create server instance (lazy: nothing is spawned until first use).
        const instance = createLSPServerInstance(serverName, config);
        servers.set(serverName, instance);

        // Register handler for workspace/configuration requests from the server.
        // Some servers (like TypeScript) send these even when we say we don't
        // support them.
        instance.onRequest("workspace/configuration", (params: unknown) => {
          debugLog(`LSP: Received workspace/configuration request from ${serverName}`);
          // Return empty/null config for each requested item.
          const items = (params as { items?: Array<{ section?: string }> })?.items;
          return Array.isArray(items) ? items.map(() => null) : [];
        });
      } catch (error) {
        logError(
          new Error(`Failed to initialize LSP server ${serverName}: ${errorMessage(error)}`),
        );
        // Continue with other servers — don't fail entire initialization.
      }
    }

    debugLog(`LSP manager initialized with ${servers.size} servers`);
  }

  /**
   * Shutdown all running servers and clear state.
   * Only servers in 'running' or 'error' state are explicitly stopped;
   * servers in other states are cleared without shutdown.
   */
  async function shutdown(): Promise<void> {
    const toStop = Array.from(servers.entries()).filter(
      ([, s]) => s.state === "running" || s.state === "error",
    );

    const results = await Promise.allSettled(toStop.map(([, server]) => server.stop()));

    servers.clear();
    extensionMap.clear();
    openedFiles.clear();

    const errors = results
      .map((r, i) =>
        r.status === "rejected" ? `${toStop[i]![0]}: ${errorMessage(r.reason)}` : null,
      )
      .filter((e): e is string => e !== null);

    if (errors.length > 0) {
      const err = new Error(
        `Failed to stop ${errors.length} LSP server(s): ${errors.join("; ")}`,
      );
      logError(err);
      throw err;
    }
  }

  /**
   * Get the LSP server instance for a given file path.
   * If multiple servers handle the same extension, returns the first registered
   * server. Returns undefined if no server handles this file type.
   */
  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const ext = extname(filePath).toLowerCase();
    const serverNames = extensionMap.get(ext);

    if (!serverNames || serverNames.length === 0) {
      return undefined;
    }

    // Use first server (can add priority later)
    const serverName = serverNames[0];
    if (!serverName) {
      return undefined;
    }

    return servers.get(serverName);
  }

  /**
   * Ensure the appropriate LSP server is started for the given file.
   * Returns undefined if no server handles this file type.
   *
   * @throws {Error} If server fails to start
   */
  async function ensureServerStarted(
    filePath: string,
  ): Promise<LSPServerInstance | undefined> {
    const server = getServerForFile(filePath);
    if (!server) return undefined;

    if (server.state === "stopped" || server.state === "error") {
      try {
        await server.start();
      } catch (error) {
        throw new Error(
          `Failed to start LSP server for file ${filePath}: ${errorMessage(error)}`,
        );
      }
    }

    return server;
  }

  /**
   * Send a request to the appropriate LSP server for the given file.
   * Returns undefined if no server handles this file type.
   *
   * @throws {Error} If server fails to start or request fails
   */
  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    const server = await ensureServerStarted(filePath);
    if (!server) return undefined;

    try {
      return await server.sendRequest<T>(method, params);
    } catch (error) {
      throw new Error(
        `LSP request failed for file ${filePath}, method '${method}': ${errorMessage(error)}`,
      );
    }
  }

  function getAllServers(): Map<string, LSPServerInstance> {
    return servers;
  }

  async function openFile(filePath: string, content: string): Promise<void> {
    const server = await ensureServerStarted(filePath);
    if (!server) return;

    const fileUri = fileUriFor(filePath);

    // Skip if already opened on this server
    if (openedFiles.get(fileUri) === server.name) {
      debugLog(`LSP: File already open, skipping didOpen for ${filePath}`);
      return;
    }

    // Language id comes from the server's language key
    const languageId = server.config.languageId || "plaintext";

    try {
      await server.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: fileUri,
          languageId,
          version: 1,
          text: content,
        },
      });
      // Track that this file is now open on this server
      openedFiles.set(fileUri, server.name);
      debugLog(`LSP: Sent didOpen for ${filePath} (languageId: ${languageId})`);
    } catch (error) {
      throw new Error(`Failed to sync file open ${filePath}: ${errorMessage(error)}`);
    }
  }

  async function changeFile(filePath: string, content: string): Promise<void> {
    const server = getServerForFile(filePath);
    if (!server || server.state !== "running") {
      return openFile(filePath, content);
    }

    const fileUri = fileUriFor(filePath);

    // If file hasn't been opened on this server yet, open it first.
    // LSP servers require didOpen before didChange.
    if (openedFiles.get(fileUri) !== server.name) {
      return openFile(filePath, content);
    }

    try {
      await server.sendNotification("textDocument/didChange", {
        textDocument: {
          uri: fileUri,
          version: 1,
        },
        contentChanges: [{ text: content }],
      });
      debugLog(`LSP: Sent didChange for ${filePath}`);
    } catch (error) {
      throw new Error(`Failed to sync file change ${filePath}: ${errorMessage(error)}`);
    }
  }

  /**
   * Save a file in LSP servers (sends didSave notification).
   * Called after a file is written to disk to trigger diagnostics.
   */
  async function saveFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath);
    if (!server || server.state !== "running") return;

    try {
      await server.sendNotification("textDocument/didSave", {
        textDocument: {
          uri: fileUriFor(filePath),
        },
      });
      debugLog(`LSP: Sent didSave for ${filePath}`);
    } catch (error) {
      throw new Error(`Failed to sync file save ${filePath}: ${errorMessage(error)}`);
    }
  }

  /**
   * Close a file in LSP servers (sends didClose notification).
   * Not currently wired into the app's compact flow; available for callers
   * that remove files from active context.
   */
  async function closeFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath);
    if (!server || server.state !== "running") return;

    const fileUri = fileUriFor(filePath);

    try {
      await server.sendNotification("textDocument/didClose", {
        textDocument: {
          uri: fileUri,
        },
      });
      // Remove from tracking so the file can be reopened later
      openedFiles.delete(fileUri);
      debugLog(`LSP: Sent didClose for ${filePath}`);
    } catch (error) {
      throw new Error(`Failed to sync file close ${filePath}: ${errorMessage(error)}`);
    }
  }

  function isFileOpen(filePath: string): boolean {
    const fileUri = fileUriFor(filePath);
    return openedFiles.has(fileUri);
  }

  return {
    initialize,
    shutdown,
    getServerForFile,
    ensureServerStarted,
    sendRequest,
    getAllServers,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    isFileOpen,
  };
}

// ─── Manager singleton ────────────────────────────────────────────────────────

type InitializationState = "not-started" | "pending" | "success" | "failed";

let lspManagerInstance: LSPServerManager | undefined;
let initializationState: InitializationState = "not-started";
let initializationError: Error | undefined;
let initializationGeneration = 0;
let initializationPromise: Promise<void> | undefined;

/**
 * Test-only sync reset: clears the module-scope singleton state so
 * initializeLspServerManager() can be re-run.
 */
export function _resetLspManagerForTesting(): void {
  initializationState = "not-started";
  initializationError = undefined;
  initializationPromise = undefined;
  initializationGeneration++;
}

/**
 * Get the singleton LSP server manager instance.
 * Returns undefined if not yet initialized, initialization failed, or still pending.
 *
 * Callers should check for undefined and handle gracefully — initialization
 * happens asynchronously during startup. Use getInitializationStatus() to
 * distinguish between pending, failed, and not-started states.
 */
export function getLspServerManager(): LSPServerManager | undefined {
  // Don't return a broken instance if initialization failed
  if (initializationState === "failed") {
    return undefined;
  }
  return lspManagerInstance;
}

/**
 * Get the current initialization status of the LSP server manager.
 */
export function getInitializationStatus():
  | { status: "not-started" }
  | { status: "pending" }
  | { status: "success" }
  | { status: "failed"; error: Error } {
  if (initializationState === "failed") {
    return {
      status: "failed",
      error: initializationError ?? new Error("Initialization failed"),
    };
  }
  if (initializationState === "not-started") {
    return { status: "not-started" };
  }
  if (initializationState === "pending") {
    return { status: "pending" };
  }
  return { status: "success" };
}

/**
 * Check whether at least one language server is connected and healthy.
 * Backs LSPTool.isEnabled() in the reference; here it is informational —
 * the tool is always registered so it can report a clear message when no
 * server is available.
 */
export function isLspConnected(): boolean {
  if (initializationState === "failed") return false;
  const manager = getLspServerManager();
  if (!manager) return false;
  const servers = manager.getAllServers();
  if (servers.size === 0) return false;
  for (const server of servers.values()) {
    if (server.state !== "error") return true;
  }
  return false;
}

/**
 * Wait for LSP server manager initialization to complete.
 * Returns immediately if initialization has already completed (success or
 * failure), is pending (waits for it), or hasn't started (nothing to wait for).
 */
export async function waitForInitialization(): Promise<void> {
  if (initializationState === "success" || initializationState === "failed") {
    return;
  }

  if (initializationState === "pending" && initializationPromise) {
    await initializationPromise;
  }
}

/**
 * Initialize the LSP server manager singleton.
 *
 * Call this during app startup. It synchronously creates the manager instance,
 * then starts async initialization (loading LSP configs) in the background
 * without blocking startup. Safe to call multiple times (idempotent); if
 * initialization previously failed, calling again retries.
 */
export function initializeLspServerManager(): void {
  debugLog("[LSP MANAGER] initializeLspServerManager() called");

  // Skip if already initialized or currently initializing
  if (lspManagerInstance !== undefined && initializationState !== "failed") {
    debugLog("[LSP MANAGER] Already initialized or initializing, skipping");
    return;
  }

  // Reset state for retry if previous initialization failed
  if (initializationState === "failed") {
    lspManagerInstance = undefined;
    initializationError = undefined;
  }

  // Create the manager instance and mark as pending
  lspManagerInstance = createLSPServerManager();
  initializationState = "pending";
  debugLog("[LSP MANAGER] Created manager instance, state=pending");

  // Increment generation to invalidate any pending initializations
  const currentGeneration = ++initializationGeneration;

  // Start initialization asynchronously without blocking.
  // Store the promise so callers can await it via waitForInitialization().
  initializationPromise = lspManagerInstance
    .initialize()
    .then(() => {
      // Only update state if this is still the current initialization
      if (currentGeneration === initializationGeneration) {
        initializationState = "success";
        debugLog("LSP server manager initialized successfully");
      }
    })
    .catch((error: unknown) => {
      // Only update state if this is still the current initialization
      if (currentGeneration === initializationGeneration) {
        initializationState = "failed";
        initializationError = error instanceof Error ? error : new Error(String(error));
        // Clear the instance since it's not usable
        lspManagerInstance = undefined;
        logError(error);
      }
    });
}

/**
 * Shutdown the LSP server manager and clean up resources.
 * Call during app shutdown. Stops all running LSP servers and clears internal
 * state. Safe to call when not initialized (no-op).
 *
 * Errors during shutdown are logged but NOT propagated to the caller; state is
 * always cleared even if shutdown fails, to prevent resource accumulation.
 */
export async function shutdownLspServerManager(): Promise<void> {
  if (lspManagerInstance === undefined) {
    return;
  }

  try {
    await lspManagerInstance.shutdown();
    debugLog("LSP server manager shut down successfully");
  } catch (error) {
    logError(error);
    debugLog(`Failed to shutdown LSP server manager: ${errorMessage(error)}`);
  } finally {
    // Always clear state even if shutdown failed
    lspManagerInstance = undefined;
    initializationState = "not-started";
    initializationError = undefined;
    initializationPromise = undefined;
    // Increment generation to invalidate any pending initializations
    initializationGeneration++;
  }
}
