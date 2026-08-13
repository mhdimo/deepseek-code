
















import { open } from "fs/promises";
import { extname } from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import { buildTool, type Tool } from "../../Tool.js";
import { resolvePath } from "../../utils/toolUtils.js";
import {
  getInitializationStatus,
  getLspServerManager,
  waitForInitialization,
  type LSPServerManager,
} from "../../services/lsp/manager.js";
import { DESCRIPTION, LSP_TOOL_NAME } from "./prompt.js";
import {
  formatDocumentSymbolResult,
  formatFindReferencesResult,
  formatGoToDefinitionResult,
  formatHoverResult,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatPrepareCallHierarchyResult,
  formatWorkspaceSymbolResult,
  type LspCallHierarchyIncomingCall,
  type LspCallHierarchyItem,
  type LspCallHierarchyOutgoingCall,
  type LspDocumentSymbol,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspSymbolInformation,
} from "./formatters.js";

const MAX_LSP_FILE_SIZE_BYTES = 10_000_000;



function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function debugLog(message: string): void {
  if (process.env.DEEPSEEK_CODE_DEBUG === "1" || process.env.DEBUG) {
    console.error(`[lsp] ${message}`);
  }
}

function uniq(values: Iterable<string>): string[] {
  return [...new Set(values)];
}



export const LSP_OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const;

export type LSPOperation = (typeof LSP_OPERATIONS)[number];


export function isValidLSPOperation(operation: string): operation is LSPOperation {
  return (LSP_OPERATIONS as readonly string[]).includes(operation);
}


const lspToolInputSchema = z.object({
  operation: z
    .enum(LSP_OPERATIONS)
    .describe("The LSP operation to perform"),
  filePath: z.string().describe("The absolute or relative path to the file"),
  line: z
    .number()
    .int()
    .positive()
    .describe("The line number (1-based, as shown in editors)"),
  character: z
    .number()
    .int()
    .positive()
    .describe("The character offset (1-based, as shown in editors)"),
});

export type LSPToolInput = z.infer<typeof lspToolInputSchema>;

export interface LSPToolOutput {
  operation: LSPOperation;
  result: string;
  filePath: string;
  resultCount?: number;
  fileCount?: number;
}


