

























import { basename, extname, resolve } from "path";
import { pathToFileURL } from "url";
import { loadSettings, type LspSettings } from "../../state/storage.js";



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



export type LspServerState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";


export interface LspServerConfig {
  
  name: string;
  
  command: string;
  
  args: string[];
  
  extensions: string[];
  
  languageId: string;
  
  rootPath: string;
  
  rootUri: string;
  
  env?: Record<string, string>;
  
  initializationOptions?: Record<string, unknown>;
  
  startupTimeout?: number;
}


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
      
      command = entry[0];
      args = entry[1] ?? [];
    } else if (entry && typeof entry === "object") {
      
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


export type JsonRpcProtocolError = Error & { code?: number };


export function encodeJsonRpcMessage(message: JsonRpcMessage): Buffer {
  const body = JSON.stringify(message);
  const contentLength = Buffer.byteLength(body, "utf-8");
  return Buffer.from(`Content-Length: ${contentLength}\r\n\r\n${body}`, "utf-8");
}


export class JsonRpcFrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  
  private static readonly MAX_CONTENT_LENGTH = 512 * 1024 * 1024;

  
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
        
        debugLog("JsonRpcFrameParser: malformed header, resyncing buffer");
        this.buffer = Buffer.alloc(0);
        return messages;
      }

      const bodyStart = boundary.index + boundary.length;
      if (this.buffer.length < bodyStart + contentLength) {
        
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


function findHeaderBoundary(buffer: Buffer): { index: number; length: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { index: crlf, length: 4 };
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return { index: lf, length: 2 };
  return null;
}


function parseContentLength(header: string): number | null {
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match || match[1] === undefined) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}



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
        
        
        const subprocess = Bun.spawn({
          cmd: [command, ...args],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          cwd: options?.cwd,
          env: { ...process.env, ...options?.env },
        });
        proc = subprocess;

        
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
            
          }
        })();

        
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
        
        try {
          await sendNotificationInternal("initialized", {});
        } catch {
          
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
          
          
          if (isInitialized) {
            try {
              await withTimeout(
                sendRequestInternal("shutdown", {}),
                5_000,
                `LSP server ${serverName} shutdown timed out`,
              );
            } catch {
              
            }
          }
          try {
            writeMessage({ jsonrpc: "2.0", method: "exit" });
          } catch {
            
          }
        }
      } catch (error) {
        shutdownError = error instanceof Error ? error : new Error(String(error));
      } finally {
        if (proc) {
          try {
            proc.kill();
          } catch {
            
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




const LSP_ERROR_CONTENT_MODIFIED = -32801;


const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3;


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


export function createLSPServerInstance(
  name: string,
  config: LspServerConfig,
): LSPServerInstance {
  let state: LspServerState = "stopped";
  let startTime: Date | undefined;
  let lastError: Error | undefined;
  let restartCount = 0;
  let crashRecoveryCount = 0;

  
  
  
  const client = createLSPClient(name, (error) => {
    state = "error";
    lastError = error;
    crashRecoveryCount++;
  });

  async function start(): Promise<void> {
    if (state === "running" || state === "starting") {
      return;
    }

    
    
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

      
      const initParams = {
        processId: process.pid,
        
        
        initializationOptions: config.initializationOptions ?? {},
        
        workspaceFolders: [
          {
            uri: config.rootUri,
            name: basename(config.rootPath),
          },
        ],
        
        rootPath: config.rootPath, 
        rootUri: config.rootUri, 

        
        capabilities: {
          workspace: {
            
            
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
                valueSet: [1, 2], 
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

        
        break;
      }
    }

    
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



export type LSPServerManager = {
  
  initialize(): Promise<void>;
  
  shutdown(): Promise<void>;
  
  getServerForFile(filePath: string): LSPServerInstance | undefined;
  
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>;
  
  sendRequest<T>(filePath: string, method: string, params: unknown): Promise<T | undefined>;
  
  getAllServers(): Map<string, LSPServerInstance>;
  
  openFile(filePath: string, content: string): Promise<void>;
  
  changeFile(filePath: string, content: string): Promise<void>;
  
  saveFile(filePath: string): Promise<void>;
  
  closeFile(filePath: string): Promise<void>;
  
  isFileOpen(filePath: string): boolean;
};


export function createLSPServerManager(): LSPServerManager {
  const servers: Map<string, LSPServerInstance> = new Map();
  const extensionMap: Map<string, string[]> = new Map();
  
  const openedFiles: Map<string, string> = new Map();

  function fileUriFor(filePath: string): string {
    return pathToFileURL(resolve(filePath)).href;
  }

  
  async function initialize(): Promise<void> {
    const serverConfigs = loadLspServerConfigs();
    debugLog(`[LSP SERVER MANAGER] loaded ${Object.keys(serverConfigs).length} server(s)`);

    for (const [serverName, config] of Object.entries(serverConfigs)) {
      try {
        if (!config.command) {
          throw new Error(`Server ${serverName} missing required 'command' field`);
        }

        
        for (const ext of config.extensions) {
          const normalized = ext.toLowerCase();
          const serverList = extensionMap.get(normalized);
          if (serverList) {
            serverList.push(serverName);
          } else {
            extensionMap.set(normalized, [serverName]);
          }
        }

        
        const instance = createLSPServerInstance(serverName, config);
        servers.set(serverName, instance);

        
        
        
        instance.onRequest("workspace/configuration", (params: unknown) => {
          debugLog(`LSP: Received workspace/configuration request from ${serverName}`);
          
          const items = (params as { items?: Array<{ section?: string }> })?.items;
          return Array.isArray(items) ? items.map(() => null) : [];
        });
      } catch (error) {
        logError(
          new Error(`Failed to initialize LSP server ${serverName}: ${errorMessage(error)}`),
        );
        
      }
    }

    debugLog(`LSP manager initialized with ${servers.size} servers`);
  }

  
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

  
  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const ext = extname(filePath).toLowerCase();
    const serverNames = extensionMap.get(ext);

    if (!serverNames || serverNames.length === 0) {
      return undefined;
    }

    
    const serverName = serverNames[0];
    if (!serverName) {
      return undefined;
    }

    return servers.get(serverName);
  }

  
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

    
    if (openedFiles.get(fileUri) === server.name) {
      debugLog(`LSP: File already open, skipping didOpen for ${filePath}`);
      return;
    }

    
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



type InitializationState = "not-started" | "pending" | "success" | "failed";

let lspManagerInstance: LSPServerManager | undefined;
let initializationState: InitializationState = "not-started";
let initializationError: Error | undefined;
let initializationGeneration = 0;
let initializationPromise: Promise<void> | undefined;


export function _resetLspManagerForTesting(): void {
  initializationState = "not-started";
  initializationError = undefined;
  initializationPromise = undefined;
  initializationGeneration++;
}


export function getLspServerManager(): LSPServerManager | undefined {
  
  if (initializationState === "failed") {
    return undefined;
  }
  return lspManagerInstance;
}


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


export async function waitForInitialization(): Promise<void> {
  if (initializationState === "success" || initializationState === "failed") {
    return;
  }

  if (initializationState === "pending" && initializationPromise) {
    await initializationPromise;
  }
}


export function initializeLspServerManager(): void {
  debugLog("[LSP MANAGER] initializeLspServerManager() called");

  
  if (lspManagerInstance !== undefined && initializationState !== "failed") {
    debugLog("[LSP MANAGER] Already initialized or initializing, skipping");
    return;
  }

  
  if (initializationState === "failed") {
    lspManagerInstance = undefined;
    initializationError = undefined;
  }

  
  lspManagerInstance = createLSPServerManager();
  initializationState = "pending";
  debugLog("[LSP MANAGER] Created manager instance, state=pending");

  
  const currentGeneration = ++initializationGeneration;

  
  
  initializationPromise = lspManagerInstance
    .initialize()
    .then(() => {
      
      if (currentGeneration === initializationGeneration) {
        initializationState = "success";
        debugLog("LSP server manager initialized successfully");
      }
    })
    .catch((error: unknown) => {
      
      if (currentGeneration === initializationGeneration) {
        initializationState = "failed";
        initializationError = error instanceof Error ? error : new Error(String(error));
        
        lspManagerInstance = undefined;
        logError(error);
      }
    });
}


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
    
    lspManagerInstance = undefined;
    initializationState = "not-started";
    initializationError = undefined;
    initializationPromise = undefined;
    
    initializationGeneration++;
  }
}
