/**
 * Shell mode's non-UI half. `!command` is the user's own shell line: it must
 * run with stderr kept separate from stdout, be killed as a process group on
 * Esc, and turn into the `<bash-input>`/`<bash-stdout>` text the model sees on
 * the next turn. The `!` itself is the prompt's mode, not part of the command.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBashResponsePrompt,
  formatShellContext,
  MAX_SHELL_OUTPUT_BYTES,
  runShellCommand,
  shouldRespondToBashCommand,
  stripAnsi,
} from "../../src/services/shellMode.js";

const cwd = mkdtempSync(join(tmpdir(), "dsc-shell-mode-"));

describe("stripAnsi", () => {
  test("drops SGR and OSC sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m plain")).toBe("red plain");
    expect(stripAnsi("\x1b]0;title\x07done")).toBe("done");
  });
});

describe("runShellCommand", () => {
  test("streams stdout and reports the exit code", async () => {
    const chunks: string[] = [];
    const result = await runShellCommand("printf 'hello\\n'", { cwd, onOutput: (c) => chunks.push(c) });
    expect(result.stdout).toBe("hello\n");
    expect(result.output).toBe("hello\n");
    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.truncated).toBe(false);
    // The live stream and the stored transcript agree byte for byte.
    expect(chunks.join("")).toBe(result.output);
  });

  test("keeps stderr separate and survives a non-zero exit", async () => {
    const result = await runShellCommand("printf 'out'; printf 'err' >&2; exit 3", { cwd });
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(3);
    // Display order is arrival order; both writes land in one stream record.
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  test("normalises CRLF and strips ANSI from the transcript", async () => {
    const result = await runShellCommand("printf '\\033[32mgreen\\033[0m\\r\\n'", { cwd });
    expect(result.output).toBe("green\n");
    expect(result.stdout).toBe("green\n");
  });

  test("caps the transcript and says it was truncated", async () => {
    const result = await runShellCommand(
      `awk 'BEGIN { for (i = 0; i < ${MAX_SHELL_OUTPUT_BYTES + 10}; i++) printf "x" }'`,
      { cwd },
    );
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBe(MAX_SHELL_OUTPUT_BYTES);
  });

  test("Esc kills the whole process group and settles as cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const run = runShellCommand("sleep 30", { cwd, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await run;
    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("formatShellContext", () => {
  test("wraps each stream in the reference's tags", () => {
    const text = formatShellContext("ls", {
      stdout: "a\nb\n",
      stderr: "",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    });
    expect(text).toBe("<bash-input>ls</bash-input>\n<bash-stdout>a\nb\n</bash-stdout>");
  });

  test("XML-escapes stderr and names a failed exit", () => {
    const text = formatShellContext("grep < x", {
      stdout: "",
      stderr: "a < b && c > d",
      exitCode: 2,
      cancelled: false,
      truncated: false,
    });
    expect(text).toContain("<bash-stderr>a &lt; b &amp;&amp; c &gt; d</bash-stderr>");
    expect(text).toContain("(exit 2)");
  });

  test("cancellation and truncation are stated, not implied", () => {
    const cancelled = formatShellContext("sleep 9", {
      stdout: "",
      stderr: "",
      exitCode: null,
      cancelled: true,
      truncated: false,
    });
    expect(cancelled).toContain("(command cancelled)");
    const truncated = formatShellContext("yes", {
      stdout: "x",
      stderr: "",
      exitCode: 0,
      cancelled: false,
      truncated: true,
    });
    expect(truncated).toContain("(output truncated at 50KB)");
  });
});

describe("buildBashResponsePrompt", () => {
  const ok = { stdout: "a\n", stderr: "", exitCode: 0, cancelled: false, truncated: false };

  test("carries the same bash context a later prompt would have", () => {
    const prompt = buildBashResponsePrompt("ls", ok);
    expect(prompt).toContain("<bash-input>ls</bash-input>");
    expect(prompt).toContain("<bash-stdout>a\n</bash-stdout>");
  });

  test("asks for a short explanation and discourages tool calls", () => {
    const prompt = buildBashResponsePrompt("ls", ok);
    expect(prompt).toContain("Briefly explain");
    // An automatic turn must not ambush the user with a permission dialog
    // when the output already says what they need.
    expect(prompt).toContain("Use tools only if the output alone cannot be explained");
  });

  test("a failed run carries its exit line", () => {
    const prompt = buildBashResponsePrompt("false", {
      ...ok,
      stdout: "",
      exitCode: 1,
    });
    expect(prompt).toContain("(exit 1)");
  });
});

describe("shouldRespondToBashCommand", () => {
  test("responds when enabled and the run finished", () => {
    expect(shouldRespondToBashCommand(true, { cancelled: false })).toBe(true);
  });

  test("the setting turns it off", () => {
    expect(shouldRespondToBashCommand(false, { cancelled: false })).toBe(false);
  });

  test("a cancelled run never earns a model turn", () => {
    expect(shouldRespondToBashCommand(true, { cancelled: true })).toBe(false);
  });
});

// Temp dir cleanup is best-effort; the assertions above already ran.
process.on("exit", () => {
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {}
});
