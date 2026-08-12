// Image metadata reading for FileReadTool.
//
// The model layer cannot consume images today (DeepSeek models are text-only,
// and the C++ SDK drops FilePart content in tool results — see the tool
// prompt), so FileRead does NOT emit images as model-visible content. Instead
// it reports format, size, and dimensions (parsed dependency-free from the
// file headers), and — for small images — includes a data: URL in the result
// text so a future binding change can consume the bytes without re-reading
// the file.
//
// Dimensions are parsed from headers only: PNG (IHDR), JPEG (SOF markers),
// GIF (logical screen descriptor), and WebP (VP8X / VP8 / VP8L). No image
// decoding, no dependencies.

import { formatFileSize } from "../../utils/limits.js";

/** Image extensions routed to the summary path. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/**
 * Images at or below this many raw bytes get their data: URL included in the
 * result (base64 ≈ 1.37× the raw size, so 32 KB ≈ 44 KB of result text,
 * ~11 K tokens — comfortably inside the default 25 K token budget).
 * Larger images report size + dimensions only.
 */
export const MAX_IMAGE_DATA_URL_BYTES = 32 * 1024;

export type ImageType = "png" | "jpeg" | "gif" | "webp";

export interface ImageDimensions {
  width: number;
  height: number;
}

function u8(buf: Uint8Array, i: number): number {
  return buf[i] ?? 0;
}

/** Detect the image format from magic bytes; null when unrecognized. */
export function detectImageType(buf: Uint8Array): ImageType | null {
  if (
    buf.length >= 8 &&
    u8(buf, 0) === 0x89 &&
    u8(buf, 1) === 0x50 &&
    u8(buf, 2) === 0x4e &&
    u8(buf, 3) === 0x47 &&
    u8(buf, 4) === 0x0d &&
    u8(buf, 5) === 0x0a &&
    u8(buf, 6) === 0x1a &&
    u8(buf, 7) === 0x0a
  ) {
    return "png";
  }
  if (
    buf.length >= 3 &&
    u8(buf, 0) === 0xff &&
    u8(buf, 1) === 0xd8 &&
    u8(buf, 2) === 0xff
  ) {
    return "jpeg";
  }
  if (
    buf.length >= 6 &&
    u8(buf, 0) === 0x47 &&
    u8(buf, 1) === 0x49 &&
    u8(buf, 2) === 0x46 &&
    (u8(buf, 3) === 0x38 || u8(buf, 3) === 0x37) &&
    (u8(buf, 4) === 0x61 || u8(buf, 4) === 0x39) &&
    u8(buf, 5) === 0x61
  ) {
    return "gif";
  }
  if (
    buf.length >= 12 &&
    u8(buf, 0) === 0x52 &&
    u8(buf, 1) === 0x49 &&
    u8(buf, 2) === 0x46 &&
    u8(buf, 3) === 0x46 &&
    u8(buf, 8) === 0x57 &&
    u8(buf, 9) === 0x45 &&
    u8(buf, 10) === 0x42 &&
    u8(buf, 11) === 0x50
  ) {
    return "webp";
  }
  return null;
}

export function imageMediaType(type: ImageType): string {
  return `image/${type}`;
}

/** Parse width/height from the file headers; null when unrecognized. */
export function parseImageDimensions(buf: Uint8Array): ImageDimensions | null {
  const type = detectImageType(buf);
  switch (type) {
    case "png": {
      // 8-byte signature, then IHDR chunk: length(4) "IHDR"(4) w(4 BE) h(4 BE)
      if (
        buf.length >= 24 &&
        u8(buf, 12) === 0x49 &&
        u8(buf, 13) === 0x48 &&
        u8(buf, 14) === 0x44 &&
        u8(buf, 15) === 0x52
      ) {
        const width = (u8(buf, 16) << 24) | (u8(buf, 17) << 16) | (u8(buf, 18) << 8) | u8(buf, 19);
        const height = (u8(buf, 20) << 24) | (u8(buf, 21) << 16) | (u8(buf, 22) << 8) | u8(buf, 23);
        return { width, height };
      }
      return null;
    }
    case "jpeg":
      return parseJPEGDimensions(buf);
    case "gif": {
      if (buf.length < 10) return null;
      return {
        width: u8(buf, 6) | (u8(buf, 7) << 8),
        height: u8(buf, 8) | (u8(buf, 9) << 8),
      };
    }
    case "webp":
      return parseWebPDimensions(buf);
    default:
      return null;
  }
}

