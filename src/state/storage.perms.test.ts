import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { tightenPermissions } from "./storage.js";

const root = mkdtempSync(join(tmpdir(), "dsc-perms-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const modeOf = (p: string): number => statSync(p).mode & 0o777;

describe("tightenPermissions", () => {
  test("strips group and other access from a world-readable file", () => {
    const f = join(root, "loose.json");
    writeFileSync(f, "{}", { mode: 0o644 });
    expect(tightenPermissions(f, 0o600)).toBe(true);
    expect(modeOf(f)).toBe(0o600);
  });

  test("strips other-access from an open directory", () => {
    const d = join(root, "loose-dir");
    mkdirSync(d, { mode: 0o755 });
    expect(tightenPermissions(d, 0o700)).toBe(true);
    expect(modeOf(d)).toBe(0o700);
  });

  test("is idempotent — a second pass has nothing to report", () => {
    const f = join(root, "already-tight.json");
    writeFileSync(f, "{}", { mode: 0o600 });
    expect(tightenPermissions(f, 0o600)).toBe(false);
    expect(modeOf(f)).toBe(0o600);
  });

  test("never widens a file the user made stricter", () => {
    const f = join(root, "stricter.json");
    writeFileSync(f, "{}", { mode: 0o400 });
    expect(tightenPermissions(f, 0o600)).toBe(false);
    expect(modeOf(f)).toBe(0o400);
  });

  test("a missing path is not an error", () => {
    expect(tightenPermissions(join(root, "nope.json"), 0o600)).toBe(false);
  });
});