export function buildLSPTool(manager?: LSPServerManager): Tool {
  return buildTool({
    name: LSP_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: lspToolInputSchema,

    userFacingName: (input) => `LSP: ${input.operation}`,

    
    
    
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    maxResultSizeChars: 100_000,

    checkPermissions: async (_input, context) => {
      if (!context.permissions.allowRead) {
        return { approved: false, feedback: "Read permission denied for this agent." };
      }
      return { approved: true };
    },

    call: async (input, context) => {
      const absolutePath = resolvePath(context.workingDir, input.filePath);

      
      
      const status = getInitializationStatus();
      if (status.status === "pending") {
        await waitForInitialization();
      }

      
      const resolvedManager = manager ?? getLspServerManager();
      if (!resolvedManager) {
        return {
          data: {
            operation: input.operation,
            result:
              "LSP server manager not initialized. This may indicate a startup issue.",
            filePath: input.filePath,
          },
        };
      }

      
      
      if (resolvedManager.getAllServers().size === 0) {
        return {
          data: {
            operation: input.operation,
            result:
              "No LSP servers are configured. Add an 'lsp' section to settings.json " +
              "(~/.deepseek-code/settings.json), e.g. " +
              '{ "lsp": { "servers": { "typescript": ["typescript-language-server", ["--stdio"]] } } }.',
            filePath: input.filePath,
          },
        };
      }

      
      const { method, params } = getMethodAndParams(input, absolutePath);

      try {
        
        
        
        if (!resolvedManager.isFileOpen(absolutePath)) {
          const handle = await open(absolutePath, "r");
          try {
            const stats = await handle.stat();
            if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
              return {
                data: {
                  operation: input.operation,
                  result: `File too large for LSP analysis (${Math.ceil(stats.size / 1_000_000)}MB exceeds 10MB limit)`,
                  filePath: input.filePath,
                },
              };
            }
            const fileContent = await handle.readFile({ encoding: "utf-8" });
            await resolvedManager.openFile(absolutePath, fileContent);
          } finally {
            await handle.close();
          }
        }

        
        let result = await resolvedManager.sendRequest(absolutePath, method, params);

        if (result === undefined) {
          debugLog(
            `No LSP server available for file type ${extname(absolutePath)} for operation ${input.operation} on file ${input.filePath}`,
          );
          return {
            data: {
              operation: input.operation,
              result: `No LSP server available for file type: ${extname(absolutePath)}`,
              filePath: input.filePath,
            },
          };
        }

        
        
        
        if (
          input.operation === "incomingCalls" ||
          input.operation === "outgoingCalls"
        ) {
          const callItems = result as LspCallHierarchyItem[];
          if (!callItems || callItems.length === 0) {
            return {
              data: {
                operation: input.operation,
                result: "No call hierarchy item found at this position",
                filePath: input.filePath,
                resultCount: 0,
                fileCount: 0,
              },
            };
          }

          
          const callMethod =
            input.operation === "incomingCalls"
              ? "callHierarchy/incomingCalls"
              : "callHierarchy/outgoingCalls";

          result = await resolvedManager.sendRequest(absolutePath, callMethod, {
            item: callItems[0],
          });

          if (result === undefined) {
            debugLog(
              `LSP server returned undefined for ${callMethod} on ${input.filePath}`,
            );
            
          }
        }

        
        if (
          result &&
          Array.isArray(result) &&
          (input.operation === "findReferences" ||
            input.operation === "goToDefinition" ||
            input.operation === "goToImplementation" ||
            input.operation === "workspaceSymbol")
        ) {
          if (input.operation === "workspaceSymbol") {
            
            const symbols = result as LspSymbolInformation[];
            const locations = symbols
              .filter((s) => s?.location?.uri)
              .map((s) => s.location);
            const filteredLocations = await filterGitIgnoredLocations(
              locations,
              context.workingDir,
            );
            const filteredUris = new Set(filteredLocations.map((l) => l.uri));
            result = symbols.filter(
              (s) => !s?.location?.uri || filteredUris.has(s.location.uri),
            );
          } else {
            
            const locations = (result as (LspLocation | LspLocationLink)[]).map(
              toLocation,
            );
            const filteredLocations = await filterGitIgnoredLocations(
              locations,
              context.workingDir,
            );
            const filteredUris = new Set(filteredLocations.map((l) => l.uri));
            result = (result as (LspLocation | LspLocationLink)[]).filter((item) => {
              const loc = toLocation(item);
              return !loc.uri || filteredUris.has(loc.uri);
            });
          }
        }

        
        const { formatted, resultCount, fileCount } = formatResult(
          input.operation,
          result,
          context.workingDir,
        );

        return {
          data: {
            operation: input.operation,
            result: formatted,
            filePath: input.filePath,
            resultCount,
            fileCount,
          },
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const errorMessageText = err.message;

        debugLog(
          `LSP tool request failed for ${input.operation} on ${input.filePath}: ${errorMessageText}`,
        );

        return {
          data: {
            operation: input.operation,
            result: `Error performing ${input.operation}: ${errorMessageText}`,
            filePath: input.filePath,
          },
        };
      }
    },
  });
}


function getMethodAndParams(
  input: LSPToolInput,
  absolutePath: string,
): { method: string; params: unknown } {
  const uri = pathToFileURL(absolutePath).href;
  
  const position = {
    line: input.line - 1,
    character: input.character - 1,
  };

  switch (input.operation) {
    case "goToDefinition":
      return {
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position,
        },
      };
    case "findReferences":
      return {
        method: "textDocument/references",
        params: {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },
        },
      };
    case "hover":
      return {
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position,
        },
      };
    case "documentSymbol":
      return {
        method: "textDocument/documentSymbol",
        params: {
          textDocument: { uri },
        },
      };
    case "workspaceSymbol":
      return {
        method: "workspace/symbol",
        params: {
          query: "", 
        },
      };
    case "goToImplementation":
      return {
        method: "textDocument/implementation",
        params: {
          textDocument: { uri },
          position,
        },
      };
    case "prepareCallHierarchy":
      return {
        method: "textDocument/prepareCallHierarchy",
        params: {
          textDocument: { uri },
          position,
        },
      };
    case "incomingCalls":
    case "outgoingCalls":
      
      
      
      return {
        method: "textDocument/prepareCallHierarchy",
        params: {
          textDocument: { uri },
          position,
        },
      };
  }
}


