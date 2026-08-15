import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  describeScope,
  groupServersByScope,
  persistMcpServerEnabled,
  readMcpServers,
  scopeLabel,
  withMinDuration,
} from "./McpView.js";
import type { MCPServerConfig } from "../types/index.js";

function makeServer(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { command: "npx", args: ["-y", "server"], ...overrides };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mcpview-test-"));
}

describe("groupServersByScope", () => {
  test("groups servers by the defining config file, alphabetical, dynamic last", () => {
    const dir = makeTmpDir();
    try {
      const project = join(dir, "project.json");
      const user = join(dir, "user.json");
      writeFileSync(project, JSON.stringify({ mcpServers: { zeta: makeServer(), alpha: makeServer() } }));
      writeFileSync(user, JSON.stringify({ mcpServers: { beta: makeServer() } }));

      const groups = groupServersByScope(
        { zeta: makeServer(), alpha: makeServer(), beta: makeServer(), delta: makeServer() },
        [project, user],
      );

      expect(groups).toHaveLength(3);
      expect(groups[0]!.file).toBe(project);
      expect(groups[0]!.names).toEqual(["alpha", "zeta"]);
      expect(groups[1]!.file).toBe(user);
      expect(groups[1]!.names).toEqual(["beta"]);
      expect(groups[2]!.file).toBeNull();
      expect(groups[2]!.names).toEqual(["delta"]);
      expect(groups[2]!.heading).toContain("dynamic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips files that define none of the servers", () => {
    const dir = makeTmpDir();
    try {
      const empty = join(dir, "empty.json");
      writeFileSync(empty, JSON.stringify({ mcpServers: { other: makeServer() } }));
      const groups = groupServersByScope({ only: makeServer() }, [empty]);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.file).toBeNull();
      expect(groups[0]!.names).toEqual(["only"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable files are treated as defining nothing", () => {
    const dir = makeTmpDir();
    try {
      const broken = join(dir, "broken.json");
      writeFileSync(broken, "not json{");
      const groups = groupServersByScope({ a: makeServer() }, [broken]);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.file).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("persistMcpServerEnabled", () => {
  test("sets the enabled flag while preserving other fields and env refs", () => {
    const dir = makeTmpDir();
    try {
      const file = join(dir, "config.json");
      writeFileSync(
        file,
        JSON.stringify({ model: "deepseek-chat", mcpServers: { fs: { command: "npx", args: ["x"], env: { KEY: "env:MY_KEY" } } } }),
      );

      const result = persistMcpServerEnabled({}, "fs", false, file);

      expect(result.ok).toBe(true);
      const onDisk = JSON.parse(readFileSync(file, "utf-8")) as {
        model?: string;
        mcpServers: Record<string, MCPServerConfig>;
      };
      expect(onDisk.mcpServers["fs"]!.enabled).toBe(false);
      expect(onDisk.mcpServers["fs"]!.command).toBe("npx");
      expect(onDisk.mcpServers["fs"]!.args).toEqual(["x"]);
      expect(onDisk.mcpServers["fs"]!.env).toEqual({ KEY: "env:MY_KEY" }); // env: ref left unresolved
      expect(onDisk.model).toBe("deepseek-chat");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes a server absent from the file, dropping env", () => {
    const dir = makeTmpDir();
    try {
      const file = join(dir, "config.json");
      writeFileSync(file, JSON.stringify({ mcpServers: {} }));

      const result = persistMcpServerEnabled(
        { plugin: makeServer({ env: { SECRET: "resolved-secret" }, cwd: "/tmp" }) },
        "plugin",
        false,
        file,
      );

      expect(result.ok).toBe(true);
      const onDisk = JSON.parse(readFileSync(file, "utf-8")) as { mcpServers: Record<string, MCPServerConfig> };
      expect(onDisk.mcpServers["plugin"]!.enabled).toBe(false);
      expect(onDisk.mcpServers["plugin"]!.command).toBe("npx");
      expect(onDisk.mcpServers["plugin"]!.cwd).toBe("/tmp");
      expect(onDisk.mcpServers["plugin"]!.env).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates the file when missing", () => {
    const dir = makeTmpDir();
    try {
      const file = join(dir, "new.json");
      const result = persistMcpServerEnabled({ srv: makeServer() }, "srv", true, file);
      expect(result.ok).toBe(true);
      const onDisk = JSON.parse(readFileSync(file, "utf-8")) as { mcpServers: Record<string, MCPServerConfig> };
      expect(onDisk.mcpServers["srv"]!.enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns ok:false on an unwritable target", () => {
    const result = persistMcpServerEnabled({ srv: makeServer() }, "srv", true, "/nonexistent-dir/x.json");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("readMcpServers", () => {
  test("returns the map from a valid file and null for a broken one", () => {
    const dir = makeTmpDir();
    try {
      const good = join(dir, "good.json");
      const bad = join(dir, "bad.json");
      writeFileSync(good, JSON.stringify({ mcpServers: { a: makeServer() } }));
      writeFileSync(bad, "{oops");
      expect(readMcpServers(good)).toEqual({ a: makeServer() });
      expect(readMcpServers(bad)).toBeNull();
      expect(readMcpServers(join(dir, "missing.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("withMinDuration", () => {
  test("resolves the promise value", async () => {
    expect(await withMinDuration(Promise.resolve(42), 0)).toBe(42);
  });

  test("holds a synchronously-resolved promise for at least minMs", async () => {
    const started = Date.now();
    await withMinDuration(Promise.resolve(), 30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("propagates rejection", async () => {
    await expect(withMinDuration(Promise.reject(new Error("boom")), 0)).rejects.toThrow("boom");
  });
});

describe("scope helpers", () => {
  test("describeScope labels every documented config path", () => {
    const { homedir } = require("os");
    const { join } = require("path");
    expect(describeScope(join(process.cwd(), ".deepseek-code.json"))).toBe("project — .deepseek-code.json");
    expect(describeScope(join(homedir(), ".config", "deepseek-code", "config.json"))).toContain("user");
    expect(describeScope(join(homedir(), ".deepseek-code.json"))).toContain("home");
    expect(describeScope(join(process.cwd(), ".zcode.json"))).toContain("legacy");
    expect(scopeLabel(join(process.cwd(), ".deepseek-code.json"))).toBe("project");
    expect(scopeLabel(null)).toBe("dynamic");
  });
});
