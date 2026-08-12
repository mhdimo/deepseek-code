// LSPTool result formatters — ported from Claude Code's
// src/tools/LSPTool/formatters.ts.
//
// Turns raw LSP responses (locations, symbols, hover, call hierarchy) into
// human-readable text for the model. The reference imported its types from
// vscode-languageserver-types; we define the minimal structural types locally
// (they are plain JSON shapes) and drop the dependency.

import { relative } from "path";

// ─── Minimal LSP structural types ─────────────────────────────────────────────

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}
export interface LspMarkupContent {
  kind: string;
  value: string;
}
export type LspMarkedString = string | { language: string; value: string };
export interface LspHover {
  contents: LspMarkupContent | LspMarkedString | LspMarkedString[];
  range?: LspRange;
}
export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}
export interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
}
export interface LspCallHierarchyIncomingCall {
  from: LspCallHierarchyItem;
  fromRanges: LspRange[];
}
export interface LspCallHierarchyOutgoingCall {
  to: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

// ─── Local helpers (replacements for Claude Code utils) ───────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function debugLog(message: string): void {
  if (process.env.DEEPSEEK_CODE_DEBUG === "1" || process.env.DEBUG) {
    console.error(`[lsp] ${message}`);
  }
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/**
 * Formats a URI by converting it to a relative path if possible.
 * Handles URI decoding and gracefully falls back to un-decoded path if malformed.
 * Only uses relative paths when shorter and not starting with ../../
 */
function formatUri(uri: string | undefined, cwd?: string): string {
  // Handle undefined/null URIs - this indicates malformed LSP data
  if (!uri) {
    debugLog(
      "formatUri called with undefined URI - indicates malformed LSP server response",
    );
    return "<unknown location>";
  }

  // Remove file:// protocol if present
  // On Windows, file:///C:/path becomes /C:/path after replacing file://
  // We need to strip the leading slash for Windows drive-letter paths
  let filePath = uri.replace(/^file:\/\//, "");
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }

  // Decode URI encoding - handle malformed URIs gracefully
  try {
    filePath = decodeURIComponent(filePath);
  } catch (error) {
    debugLog(
      `Failed to decode LSP URI '${uri}': ${errorMessage(error)}. Using un-decoded path: ${filePath}`,
    );
    // filePath already contains the un-decoded path, which is still usable
  }

  // Convert to relative path if cwd is provided
  if (cwd) {
    // Normalize separators to forward slashes for consistent display output
    const relativePath = relative(cwd, filePath).replaceAll("\\", "/");
    // Only use relative path if it's shorter and doesn't start with ../..
    if (
      relativePath.length < filePath.length &&
      !relativePath.startsWith("../../")
    ) {
      return relativePath;
    }
  }

  // Normalize separators to forward slashes for consistent display output
  return filePath.replaceAll("\\", "/");
}

/**
 * Groups items by their file URI.
 * Generic helper that works with both Location[] and SymbolInformation[]
 */
function groupByFile<T extends { uri: string } | { location: { uri: string } }>(
  items: T[],
  cwd?: string,
): Map<string, T[]> {
  const byFile = new Map<string, T[]>();
  for (const item of items) {
    const uri = "uri" in item ? item.uri : item.location.uri;
    const filePath = formatUri(uri, cwd);
    const existingItems = byFile.get(filePath);
    if (existingItems) {
      existingItems.push(item);
    } else {
      byFile.set(filePath, [item]);
    }
  }
  return byFile;
}

/**
 * Formats a Location with file path and line/character position
 */
function formatLocation(location: LspLocation, cwd?: string): string {
  const filePath = formatUri(location.uri, cwd);
  const line = location.range.start.line + 1; // Convert to 1-based
  const character = location.range.start.character + 1; // Convert to 1-based
  return `${filePath}:${line}:${character}`;
}

/**
 * Converts LocationLink to Location format for consistent handling
 */
function locationLinkToLocation(link: LspLocationLink): LspLocation {
  return {
    uri: link.targetUri,
    range: link.targetSelectionRange || link.targetRange,
  };
}

/**
 * Checks if an object is a LocationLink (has targetUri) vs Location (has uri)
 */
function isLocationLink(item: LspLocation | LspLocationLink): item is LspLocationLink {
  return "targetUri" in item;
}

/**
 * Formats goToDefinition result
 * Can return Location, LocationLink, or arrays of either
 */
export function formatGoToDefinitionResult(
  result: LspLocation | LspLocation[] | LspLocationLink | LspLocationLink[] | null,
  cwd?: string,
): string {
  if (!result) {
    return "No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.";
  }

  if (Array.isArray(result)) {
    // Convert LocationLinks to Locations for uniform handling
    const locations: LspLocation[] = result.map((item) =>
      isLocationLink(item) ? locationLinkToLocation(item) : item,
    );

    // Log and filter out any locations with undefined uris
    const invalidLocations = locations.filter((loc) => !loc || !loc.uri);
    if (invalidLocations.length > 0) {
      debugLog(
        `formatGoToDefinitionResult: Filtering out ${invalidLocations.length} invalid location(s) - this should have been caught earlier`,
      );
    }

    const validLocations = locations.filter((loc) => loc && loc.uri);

    if (validLocations.length === 0) {
      return "No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.";
    }
    if (validLocations.length === 1) {
      return `Defined in ${formatLocation(validLocations[0]!, cwd)}`;
    }
    const locationList = validLocations
      .map((loc) => `  ${formatLocation(loc, cwd)}`)
      .join("\n");
    return `Found ${validLocations.length} definitions:\n${locationList}`;
  }

  // Single result - convert LocationLink if needed
  const location = isLocationLink(result)
    ? locationLinkToLocation(result)
    : result;
  return `Defined in ${formatLocation(location, cwd)}`;
}

/**
 * Formats findReferences result
 */
export function formatFindReferencesResult(
  result: LspLocation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return "No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.";
  }

