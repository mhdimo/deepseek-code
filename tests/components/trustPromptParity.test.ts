/**
 * The workspace trust dialog: its title, its options and the frame it is drawn
 * in. The reference renders it through PermissionDialog — "Accessing
 * workspace:" over a rounded top rule that has no sides or bottom, with the
 * standard two-hint footer — and none of that was what our copy showed.
 */
import { expect, test } from "bun:test";
import React from "react";

const { renderToString } = await import("ink");
const { default: TrustPrompt } = await import("../../src/components/TrustPrompt");

function frame(): string {
  return renderToString(
    React.createElement(TrustPrompt, {
      directory: "/tmp/proj",
      configFile: ".deepseek-code.json",
      onDecide: () => {},
    }),
  );
}

test("titles the dialog the way the reference does", () => {
  const out = frame();
  expect(out).toContain("Accessing workspace:");
  expect(out).not.toContain("Trust this workspace?");
});

test("offers the reference's accept label", () => {
  expect(frame()).toContain("Yes, I trust this folder");
});

test("ends on the standard confirm footer", () => {
  const out = frame();
  expect(out).toContain("Enter to confirm · Esc to cancel");
  // The navigation and persistence notes were extra lines the reference does
  // not have under the options.
  expect(out).not.toContain("trusted-dirs.json");
  expect(out).not.toContain("↑/↓ to move");
});

test("draws a top rule and nothing else", () => {
  const out = frame();
  // PermissionDialog: borderStyle round with the left, right and bottom
  // borders switched off. Ink drops the corner glyphs with their sides, so the
  // rule is flat — and there is no box closing under the options any more.
  const lines = out.split("\n");
  const rule = lines.find((line) => line.trim().length > 0) ?? "";
  expect(rule.trim()).toMatch(/^─+$/);
  expect(out).not.toContain("╭");
  expect(out).not.toContain("╮");
  expect(out).not.toContain("╰");
  expect(out).not.toContain("╯");
  expect(out).not.toContain("│");
});
