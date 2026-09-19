import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const saved: unknown[] = [];
mock.module("../state/storage.js", () => ({
  loadSettings: () => ({ permissions: { allow: ["Bash"] } }),
  saveSettings: (s: unknown) => {
    saved.push(s);
  },
}));

// Which directories are trusted is machine state (a file in ~/.deepseek-code),
// so the workspace-rule tests drive it from here instead of the developer's own
// trust list.
const trustedDirs = new Set<string>();
mock.module("../services/projectTrust.js", () => ({
  isTrusted: (dir: string) => trustedDirs.has(dir),
}));

const perms = await import("./permissions.js");
// The workspace's half is read in config.ts, which owns config files and the
// trust decision that governs them.
const { loadProjectPermissions } = await import("../utils/config.js");

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

/**
 * Relative-path rules are how people actually write them — `.git/**`,
 * `secret/**`, `.env` — and every tool input they are matched against is
 * absolute, because extractSubjects resolves subjects against the working
 * directory. Rules used to be handed to the matcher without that directory, so
 * a relative pattern compiled to `^\.git[/\\](?:.*)$`, matched nothing, and
 * said nothing: the deny rule a user wrote to protect their git directory was
 * a silent no-op, reported as a valid rule by every surface that displays it.
 */
describe("relative-path rules resolve against the working directory", () => {
  const WD = "/work/proj";
  const decision = (
    settings: Parameters<typeof perms.parsePermissionSettings>[0],
    tool: string,
    input: Record<string, unknown>,
  ) => perms.matchDecision(perms.parsePermissionSettings(settings), tool, input, WD).decision;

  test("a project-relative deny rule denies", () => {
    expect(decision({ deny: ["Edit(.git/**)"] }, "Edit", { file_path: `${WD}/.git/config` })).toBe("deny");
    expect(decision({ deny: ["Edit(secret/**)"] }, "Edit", { file_path: `${WD}/secret/key.pem` })).toBe("deny");
    expect(decision({ deny: ["Read(.env)"] }, "Read", { file_path: `${WD}/.env` })).toBe("deny");
  });

  test("a project-relative allow rule allows", () => {
    expect(decision({ allow: ["Edit(src/**)"] }, "Edit", { file_path: `${WD}/src/App.tsx` })).toBe("allow");
    expect(
      decision({ allow: ["Read(tests/fixtures/**)"] }, "Read", { file_path: `${WD}/tests/fixtures/a.json` }),
    ).toBe("allow");
  });

  test("a leading ./ is the same rule", () => {
    expect(decision({ deny: ["Edit(./src/**)"] }, "Edit", { file_path: `${WD}/src/App.tsx` })).toBe("deny");
  });

  test("absolute and ~ rules keep working, with and without a cwd anchor", () => {
    expect(decision({ deny: [`Edit(${WD}/.git/**)`] }, "Edit", { file_path: `${WD}/.git/config` })).toBe("deny");
    const home = process.env.HOME || process.env.USERPROFILE || "";
    expect(decision({ deny: ["Read(~/.zshrc)"] }, "Read", { file_path: `${home}/.zshrc` })).toBe("deny");
  });

  test("the anchor has teeth: a relative rule is for this project, not any path", () => {
    // `/elsewhere/.git/config` ends with the same segments, and must not be
    // covered by a rule written for the working directory.
    expect(decision({ deny: ["Edit(.git/**)"] }, "Edit", { file_path: "/elsewhere/.git/config" })).toBe("ask");
    expect(decision({ deny: ["Read(.env)"] }, "Read", { file_path: "/elsewhere/.env" })).toBe("ask");
  });

  test("a sibling name that merely starts with the segment is not covered", () => {
    expect(decision({ deny: ["Edit(src/**)"] }, "Edit", { file_path: `${WD}/src-backup/a.ts` })).toBe("ask");
  });

  test("the filesystem root is a working directory too", () => {
    // At `/` the base *is* the separator; anchoring naively would compile
    // `src/**` to `/[/\\]src…` — matching `//src/…` and nothing real.
    expect(perms.matchGlob("src/**", "/src/a.ts", "/")).toBe(true);
    expect(perms.matchGlob(".env", "/.env", "/")).toBe(true);
    expect(perms.matchGlob("src/**", "/other/src/a.ts", "/")).toBe(false);
  });

  test("a rule content that is not a path is still matched as a bare string", () => {
    // rule-vs-rule shadow detection compares rule *content* to rule content,
    // where there is no directory to anchor to and none should be invented.
    expect(perms.matchGlob("Bash(npm run:*)", "Bash(npm run:*)")).toBe(true);
    expect(perms.matchGlob("Edit(src/**)", `${WD}/src/a.ts`)).toBe(false);
  });
});