  // Log and filter out any locations with undefined uris
  const invalidLocations = result.filter((loc) => !loc || !loc.uri);
  if (invalidLocations.length > 0) {
    debugLog(
      `formatFindReferencesResult: Filtering out ${invalidLocations.length} invalid location(s) - this should have been caught earlier`,
    );
  }

  const validLocations = result.filter((loc) => loc && loc.uri);

  if (validLocations.length === 0) {
    return "No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.";
  }

  if (validLocations.length === 1) {
    return `Found 1 reference:\n  ${formatLocation(validLocations[0]!, cwd)}`;
  }

  // Group references by file
  const byFile = groupByFile(validLocations, cwd);

  const lines: string[] = [
    `Found ${validLocations.length} references across ${byFile.size} files:`,
  ];

  for (const [filePath, locations] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const loc of locations) {
      const line = loc.range.start.line + 1;
      const character = loc.range.start.character + 1;
      lines.push(`  Line ${line}:${character}`);
    }
  }

  return lines.join("\n");
}

/**
 * Extracts text content from MarkupContent or MarkedString
 */
function extractMarkupText(
  contents: LspMarkupContent | LspMarkedString | LspMarkedString[],
): string {
  if (Array.isArray(contents)) {
    return contents
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        return item.value;
      })
      .join("\n\n");
  }

  if (typeof contents === "string") {
    return contents;
  }

  if ("kind" in contents) {
    // MarkupContent
    return contents.value;
  }

  // MarkedString object
  return contents.value;
}

/**
 * Formats hover result
 */
export function formatHoverResult(result: LspHover | null, _cwd?: string): string {
  if (!result) {
    return "No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.";
  }

  const content = extractMarkupText(result.contents);

  if (result.range) {
    const line = result.range.start.line + 1;
    const character = result.range.start.character + 1;
    return `Hover info at ${line}:${character}:\n\n${content}`;
  }

  return content;
}

/**
 * Maps SymbolKind enum to readable string
 */
function symbolKindToString(kind: number): string {
  const kinds: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  };
  return kinds[kind] || "Unknown";
}

/**
 * Formats a single DocumentSymbol with indentation
 */
function formatDocumentSymbolNode(
  symbol: LspDocumentSymbol,
  indent: number = 0,
): string[] {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);
  const kind = symbolKindToString(symbol.kind);

  let line = `${prefix}${symbol.name} (${kind})`;
  if (symbol.detail) {
    line += ` ${symbol.detail}`;
  }

  const symbolLine = symbol.range.start.line + 1;
  line += ` - Line ${symbolLine}`;

  lines.push(line);

  // Recursively format children
  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      lines.push(...formatDocumentSymbolNode(child, indent + 1));
    }
  }

  return lines;
}

/**
 * Formats documentSymbol result (hierarchical outline)
 * Handles both DocumentSymbol[] (hierarchical, with range) and SymbolInformation[] (flat, with location.range)
 * per LSP spec which allows textDocument/documentSymbol to return either format
 */
export function formatDocumentSymbolResult(
  result: LspDocumentSymbol[] | LspSymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return "No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.";
  }

  // Detect format: DocumentSymbol has 'range' directly, SymbolInformation has 'location.range'
  // Check the first valid element to determine format
  const firstSymbol = result[0];
  const isSymbolInformation = firstSymbol && "location" in firstSymbol;

  if (isSymbolInformation) {
    // Delegate to workspace symbol formatter which handles SymbolInformation[]
    return formatWorkspaceSymbolResult(result as LspSymbolInformation[], cwd);
  }

  // Handle DocumentSymbol[] format (hierarchical)
  const lines: string[] = ["Document symbols:"];

  for (const symbol of result as LspDocumentSymbol[]) {
    lines.push(...formatDocumentSymbolNode(symbol));
  }

  return lines.join("\n");
}

/**
 * Formats workspaceSymbol result (flat list of symbols)
 */