/** Walk JPEG segments to the first Start-Of-Frame marker (height/width). */
function parseJPEGDimensions(buf: Uint8Array): ImageDimensions | null {
  let i = 2; // Skip SOI.
  while (i + 9 < buf.length) {
    if (u8(buf, i) !== 0xff) {
      i++;
      continue;
    }
    const marker = u8(buf, i + 1);
    // Standalone markers: RSTn, SOI, TEM.
    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI.
    const segLen = (u8(buf, i + 2) << 8) | u8(buf, i + 3);
    if (segLen < 2) break; // Malformed.
    // SOF0..SOF15 excluding DHT(C4), JPG(C8), DAC(CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: (u8(buf, i + 5) << 8) | u8(buf, i + 6),
        width: (u8(buf, i + 7) << 8) | u8(buf, i + 8),
      };
    }
    i += 2 + segLen;
  }
  return null;
}

function u24LE(buf: Uint8Array, i: number): number {
  return u8(buf, i) | (u8(buf, i + 1) << 8) | (u8(buf, i + 2) << 16);
}

function parseWebPDimensions(buf: Uint8Array): ImageDimensions | null {
  if (buf.length < 30) return null;
  const chunkType = String.fromCharCode(
    u8(buf, 12),
    u8(buf, 13),
    u8(buf, 14),
    u8(buf, 15),
  );
  // Chunk data starts at offset 20 (8-byte header after RIFF/WEBP).
  switch (chunkType) {
    case "VP8X": {
      // flags(1) reserved(3) width-1(3 LE) height-1(3 LE)
      if (buf.length < 30) return null;
      return {
        width: u24LE(buf, 24) + 1,
        height: u24LE(buf, 27) + 1,
      };
    }
    case "VP8 ": {
      // Frame tag(3) start code 9D 01 2A(3), then 14-bit LE dimensions.
      if (u8(buf, 23) !== 0x9d || u8(buf, 24) !== 0x01 || u8(buf, 25) !== 0x2a) {
        return null;
      }
      return {
        width: (u8(buf, 26) | ((u8(buf, 27) & 0x3f) << 8)) & 0x3fff,
        height:
          ((u8(buf, 27) >> 6) | (u8(buf, 28) << 2) | ((u8(buf, 29) & 0x0f) << 10)) &
          0x3fff,
      };
    }
    case "VP8L": {
      // Signature byte 0x2f, then 14-bit width-1 / height-1 packed in 4 bytes.
      if (u8(buf, 20) !== 0x2f) return null;
      const bits =
        u8(buf, 21) |
        (u8(buf, 22) << 8) |
        (u8(buf, 23) << 16) |
        (u8(buf, 24) << 24);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    default:
      return null;
  }
}

/**
 * Build the image result text: format, size, dimensions, and — for images
 * small enough — the data: URL for future machine consumption.
 */
export function buildImageSummary(opts: {
  filePath: string;
  sizeBytes: number;
  buf: Uint8Array;
}): string {
  const { filePath, sizeBytes, buf } = opts;
  const type = detectImageType(buf);
  const dims = parseImageDimensions(buf);

  const lines: string[] = [
    `Image file: ${filePath}`,
    `Format: ${type === null ? "unknown (not a recognized image)" : type.toUpperCase()}`,
    `Size: ${formatFileSize(sizeBytes)} (${sizeBytes} bytes)`,
  ];
  if (dims !== null) {
    lines.push(`Dimensions: ${dims.width} × ${dims.height} pixels`);
  } else {
    lines.push("Dimensions: unknown (header not parsed)");
  }

  if (type !== null && buf.length > 0 && buf.length <= MAX_IMAGE_DATA_URL_BYTES) {
    const base64 = Buffer.from(buf).toString("base64");
    lines.push(`Data URL: data:${imageMediaType(type)};base64,${base64}`);
  } else {
    const reason =
      type === null
        ? "unrecognized format"
        : `file is ${formatFileSize(sizeBytes)} (over the ${formatFileSize(MAX_IMAGE_DATA_URL_BYTES)} inline limit)`;
    lines.push(
      `Data URL: omitted (${reason}) — the model cannot view images; ` +
        `use the size and dimensions above`,
    );
  }

  return lines.join("\n");
}
