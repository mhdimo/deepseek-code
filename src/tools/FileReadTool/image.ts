













import { formatFileSize } from "../../utils/limits.js";


export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);


export const MAX_IMAGE_DATA_URL_BYTES = 32 * 1024;

export type ImageType = "png" | "jpeg" | "gif" | "webp";

export interface ImageDimensions {
  width: number;
  height: number;
}

function u8(buf: Uint8Array, i: number): number {
  return buf[i] ?? 0;
}


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


export function parseImageDimensions(buf: Uint8Array): ImageDimensions | null {
  const type = detectImageType(buf);
  switch (type) {
    case "png": {
      
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


function parseJPEGDimensions(buf: Uint8Array): ImageDimensions | null {
  let i = 2; 
  while (i + 9 < buf.length) {
    if (u8(buf, i) !== 0xff) {
      i++;
      continue;
    }
    const marker = u8(buf, i + 1);
    
    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) break; 
    const segLen = (u8(buf, i + 2) << 8) | u8(buf, i + 3);
    if (segLen < 2) break; 
    
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
  
  switch (chunkType) {
    case "VP8X": {
      
      if (buf.length < 30) return null;
      return {
        width: u24LE(buf, 24) + 1,
        height: u24LE(buf, 27) + 1,
      };
    }
    case "VP8 ": {
      
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
