export const SLEEP_TOOL_NAME = "Sleep";

export const DESCRIPTION = `Wait for a specified duration (in milliseconds), then resume. Useful when polling for a condition to become true, or when the model has nothing else to do for a short while.

Usage:
- The \`duration_ms\` parameter is the number of milliseconds to sleep. Values are clamped to the range 0–600000 (10 minutes).
- The sleep can be interrupted early if the user cancels the run.

Prefer this tool over \`Bash(sleep N)\` — it does not hold a shell process, is read-only, and is safe to run concurrently with other tools (it will not interfere with them).

When polling, call this tool between checks rather than busy-waiting, so the TUI stays responsive.
`;
