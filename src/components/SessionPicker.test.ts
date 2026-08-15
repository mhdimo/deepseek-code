import { describe, expect, test } from "bun:test";
import {
  deriveSessionTitle,
  formatRelativeTimeAgo,
  shortenHomePath,
  stripDisplayTags,
  truncateText,
} from "./SessionPicker.js";
import type { SessionData } from "../state/storage.js";

function session(overrides: Partial<SessionData> = {}): SessionData {
  return {
    hash: "h1",
    messages: [],
    tokenUsage: 0,
    model: "deepseek-chat",
    agent: "code",
    workingDirectory: "/tmp/proj",
    createdAt: 1_000_000_000_000,
    updatedAt: 1_000_000_000_000,
    ...overrides,
  };
}

describe("stripDisplayTags", () => {
  test("strips lowercase XML-like tag blocks", () => {
    expect(stripDisplayTags("<command-name>/status</command-name> done")).toBe("done");
    expect(stripDisplayTags("<local-command-stdout>output</local-command-stdout>")).toBe(
      "<local-command-stdout>output</local-command-stdout>",
    );
  });
  test("returns the original text when everything was tags", () => {
    expect(stripDisplayTags("<command-name>x</command-name>")).toBe("<command-name>x</command-name>");
  });
  test("leaves user prose mentioning JSX/HTML alone", () => {
    expect(stripDisplayTags("fix the <Button> layout")).toBe("fix the <Button> layout");
  });
});

describe("deriveSessionTitle", () => {
  test("uses the user-assigned title first", () => {
    expect(
      deriveSessionTitle(session({ title: "My title", messages: [{ role: "user", content: "hello" }] })),
    ).toBe("My title");
  });
  test("derives from the first user message", () => {
    expect(deriveSessionTitle(session({ messages: [{ role: "user", content: "fix the tests" }] }))).toBe(
      "fix the tests",
    );
  });
  test("strips display tags and collapses whitespace", () => {
    const s = session({
      messages: [{ role: "user", content: "<command-name>/status</command-name>\n\n  check   the   output  " }],
    });
    expect(deriveSessionTitle(s)).toBe("check the output");
  });
  test("skips empty/system messages and falls back to the agent", () => {
    const s = session({
      messages: [
        { role: "system", content: "context loaded" },
        { role: "user", content: "   " },
      ],
    });
    expect(deriveSessionTitle(s)).toBe("code");
  });
  test("a message that is only display tags falls back to the agent", () => {
    const s = session({
      messages: [{ role: "user", content: "<local-command-stdout>output</local-command-stdout>" }],
    });
    expect(deriveSessionTitle(s)).toBe("code");
  });
  test("truncates long messages to ~60 columns", () => {
    expect(deriveSessionTitle(session({ messages: [{ role: "user", content: "x".repeat(120) }] }))).toBe(
      "x".repeat(59) + "…",
    );
  });
});

describe("truncateText", () => {
  test("leaves short text untouched", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });
  test("appends an ellipsis past the width", () => {
    expect(truncateText("hello world", 6)).toBe("hello…");
  });
  test("counts display columns, not code units", () => {
    expect(truncateText("héllo world", 6)).toBe("héllo…");
  });
});

describe("formatRelativeTimeAgo", () => {
  const now = 1_000_000_000_000;
  test("formats narrow relative ages", () => {
    expect(formatRelativeTimeAgo(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(formatRelativeTimeAgo(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(formatRelativeTimeAgo(now - 90 * 60_000, now)).toBe("1h ago");
    expect(formatRelativeTimeAgo(now - 45_000, now)).toBe("just now");
  });
  test("clamps future timestamps to just now", () => {
    expect(formatRelativeTimeAgo(now + 5_000, now)).toBe("just now");
  });
});

describe("shortenHomePath", () => {
  test("replaces the home prefix with a tilde", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/home/tester";
    try {
      expect(shortenHomePath("/home/tester/proj/src")).toBe("~/proj/src");
      expect(shortenHomePath("/var/proj")).toBe("/var/proj");
    } finally {
      process.env.HOME = prev;
    }
  });
});
