import { describe, expect, test } from "bun:test";
import {
  behaviorLabel,
  computeShadowedMap,
  describeRule,
  findShadowingRules,
  ruleCovers,
  type RuleEntry,
} from "./permissionsRuleUtils.js";

describe("behaviorLabel", () => {
  test("reference delete-panel wording", () => {
    expect(behaviorLabel("allow")).toBe("allowed");
    expect(behaviorLabel("deny")).toBe("denied");
    expect(behaviorLabel("ask")).toBe("ask");
  });
});

describe("describeRule", () => {
  test("Bash prefix rules read as 'Any Bash command starting with X'", () => {
    expect(describeRule("Bash(ls:*)")).toEqual({
      prefix: "Any Bash command starting with ",
      bold: "ls",
    });
  });

  test("tool-wide Bash", () => {
    expect(describeRule("Bash")).toEqual({ prefix: "Any Bash command" });
  });

  test("tool-wide Bash written with an empty spec", () => {
    expect(describeRule("Bash(*)")).toEqual({ prefix: "Any Bash command" });
  });

  test("concrete Bash command", () => {
    expect(describeRule("Bash(git commit)")).toEqual({
      prefix: "The Bash command ",
      bold: "git commit",
    });
  });

  test("tool-wide non-Bash tool", () => {
    expect(describeRule("Read")).toEqual({
      prefix: "Any use of the ",
      bold: "Read",
      suffix: " tool",
    });
  });

  test("specific non-Bash rule has no natural language", () => {
    expect(describeRule("Read(src/**)")).toBeNull();
  });
});

describe("ruleCovers", () => {
  test("tool-wide rule covers specific patterns of the same tool", () => {
    expect(ruleCovers({ toolName: "Bash" }, { toolName: "Bash", ruleContent: "ls" })).toBe(true);
  });

  test("prefix pattern covers commands under the prefix", () => {
    expect(
      ruleCovers(
        { toolName: "Bash", ruleContent: "ls:*" },
        { toolName: "Bash", ruleContent: "ls -la" },
      ),
    ).toBe(true);
  });

  test("wildcard pattern covers matching commands", () => {
    expect(
      ruleCovers(
        { toolName: "Bash", ruleContent: "git *" },
        { toolName: "Bash", ruleContent: "git commit" },
      ),
    ).toBe(true);
  });

  test("specific rule does not cover a different command", () => {
    expect(
      ruleCovers({ toolName: "Bash", ruleContent: "ls" }, { toolName: "Bash", ruleContent: "ls -la" }),
    ).toBe(false);
  });

  test("different tools never cover", () => {
    expect(ruleCovers({ toolName: "Read" }, { toolName: "Write" })).toBe(false);
  });

  test("specific rule cannot cover a tool-wide rule", () => {
    expect(ruleCovers({ toolName: "Bash", ruleContent: "ls" }, { toolName: "Bash" })).toBe(false);
  });
});

describe("findShadowingRules", () => {
  const all: RuleEntry[] = [
    { section: "deny", text: "Bash" },
    { section: "ask", text: "Edit(src/**)" },
    { section: "allow", text: "Bash(ls:*)" },
  ];

  test("finds a tool-wide deny shadowing a specific allow", () => {
    expect(findShadowingRules("Bash(ls:*)", "allow", all)).toEqual(["Bash"]);
  });

  test("an equal ask rule shadows the same allow rule (ask is checked first)", () => {
    expect(findShadowingRules("Edit(src/**)", "allow", all)).toEqual(["Edit(src/**)"]);
  });

  test("rules of other tools are not shadowed", () => {
    expect(findShadowingRules("WebFetch", "allow", all)).toEqual([]);
  });

  test("same-precedence rules do not shadow", () => {
    const entries: RuleEntry[] = [
      { section: "ask", text: "Edit(src/**)" },
      { section: "ask", text: "Edit(**)" },
    ];
    expect(findShadowingRules("Edit(src/**)", "ask", entries)).toEqual([]);
  });

  test("deny is never shadowed", () => {
    const entries: RuleEntry[] = [
      { section: "deny", text: "Bash" },
      { section: "allow", text: "Bash" },
    ];
    expect(findShadowingRules("Bash", "deny", entries)).toEqual([]);
  });

  test("same text in a higher-precedence section shadows", () => {
    const entries: RuleEntry[] = [
      { section: "deny", text: "Bash" },
      { section: "allow", text: "Bash" },
    ];
    expect(findShadowingRules("Bash", "allow", entries)).toEqual(["Bash"]);
  });
});

describe("computeShadowedMap", () => {
  test("maps every shadowed rule to its shadowers", () => {
    const entries: RuleEntry[] = [
      { section: "deny", text: "Bash" },
      { section: "allow", text: "Bash(ls:*)" },
      { section: "allow", text: "Read(src/**)" },
    ];
    expect(computeShadowedMap(entries)).toEqual({ "Bash(ls:*)": ["Bash"] });
  });
});
