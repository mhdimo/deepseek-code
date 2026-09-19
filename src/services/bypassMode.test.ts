/**
 * When this process may stop asking for permission.
 *
 * The startup check (`assertBypassSafe`) has to stay in step with the only
 * other way into the mode, which is a keypress: Shift+Tab cycles the
 * permission modes, and `bypassPermissions` used to be the fourth entry in
 * that cycle unconditionally. So root outside a sandbox — the exact process
 * `assertBypassSafe` refuses to start — could reach unrestricted execution by
 * pressing Shift+Tab four times, in the TUI the gate had just declined to
 * protect. These pin that the cycle and the startup check ask one question.
 *
 * Root is faked through `SUDO_UID`, which is one of the two things
 * `isRunningAsRoot` looks at and the only one a test can set without being
 * root. Fake it the same way the real check does or the test proves nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bypassIsPermitted,
  initialPermissionMode,
  permissionModeCycle,
} from "./bypassMode.js";

const granted = { dangerouslySkipPermissions: true };
const notGranted = {};

const savedSudoUid = process.env.SUDO_UID;
const savedContainer = process.env.container;

beforeEach(() => {
  delete process.env.SUDO_UID;
  delete process.env.container;
});

afterEach(() => {
  if (savedSudoUid === undefined) delete process.env.SUDO_UID;
  else process.env.SUDO_UID = savedSudoUid;
  if (savedContainer === undefined) delete process.env.container;
  else process.env.container = savedContainer;
});

describe("the cycle offers bypass only when it is permitted", () => {
  test("a process with no grant never cycles into it", () => {
    expect(permissionModeCycle(notGranted)).toEqual(["default", "acceptEdits", "plan"]);
  });

  test("a granted process on an ordinary host can reach it", () => {
    expect(permissionModeCycle(granted)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
  });

  test("a granted process running as root outside a sandbox cannot", () => {
    // The regression: the grant is held and the process must still not reach
    // the mode, because that is precisely the case `assertBypassSafe` exists
    // to refuse — and it never sees a keypress.
    process.env.SUDO_UID = "501";
    expect(permissionModeCycle(granted)).toEqual(["default", "acceptEdits", "plan"]);
  });

  test("root inside a container is allowed, as it is at startup", () => {
    process.env.SUDO_UID = "501";
    process.env.container = "docker";
    expect(permissionModeCycle(granted)).toContain("bypassPermissions");
  });
});

describe("the mode a session starts in comes from the same question", () => {
  test("no grant starts in default", () => {
    expect(initialPermissionMode(notGranted)).toBe("default");
  });

  test("a grant on an ordinary host starts in bypass", () => {
    expect(initialPermissionMode(granted)).toBe("bypassPermissions");
  });

  test("a grant as root outside a sandbox still starts in default", () => {
    process.env.SUDO_UID = "501";
    expect(initialPermissionMode(granted)).toBe("default");
  });
});

describe("the predicate itself", () => {
  test("root outside a sandbox is not permitted", () => {
    process.env.SUDO_UID = "501";
    expect(bypassIsPermitted()).toBe(false);
  });

  test("containment is what makes root acceptable", () => {
    // Both halves of what `isInContainer` looks at on Linux: the env var the
    // runtimes set, and the marker file. Only the first is settable here.
    process.env.SUDO_UID = "501";
    process.env.container = "docker";
    expect(bypassIsPermitted()).toBe(true);
  });
});
