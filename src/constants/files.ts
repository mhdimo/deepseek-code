












export const BINARY_EXTENSIONS = new Set<string>([
  
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
  "jar", 
  "war",
  "ear",
  "whl",
  "egg",
  
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
  
  "db",
  "sqlite",
  "sqlite3",
  "db3",
  "mdb",
  "accdb",
  "frm",
  "ibd",
  
  "img",
  "vdi",
  "vmdk",
  "vhd",
  "qcow2",
  "vhdx",
  
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  
  "lockb", 
  "bin",
  "dat",
]);




export function hasBinaryContent(buf: Uint8Array, scanLimit = 8192): boolean {
  const end = Math.min(buf.length, scanLimit);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}


export function getExtension(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}


export function hasBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(getExtension(filePath));
}


export function isDeviceOrProcPath(normalizedPath: string): boolean {
  if (!normalizedPath.startsWith("/")) return false;
  
  
  const segments = normalizedPath.split("/"); 
  const top = segments[1];
  return top === "dev" || top === "proc" || top === "sys";
}
