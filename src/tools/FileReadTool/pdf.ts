

















import { inflateSync, inflateRawSync } from "node:zlib";





const latin1Decoder = new TextDecoder("windows-1252");

function toLatin1(buf: Uint8Array): string {
  return latin1Decoder.decode(buf);
}


export const PDF_MAX_PAGES_PER_READ = 20;


export const PDF_MAX_READ_SIZE_BYTES = 64 * 1024 * 1024;


const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;


const MAX_STREAMS = 500;

export interface PDFTextResult {
  text: string;
  pageCount: number;
  
  streamsExtracted: number;
}


export function getPDFPageCount(buf: Uint8Array): number {
  const text = toLatin1(buf);
  const re = /\/Type\s*\/Page(?![A-Za-z])/g;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    
    
    count++;
  }
  return count;
}


export function extractPDFText(
  buf: Uint8Array,
  maxChars: number,
): PDFTextResult {
  const pageCount = getPDFPageCount(buf);
  const latin1 = toLatin1(buf);

  const parts: string[] = [];
  let extractedChars = 0;
  let streamsExtracted = 0;
  let streamsProcessed = 0;
  let decompressedBytes = 0;
  let searchFrom = 0;

  while (streamsProcessed < MAX_STREAMS) {
    const streamIdx = latin1.indexOf("stream", searchFrom);
    if (streamIdx < 0) break;
    searchFrom = streamIdx + 6;

    
    const after = latin1.charCodeAt(streamIdx + 6);
    if (after !== 0x0a && after !== 0x0d && after !== 0x20 && after !== 0x09) {
      continue;
    }
    
    let dataStart = streamIdx + 6;
    if (latin1[dataStart] === "\r" && latin1[dataStart + 1] === "\n") {
      dataStart += 2;
    } else {
      dataStart += 1;
    }

    const endIdx = latin1.indexOf("endstream", dataStart);
    if (endIdx < 0) break; 
    searchFrom = endIdx + 9;

    streamsProcessed++;
    const raw = buf.subarray(dataStart, endIdx);
    if (raw.length > MAX_DECOMPRESSED_BYTES - decompressedBytes) break;

    
    
    
    
    
    const dictClose = latin1.lastIndexOf(">>", streamIdx);
    const dictOpen = dictClose >= 0 ? latin1.lastIndexOf("<<", dictClose) : -1;
    const dictStart =
      dictOpen >= 0 ? dictOpen : Math.max(0, streamIdx - 4096);
    const dictText = latin1.slice(dictStart, streamIdx);
    const hasFlate =
      dictText.includes("/FlateDecode") || dictText.includes("/Fl");

    let content: Uint8Array;
    if (hasFlate) {
      const inflated = tryInflate(raw);
      if (inflated === null) continue; 
      decompressedBytes += inflated.length;
      if (decompressedBytes > MAX_DECOMPRESSED_BYTES) break;
      content = inflated;
    } else {
      content = raw;
      decompressedBytes += content.length;
    }

    
    const text = extractTextFromContentStream(content);
    if (text.length === 0) continue;

    parts.push(text);
    streamsExtracted++;
    extractedChars += text.length;
    if (extractedChars > maxChars) break;
  }

  return {
    text: parts.join("\n\n"),
    pageCount,
    streamsExtracted,
  };
}

function tryInflate(data: Uint8Array): Uint8Array | null {
  try {
    return inflateSync(data);
  } catch {
    try {
      return inflateRawSync(data);
    } catch {
      return null;
    }
  }
}


function isMostlyPrintable(text: string): boolean {
  if (text.length === 0) return false;
  const n = Math.min(text.length, 64 * 1024);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (
      c === 0x09 ||
      c === 0x0a ||
      c === 0x0d ||
      (c >= 0x20 && c <= 0x7e)
    ) {
      printable++;
    }
  }
  return printable / n > 0.9;
}


function extractTextFromContentStream(stream: Uint8Array): string {
  
  
  const content = stripInlineImages(toLatin1(stream));
  if (!isMostlyPrintable(content)) return "";
  if (!content.includes("BT") || (!content.includes("Tj") && !content.includes("TJ"))) {
    return "";
  }

  const lines: string[] = [];
  let current = "";
  const tokenRe = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\r\n\t\s]+>|Td|TD|T\*|Tm|Tj|TJ|'|"|ET|BT/g;
  let m: RegExpExecArray | null;

  const flushLine = () => {
    if (current.trim()) lines.push(current.trim());
    current = "";
  };

  while ((m = tokenRe.exec(content)) !== null) {
    const tok = m[0];
    const first = tok[0];
    if (first === "(") {
      current += decodeStringLiteral(tok);
    } else if (first === "<") {
      current += decodeHexString(tok);
    } else if (tok === "Td" || tok === "TD" || tok === "T*" || tok === "Tm") {
      flushLine();
    } else if (tok === "Tj" || tok === "TJ" || tok === "'" || tok === '"') {
      flushLine();
    } else if (tok === "ET") {
      flushLine();
      lines.push(""); 
    }
    
  }
  flushLine();

  
  const result: string[] = [];
  for (const line of lines) {
    if (line === "" && result[result.length - 1] === "") continue;
    result.push(line);
  }
  const joined = result.join("\n").trim();

  
  
  
  
  if (joined.length > 0 && !isMostlyPrintable(joined)) return "";

  return joined;
}


function stripInlineImages(content: string): string {
  let out = content;
  let idx = 0;
  while (true) {
    const bi = out.indexOf("BI", idx);
    if (bi < 0) break;
    
    
    
    const id = findInlineImageID(out, bi + 2, Math.min(out.length, bi + 2 + 512));
    if (id < 0) break;
    const ei = out.indexOf("EI", id + 2);
    if (ei < 0) break;
    out = out.slice(0, bi) + " " + out.slice(ei + 2);
    idx = bi + 1;
  }
  return out;
}

function findInlineImageID(content: string, from: number, to: number): number {
  let i = from;
  while (i < to - 1) {
    if (
      content[i] === "I" &&
      content[i + 1] === "D" &&
      isWs(content.charCodeAt(i - 1)) &&
      isWs(content.charCodeAt(i + 2))
    ) {
      return i;
    }
    i++;
  }
  return -1;
}

function isWs(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x09 ||
    code === 0x0c ||
    Number.isNaN(code)
  );
}


export function decodeStringLiteral(raw: string): string {
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) break;
    i++;
    switch (next) {
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "(": out += "("; break;
      case ")": out += ")"; break;
      case "\\": out += "\\"; break;
      case "\r":
      case "\n":
        
        if (next === "\r" && inner[i + 1] === "\n") i++;
        break;
      default:
        if (next >= "0" && next <= "7") {
          
          let oct = next;
          let j = i + 1;
          while (
            j < inner.length &&
            j < i + 3 &&
            inner[j]! >= "0" &&
            inner[j]! <= "7"
          ) {
            oct += inner[j]!;
            j++;
          }
          out += String.fromCharCode(Number.parseInt(oct, 8));
          i = j - 1;
        } else {
          out += next; 
        }
    }
  }
  return out;
}


export function decodeHexString(raw: string): string {
  let hex = raw.slice(1, -1).replace(/[\s]/g, "");
  if (hex.length % 2 === 1) hex += "0";
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    out += String.fromCharCode(Number.isNaN(byte) ? 0 : byte);
  }
  return out;
}
