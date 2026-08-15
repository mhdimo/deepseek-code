import { describe, expect, test } from "bun:test";
import {
  HOOK_EVENTS,
  countHooks,
  eventSupportsMatcher,
  getHookDisplayText,
  getHookFieldLabel,
  getHookTypeLabel,
  type HookConfig,
  type HooksConfig,
} from "./hooks.js";

describe("eventSupportsMatcher", () => {
  test("evaluated only for tool events", () => {
    expect(eventSupportsMatcher("PreToolUse")).toBe(true);
    expect(eventSupportsMatcher("PostToolUse")).toBe(true);
    expect(eventSupportsMatcher("UserPromptSubmit")).toBe(false);
    expect(eventSupportsMatcher("Stop")).toBe(false);
    expect(eventSupportsMatcher("Notification")).toBe(false);
  });
});

describe("getHookTypeLabel", () => {
  test("returns known types as-is", () => {
    expect(getHookTypeLabel({ type: "command", command: "x" })).toBe("command");
    expect(getHookTypeLabel({ type: "http", url: "x" })).toBe("http");
  });
  test("falls back for empty or missing type — never undefined", () => {
    expect(getHookTypeLabel({ type: "" })).toBe("unknown");
    expect(getHookTypeLabel({ type: undefined } as unknown as HookConfig)).toBe("unknown");
  });
});

describe("getHookDisplayText", () => {
  test("uses the content field for each known type", () => {
    expect(getHookDisplayText({ type: "command", command: "echo hi" })).toBe("echo hi");
    expect(getHookDisplayText({ type: "prompt", prompt: "review this" })).toBe("review this");
    expect(getHookDisplayText({ type: "http", url: "https://x.dev/hook" })).toBe("https://x.dev/hook");
  });
  test("falls back when the content field is missing — never undefined", () => {
    expect(getHookDisplayText({ type: "command" })).toBe("(no command)");
    expect(getHookDisplayText({ type: "prompt" })).toBe("(no prompt)");
    expect(getHookDisplayText({ type: "http" })).toBe("(no url)");
  });
  test("unknown types render their type label, not undefined", () => {
    expect(getHookDisplayText({ type: "agent", prompt: "x" })).toBe("agent");
    expect(getHookDisplayText({ type: undefined } as unknown as HookConfig)).toBe("unknown");
  });
});

describe("getHookFieldLabel", () => {
  test("maps each type to its primary field label", () => {
    expect(getHookFieldLabel({ type: "command", command: "x" })).toBe("Command");
    expect(getHookFieldLabel({ type: "prompt", prompt: "x" })).toBe("Prompt");
    expect(getHookFieldLabel({ type: "http", url: "x" })).toBe("URL");
    expect(getHookFieldLabel({ type: "agent" })).toBe("Content");
  });
});

describe("countHooks", () => {
  test("empty config counts zero with stable event keys", () => {
    expect(countHooks({})).toEqual({
      perEvent: {
        PreToolUse: 0,
        PostToolUse: 0,
        UserPromptSubmit: 0,
        Stop: 0,
        Notification: 0,
      },
      total: 0,
    });
  });
  test("counts per event and in total", () => {
    const config: HooksConfig = {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] },
        { matcher: "Bash", hooks: [{ type: "http", url: "x" }] },
      ],
      Stop: [{ matcher: "*", hooks: [{ type: "prompt", prompt: "p" }] }],
    };
    const { perEvent, total } = countHooks(config);
    expect(perEvent["PreToolUse"]).toBe(3);
    expect(perEvent["Stop"]).toBe(1);
    expect(perEvent["Notification"]).toBe(0);
    expect(total).toBe(4);
  });
  test("disabled groups still count as configured", () => {
    const config: HooksConfig = {
      PostToolUse: [{ matcher: "*", enabled: false, hooks: [{ type: "command", command: "a" }] }],
    };
    expect(countHooks(config).total).toBe(1);
  });
  test("groups without hooks count zero", () => {
    const config: HooksConfig = { PreToolUse: [{ matcher: "Bash" }] };
    expect(countHooks(config).total).toBe(0);
  });
});

describe("HOOK_EVENTS", () => {
  test("lists every supported event in canonical order", () => {
    expect(HOOK_EVENTS).toEqual([
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
      "Notification",
    ]);
  });
});
