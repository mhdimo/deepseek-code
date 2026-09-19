/**
 * The startup box's metadata block. The reference stacks two dim lines under
 * the logo — the model line, then the working directory — and our version
 * joined them into one, so the box was a row shorter and the path sat beside
 * the model instead of under it.
 */
import { expect, test } from "bun:test";
import React from "react";

const { renderToString } = await import("ink");
const { default: WelcomeScreen } = await import("../../src/components/WelcomeScreen");

function frame(workingDirectory: string): string[] {
  return renderToString(
    React.createElement(WelcomeScreen, {
      version: "9.9.9",
      model: "deepseek-chat",
      workingDirectory,
      agentName: "code",
      providerType: "deepseek",
    }),
  ).split("\n");
}

test("stacks the model and the working directory on their own lines", () => {
  const lines = frame("/tmp/proj");
  const modelLine = lines.find((line) => line.includes("deepseek-chat"));
  const cwdLine = lines.find((line) => line.includes("~/proj"));
  expect(modelLine).toBeDefined();
  expect(cwdLine).toBeDefined();
  expect(cwdLine).not.toBe(modelLine);
  // One dim line per value: the model line carries no path and the path line
  // carries no model.
  expect(modelLine).not.toContain("~/proj");
  expect(cwdLine).not.toContain("deepseek-chat");
});

test("keeps the two lines adjacent, in the reference's order", () => {
  const lines = frame("/tmp/proj");
  const modelLine = lines.findIndex((line) => line.includes("deepseek-chat"));
  const cwdLine = lines.findIndex((line) => line.includes("~/proj"));
  expect(cwdLine).toBe(modelLine + 1);
});

test("still shows the home-relative path, on its own line", () => {
  const lines = frame("/Users/liang/deepseek-code");
  const cwdLine = lines.find((line) => line.includes("~/deepseek-code"));
  expect(cwdLine).toBeDefined();
  expect(cwdLine).not.toContain("deepseek-chat");
});
