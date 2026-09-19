/**
 * Workspace trust: granting it, and what it then covers.
 *
 * The gate is only as good as the answer it records, so the scope is pinned
 * from both directions — a descendant of a trusted directory is trusted, and
 * neither a parent nor a sibling of one is. The last test is the reason this
 * file can be hermetic at all: the trust store lives with the rest of the
 * app's state, so DEEPSEEK_CODE_DATA_DIR decides where both are.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import {
  getTrustedDirsFile,
  isTrusted,
  listTrustedDirs,
  shouldPromptTrust,
  trustDir,
  untrustDir,
} from "./projectTrust.js";

const root = mkdtempSync(join(tmpdir(), "trust-"));
let n = 0;

beforeEach(() => {
  // A store of its own per test: the developer's own trusted-dirs.json must
  // not be able to decide these outcomes, and these tests must not write to
  // it either.
  process.env.DEEPSEEK_CODE_DATA_DIR = join(root, `data${n++}`);
});

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function workspace(name: string): string {
  const dir = join(root, `ws${n}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("workspace trust", () => {
  test("an unseen workspace is untrusted and asks", () => {
    const dir = workspace("plain");
    expect(isTrusted(dir)).toBe(false);
    expect(shouldPromptTrust(dir)).toBe(true);
  });

  test("granting trust is remembered — the answer decides what happens next", () => {
    const dir = workspace("granted");
    // Recorded as the real location (/tmp is /private/tmp on macOS), which is
    // what makes a decision survive being asked about the same directory twice.
    expect(trustDir(dir)).toBe(realpathSync(dir));
    expect(isTrusted(dir)).toBe(true);
    expect(shouldPromptTrust(dir)).toBe(false);
    expect(listTrustedDirs()).toContain(realpathSync(dir));
  });

  test("trust covers descendants, and only descendants", () => {
    const dir = workspace("scoped");
    const child = join(dir, "packages", "app");
    mkdirSync(child, { recursive: true });
    trustDir(dir);

    expect(isTrusted(child)).toBe(true);
    // A parent is a different workspace: trusting a checkout must not vouch
    // for everything above it.
    expect(isTrusted(root)).toBe(false);
    expect(isTrusted(join(root, "ws-other"))).toBe(false);
  });

  test("untrusting takes it back", () => {
    const dir = workspace("revoked");
    trustDir(dir);
    expect(untrustDir(dir)).toBe(true);
    expect(isTrusted(dir)).toBe(false);
    // Nothing to remove the second time, and the caller is told so.
    expect(untrustDir(dir)).toBe(false);
  });

  test("the same directory is one entry, whatever spelling it is asked about", () => {
    const dir = workspace("spellings");
    trustDir(dir);
    expect(isTrusted(`${dir}/`)).toBe(true);
    // A path that walks up and back down is the same directory, and stays one
    // entry: the store is keyed on where the directory really is.
    expect(isTrusted(join(dir, "..", basename(dir)))).toBe(true);
    trustDir(`${dir}/`);
    expect(listTrustedDirs().filter((d) => d === realpathSync(dir))).toHaveLength(1);
  });

  test("the store lives in the data dir, not in the developer's home", () => {
    // A trust decision recorded here has to be the one the app reads back; a
    // store that picks its own path (this one used to hardcode ~/.deepseek-code)
    // splits the decision from the file that holds it.
    const dir = workspace("location");
    trustDir(dir);
    const file = getTrustedDirsFile();
    expect(file.startsWith(process.env.DEEPSEEK_CODE_DATA_DIR!)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toContain(realpathSync(dir));
  });
});