function countSymbols(symbols: LspDocumentSymbol[]): number {
  let count = symbols.length;
  for (const symbol of symbols) {
    if (symbol.children && symbol.children.length > 0) {
      count += countSymbols(symbol.children);
    }
  }
  return count;
}


function countUniqueFiles(locations: LspLocation[]): number {
  return new Set(locations.map((loc) => loc.uri)).size;
}


function uriToFilePath(uri: string): string {
  let filePath = uri.replace(/^file:\/\//, "");
  
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    
  }
  return filePath;
}


async function filterGitIgnoredLocations<T extends LspLocation>(
  locations: T[],
  cwd: string,
): Promise<T[]> {
  if (locations.length === 0) {
    return locations;
  }

  
  const uriToPath = new Map<string, string>();
  for (const loc of locations) {
    if (loc.uri && !uriToPath.has(loc.uri)) {
      uriToPath.set(loc.uri, uriToFilePath(loc.uri));
    }
  }

  const uniquePaths = uniq(uriToPath.values());
  if (uniquePaths.length === 0) {
    return locations;
  }

  
  
  
  const ignoredPaths = new Set<string>();
  const BATCH_SIZE = 50;
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE);
    let stdout = "";
    try {
      const result = Bun.spawnSync({
        cmd: ["git", "check-ignore", ...batch],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      if (result.exitCode === 0) {
        stdout = result.stdout.toString("utf-8");
      }
    } catch {
      
      continue;
    }

    if (stdout) {
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          ignoredPaths.add(trimmed);
        }
      }
    }
  }

  if (ignoredPaths.size === 0) {
    return locations;
  }

  return locations.filter((loc) => {
    const filePath = uriToPath.get(loc.uri);
    return !filePath || !ignoredPaths.has(filePath);
  });
}


function isLocationLink(item: LspLocation | LspLocationLink): item is LspLocationLink {
  return "targetUri" in item;
}


function toLocation(item: LspLocation | LspLocationLink): LspLocation {
  if (isLocationLink(item)) {
    return {
      uri: item.targetUri,
      range: item.targetSelectionRange || item.targetRange,
    };
  }
  return item;
}


