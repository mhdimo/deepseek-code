/**
 * What the MCP view puts on screen.
 *
 * The list is a port of Claude Code's MCPListPanel, and every row was
 * divergent: a numbered "1. ● filesystem" line whose second row was the
 * command, scope headers written as "▪ project — …" instead of a bold label
 * with a dim "(path)", a footer of "enter details · esc close", and a detail
 * header that showed the raw server id. The pure helpers next to the view
 * (config persistence) were already covered; what is asserted here is the
 * frame the user reads.
 *
 * Rows are asserted through server names invented here, so the view's output
 * does not depend on whatever servers are configured on this machine.
 */
import { expect, test } from "bun:test";
import React from "react";
import { join } from "path";
import { renderToString } from "ink";
import McpView, { McpServerDetail, scopeHeading } from "../../src/components/McpView";

function renderList(servers: Record<string, { command: string; args?: string[]; enabled?: boolean }>): string {
  return renderToString(
    React.createElement(McpView, {
      servers,
      onToggle: () => {},
      onReconnect: () => {},
      onClose: () => {},
    }),
  );
}

const FIXTURE = {
  "zz-alpha-server": { command: "npx", args: ["-y", "@example/alpha"] },
  "zz-beta-server": { command: "npx", args: ["-y", "@example/beta"], enabled: false },
};

test("the pane is 'Manage MCP servers' and counts them", () => {
  const frame = renderList(FIXTURE);
  expect(frame).toContain("Manage MCP servers");
  expect(frame).not.toContain("  MCP servers\n");
  // "2 servers" — a total, not an enabled/total ratio.
  expect(frame).toMatch(/\n\s*\d+ servers?\n/);
  expect(frame).not.toMatch(/\d+ of \d+ enabled/);
});

test("scope headings are a bold label with a dim path, indented two columns", () => {
  const frame = renderList(FIXTURE);
  expect(frame).toContain("Dynamic MCPs (not in a config file)");
  // The old heading was a single bullet-prefixed line.
  expect(frame).not.toContain("▪");
  // Two columns in from the pane, with the rows flush against its edge.
  expect(frame).toMatch(/^ {4}Dynamic MCPs \(not in a config file\)$/m);
  expect(frame).toMatch(/^ {2}❯ zz-alpha-server$/m);
});

test("rows are a pointer and a name: no index digits, no enablement dot, no command blurb", () => {
  const frame = renderList(FIXTURE);
  expect(frame).toMatch(/^ {2}❯ zz-alpha-server$/m);
  expect(frame).toMatch(/^ {4}zz-beta-server · ○ disabled$/m);
  // Select's number hints ("1. ") are gone with the Select.
  expect(frame).not.toMatch(/^\s*\d+\. /m);
  expect(frame).not.toMatch(/[●○] zz-alpha-server/);
  expect(frame).not.toContain("npx -y @example/alpha");
});

test("the input guide sits below the pane", () => {
  const frame = renderList(FIXTURE);
  expect(frame).toContain("↑↓ to navigate · Enter to confirm · Esc to cancel");
  expect(frame).not.toContain("enter details");
});

test("scopeHeading names each config source and its path", () => {
  expect(scopeHeading(null)).toEqual({ label: "Dynamic MCPs", path: "not in a config file" });
  const project = scopeHeading(join(process.cwd(), ".deepseek-code.json"));
  expect(project.label).toBe("Project MCPs");
  expect(project.path).toBe(".deepseek-code.json");
  const legacy = scopeHeading(join(process.cwd(), ".zcode.json"));
  expect(legacy.label).toBe("Legacy MCPs");
});

test("the detail pane names the server and labels the config row", () => {
  const frame = renderToString(
    React.createElement(McpServerDetail, {
      name: "my filesystem",
      server: { command: "npx", args: ["-y", "@example/fs"] },
      configScope: "project — .deepseek-code.json",
      reconnecting: false,
      notice: null,
      onReconnect: () => {},
      onBack: () => {},
    }),
  );
  expect(frame).toContain("My filesystem MCP Server");
  expect(frame).toContain("Config location: ");
  expect(frame).not.toMatch(/Config: /);
  expect(frame).toContain("Command: ");
  expect(frame).toContain("↑↓ to navigate · Enter to select · Esc to back");
});
