import { expect, test } from "bun:test";

import { buildAgentFanoutLines } from "../../src/components/AgentFanout.js";
import { getPillLabel } from "../../src/components/TasksStatusPill.js";
import { getTheme } from "../../src/utils/theme.js";
import type { ToolUseBlock } from "../../src/types/index.js";

const theme = getTheme("dark");

const agent = (partial: Partial<ToolUseBlock> & { toolCallId: string }): ToolUseBlock => ({
  toolName: "Agent",
  status: "running",
  argsJson: JSON.stringify({ subagent_type: "explore", description: "map" }),
  input: "map",
  output: "",
  ...partial,
});

const text = (l: { segments: { text: string }[] }): string =>
  l.segments.map((s) => s.text).join("");

test("fanout header reflects running state + ctrl+o hint", () => {
  const lines = buildAgentFanoutLines([agent({ toolCallId: "a", output: "⎿ Reading x\n" })], theme);
  expect(text(lines[0]!)).toContain("Running 1 explore agents…");
  expect(text(lines[0]!)).toContain("(ctrl+o to expand)");
});

test("fanout groups same-type agents in the header", () => {
  const lines = buildAgentFanoutLines([
    agent({ toolCallId: "a", output: "⎿ Reading x\n" }),
    agent({ toolCallId: "b", output: "⎿ Writing y\n" }),
  ], theme);
  expect(text(lines[0]!)).toContain("Running 2 explore agents…");
});

test("fanout finished header + hideType for same-type runs", () => {
  const lines = buildAgentFanoutLines([
    agent({ toolCallId: "a", status: "done", output: "Done (3 tool uses · 4,200 tokens · 10s)\n" }),
  ], theme);
  expect(text(lines[0]!)).toContain("1 explore agents finished");
  // hideType: description stands in for the type chip
  expect(text(lines[1]!)).toContain("map");
  expect(text(lines[1]!)).not.toContain("(map)");
  // status line says Done
  expect(text(lines[2]!)).toContain("Done");
});

test("fanout shows live tool-use count and parsed tokens", () => {
  const lines = buildAgentFanoutLines([agent({ toolCallId: "a", output: "⎿ Reading x\n⎿ Searching y\n" })], theme);
  expect(text(lines[1]!)).toContain("· 2 tool uses");
  const done = buildAgentFanoutLines([
    agent({ toolCallId: "b", status: "done", output: "Done (3 tool uses · 4,200 tokens · 10s)\n" }),
  ], theme);
  expect(text(done[1]!)).toContain("· 3 tool uses");
  expect(text(done[1]!)).toContain("· 4.2k tokens");
});

test("fanout marks backgrounded agents and skips their stats tail", () => {
  const lines = buildAgentFanoutLines([
    agent({ toolCallId: "a", status: "done", output: "Background agent launched (task b1).\n" }),
  ], theme);
  expect(text(lines[0]!)).toContain("1 background agent launched");
  expect(text(lines[1]!)).not.toContain("tool uses");
  expect(text(lines[2]!)).toContain("Running in the background");
});

test("fanout status falls back to Initializing… for idle running agents", () => {
  const lines = buildAgentFanoutLines([agent({ toolCallId: "a", output: "" })], theme);
  expect(text(lines[2]!)).toContain("Initializing…");
});

test("fanout error agents show failed status", () => {
  const lines = buildAgentFanoutLines([
    agent({ toolCallId: "a", status: "error", output: "✗ boom" }),
  ], theme);
  expect(text(lines[1]!)).toContain("· failed");
});

test("pill label aggregates by type (reference pillLabel parity)", () => {
  const t = (type: "shell" | "agent" | "workflow", id: string) => ({
    type, id, command: "x", outputPath: "", pid: 1, startedAt: 0, status: "running" as const,
  });
  expect(getPillLabel([t("shell", "s1")])).toBe("1 shell");
  expect(getPillLabel([t("shell", "s1"), t("shell", "s2")])).toBe("2 shells");
  expect(getPillLabel([t("agent", "a1")])).toBe("1 local agent");
  expect(getPillLabel([t("agent", "a1"), t("agent", "a2")])).toBe("2 local agents");
  expect(getPillLabel([t("workflow", "w1")])).toBe("1 background workflow");
  expect(getPillLabel([t("workflow", "w1"), t("workflow", "w2")])).toBe("2 background workflows");
  expect(getPillLabel([t("shell", "s1"), t("agent", "a1")])).toBe("2 background tasks");
});