function formatResult(
  operation: LSPOperation,
  result: unknown,
  cwd: string,
): { formatted: string; resultCount: number; fileCount: number } {
  switch (operation) {
    case "goToDefinition": {
      
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as LspLocation | LspLocationLink]
          : [];

      
      const locations = rawResults.map(toLocation);

      
      const invalidLocations = locations.filter((loc) => !loc || !loc.uri);
      if (invalidLocations.length > 0) {
        debugLog(
          `LSP server returned ${invalidLocations.length} location(s) with undefined URI for goToDefinition on ${cwd}. ` +
            `This indicates malformed data from the LSP server.`,
        );
      }

      const validLocations = locations.filter((loc) => loc && loc.uri);
      return {
        formatted: formatGoToDefinitionResult(
          result as
            | LspLocation
            | LspLocation[]
            | LspLocationLink
            | LspLocationLink[]
            | null,
          cwd,
        ),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      };
    }
    case "findReferences": {
      const locations = (result as LspLocation[]) || [];

      
      const invalidLocations = locations.filter((loc) => !loc || !loc.uri);
      if (invalidLocations.length > 0) {
        debugLog(
          `LSP server returned ${invalidLocations.length} location(s) with undefined URI for findReferences on ${cwd}. ` +
            `This indicates malformed data from the LSP server.`,
        );
      }

      const validLocations = locations.filter((loc) => loc && loc.uri);
      return {
        formatted: formatFindReferencesResult(result as LspLocation[] | null, cwd),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      };
    }
    case "hover": {
      return {
        formatted: formatHoverResult(result as LspHover | null, cwd),
        resultCount: result ? 1 : 0,
        fileCount: result ? 1 : 0,
      };
    }
    case "documentSymbol": {
      
      const symbols = (result as (LspDocumentSymbol | LspSymbolInformation)[]) || [];
      
      const isDocumentSymbol = symbols.length > 0 && symbols[0] && "range" in symbols[0];
      
      const count = isDocumentSymbol
        ? countSymbols(symbols as LspDocumentSymbol[])
        : symbols.length;
      return {
        formatted: formatDocumentSymbolResult(
          result as (LspDocumentSymbol[] | LspSymbolInformation[]) | null,
          cwd,
        ),
        resultCount: count,
        fileCount: symbols.length > 0 ? 1 : 0,
      };
    }
    case "workspaceSymbol": {
      const symbols = (result as LspSymbolInformation[]) || [];

      
      const invalidSymbols = symbols.filter(
        (sym) => !sym || !sym.location || !sym.location.uri,
      );
      if (invalidSymbols.length > 0) {
        debugLog(
          `LSP server returned ${invalidSymbols.length} symbol(s) with undefined location URI for workspaceSymbol on ${cwd}. ` +
            `This indicates malformed data from the LSP server.`,
        );
      }

      const validSymbols = symbols.filter(
        (sym) => sym && sym.location && sym.location.uri,
      );
      const locations = validSymbols.map((s) => s.location);
      return {
        formatted: formatWorkspaceSymbolResult(result as LspSymbolInformation[] | null, cwd),
        resultCount: validSymbols.length,
        fileCount: countUniqueFiles(locations),
      };
    }
    case "goToImplementation": {
      
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as LspLocation | LspLocationLink]
          : [];

      
      const locations = rawResults.map(toLocation);

      
      const invalidLocations = locations.filter((loc) => !loc || !loc.uri);
      if (invalidLocations.length > 0) {
        debugLog(
          `LSP server returned ${invalidLocations.length} location(s) with undefined URI for goToImplementation on ${cwd}. ` +
            `This indicates malformed data from the LSP server.`,
        );
      }

      const validLocations = locations.filter((loc) => loc && loc.uri);
      return {
        
        formatted: formatGoToDefinitionResult(
          result as
            | LspLocation
            | LspLocation[]
            | LspLocationLink
            | LspLocationLink[]
            | null,
          cwd,
        ),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      };
    }
    case "prepareCallHierarchy": {
      const items = (result as LspCallHierarchyItem[]) || [];
      return {
        formatted: formatPrepareCallHierarchyResult(
          result as LspCallHierarchyItem[] | null,
          cwd,
        ),
        resultCount: items.length,
        fileCount: items.length > 0 ? countUniqueFilesFromCallItems(items) : 0,
      };
    }
    case "incomingCalls": {
      const calls = (result as LspCallHierarchyIncomingCall[]) || [];
      return {
        formatted: formatIncomingCallsResult(
          result as LspCallHierarchyIncomingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount:
          calls.length > 0 ? countUniqueFilesFromIncomingCalls(calls) : 0,
      };
    }
    case "outgoingCalls": {
      const calls = (result as LspCallHierarchyOutgoingCall[]) || [];
      return {
        formatted: formatOutgoingCallsResult(
          result as LspCallHierarchyOutgoingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount:
          calls.length > 0 ? countUniqueFilesFromOutgoingCalls(calls) : 0,
      };
    }
  }
}


function countUniqueFilesFromCallItems(items: LspCallHierarchyItem[]): number {
  const validUris = items.map((item) => item.uri).filter((uri) => uri);
  return new Set(validUris).size;
}


function countUniqueFilesFromIncomingCalls(
  calls: LspCallHierarchyIncomingCall[],
): number {
  const validUris = calls.map((call) => call.from?.uri).filter((uri) => uri);
  return new Set(validUris).size;
}


function countUniqueFilesFromOutgoingCalls(
  calls: LspCallHierarchyOutgoingCall[],
): number {
  const validUris = calls.map((call) => call.to?.uri).filter((uri) => uri);
  return new Set(validUris).size;
}