/**
 * A workspace's own rules — the ones `/permissions` stores under "Project
 * settings" — used to be written and never read: nothing outside
 * `~/.deepseek-code/settings.json` reached the engine, so a project deny rule
 * saved the file, showed up as saved, and enforced nothing. These tests pin the
 * read, and the trust gate that has to come with it: this file can approve
 * tools, so a cloned repo must not be able to hand itself `allow: ["Bash"]`.
 */
describe("workspace permission rules", () => {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  /** A fresh, trusted workspace holding the given config. A fresh directory per
   *  call also keeps the loader's mtime cache out of the way. */
  function workspace(config: unknown, opts: { trusted?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-perms-"));
    created.push(dir);
    writeFileSync(join(dir, ".deepseek-code.json"), JSON.stringify(config));
    if (opts.trusted !== false) trustedDirs.add(dir);
    return dir;
  }

  const decide = (dir: string, tool: string, input: Record<string, unknown>) =>
    perms.matchDecision(
      perms.parsePermissionSettings(perms.loadEffectivePermissions(dir)),
      tool,
      input,
      dir,
    ).decision;

  test("a trusted workspace's rules govern the tools it names", () => {
    const dir = workspace({ permissions: { deny: ["Read(.env)"] } });
    expect(decide(dir, "Read", { file_path: join(dir, ".env") })).toBe("deny");
    expect(decide(dir, "Read", { file_path: join(dir, "README.md") })).toBe("ask");
  });

  test("an untrusted workspace's rules are not read at all", () => {
    const dir = workspace({ permissions: { deny: ["Read(.env)"] } }, { trusted: false });
    expect(decide(dir, "Read", { file_path: join(dir, ".env") })).toBe("ask");
  });

  test("one workspace's rules are not another's", () => {
    const mine = workspace({ permissions: { deny: ["Read(.env)"] } });
    const theirs = workspace({ permissions: {} });
    expect(decide(mine, "Read", { file_path: join(theirs, ".env") })).toBe("ask");
  });

  test("the user's own rules stay in effect alongside the workspace's", () => {
    const dir = workspace({ permissions: { deny: ["Read(.env)"] } });
    // The settings mock above allows Bash; the workspace file says nothing
    // about it, and nothing about it should change.
    expect(decide(dir, "Bash", { command: "rm -rf build" })).toBe("allow");
  });

  test("a workspace allow cannot lift a user deny", () => {
    const dir = workspace({ permissions: { allow: ["Read(secret/**)"] } });
    const merged = perms.mergePermissions(
      { deny: ["Read(secret/**)"] },
      loadProjectPermissions(dir),
    );
    expect(
      perms.matchDecision(perms.parsePermissionSettings(merged), "Read", { file_path: join(dir, "secret/key") }, dir)
        .decision,
    ).toBe("deny");
  });

  test("the same rule in both scopes is one rule", () => {
    const merged = perms.mergePermissions(
      { allow: ["Bash(npm test:*)"] },
      { allow: ["Bash(npm test:*)", "Read"] },
    );
    expect(merged.allow).toEqual(["Bash(npm test:*)", "Read"]);
  });

  test("a string where a list belongs is dropped, not read as rules", () => {
    // `"allow": "Bash"` iterates as four one-letter rules if it is not checked.
    const dir = workspace({ permissions: { allow: "Bash", deny: ["Read(.env)"] } });
    const rules = perms.loadEffectivePermissions(dir);
    expect(rules.allow).not.toContain("B");
    expect(rules.deny).toEqual(["Read(.env)"]);
  });

  test("a config with no rules, or no file, contributes nothing", () => {
    expect(perms.loadEffectivePermissions(workspace({ model: "deepseek-chat" })).deny).toEqual([]);
    const bare = workspace({});
    rmSync(join(bare, ".deepseek-code.json"));
    expect(loadProjectPermissions(bare)).toBeNull();
  });

  test("every surface that enforces rules loads all of them", () => {
    // The failure this guards is not a wrong answer but a missing read: each of
    // these consulted the user's settings directly, so a workspace rule was
    // invisible to it. A new surface that reads settings alone is the same bug
    // again, and this is where it gets caught.
    const surfaces = [
      join(import.meta.dir, "..", "tools.ts"),
      join(import.meta.dir, "..", "services", "agent", "mcpPermissions.ts"),
      join(import.meta.dir, "..", "components", "PermissionPrompt.tsx"),
    ];
    for (const file of surfaces) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("loadEffectivePermissions(");
      expect(source).not.toContain("loadSettings().permissions");
    }
  });
});
