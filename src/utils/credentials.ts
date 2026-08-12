// Secure credential storage — getSecret / setSecret / deleteSecret
//
// Adapted from Claude Code's macOS keychain helpers
// (utils/secureStorage/macOsKeychain*.ts), but reworked for DeepSeek's
// conventions: Bun APIs, the ~/.deepseek-code/ data dir, and a per-secret
// (name → value) API rather than Claude's single opaque-blob store.
//
// Strategy
// --------
//   macOS  → Keychain via the `security` CLI (add/find/delete-generic-password).
//            Each secret is its own keychain item whose SERVICE name embeds
//            the secret name ("DeepSeek-Code:<name>"), so add/find/delete are
//            always unambiguous — no reliance on the description field.
//            Values are hex-encoded (`-X`) to sidestep any shell/quote
//            escaping issues (newlines, quotes, etc.).
//   other  → Plaintext fallback file at ~/.deepseek-code/secrets.json with
//            0600 permissions. Less secure than the keychain but better than
//            nothing on Linux/Windows, and the file is private to the user.
//
// Everything is defensive: any spawn/IO failure is caught and surfaced so
// callers can fall back to env/config.

import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, userInfo } from "os";

// ─── Paths & constants ───────────────────────────────────────────────────────

/** Base data directory — mirrors storage.ts (~/.deepseek-code). */
const DATA_DIR = join(homedir(), ".deepseek-code");

/** Plaintext fallback store for non-macOS (or when the keychain is unavailable). */
const SECRETS_FILE = join(DATA_DIR, "secrets.json");

/**
 * Keychain service-name prefix. Stable — DO NOT change the prefix, it is part
 * of the keychain lookup key and changing it would orphan every stored secret.
 * The per-secret service name is `${KEYCHAIN_SERVICE}:${name}` so each secret
 * is a distinct, unambiguous keychain item.
 */
const KEYCHAIN_SERVICE = "DeepSeek-Code";

/** Spawn timeout for `security` calls — guards against a locked/hung keychain. */
const KEYCHAIN_TIMEOUT_MS = 10_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isMacOS(): boolean {
  return process.platform === "darwin";
}

/** Best-effort username for the keychain account (-a) field. */
function getUsername(): string {
  try {
    return process.env.USER || process.env.LOGNAME || userInfo().username || "deepseek-code-user";
  } catch {
    return "deepseek-code-user";
  }
}

/**
 * The per-secret service name. Embedding the secret name in the service makes
 * every keychain item uniquely addressable (add/find/delete all key on
 * service+account), avoiding any ambiguity from a shared service name.
 */
function serviceName(name: string): string {
  return `${KEYCHAIN_SERVICE}:${name}`;
}

/** Encode a UTF-8 string as hex (safe for the `security -X` hex-value flag). */
function toHex(value: string): string {
  return Buffer.from(value, "utf-8").toString("hex");
}

/**
 * Run the `security` CLI with the given args.
 * Resolves with stdout (trimmed) on exit code 0.
 * Rejects with an Error (including stderr) on non-zero exit, timeout, or spawn error.
 *
 * `expectNotFound`: when true, exit code 44 ("item not found") resolves with ""
 * instead of rejecting — used by get/delete to treat absence as a normal result.
 */
