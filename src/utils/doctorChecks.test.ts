import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkClaudeMdWarnings,
  collectAgentParseErrors,
  collectMcpParsingWarnings,
  detectShadowedRules,
  MAX_MEMORY_CHARACTER_COUNT,
  rulesCover,
  validateBoundedIntEnvVar,
  validateEnvVars,
  validateSettings,
  type ParsedRule,
} from "./doctorChecks.js";

function rule(raw: string, behavior: "allow" | "deny" | "ask"): ParsedRule {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open !== -1 && close > open && close === raw.length - 1) {
    return {
      raw,
      toolName: raw.slice(0, open),
      ruleContent: raw.slice(open + 1, close),
      behavior,
    };
  }
  return { raw, toolName: raw, ruleContent: undefined, behavior };
}

describe("rulesCover", () => {
  test("tool-wide covers any content for the tool", () => {
    expect(rulesCover(rule("Bash", "deny"), rule("Bash(ls *)", "allow"))).toBe(true);
    expect(rulesCover(rule("*", "ask"), rule("Read(foo)", "allow"))).toBe(true);
  });

  test("different tools never cover", () => {
    expect(rulesCover(rule("Bash", "deny"), rule("Read", "allow"))).toBe(false);
  });

  test("specific never covers tool-wide", () => {
    expect(rulesCover(rule("Bash(ls *)", "deny"), rule("Bash", "allow"))).toBe(false);
  });

  test("exact, glob, shell-prefix and substring coverage", () => {
    expect(rulesCover(rule("Bash(ls *)", "allow"), rule("Bash(ls *)", "allow"))).toBe(true);
    expect(rulesCover(rule("Read(src/**)", "deny"), rule("Read(src/foo.ts)", "allow"))).toBe(true);
    expect(rulesCover(rule("Bash(ls:*)", "ask"), rule("Bash(ls -la)", "allow"))).toBe(true);
    expect(rulesCover(rule("Read(notes)", "deny"), rule("Read(notes/final.md)", "allow"))).toBe(true);
  });
});

