export const FILE_READ_TOOL_NAME = "Read";

/** Default number of lines read in a whole-file read. */
export const MAX_LINES_TO_READ = 2000;

/**
 * Describes EXACTLY what FileReadTool implements. Keep this honest: anything
 * listed here must have a code path in FileReadTool.ts and its helpers.
 */
export const DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid.
It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- Files larger than 256 KB (the default size cap) return an error when read in full; use the offset and limit parameters to read specific portions of larger files
- You can optionally specify a line offset and limit (especially handy for large files), but it's recommended to read the whole file by not providing these parameters
- Results are returned in cat -n format, with line numbers starting at 1
- Lines longer than 2000 characters are truncated, with a marker showing how many characters were omitted
- Content that would exceed the token budget is truncated with a marker that tells you the line offset to continue from; read the remainder by calling this tool again with offset=<next line>
- Binary files (audio, video, archives, executables, fonts, databases, etc.) are detected automatically and returned as a short summary (size and type) instead of their contents
- PDF files (.pdf) are supported: the tool extracts the embedded text with a lightweight best-effort extractor. Images, tables, charts, and original formatting are NOT preserved, scanned (image-only) PDFs yield no text, and multi-column layouts may reorder text. Large PDFs are read up to the token budget, and very large PDFs (>64 MB) return an error
- Jupyter notebooks (.ipynb) are supported: the tool returns all code and markdown cells with their text outputs. Image outputs are noted but not shown
- Image files (PNG, JPEG, GIF, WebP) are NOT displayed: the model cannot view images, so the tool returns a summary with the image format, size, and pixel dimensions instead of the image content
- Device and pseudo-filesystem paths under /dev, /proc, and /sys are blocked and return an error
- This tool can only read files, not directories. To read a directory, use the LS tool
- If you read a file that exists but has empty contents, the result is "(empty file)"
- You can call multiple tools in a single response. When multiple independent pieces are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance.`;
