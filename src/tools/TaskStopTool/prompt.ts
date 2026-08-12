export const TASK_STOP_TOOL_NAME = "TaskStop";

export const DESCRIPTION = `Stop a background shell task that is still running.

Use this to terminate a command that was started in the background with Bash(run_in_background: true) and is no longer needed, or is misbehaving.

# When to use
- When a background task is running too long, producing too much output, or is no longer needed.
- The user explicitly asks to stop / kill a background command.

# Parameters
- task_id (required): The background task id returned by Bash(run_in_background: true).

# Behavior
- Sends SIGTERM to the task's process group, escalating to SIGKILL after a 2-second grace period.
- If the task is already finished or unknown, reports that without error.
- Returns a status message describing the result.`;
