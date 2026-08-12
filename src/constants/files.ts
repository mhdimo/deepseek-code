// File-type constants and binary detection helpers.
//
// Used by tools (e.g. FileReadTool) to decide whether a file is safe to
// decode as UTF-8 text or should be reported as a binary blob instead of
// dumping garbage bytes into the model context.

// ─── Binary file extensions ──────────────────────────────────────────────────
//
// Extensions that are, by convention, binary. We match case-insensitively on
// the extension (without the leading dot). This is a heuristic — `hasBinaryContent`
// is the authoritative null-byte check; this set is a fast path / tie-breaker for
// known formats and for empty files (where a null-byte scan is inconclusive).

export const BINARY_EXTENSIONS = new Set<string>([
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "icns",
  "tiff",
  "tif",
  "webp",
  "heic",
  "heif",
  "avif",
  "psd",
  "tga",
  "raw",
  "cr2",
  "nef",
  "arw",
  // Audio
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "oga",
  "opus",
  "wma",
  "m4a",
  "aiff",
  "aif",
  "alac",
  "mid",
  "midi",
  // Video
  "mp4",
  "mov",
  "m4v",
  "mkv",
  "webm",
  "avi",
  "wmv",
  "flv",
  "mpeg",
  "mpg",
  "m2ts",
  "ts",
  "3gp",
  "vob",
  // Archives / compressed
  "zip",
  "gz",
  "tar",
  "tgz",
  "bz2",
  "xz",
  "lz",
  "lzma",
  "zst",
  "zstd",
  "7z",
  "rar",
  "iso",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "cab",
  "jar", // jars are zip containers
  "war",
  "ear",
  "whl",
  "egg",
  // Documents / rich formats
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "epub",
  "mobi",
  "azw",
  "azw3",
  // Executables / object code
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "obj",
  "a",
  "lib",
  "class",
  "wasm",
  "ko",
  "pyc",
  "pyo",
  "pyd",
  // Databases
  "db",
  "sqlite",
  "sqlite3",
  "db3",
  "mdb",
  "accdb",
  "frm",
  "ibd",
  // Disk / VM images
  "img",
  "vdi",
  "vmdk",
  "vhd",
  "qcow2",
  "vhdx",
  // Fonts
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  // Lock / cache blobs
  "lockb", // bun.lockb
  "bin",
  "dat",
]);

// ─── Binary detection ────────────────────────────────────────────────────────

/**
 * Heuristic: a file is considered binary if its buffer contains a NUL byte
 * within the first chunk we inspect.
 *
 * Text files essentially never contain NUL bytes; virtually all binary formats
 * do (often in the first few bytes). This is the same heuristic `git`, `grep -I`,
 * and most editors use. We scan a bounded prefix (8 KiB) for speed on huge files.
 *
 * @param buf  The raw file bytes (or a representative prefix of them).
 * @param scanLimit  Max number of leading bytes to scan. Defaults to 8192.
 * @returns `true` if a NUL byte is found, `false` otherwise.
 */
export function hasBinaryContent(buf: Uint8Array, scanLimit = 8192): boolean {
  const end = Math.min(buf.length, scanLimit);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Classify a file by its extension.
 * @returns the lowercase extension WITHOUT the leading dot (e.g. `"png"`), or
 *          `""` if there is no extension.
 */
export function getExtension(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * True if the file's extension is in the known-binary set.
 */
export function hasBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(getExtension(filePath));
}

/**
 * True if `normalizedPath` resolves under one of the dangerous pseudo-filesystem
 * trees (/dev, /proc, /sys). Reading these can hang, leak kernel state, or
 * return unbounded streams, so FileRead refuses them.
 *
 * `normalizedPath` should be an absolute, already-resolved path.
 */
export function isDeviceOrProcPath(normalizedPath: string): boolean {
  if (!normalizedPath.startsWith("/")) return false;
  // Match `/dev`, `/dev/foo`, `/proc`, `/proc/1`, `/sys`, `/sys/class`, etc.
  // but NOT paths that merely start with these as substrings (e.g. `/dev-team`).
  const segments = normalizedPath.split("/"); // ["", "dev", "foo", ...]
  const top = segments[1];
  return top === "dev" || top === "proc" || top === "sys";
}
