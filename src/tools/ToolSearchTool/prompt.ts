export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

export const DESCRIPTION = `Search and discover available tools by keyword.

Use this tool when you are unsure which tool to use, when many tools are loaded (including MCP toolsets), or when you need to find a tool by name or capability. Provide keywords describing what you want to do (e.g. "read file", "git", "notebook", "create task"), and it returns the matching tool names with their descriptions so you can decide which to invoke.

Query forms:
- "read file" — keyword search, returns up to max_results best matches
- "select:Read,Edit,Grep" — fetch these exact tools by name (comma-separated)
- "+git commit" — require "git" to appear in the name or description, then rank by the remaining terms

The returned list is a summary (name + description). To actually invoke a tool, call it directly by name as you normally would.`;
