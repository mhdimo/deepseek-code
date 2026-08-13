







import { openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const MAX_READ_BYTES = 64 * 1024;

function debugLog(message: string): void {
  if (process.env.DEEPSEEK_CODE_DEBUG === "1" || process.env.DEBUG) {
    console.error(`[lsp] ${message}`);
  }
}


function expandPath(filePath: string, cwd?: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath.startsWith("/") ? filePath : resolve(cwd ?? process.cwd(), filePath);
}


function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}


export function getSymbolAtPosition(
  filePath: string,
  line: number,
  character: number,
  cwd?: string,
): string | null {
  try {
    const absolutePath = expandPath(filePath, cwd);

    
    
    
    
    const fd = openSync(absolutePath, "r");
    let bytesRead = 0;
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(MAX_READ_BYTES);
      bytesRead = readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
    } finally {
      closeSync(fd);
    }
    const content = buffer.toString("utf-8", 0, bytesRead);
    const lines = content.split("\n");

    if (line < 0 || line >= lines.length) {
      return null;
    }
    
    
    if (bytesRead === MAX_READ_BYTES && line === lines.length - 1) {
      return null;
    }

    const lineContent = lines[line];
    if (!lineContent || character < 0 || character >= lineContent.length) {
      return null;
    }

    
    
    
    
    
    
    
    const symbolPattern = /[\w$'!]+|[+\-*/%&|^~<>=]+/g;
    let match: RegExpExecArray | null;

    while ((match = symbolPattern.exec(lineContent)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      
      if (character >= start && character < end) {
        const symbol = match[0];
        
        return truncate(symbol, 30);
      }
    }

    return null;
  } catch (error) {
    
    if (error instanceof Error) {
      debugLog(
        `Symbol extraction failed for ${filePath}:${line}:${character}: ${error.message}`,
      );
    }
    
    return null;
  }
}