export function formatWorkspaceSymbolResult(
  result: LspSymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return "No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.";
  }

  // Log and filter out any symbols with undefined location.uri
  const invalidSymbols = result.filter(
    (sym) => !sym || !sym.location || !sym.location.uri,
  );
  if (invalidSymbols.length > 0) {
    debugLog(
      `formatWorkspaceSymbolResult: Filtering out ${invalidSymbols.length} invalid symbol(s) - this should have been caught earlier`,
    );
  }

  const validSymbols = result.filter(
    (sym) => sym && sym.location && sym.location.uri,
  );

  if (validSymbols.length === 0) {
    return "No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.";
  }

  const lines: string[] = [
    `Found ${validSymbols.length} ${plural(validSymbols.length, "symbol")} in workspace:`,
  ];

  // Group by file
  const byFile = groupByFile(validSymbols, cwd);

  for (const [filePath, symbols] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const symbol of symbols) {
      const kind = symbolKindToString(symbol.kind);
      const line = symbol.location.range.start.line + 1;
      let symbolLine = `  ${symbol.name} (${kind}) - Line ${line}`;

      // Add container name if available
      if (symbol.containerName) {
        symbolLine += ` in ${symbol.containerName}`;
      }

      lines.push(symbolLine);
    }
  }

  return lines.join("\n");
}

/**
 * Formats a CallHierarchyItem with its location
 * Validates URI before formatting to handle malformed LSP data
 */
function formatCallHierarchyItem(
  item: LspCallHierarchyItem,
  cwd?: string,
): string {
  // Validate URI - handle undefined/null gracefully
  if (!item.uri) {
    debugLog("formatCallHierarchyItem: CallHierarchyItem has undefined URI");
    return `${item.name} (${symbolKindToString(item.kind)}) - <unknown location>`;
  }

  const filePath = formatUri(item.uri, cwd);
  const line = item.range.start.line + 1;
  const kind = symbolKindToString(item.kind);
  let result = `${item.name} (${kind}) - ${filePath}:${line}`;
  if (item.detail) {
    result += ` [${item.detail}]`;
  }
  return result;
}

/**
 * Formats prepareCallHierarchy result
 * Returns the call hierarchy item(s) at the given position
 */
export function formatPrepareCallHierarchyResult(
  result: LspCallHierarchyItem[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return "No call hierarchy item found at this position";
  }

  if (result.length === 1) {
    return `Call hierarchy item: ${formatCallHierarchyItem(result[0]!, cwd)}`;
  }

  const lines = [`Found ${result.length} call hierarchy items:`];
  for (const item of result) {
    lines.push(`  ${formatCallHierarchyItem(item, cwd)}`);
  }
  return lines.join("\n");
}

/**
 * Formats incomingCalls result
 * Shows all functions/methods that call the target
 */
export function formatIncomingCallsResult(
  result: LspCallHierarchyIncomingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return "No incoming calls found (nothing calls this function)";
  }

  const lines = [
    `Found ${result.length} incoming ${plural(result.length, "call")}:`,
  ];

  // Group by file
  const byFile = new Map<string, LspCallHierarchyIncomingCall[]>();
  for (const call of result) {
    if (!call.from) {
      debugLog("formatIncomingCallsResult: CallHierarchyIncomingCall has undefined from field");
      continue;
    }
    const filePath = formatUri(call.from.uri, cwd);
    const existing = byFile.get(filePath);
    if (existing) {
      existing.push(call);
    } else {
      byFile.set(filePath, [call]);
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const call of calls) {
      if (!call.from) {
        continue; // Already logged above
      }
      const kind = symbolKindToString(call.from.kind);
      const line = call.from.range.start.line + 1;
      let callLine = `  ${call.from.name} (${kind}) - Line ${line}`;

      // Show call sites within the caller
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map((r) => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(", ");
        callLine += ` [calls at: ${callSites}]`;
      }

      lines.push(callLine);
    }
  }

  return lines.join("\n");
}

/**
 * Formats outgoingCalls result
 * Shows all functions/methods called by the target
 */
export function formatOutgoingCallsResult(
  result: LspCallHierarchyOutgoingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return "No outgoing calls found (this function calls nothing)";
  }

  const lines = [
    `Found ${result.length} outgoing ${plural(result.length, "call")}:`,
  ];

  // Group by file
  const byFile = new Map<string, LspCallHierarchyOutgoingCall[]>();
  for (const call of result) {
    if (!call.to) {
      debugLog("formatOutgoingCallsResult: CallHierarchyOutgoingCall has undefined to field");
      continue;
    }
    const filePath = formatUri(call.to.uri, cwd);
    const existing = byFile.get(filePath);
    if (existing) {
      existing.push(call);
    } else {
      byFile.set(filePath, [call]);
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const call of calls) {
      if (!call.to) {
        continue; // Already logged above
      }
      const kind = symbolKindToString(call.to.kind);
      const line = call.to.range.start.line + 1;
      let callLine = `  ${call.to.name} (${kind}) - Line ${line}`;

      // Show call sites within the current function
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map((r) => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(", ");
        callLine += ` [called from: ${callSites}]`;
      }

      lines.push(callLine);
    }
  }

  return lines.join("\n");
}