function runSecurity(args: string[], expectNotFound = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error("security command timed out"));
    }, KEYCHAIN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn 'security': ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (code === 0) {
        resolve(trimmed);
      } else if (code === 44 && expectNotFound) {
        resolve("");
      } else {
        reject(new Error(`security ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
      }
    });

    child.stdin.end();
  });
}

/** Synchronous counterpart of runSecurity. */
function runSecuritySync(args: string[], expectNotFound = false): string {
  const result = spawnSync("security", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: KEYCHAIN_TIMEOUT_MS,
    input: "",
  });
  if (result.error) {
    throw new Error(`Failed to spawn 'security': ${result.error.message}`);
  }
  const code = result.status ?? -1;
  if (code === 0) return (result.stdout || "").trim();
  if (code === 44 && expectNotFound) return "";
  throw new Error(`security ${args.join(" ")} exited ${code}: ${(result.stderr || "").trim()}`);
}

// ─── Plaintext fallback store ────────────────────────────────────────────────

interface SecretsFile {
  [name: string]: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readFallbackStore(): SecretsFile {
  try {
    if (!existsSync(SECRETS_FILE)) return {};
    const raw = readFileSync(SECRETS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SecretsFile;
    }
    return {};
  } catch {
    return {};
  }
}

function writeFallbackStore(data: SecretsFile): void {
  ensureDataDir();
  // Write with 0600, then chmod in case the file already existed with looser
  // perms (writeFileSync does not tighten an existing file's mode).
  writeFileSync(SECRETS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(SECRETS_FILE, 0o600);
  } catch {
    // best-effort; some filesystems/Windows ignore chmod
  }
}

// ─── Public API (async) ──────────────────────────────────────────────────────

/**
 * Retrieve a secret by name.
 * Returns "" if the secret does not exist (not an error).
 *
 * On macOS, a keychain error (locked keychain, denied access, headless SSH)
 * transparently falls back to the plaintext store so a secret written via the
 * fallback is still found. Throws only if BOTH the keychain read and the file
 * read fail in a way that can't be recovered.
 */
export async function getSecret(name: string): Promise<string> {
  if (!name) return "";

  if (isMacOS()) {
    try {
      // find -w returns the stored plaintext directly (the -X hex on write is
      // decoded by the keychain before storage), so return it as-is.
      return await runSecurity(
        ["find-generic-password", "-a", getUsername(), "-s", serviceName(name), "-w"],
        true,
      );
    } catch {
      // Locked keychain, denied access, etc. Fall through to plaintext store so
      // a transient keychain issue doesn't lock the user out of their secrets.
      // (For SSH/headless macOS, the plaintext fallback is the working path.)
    }
  }

  return readFallbackStore()[name] ?? "";
}

/**
 * Store a secret by name.
 * On macOS writes to the keychain; everywhere else (and as an implicit
 * fallback if the keychain write fails) writes to the plaintext store.
 * Returns true on success, false only if both backends fail.
 */
export async function setSecret(name: string, value: string): Promise<boolean> {
  if (!name) return false;

  if (isMacOS()) {
    try {
      // `-X` takes a hex-encoded value. Hex avoids quoting/escaping issues
      // regardless of the secret's content (newlines, quotes, etc.).
      await runSecurity([
        "add-generic-password",
        "-U",                          // update if exists
        "-a", getUsername(),           // account
        "-s", serviceName(name),       // service (unique per secret)
        "-X", toHex(value),            // hex-encoded secret
      ]);
      return true;
    } catch {
      // Fall through to plaintext store below.
    }
  }

  try {
    const store = readFallbackStore();
    store[name] = value;
    writeFallbackStore(store);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a secret by name. Returns true if a delete succeeded or the secret
 * was already absent; returns false only if a delete was attempted and failed
 * on both backends.
 */
export async function deleteSecret(name: string): Promise<boolean> {
  if (!name) return false;

  if (isMacOS()) {
    try {
      await runSecurity(
        ["delete-generic-password", "-a", getUsername(), "-s", serviceName(name)],
        true,
      );
      // Also remove any stray plaintext copy so the two backends stay in sync.
      removeFromFallbackStore(name);
      return true;
    } catch {
      // keychain delete failed (locked / denied) — try the plaintext store.
    }
  }

  return removeFromFallbackStore(name);
}

/** Shared helper: remove a key from the plaintext store. Returns true if present. */
function removeFromFallbackStore(name: string): boolean {
  try {
    const store = readFallbackStore();
    if (!(name in store)) return true; // absent == success
    delete store[name];
    writeFallbackStore(store);
    return true;
  } catch {
    return false;
  }
}

// ─── Public API (sync variants) ──────────────────────────────────────────────
//
// Some call sites (e.g. early config loading on startup) are simpler to write
// synchronously. These spawn `security` synchronously on macOS and hit the
// file synchronously otherwise. Prefer the async forms when possible to avoid
// blocking the event loop.

/** Synchronous version of getSecret — see getSecret for semantics. */
export function getSecretSync(name: string): string {
  if (!name) return "";
  if (isMacOS()) {
    try {
      // find -w returns the stored plaintext directly (the -X hex on write is
      // decoded by the keychain before storage), so return it as-is.
      return runSecuritySync(
        ["find-generic-password", "-a", getUsername(), "-s", serviceName(name), "-w"],
        true,
      );
    } catch {
      // fall through
    }
  }
  return readFallbackStore()[name] ?? "";
}

/** Synchronous version of setSecret — see setSecret for semantics. */
export function setSecretSync(name: string, value: string): boolean {
  if (!name) return false;
  if (isMacOS()) {
    try {
      runSecuritySync([
        "add-generic-password",
        "-U",
        "-a", getUsername(),
        "-s", serviceName(name),
        "-X", toHex(value),
      ]);
      return true;
    } catch {
      // fall through
    }
  }
  try {
    const store = readFallbackStore();
    store[name] = value;
    writeFallbackStore(store);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous version of deleteSecret — see deleteSecret for semantics. */
export function deleteSecretSync(name: string): boolean {
  if (!name) return false;
  if (isMacOS()) {
    try {
      runSecuritySync(
        ["delete-generic-password", "-a", getUsername(), "-s", serviceName(name)],
        true,
      );
      removeFromFallbackStore(name);
      return true;
    } catch {
      // fall through
    }
  }
  return removeFromFallbackStore(name);
}

// ─── Diagnostics / maintenance ───────────────────────────────────────────────

/**
 * Remove the entire plaintext secrets file. Idempotent — returns true if the
 * file is gone afterward (whether or not it existed). Useful for /logout,
 * factory reset, etc.
 */
export function clearPlaintextSecrets(): boolean {
  try {
    if (existsSync(SECRETS_FILE)) unlinkSync(SECRETS_FILE);
    return true;
  } catch {
    return false;
  }
}

/** Path to the plaintext fallback file (exposed for diagnostics/migration). */
export function getSecretsFilePath(): string {
  return SECRETS_FILE;
}

/** Base keychain service-name prefix (exposed for diagnostics/migration). */
export function getKeychainService(): string {
  return KEYCHAIN_SERVICE;
}

/** Full per-secret keychain service name (exposed for diagnostics). */
export function getKeychainServiceName(name: string): string {
  return serviceName(name);
}
