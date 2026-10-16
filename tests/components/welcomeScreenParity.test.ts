/**
 * The empty-state header: the whale beside the reference's three dim lines
 * (LogoV2/CondensedLogo.tsx) — product and version, model and where it posts,
 * agent and working directory — with no box, no READY chip and no quick-start
 * or feature list.
 */
import { expect, test } from "bun:test";
import React from "react";

const { renderToString } = await import("ink");
const { default: WelcomeScreen } = await import("../../src/components/WelcomeScreen");

function frame(workingDirectory: string, props: Record<string, unknown> = {}): string[] {
  return renderToString(
    React.createElement(WelcomeScreen, {
      version: "9.9.9",
      model: "deepseek-flash",
      workingDirectory,
      agentName: "code",
      ...props,
    }),
  ).split("\n");
}

test("stacks the model and the working directory on their own lines", () => {
  const lines = frame("/tmp/proj");
  const modelLine = lines.find((line) => line.includes("deepseek-flash"));
  const cwdLine = lines.find((line) => line.includes("~/proj"));
  expect(modelLine).toBeDefined();
  expect(cwdLine).toBeDefined();
  expect(cwdLine).not.toBe(modelLine);
  // One dim line per value: the model line carries no path and the path line
  // carries no model.
  expect(modelLine).not.toContain("~/proj");
  expect(cwdLine).not.toContain("deepseek-flash");
});

test("keeps the two lines adjacent, in the reference's order", () => {
  const lines = frame("/tmp/proj");
  const modelLine = lines.findIndex((line) => line.includes("deepseek-flash"));
  const cwdLine = lines.findIndex((line) => line.includes("~/proj"));
  expect(cwdLine).toBe(modelLine + 1);
});

test("still shows the home-relative path, on its own line", () => {
  const lines = frame("/Users/liang/deepseek-code");
  const cwdLine = lines.find((line) => line.includes("~/deepseek-code"));
  expect(cwdLine).toBeDefined();
  expect(cwdLine).not.toContain("deepseek-flash");
});

test("hangs the version off the product name, on the first header line", () => {
  const lines = frame("/tmp/proj");
  const header = lines.findIndex((line) => line.includes("DeepSeek Code"));
  expect(header).toBeGreaterThanOrEqual(0);
  expect(lines[header]).toContain("DeepSeek Code v9.9.9");
  // Above the model and the path: the reference's order, top to bottom.
  expect(lines.findIndex((line) => line.includes("deepseek-flash"))).toBe(header + 1);
});

test("the agent rides the cwd line behind an @, as in the reference", () => {
  const cwdLine = frame("/tmp/proj").find((line) => line.includes("~/proj"))!;
  expect(cwdLine).toContain("@code · ~/proj");
});

test("the model line names the endpoint it posts to", () => {
  // Default provider host when no baseURL is configured.
  const line = frame("/tmp/proj").find((l) => l.includes("deepseek-flash"))!;
  expect(line).toContain("deepseek-flash · api.deepseek.com");
  // A configured endpoint shows its host, not the scheme or path.
  const custom = frame("/tmp/proj", { baseURL: "https://proxy.internal:8443/v1" }).find((l) =>
    l.includes("deepseek-flash"),
  )!;
  expect(custom).toContain("deepseek-flash · proxy.internal:8443");
});

test("draws the mascot beside the text, not above it", () => {
  const lines = frame("/tmp/proj");
  // The whale is taller than the three header lines, so those lines sit
  // centered against it and each one shares its terminal row with sprite
  // glyphs — mascot and text side by side, as in the reference's row.
  const headerRows = ["DeepSeek Code v9.9.9", "deepseek-flash", "~/proj"].map((needle) =>
    lines.findIndex((line) => line.includes(needle)),
  );
  expect(headerRows).not.toContain(-1);
  for (const row of headerRows) expect(lines[row]).toMatch(/[█▀▄]/);
  // The sprite starts above the text and runs past it: 11 rows of whale
  // against 3 rows of header.
  expect(Math.min(...headerRows)).toBeGreaterThan(0);
  expect(lines.length).toBeGreaterThan(Math.max(...headerRows) + 1);
});

test("is the mascot beside three header lines and nothing else", () => {
  const lines = frame("/tmp/proj");
  const out = lines.join("\n");
  // No box (the reference is a bare row), and none of the boxed welcome's
  // blocks survive the port.
  expect(out).not.toContain("╭");
  expect(out).not.toContain("╰");
  expect(out).not.toContain("Quick start");
  expect(out).not.toContain("Features");
  expect(out).not.toContain("READY");
  // Every non-empty row is a row of the whale, so there is no chrome above
  // or below it, and the header is exactly its three lines.
  for (const line of lines.filter((l) => l.trim().length > 0)) {
    expect(line).toMatch(/[█▀▄]/);
  }
  expect(lines.filter((l) => /(DeepSeek Code|deepseek-flash|~\/proj)/.test(l)).length).toBe(3);
});

test("warns about a missing key on one dim line, and only then", () => {
  expect(frame("/tmp/proj").join("\n")).not.toContain("No API key");
  const keyless = frame("/tmp/proj", { hasApiKey: false });
  const line = keyless.find((l) => l.includes("No API key"))!;
  expect(line).toContain("platform.deepseek.com/api_keys");
  // Below the mascot rather than beside it, and one extra line — not the
  // banner + link pair the boxed welcome drew.
  expect(line).not.toMatch(/[█▀▄]/);
  expect(keyless.filter((l) => l.trim().length > 0).length).toBe(
    frame("/tmp/proj").filter((l) => l.trim().length > 0).length + 1,
  );
});
