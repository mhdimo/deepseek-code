export const GREP_TOOL_NAME = "Grep";

export const DESCRIPTION = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with the \`glob\` parameter (e.g. "*.js", "**/*.tsx") or the \`type\` parameter (e.g. "js", "py", "rust", "go")
  - Output modes: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows only file paths (default), "count" shows per-file match counts
  - Pagination: use \`head_limit\` to cap results and \`offset\` to skip the first N entries, across all output modes. Defaults to head_limit=250; pass 0 for unlimited.
  - Context lines: with output_mode "content", use \`-B\`/\`-A\`/\`-C\`/\`context\` to show surrounding lines
  - Multiline matching: by default patterns match within single lines. For cross-line patterns like \`struct\\s*\\{[\\s\\S]*?field\`, use \`multiline: true\`
  - Case-insensitive search: use \`-i: true\`
  - Use Agent tool for open-ended searches requiring multiple rounds`;
