import { describe, expect, mock, test } from "bun:test";

const saved: unknown[] = [];
mock.module("../state/storage.js", () => ({
  loadSettings: () => ({ permissions: { allow: ["Bash"] } }),
  saveSettings: (s: unknown) => {
    saved.push(s);
  },
}));

const perms = await import("./permissions.js");

describe("stripBashRedirections", () => {
  test("strips output and error redirections", () => {
    expect(perms.stripBashRedirections("npm run build > out.log 2>&1")).toBe("npm run build");
    expect(perms.stripBashRedirections("echo hi >> log.txt")).toBe("echo hi");
    expect(perms.stripBashRedirections("cat a.txt 2> err.txt")).toBe("cat a.txt");
  });

  test("leaves command separators and pipes alone", () => {
    expect(perms.stripBashRedirections("cd src && npm test")).toBe("cd src && npm test");
    expect(perms.stripBashRedirections("ls | grep foo")).toBe("ls | grep foo");
  });

  test("returns trimmed input when nothing to strip", () => {
    expect(perms.stripBashRedirections("  git status  ")).toBe("git status");
    expect(perms.stripBashRedirections("")).toBe("");
  });
});

describe("suggestBashPrefix", () => {
  test("two-word subcommand prefix", () => {
    expect(perms.suggestBashPrefix("npm run build")).toBe("npm run");
    expect(perms.suggestBashPrefix("npm run build > out.log 2>&1")).toBe("npm run");
  });

  test("bare command fallback", () => {
    expect(perms.suggestBashPrefix("git status")).toBe("git status");
    expect(perms.suggestBashPrefix("cat file.txt")).toBe("cat");
    expect(perms.suggestBashPrefix("ls -la")).toBe("ls");
  });

  test("skips safe env assignments", () => {
    expect(perms.suggestBashPrefix("NODE_ENV=prod npm run build")).toBe("npm run");
  });

  test("declines paths, flags, bare shells and empty input", () => {
    expect(perms.suggestBashPrefix("bash -c 'ls'")).toBeNull();
    expect(perms.suggestBashPrefix("sh script.sh")).toBeNull();
    expect(perms.suggestBashPrefix("-rf")).toBeNull();
    expect(perms.suggestBashPrefix("")).toBeNull();
    expect(perms.suggestBashPrefix("sudo rm -rf /")).toBe("sudo rm");
  });
});

describe("isPathInFolder", () => {
  test("case-insensitive prefix with separator boundary", () => {
    expect(perms.isPathInFolder("/work/proj/.CLAUDE/settings.json", "/work/proj/.claude")).toBe(true);
    expect(perms.isPathInFolder("/work/proj/.claude/skills/x/SKILL.md", "/work/proj/.claude")).toBe(true);
  });

  test("rejects siblings and the folder itself", () => {
    expect(perms.isPathInFolder("/work/proj/.claude2/x", "/work/proj/.claude")).toBe(false);
    expect(perms.isPathInFolder("/work/proj/.claude", "/work/proj/.claude")).toBe(false);
    expect(perms.isPathInFolder("/work/proj/src/a.ts", "/work/proj/.claude")).toBe(false);
  });
});

describe("pathInWorkingPath", () => {
  test("inside, equal, and outside", () => {
    expect(perms.pathInWorkingPath("/work/proj/src/a.ts", "/work/proj")).toBe(true);
    expect(perms.pathInWorkingPath("/work/proj", "/work/proj")).toBe(true);
    expect(perms.pathInWorkingPath("/work/proj2/x", "/work/proj")).toBe(false);
    expect(perms.pathInWorkingPath("/work/proj2", "/work/proj")).toBe(false);
  });

  test("macOS /private symlink normalization", () => {
    expect(perms.pathInWorkingPath("/private/tmp/proj/a.ts", "/tmp/proj")).toBe(true);
    expect(perms.pathInWorkingPath("/private/var/log/x", "/var")).toBe(true);
  });

  test("case-insensitive comparison", () => {
    expect(perms.pathInWorkingPath("/Work/Proj/A.TS", "/work/proj")).toBe(true);
  });
});

describe("permissionRuleExplanation", () => {
  test("ask with a matched rule explains and hints", () => {
    const decision = perms.matchDecision(
      perms.parsePermissionSettings({ ask: ["Bash(npm run:*)"] }),
      "Bash",
      { command: "npm run build" },
      "/work/proj",
    );
    expect(decision.decision).toBe("ask");
    expect(perms.permissionRuleExplanation(decision)).toBe(
      "Permission rule Bash(npm run:*) requires confirmation for this tool. /permissions to update rules",
    );
  });

  test("ask without a rule, allow, and deny yield no explanation", () => {
    expect(perms.permissionRuleExplanation({ decision: "ask", rule: null, reason: "x" })).toBeNull();
    const allow = perms.matchDecision(
      perms.parsePermissionSettings({ allow: ["Glob"] }),
      "Glob",
      {},
      "/work/proj",
    );
    expect(perms.permissionRuleExplanation(allow)).toBeNull();
    const deny = perms.matchDecision(
      perms.parsePermissionSettings({ deny: ["Bash(rm *)"] }),
      "Bash",
      { command: "rm -rf /" },
      "/work/proj",
    );
    expect(perms.permissionRuleExplanation(deny)).toBeNull();
  });
});

describe("WebFetch domain rules", () => {
  test("domain rule matches the URL hostname exactly", () => {
    const decision = perms.matchDecision(
      perms.parsePermissionSettings({ allow: ["WebFetch(domain:github.com)"] }),
      "WebFetch",
      { url: "https://github.com/anthropics/claude-code" },
      "/work/proj",
    );
    expect(decision.decision).toBe("allow");
  });

  test("different host or subdomain does not match an exact domain rule", () => {
    const rules = perms.parsePermissionSettings({ allow: ["WebFetch(domain:github.com)"] });
    expect(perms.matchDecision(rules, "WebFetch", { url: "https://example.com/x" }, "/work/proj").decision).toBe("ask");
    expect(perms.matchDecision(rules, "WebFetch", { url: "https://sub.github.com/x" }, "/work/proj").decision).toBe("ask");
  });

  test("wildcard domain rule matches subdomains", () => {
    const rules = perms.parsePermissionSettings({ allow: ["WebFetch(domain:*.example.com)"] });
    expect(perms.matchDecision(rules, "WebFetch", { url: "https://sub.example.com/x" }, "/work/proj").decision).toBe("allow");
  });
});

describe("persistAllowRule", () => {
  test("appends a new rule and dedupes", () => {
    saved.length = 0;
    perms.persistAllowRule("Bash(npm run:*)");
    expect(saved).toHaveLength(1);
    const settings = saved[0] as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toEqual(["Bash", "Bash(npm run:*)"]);

    perms.persistAllowRule("Bash");
    expect(saved).toHaveLength(1);
  });
});

describe("clampLines", () => {
  test("passes through short text and truncates long text", () => {
    expect(perms.clampLines("one\ntwo", 3)).toBe("one\ntwo");
    expect(perms.clampLines("one\ntwo\nthree\nfour", 3)).toBe("one\ntwo\nthree\n…");
  });
});
