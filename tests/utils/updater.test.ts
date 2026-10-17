/**
 * The updater's decision surface: version ordering, the registry answer, the
 * once-a-day cache, and how the owning package manager is inferred. Installing
 * is not exercised here — `runUpdate` is a thin Bun.spawn wrapper — but every
 * input that decides *whether* to install is.
 *
 * Nothing in this file touches the network or the real data directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  compareVersions,
  detectInstallMethod,
  fetchLatestVersion,
  formatChangelogForDisplay,
  installCommand,
  isNewerVersion,
  PACKAGE_NAME,
  parseVersion,
  resolveChangelogPath,
  updateCheckEnabledOnStartup,
  UPDATE_CHECK_INTERVAL_MS,
} from "../../src/utils/updater.js";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-updater-"));

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("version ordering", () => {
  test("parses releases, v-prefixes and prereleases", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("v0.1.1")).toEqual({ major: 0, minor: 1, patch: 1, prerelease: [] });
    expect(parseVersion("1.0.0-beta.2")?.prerelease).toEqual(["beta", "2"]);
    expect(parseVersion("1.0.0+build.5")?.prerelease).toEqual([]);
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
  });

  test("compares numerically, not lexically", () => {
    expect(compareVersions("1.2.3", "1.10.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.2.3")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("a prerelease precedes its release", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    // Numeric identifiers sort below alphanumeric ones (semver 11.4.3).
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  test("garbage never counts as newer", () => {
    expect(isNewerVersion("0.1.1", "0.1.0")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.0.9", "0.1.0")).toBe(false);
    expect(isNewerVersion("latest", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.1", "not-a-version")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  test("reads the version field from the registry", async () => {
    const version = await fetchLatestVersion({
      fetchImpl: (async () => jsonResponse({ version: "1.4.2" })) as unknown as typeof fetch,
    });
    expect(version).toBe("1.4.2");
  });

  test("a non-OK response is not a version", async () => {
    const version = await fetchLatestVersion({
      fetchImpl: (async () => jsonResponse({ error: "not found" }, 404)) as unknown as typeof fetch,
    });
    expect(version).toBeNull();
  });

  test("a dist-tag or missing field is rejected", async () => {
    const distTag = await fetchLatestVersion({
      fetchImpl: (async () => jsonResponse({ version: "latest" })) as unknown as typeof fetch,
    });
    expect(distTag).toBeNull();
    const missing = await fetchLatestVersion({
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    expect(missing).toBeNull();
  });

  test("network and parse errors degrade to null", async () => {
    const offline = await fetchLatestVersion({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(offline).toBeNull();
    const badJson = await fetchLatestVersion({
      fetchImpl: (async () => new Response("{not json", { status: 200 })) as unknown as typeof fetch,
    });
    expect(badJson).toBeNull();
  });
});

describe("checkForUpdate", () => {
  const dirFor = (name: string): string => {
    const dir = join(sandbox, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  test("a newer registry version is an available update, and is cached", async () => {
    const dir = dirFor("fresh");
    const result = await checkForUpdate({
      currentVersion: "0.1.0",
      dataDirPath: dir,
      fetchImpl: (async () => jsonResponse({ version: "0.1.1" })) as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
    });
    expect(result).toMatchObject({
      current: "0.1.0",
      latest: "0.1.1",
      updateAvailable: true,
      cached: false,
    });

    const cached = JSON.parse(readFileSync(join(dir, "update-check.json"), "utf-8"));
    expect(cached).toEqual({ current: "0.1.0", latest: "0.1.1", checkedAt: 1_700_000_000_000 });
  });

  test("a fresh cache answers without the network", async () => {
    const dir = dirFor("cached");
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ version: "0.1.1" });
    }) as unknown as typeof fetch;

    await checkForUpdate({ currentVersion: "0.1.0", dataDirPath: dir, fetchImpl, now: () => 1_000 });
    const second = await checkForUpdate({
      currentVersion: "0.1.0",
      dataDirPath: dir,
      fetchImpl,
      now: () => 1_000 + UPDATE_CHECK_INTERVAL_MS - 1,
    });

    expect(calls).toBe(1);
    expect(second?.cached).toBe(true);
    expect(second?.updateAvailable).toBe(true);
  });

  test("force ignores the cache", async () => {
    const dir = dirFor("forced");
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1 ? jsonResponse({ version: "0.1.1" }) : jsonResponse({ version: "0.1.2" });
    }) as unknown as typeof fetch;

    await checkForUpdate({ currentVersion: "0.1.0", dataDirPath: dir, fetchImpl, now: () => 1_000 });
    const forced = await checkForUpdate({
      currentVersion: "0.1.0",
      dataDirPath: dir,
      fetchImpl,
      force: true,
      now: () => 2_000,
    });

    expect(calls).toBe(2);
    expect(forced?.latest).toBe("0.1.2");
    expect(forced?.cached).toBe(false);
  });

  test("an offline check falls back to the stale answer, recomputed for the running version", async () => {
    const dir = dirFor("stale");
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    await checkForUpdate({
      currentVersion: "0.1.0",
      dataDirPath: dir,
      fetchImpl: (async () => jsonResponse({ version: "0.1.5" })) as unknown as typeof fetch,
      now: () => 1_000,
    });

    const stale = await checkForUpdate({
      currentVersion: "0.1.3",
      dataDirPath: dir,
      fetchImpl: offline,
      now: () => 1_000 + UPDATE_CHECK_INTERVAL_MS + 1,
    });

    expect(stale).toMatchObject({
      current: "0.1.3",
      latest: "0.1.5",
      updateAvailable: true,
      cached: true,
    });
  });

  test("no cache and no network is silence", async () => {
    const dir = dirFor("empty");
    const result = await checkForUpdate({
      currentVersion: "0.1.0",
      dataDirPath: dir,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(existsSync(join(dir, "update-check.json"))).toBe(false);
  });

  test("a corrupt cache is treated as absent", async () => {
    const dir = dirFor("corrupt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "update-check.json"), "{ nope");
    const result = await checkForUpdate({
      currentVersion: "0.1.0",
      dataDirPath: dir,
      fetchImpl: (async () => jsonResponse({ version: "0.1.0" })) as unknown as typeof fetch,
    });
    expect(result?.latest).toBe("0.1.0");
    expect(result?.updateAvailable).toBe(false);
  });
});

describe("detectInstallMethod", () => {
  const emptyEnv: NodeJS.ProcessEnv = {};

  test("bun's global prefix is recognised", () => {
    expect(
      detectInstallMethod(
        "/Users/ada/.bun/install/global/node_modules/@mihaldmo/deepseek-code/dist",
        emptyEnv,
      ),
    ).toBe("bun");
  });

  test("a bun bin symlink identifies bun even when the global dir is custom", () => {
    // bun's bin symlink can point into any configured globalDir (this machine:
    // ~/node_modules), so the module path alone reads as npm. The symlink is
    // the reliable marker — and reading it as npm updates the wrong copy.
    expect(
      detectInstallMethod(
        "/Users/ada/node_modules/@mihaldmo/deepseek-code/dist",
        emptyEnv,
        "/Users/ada/.bun/bin/deepseek-code",
      ),
    ).toBe("bun");
  });

  test("an nvm bin symlink does not turn npm into bun", () => {
    expect(
      detectInstallMethod(
        "/Users/ada/.nvm/versions/node/v22/lib/node_modules/@mihaldmo/deepseek-code/dist",
        emptyEnv,
        "/Users/ada/.nvm/versions/node/v22/bin/deepseek-code",
      ),
    ).toBe("npm");
  });

  test("an npm prefix under node_modules is npm", () => {
    expect(
      detectInstallMethod("/usr/local/lib/node_modules/@mihaldmo/deepseek-code/dist", emptyEnv),
    ).toBe("npm");
    expect(
      detectInstallMethod(
        "/Users/ada/.nvm/versions/node/v22/lib/node_modules/@mihaldmo/deepseek-code/dist",
        emptyEnv,
      ),
    ).toBe("npm");
  });

  test("a source checkout is unknown", () => {
    expect(detectInstallMethod("/Users/ada/deepseek-code/src/utils", emptyEnv)).toBe("unknown");
  });

  test("pnpm and yarn trees are unknown — a second npm copy would shadow them", () => {
    expect(
      detectInstallMethod(
        "/Users/ada/Library/pnpm/global/5/node_modules/@mihaldmo/deepseek-code/dist",
        emptyEnv,
      ),
    ).toBe("unknown");
    expect(
      detectInstallMethod(
        "/Users/ada/.config/yarn/global/node_modules/@mihaldmo/deepseek-code/dist",
        emptyEnv,
      ),
    ).toBe("unknown");
  });

  test("bun's user agent wins when it is available", () => {
    expect(
      detectInstallMethod("/usr/local/lib/node_modules/@mihaldmo/deepseek-code/dist", {
        npm_config_user_agent: "bun/1.3.0 npm/? node/v22.0.0 darwin arm64",
      }),
    ).toBe("bun");
  });
});

describe("installCommand", () => {
  test("names the package and the exact version", () => {
    expect(installCommand("npm", "0.1.1")).toEqual([
      "npm",
      "install",
      "-g",
      `${PACKAGE_NAME}@0.1.1`,
    ]);
    expect(installCommand("bun")).toEqual(["bun", "add", "-g", `${PACKAGE_NAME}@latest`]);
  });
});

describe("updateCheckEnabledOnStartup", () => {
  test("on in a normal terminal", () => {
    expect(updateCheckEnabledOnStartup({})).toBe(true);
  });

  test("off for the opt-out, tests and CI", () => {
    expect(updateCheckEnabledOnStartup({ DEEPSEEK_CODE_NO_UPDATE_CHECK: "1" })).toBe(false);
    expect(updateCheckEnabledOnStartup({ NODE_ENV: "test" })).toBe(false);
    expect(updateCheckEnabledOnStartup({ CI: "true" })).toBe(false);
  });
});

describe("release notes", () => {
  test("resolves beside the built bundle and from the repo root in dev", () => {
    const dist = "/pkg/node_modules/@mihaldmo/deepseek-code/dist";
    expect(resolveChangelogPath(dist, (path) => path === join(dist, "CHANGELOG.md"))).toBe(
      join(dist, "CHANGELOG.md"),
    );

    const source = "/repo/src/utils";
    expect(resolveChangelogPath(source, (path) => path === "/repo/CHANGELOG.md")).toBe(
      "/repo/CHANGELOG.md",
    );

    expect(resolveChangelogPath(dist, () => false)).toBeNull();
  });

  test("the repo ships one, and it names the current release", async () => {
    const path = resolveChangelogPath(join(import.meta.dir, "..", "utils"), existsSync);
    expect(path).not.toBeNull();
    const text = readFileSync(path!, "utf-8");
    expect(text).toContain("## [0.1.1]");
  });

  test("a long changelog is clipped with a pointer to the file", () => {
    const clipped = formatChangelogForDisplay("x".repeat(50), 20);
    expect(clipped.length).toBeLessThan(100);
    expect(clipped).toContain("see CHANGELOG.md");
    expect(formatChangelogForDisplay("  short  ")).toBe("short");
  });
});
