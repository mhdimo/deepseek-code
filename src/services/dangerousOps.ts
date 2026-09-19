/**
 * The safety floor: a small set of operations that are refused no matter what
 * the permission rules say.
 *
 * The permission engine is a user-configurable control — allow/deny/ask rules
 * plus an interactive prompt. That is the right design for the general case, but
 * it has two failure modes this module exists to cover:
 *
 *   1. Headless `--print` auto-approves anything the ruleset does not explicitly
 *      deny, so "ask" silently becomes "allow".
 *   2. A rule written for the common case (`Bash(rm:*)`, `Bash(git:*)`) also
 *      covers the catastrophic one, and nobody audits their own allow rules.
 *
 * Deliberately narrow. A denylist that blocks legitimate work is worse than no
 * denylist, because it gets disabled wholesale and then protects nothing — so
 * entry requires an operation that is both unrecoverable and unambiguous.
 * `rm -rf build/` is not on this list. `rm -rf ~` is.
 */

import { homedir } from "os";
import { join } from "path";
import { splitShellCommand } from "./permissions.js";
import { PATH_INPUT_KEYS, resolvePath } from "../utils/toolUtils.js";

/** Targets where a recursive force-delete destroys a machine or a whole home. */
const CATASTROPHIC_TARGETS = [
  "/",
  "/*",
  "/System",
  "/System/*",
  "/Library",
  "/Library/*",
  "/Applications",
  "/Applications/*",
  "/usr",
  "/usr/*",
  "/etc",
  "/etc/*",
  "/var",
  "/var/*",
  "/bin",
  "/bin/*",
  "/sbin",
  "/sbin/*",
  "/opt",
  "/opt/*",
  "/boot",
  "/boot/*",
  "/Users",
  "/Users/*",
  "/home",
  "/home/*",
  "/Volumes",
  "/Volumes/*",
];

/** Whole-disk devices, as opposed to a partition on removable media. */
const SYSTEM_DEVICES = [
  "/dev/disk0",
  "/dev/rdisk0",
  "/dev/sda",
  "/dev/vda",
  "/dev/xvda",
  "/dev/nvme0n1",
  "/dev/mmcblk0",
];

/** Expand the shell spellings of the home directory. */
function expandHome(token: string, home: string): string {
  if (token === "~") return home;
  if (token.startsWith("~/")) return home + token.slice(1);
  if (token === "$HOME" || token === "${HOME}") return home;
  if (token.startsWith("$HOME/")) return home + token.slice("$HOME".length);
  if (token.startsWith("${HOME}/")) return home + token.slice("${HOME}".length);
  return token;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Private key material and credential stores: the exfiltration targets. */
export function isCredentialPath(path: string): boolean {
  const home = homedir();
  const p = stripTrailingSlash(path);

  const sshDir = join(home, ".ssh");
  if (p === sshDir || p.startsWith(`${sshDir}/`)) {
    const base = p.slice(sshDir.length + 1);
    // Public keys are meant to be shared; private ones never are.
    if (!base.includes("/") && base.startsWith("id_") && !base.endsWith(".pub")) return true;
  }

  return (
    p === join(home, ".aws", "credentials") ||
    p === join(home, ".netrc") ||
    // This app's own store: it holds the API key the agent runs on.
    p === join(home, ".deepseek-code", "settings.json")
  );
}

/** `rm -rf` against a target that cannot be recovered from. */
function checkRecursiveDelete(tokens: string[], home: string): string | null {
  const flags = new Set<string>();
  const operands: string[] = [];
  for (const t of tokens) {
    if (t === "--recursive" || t === "--force") {
      flags.add(t === "--recursive" ? "r" : "f");
      continue;
    }
    if (t.startsWith("-") && t !== "-") {
      for (const ch of t.replace(/^-+/, "")) flags.add(ch);
      continue;
    }
    operands.push(t);
  }
  if (!flags.has("r") || !flags.has("f")) return null;

  // operands[0] is the word `rm` itself.
  for (const target of operands.slice(1)) {
    const expanded = stripTrailingSlash(expandHome(target, home));
    if (expanded === home) {
      return `recursive force-delete of the home directory (${target})`;
    }
    if (CATASTROPHIC_TARGETS.includes(expanded)) {
      return `recursive force-delete of a system location (${target})`;
    }
  }
  return null;
}

function checkShellSubcommand(part: string, home: string, workingDir: string): string | null {
  const tokens = part.split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0];
  if (!head) return null;
  const cmd = head.split("/").pop() ?? head;

  if (cmd === "rm" || cmd === "rmdir") {
    const hit = checkRecursiveDelete(tokens, home);
    if (hit) return hit;
  }

  if (/^mkfs(\.|$)/.test(cmd) || cmd === "newfs" || cmd === "wipefs") {
    return `filesystem creation on a device (${cmd})`;
  }

  if (cmd === "diskutil" && /^(eraseDisk|zeroDisk|reformat)$/.test(tokens[1] ?? "")) {
    return `disk erase (diskutil ${tokens[1]})`;
  }

  for (const t of tokens) {
    if (t.startsWith("of=")) {
      const device = t.slice(3);
      if (SYSTEM_DEVICES.includes(device)) return `raw write to a system disk (${device})`;
    }
  }

  for (const t of tokens) {
    // `@path` is how curl and friends spell "read this file" — `-d @~/.ssh/id_rsa`
    // is the shortest way to POST a private key somewhere.
    const raw = t.startsWith("@") ? t.slice(1) : t;
    if (isCredentialPath(resolvePath(workingDir, expandHome(raw, home)))) {
      return `read of credential material (${raw})`;
    }
  }

  return null;
}

/**
 * Returns a human-readable reason when the call is on the safety floor, or null
 * when it is an ordinary operation the permission engine should decide.
 */
export function checkDangerousOperation(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): string | null {
  const home = homedir();
  const tn = toolName.toLowerCase();

  // Fork bombs are a single opaque token to everything else, so check the raw
  // string first and for every shell-ish tool.
  for (const value of Object.values(input)) {
    if (typeof value === "string" && /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}/.test(value)) {
      return "fork bomb";
    }
  }

  if (tn === "bash" || tn === "bashoutput" || tn === "powershell") {
    const command = (input.command ?? input.cmd) as string | undefined;
    if (typeof command !== "string" || command.length === 0) return null;
    const { parts } = splitShellCommand(command);
    for (const part of parts) {
      const hit = checkShellSubcommand(part, home, workingDir);
      if (hit) return hit;
    }
    return null;
  }

  // File tools: a credential path is off limits however it is spelled.
  for (const key of PATH_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      const resolved = resolvePath(workingDir, value);
      if (isCredentialPath(resolved)) {
        return `access to credential material (${value})`;
      }
    }
  }

  return null;
}
