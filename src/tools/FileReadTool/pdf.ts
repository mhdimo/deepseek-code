// Minimal, dependency-free PDF text extraction for FileReadTool.
//
// Scope: uncompressed text streams plus FlateDecode (zlib) streams, using
// Node's built-in zlib — no sharp, no pdf.js. This is deliberately best-effort:
//
//   - Text is extracted from the Tj / TJ / ' / " text-showing operators.
//   - Inline images (BI ... ID ... EI) are stripped before extraction.
//   - Streams that don't decompress to mostly-printable text are skipped
//     (fonts, images, and other binary objects).
//   - Xref is NOT parsed: pages are counted with a heuristic, and extraction
//     work is bounded (stream count, decompressed bytes, accumulated chars),
//     so a pathological file cannot hang the tool.
//
// Known limitations: LZWDecode and ASCIIHexDecode filters are not supported
// (rare in modern PDFs); text that uses custom encodings or is drawn as
// vector paths (e.g. scanned pages) will not be extracted; text ordering can
// be off for multi-column layouts.

import { inflateSync, inflateRawSync } from "node:zlib";

// windows-1252 (Bun's Encoding union) is a superset of latin1 and maps every
// byte 1:1 to a code point, which is what the PDF scanners need for
// indexOf-style byte search. Uint8Array.toString() takes no encoding
// argument (that's a Buffer-ism), so decode explicitly.
const latin1Decoder = new TextDecoder("windows-1252");

function toLatin1(buf: Uint8Array): string {
  return latin1Decoder.decode(buf);
}

/** Maximum pages a single read is expected to cover (extraction is capped
 *  by the token budget anyway — this only guards the reported page count). */
export const PDF_MAX_PAGES_PER_READ = 20;

/** Hard cap on PDF file size — reading bigger files into memory is not worth it. */
export const PDF_MAX_READ_SIZE_BYTES = 64 * 1024 * 1024;

/** Hard cap on decompressed bytes examined across all streams. */
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Maximum number of stream objects processed. */
const MAX_STREAMS = 500;

export interface PDFTextResult {
  text: string;
  pageCount: number;
  /** Number of content streams text was successfully pulled from. */
  streamsExtracted: number;
}

/**
 * Rough page count without xref parsing: counts "/Type /Page" objects but
 * not "/Type /Pages" (the page-tree node). A heuristic — PDFs with unusual
 * encodings may miscount, which only affects the reported number and the
 * "many pages" warning, never correctness of the extracted text.
 */
export function getPDFPageCount(buf: Uint8Array): number {
  const text = toLatin1(buf);
  const re = /\/Type\s*\/Page(?![A-Za-z])/g;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // "/Page" that is not part of "/Pages" — the negative lookahead above
    // already excludes "Pages"; count everything else.
    count++;
  }
  return count;
}

/**
 * Extract text from a PDF buffer. Stops early once `maxChars` of text has
 * been accumulated (the caller truncates to its token budget afterwards).
 */
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

    // "stream" must be a PDF keyword — followed by an EOL.
    const after = latin1.charCodeAt(streamIdx + 6);
    if (after !== 0x0a && after !== 0x0d && after !== 0x20 && after !== 0x09) {
      continue;
    }
    // Skip the EOL after the keyword (\r\n is a single EOL).
    let dataStart = streamIdx + 6;
    if (latin1[dataStart] === "\r" && latin1[dataStart + 1] === "\n") {
      dataStart += 2;
    } else {
      dataStart += 1;
    }

    const endIdx = latin1.indexOf("endstream", dataStart);
    if (endIdx < 0) break; // Malformed — give up rather than scan forever.
    searchFrom = endIdx + 9;

    streamsProcessed++;
    const raw = buf.subarray(dataStart, endIdx);
    if (raw.length > MAX_DECOMPRESSED_BYTES - decompressedBytes) break;

    // Look backwards from the stream keyword for the stream dict's filter.
    // Bound the scan at the dict's own opening "<<" — the last ">>" before
    // the keyword ends the dict, and the "<<" before that opens it. Scanning
    // further back can pick up a PREVIOUS object's filter and misclassify an
    // uncompressed stream as FlateDecode.
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
      if (inflated === null) continue; // Un-decodable — skip this stream.
      decompressedBytes += inflated.length;
      if (decompressedBytes > MAX_DECOMPRESSED_BYTES) break;
      content = inflated;
    } else {
      content = raw;
      decompressedBytes += content.length;
    }

    // Content-stream heuristic: mostly-printable text that shows text.
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

/** True if `text` looks like printable text (operators + strings), not binary. */
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

/**
 * Pull the text out of a content stream: strip inline images, then walk the
 * text-showing operators (Tj, TJ, ', ") and positioning operators (Td, TD,
 * T*, Tm) to reconstruct lines.
 */
function extractTextFromContentStream(stream: Uint8Array): string {
  // Strip inline images FIRST — their binary payload would otherwise fail
  // the printable-text heuristic and lose the whole page's text.
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
      lines.push(""); // Paragraph separator between text objects.
    }
    // "BT" — start of text object; nothing to do.
  }
  flushLine();

  // Collapse runs of blank lines and trim.
  const result: string[] = [];
  for (const line of lines) {
    if (line === "" && result[result.length - 1] === "") continue;
    result.push(line);
  }
  const joined = result.join("\n").trim();

  // Garbage guard: PDFs with custom font encodings (no ToUnicode CMap)
  // extract raw glyph IDs, which are mostly control/high characters that
  // would confuse the model more than silence would. Drop the stream when
  // the extracted text isn't mostly printable.
  if (joined.length > 0 && !isMostlyPrintable(joined)) return "";

  return joined;
}

/** Remove inline images (BI ... ID <binary> EI) which would otherwise trip
 *  the printable-text heuristic and pollute extracted text. */
function stripInlineImages(content: string): string {
  let out = content;
  let idx = 0;
  while (true) {
    const bi = out.indexOf("BI", idx);
    if (bi < 0) break;
    // "ID" ends the inline-image dict; it's the first standalone "ID"
    // (whitespace-delimited) after "BI". Binary data may contain " ID "
    // but the dict is short — bound the search.
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

/** Decode a PDF string literal `( ... )` including escape sequences. */
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
        // Line continuation — swallows the following newline too.
        if (next === "\r" && inner[i + 1] === "\n") i++;
        break;
      default:
        if (next >= "0" && next <= "7") {
          // Up to 3 octal digits.
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
          out += next; // Unknown escape — keep the character.
        }
    }
  }
  return out;
}

/** Decode a PDF hex string `<...>` (whitespace ignored, odd nibble padded). */
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
