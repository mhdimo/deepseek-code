import { describe, expect, test } from "bun:test";
import { buildStatusLineCommandInput, parseAnsi } from "./statusline.js";

describe("parseAnsi", () => {
  test("passes plain text through", () => {
    expect(parseAnsi("hello world")).toEqual([{ text: "hello world" }]);
  });

  test("maps basic fg colors", () => {
    expect(parseAnsi("\x1b[31mred\x1b[0mplain")).toEqual([
      { text: "red", color: "red" },
      { text: "plain" },
    ]);
  });

  test("maps bright fg colors", () => {
    expect(parseAnsi("\x1b[91mbright\x1b[39m")).toEqual([
      { text: "bright", color: "redBright" },
    ]);
  });

  test("maps bg colors", () => {
    expect(parseAnsi("\x1b[44mon-blue\x1b[49m")).toEqual([
      { text: "on-blue", backgroundColor: "blue" },
    ]);
  });

  test("maps styles", () => {
    expect(parseAnsi("\x1b[1mbold\x1b[22m\x1b[2mdim\x1b[22m\x1b[4munder\x1b[24m")).toEqual([
      { text: "bold", bold: true },
      { text: "dim", dim: true },
      { text: "under", underline: true },
    ]);
  });

  test("composes color + style in one SGR", () => {
    expect(parseAnsi("\x1b[1;32mbold green\x1b[0m")).toEqual([
      { text: "bold green", color: "green", bold: true },
    ]);
  });

  test("reset clears everything", () => {
    expect(parseAnsi("\x1b[31mred\x1b[0;1mbold-only\x1b[0m")).toEqual([
      { text: "red", color: "red" },
      { text: "bold-only", bold: true },
    ]);
  });

  test("strips unsupported 256-color and truecolor params", () => {
    expect(parseAnsi("\x1b[38;5;123mtext\x1b[0m")).toEqual([{ text: "text" }]);
    expect(parseAnsi("\x1b[38;2;10;20;30mtext\x1b[0m")).toEqual([{ text: "text" }]);
  });

  test("strips cursor-movement and erase sequences", () => {
    // \x1bB is a two-byte escape: the ESC is dropped, the char survives
    expect(parseAnsi("a\x1b[1;1H\x1b[2Kb\x1b[3Ac\x1bBd")).toEqual([{ text: "abcBd" }]);
  });

  test("strips OSC sequences (e.g. title)", () => {
    expect(parseAnsi("\x1b]0;my title\x07visible")).toEqual([{ text: "visible" }]);
    expect(parseAnsi("\x1b]0;my title\x1b\\visible")).toEqual([{ text: "visible" }]);
  });

  test("strips lone and unterminated escapes", () => {
    expect(parseAnsi("\x1btext")).toEqual([{ text: "text" }]);
    // a complete SGR escape still applies even at end of input
    expect(parseAnsi("\x1b[31mnever-ending")).toEqual([{ text: "never-ending", color: "red" }]);
    // a truncated CSI remainder is dropped entirely
    expect(parseAnsi("a\x1b[3")).toEqual([{ text: "a" }]);
  });

  test("empty input yields no segments", () => {
    expect(parseAnsi("")).toEqual([]);
    expect(parseAnsi("\x1b[0m")).toEqual([]);
  });
});

describe("buildStatusLineCommandInput", () => {
  const base = {
    model: "deepseek-chat",
    currentDir: "/work",
  };

  test("includes contract fields with sane defaults", () => {
    const input = buildStatusLineCommandInput(base);
    expect(input).toEqual({
      model: { id: "deepseek-chat", display_name: "deepseek-chat" },
      workspace: { current_dir: "/work", project_dir: "/work", added_dirs: [] },
      version: "0.1.0",
      output_style: { name: "default" },
      cost: {
        total_cost_usd: 0,
        total_duration_ms: 0,
        total_api_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 1_000_000,
        current_usage: 0,
        used_percentage: 0,
        remaining_percentage: 100,
      },
      exceeds_200k_tokens: false,
    });
  });

  test("omits optional keys when sources are absent", () => {
    const input = buildStatusLineCommandInput(base);
    expect(input.vim).toBeUndefined();
    expect(input.agent).toBeUndefined();
    expect(input.permission_mode).toBeUndefined();
    expect(input.session_name).toBeUndefined();
  });

  test("carries optional values through", () => {
    const input = buildStatusLineCommandInput({
      ...base,
      model: "deepseek-reasoner",
      displayName: "reasoner",
      projectDir: "/project",
      addedDirs: ["/a"],
      version: "9.9.9",
      outputStyleName: "compact",
      costUsd: 1.5,
      inputTokens: 150_000,
      outputTokens: 100_000,
      contextWindowSize: 200_000,
      agentName: "plan",
      permissionMode: "plan",
      vimMode: "INSERT",
      sessionName: "fix tests",
    });
    expect(input.model).toEqual({ id: "deepseek-reasoner", display_name: "reasoner" });
    expect(input.workspace).toEqual({ current_dir: "/work", project_dir: "/project", added_dirs: ["/a"] });
    expect(input.version).toBe("9.9.9");
    expect(input.output_style.name).toBe("compact");
    expect(input.cost.total_cost_usd).toBe(1.5);
    expect(input.context_window.total_input_tokens).toBe(150_000);
    expect(input.context_window.total_output_tokens).toBe(100_000);
    expect(input.exceeds_200k_tokens).toBe(true);
    expect(input.agent).toEqual({ name: "plan" });
    expect(input.permission_mode).toBe("plan");
    expect(input.vim).toEqual({ mode: "INSERT" });
    expect(input.session_name).toBe("fix tests");
  });

  test("derives usage percentages and 200k flag", () => {
    const input = buildStatusLineCommandInput({
      ...base,
      inputTokens: 150_000,
      outputTokens: 100_000,
      contextWindowSize: 1_000_000,
    });
    expect(input.context_window.current_usage).toBe(250_000);
    expect(input.context_window.used_percentage).toBe(25);
    expect(input.context_window.remaining_percentage).toBe(75);
    expect(input.exceeds_200k_tokens).toBe(true);
  });

  test("respects explicit currentUsage and usedPercentage", () => {
    const input = buildStatusLineCommandInput({
      ...base,
      currentUsage: 500_000,
      contextWindowSize: 1_000_000,
      usedPercentage: 50,
    });
    expect(input.context_window.current_usage).toBe(500_000);
    expect(input.context_window.used_percentage).toBe(50);
    expect(input.context_window.remaining_percentage).toBe(50);
  });
});
