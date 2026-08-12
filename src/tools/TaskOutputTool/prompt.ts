export const TASK_OUTPUT_TOOL_NAME = "TaskOutput";

export const DESCRIPTION = `Read the latest output from a background shell task.

Use this to check on a command that was started in the background with Bash(run_in_background: true). Returns the task's status and the tail of its captured stdout/stderr log.

# When to use
- After starting a long-running command with run_in_background: true, to check whether it has finished and read its output.
- When you receive a notification that a background task completed or failed.
- You can also use the Read tool on the output file path returned when the task was started; this tool is the convenient alternative.

# Parameters
- task_id (required): The background task id returned by Bash(run_in_background: true).
- tail_bytes (optional, default 50000): Maximum number of trailing bytes to return. The output is tailed so you always get the most recent lines.

# Behavior
- Returns the task status (running / done / error), exit code (if finished), and the tail of the output log.
- If the task is still running, the output so far is returned along with status "running".
- For a finished task the full exit code is included.`;
