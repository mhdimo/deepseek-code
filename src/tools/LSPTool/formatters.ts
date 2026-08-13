







import { relative } from "path";



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


function formatUri(uri: string | undefined, cwd?: string): string {
  
  if (!uri) {
    debugLog(
      "formatUri called with undefined URI - indicates malformed LSP server response",
    );
    return "<unknown location>";
  }

  
  
  
  let filePath = uri.replace(/^file:\/\//, "");
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }

  
  try {
    filePath = decodeURIComponent(filePath);
  } catch (error) {
    debugLog(
      `Failed to decode LSP URI '${uri}': ${errorMessage(error)}. Using un-decoded path: ${filePath}`,
    );
    
  }

  
  if (cwd) {
    
    const relativePath = relative(cwd, filePath).replaceAll("\\", "/");
    
    if (
      relativePath.length < filePath.length &&
      !relativePath.startsWith("../../")
    ) {
      return relativePath;
    }
  }

  
  return filePath.replaceAll("\\", "/");
}


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


function formatLocation(location: LspLocation, cwd?: string): string {
  const filePath = formatUri(location.uri, cwd);
  const line = location.range.start.line + 1; 
  const character = location.range.start.character + 1; 
  return `${filePath}:${line}:${character}`;
}


function locationLinkToLocation(link: LspLocationLink): LspLocation {
  return {
    uri: link.targetUri,
    range: link.targetSelectionRange || link.targetRange,
  };
}


function isLocationLink(item: LspLocation | LspLocationLink): item is LspLocationLink {
  return "targetUri" in item;
}


export function formatGoToDefinitionResult(
  result: LspLocation | LspLocation[] | LspLocationLink | LspLocationLink[] | null,
  cwd?: string,
): string {
  if (!result) {
    return "No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.";
  }

  if (Array.isArray(result)) {
    
    const locations: LspLocation[] = result.map((item) =>
      isLocationLink(item) ? locationLinkToLocation(item) : item,
    );

    
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

  
  const location = isLocationLink(result)
    ? locationLinkToLocation(result)
    : result;
  return `Defined in ${formatLocation(location, cwd)}`;
}


export function formatFindReferencesResult(
  result: LspLocation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return "No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.";
  }

  
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
    
    return contents.value;
  }

  
  return contents.value;
}


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

  
  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      lines.push(...formatDocumentSymbolNode(child, indent + 1));
    }
  }

  return lines;
}


export function formatDocumentSymbolResult(
  result: LspDocumentSymbol[] | LspSymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return "No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.";
  }

  
  
  const firstSymbol = result[0];
  const isSymbolInformation = firstSymbol && "location" in firstSymbol;

  if (isSymbolInformation) {
    
    return formatWorkspaceSymbolResult(result as LspSymbolInformation[], cwd);
  }

  
  const lines: string[] = ["Document symbols:"];

  for (const symbol of result as LspDocumentSymbol[]) {
    lines.push(...formatDocumentSymbolNode(symbol));
  }

  return lines.join("\n");
}


export function formatWorkspaceSymbolResult(
  result: LspSymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return "No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.";
  }

  
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

  
  const byFile = groupByFile(validSymbols, cwd);

  for (const [filePath, symbols] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const symbol of symbols) {
      const kind = symbolKindToString(symbol.kind);
      const line = symbol.location.range.start.line + 1;
      let symbolLine = `  ${symbol.name} (${kind}) - Line ${line}`;

      
      if (symbol.containerName) {
        symbolLine += ` in ${symbol.containerName}`;
      }

      lines.push(symbolLine);
    }
  }

  return lines.join("\n");
}


function formatCallHierarchyItem(
  item: LspCallHierarchyItem,
  cwd?: string,
): string {
  
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
        continue; 
      }
      const kind = symbolKindToString(call.from.kind);
      const line = call.from.range.start.line + 1;
      let callLine = `  ${call.from.name} (${kind}) - Line ${line}`;

      
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
        continue; 
      }
      const kind = symbolKindToString(call.to.kind);
      const line = call.to.range.start.line + 1;
      let callLine = `  ${call.to.name} (${kind}) - Line ${line}`;

      
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