describe("detectShadowedRules", () => {
  test("tool-wide deny shadows a specific allow", () => {
    const out = detectShadowedRules([rule("Bash(ls *)", "allow"), rule("Bash", "deny")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.shadowType).toBe("deny");
    expect(out[0]!.rule.raw).toBe("Bash(ls *)");
    expect(out[0]!.reason).toContain("deny");
  });

  test("tool-wide ask shadows a specific allow (always prompts)", () => {
    const out = detectShadowedRules([rule("Bash(ls *)", "allow"), rule("Bash", "ask")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.shadowType).toBe("ask");
  });

  test("ask rule shadowed by tool-wide deny", () => {
    const out = detectShadowedRules([rule("Bash(rm *)", "ask"), rule("Bash", "deny")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.shadowType).toBe("deny");
    expect(out[0]!.rule.behavior).toBe("ask");
  });

  test("earlier same-class tool-wide rule shadows later specific rule", () => {
    const out = detectShadowedRules([rule("Bash", "allow"), rule("Bash(ls *)", "allow")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.shadowType).toBe("order");
    expect(out[0]!.shadowedBy.raw).toBe("Bash");
  });

  test("later specific allow not shadowed by earlier non-covering allow", () => {
    const out = detectShadowedRules([rule("Bash(ls *)", "allow"), rule("Bash(rm *)", "allow")]);
    expect(out).toHaveLength(0);
  });

  test("tool-wide deny vs tool-wide allow is a conflict, not a shadow", () => {
    const out = detectShadowedRules([rule("Bash", "allow"), rule("Bash", "deny")]);
    expect(out).toHaveLength(0);
  });

  test("different tools never shadow", () => {
    const out = detectShadowedRules([rule("Read", "deny"), rule("Bash(ls *)", "allow")]);
    expect(out).toHaveLength(0);
  });

  test("deny shadow reported over ask shadow for the same rule", () => {
    const out = detectShadowedRules([
      rule("Bash(ls *)", "allow"),
      rule("Bash", "ask"),
      rule("Bash", "deny"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.shadowType).toBe("deny");
  });

  test("duplicate identical allow rules shadow the second", () => {
    const out = detectShadowedRules([rule("Bash(ls *)", "allow"), rule("Bash(ls *)", "allow")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.shadowType).toBe("order");
  });
});

describe("validateBoundedIntEnvVar", () => {
  test("unset is valid with the default", () => {
    expect(validateBoundedIntEnvVar("X", undefined, 25, 200)).toEqual({
      name: "X",
      effective: 25,
      status: "valid",
    });
  });

  test("non-parseable is invalid and falls back to default", () => {
    expect(validateBoundedIntEnvVar("X", "abc", 25, 200).status).toBe("invalid");
    expect(validateBoundedIntEnvVar("X", "-5", 25, 200).status).toBe("invalid");
  });

  test("above upper limit is capped", () => {
    expect(validateBoundedIntEnvVar("X", "5000", 25, 200)).toEqual({
      name: "X",
      effective: 200,
      status: "capped",
      message: "Capped from 5000 to 200",
    });
  });

  test("in-range value is valid", () => {
    expect(validateBoundedIntEnvVar("X", "42", 25, 200).status).toBe("valid");
    expect(validateBoundedIntEnvVar("X", "42", 25, 200).effective).toBe(42);
  });
});

describe("validateEnvVars", () => {
  test("clean environment yields no errors", () => {
    expect(validateEnvVars({})).toEqual([]);
  });

  test("invalid and capped vars are reported, valid ones are not", () => {
    const env: Record<string, string | undefined> = {
      DEEPSEEK_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "not-a-number",
      DEEPSEEK_CODE_FILE_READ_MAX_SIZE_BYTES: "999999999999",
      DEEPSEEK_MAX_STEPS: "15",
    };
    const out = validateEnvVars(env);
    expect(out).toHaveLength(2);
    expect(out[0]!.status).toBe("invalid");
    expect(out[1]!.status).toBe("capped");
  });
});

describe("validateSettings", () => {
  test("valid settings produce no errors", () => {
    expect(validateSettings({})).toEqual([]);
    expect(
      validateSettings({
        effort: "high",
        themeMode: "dark",
        cleanupPeriodDays: 30,
        permissions: { allow: ["Bash(ls *)"], deny: ["Bash(rm *)"] },
        verbose: true,
      }),
    ).toEqual([]);
  });

  test("unknown keys and bad enums are flagged", () => {
    const out = validateSettings({ bogus: 1, effort: "turbo", themeMode: "sepia" });
    expect(out.map((e) => e.key).sort()).toEqual(["bogus", "effort", "themeMode"]);
  });

  test("out-of-range cleanupPeriodDays is flagged", () => {
    expect(validateSettings({ cleanupPeriodDays: 0 }).map((e) => e.key)).toContain("cleanupPeriodDays");
    expect(validateSettings({ cleanupPeriodDays: 999 }).map((e) => e.key)).toContain("cleanupPeriodDays");
  });

  test("malformed permissions and hooks are flagged", () => {
    const perms = validateSettings({ permissions: { allow: [42] } });
    expect(perms.map((e) => e.key)).toContain("permissions.allow");
    const hooks = validateSettings({ hooks: { PreToolUse: [{ hooks: [{ nope: 1 }] }] } });
    expect(hooks.map((e) => e.key)).toContain("hooks.PreToolUse[0].hooks[0]");
    expect(validateSettings({ hooks: { BogusEvent: [] } }).map((e) => e.key)).toContain(
      "hooks.BogusEvent",
    );
  });

  test("statusLine shape is validated", () => {
    const out = validateSettings({ statusLine: { type: "script", command: "" } });
    expect(out.map((e) => e.key).sort()).toEqual(["statusLine.command", "statusLine.type"]);
  });
});

describe("checkClaudeMdWarnings", () => {
  test("no large files yields no warning", () => {
    expect(checkClaudeMdWarnings([{ path: "/x/CLAUDE.md", content: "small" }])).toBeNull();
  });

  test("file over the threshold is reported with its char count", () => {
    const big = "a".repeat(MAX_MEMORY_CHARACTER_COUNT + 1);
    const out = checkClaudeMdWarnings([{ path: "/x/.claude/CLAUDE.md", content: big }]);
    expect(out).not.toBeNull();
    expect(out!.type).toBe("claudemd_files");
    expect(out!.details[0]).toContain("/x/.claude/CLAUDE.md");
    expect(out!.details[0]).toContain((MAX_MEMORY_CHARACTER_COUNT + 1).toLocaleString());
  });
});

describe("collectMcpParsingWarnings", () => {
  test("broken config JSON is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-mcp-"));
    const path = join(dir, ".deepseek-code.json");
    writeFileSync(path, "{not json");
    try {
      const out = collectMcpParsingWarnings([path]);
      expect(out).toHaveLength(1);
      expect(out[0]!.path).toBe(path);
      expect(out[0]!.error).toContain("invalid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed mcpServers entries are reported with server names", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-mcp-"));
    const path = join(dir, ".deepseek-code.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { filesystem: { command: "npx" }, broken: { args: [] } } }),
    );
    try {
      const out = collectMcpParsingWarnings([path]);
      expect(out).toHaveLength(1);
      expect(out[0]!.error).toContain("mcpServers.broken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("valid config yields no warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-mcp-"));
    const path = join(dir, ".deepseek-code.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { ok: { command: "npx", args: ["-y", "x"] } } }));
    try {
      expect(collectMcpParsingWarnings([path])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectAgentParseErrors", () => {
  test("invalid agent names are reported, valid ones are not", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-agents-"));
    const agentsDir = join(dir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "good.md"), "---\nname: good\n---\nDo things.\n");
    writeFileSync(join(agentsDir, "bad name.md"), "---\nname: not valid!\n---\nNope.\n");
    try {
      const out = collectAgentParseErrors(dir).filter((f) => f.path.startsWith(agentsDir));
      expect(out).toHaveLength(1);
      expect(out[0]!.path).toBe(join(agentsDir, "bad name.md"));
      expect(out[0]!.error).toContain("invalid agent name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty agent dir yields no errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-agents-"));
    try {
      expect(collectAgentParseErrors(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
