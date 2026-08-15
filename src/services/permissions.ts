



















import { loadSettings, saveSettings } from "../state/storage.js";

export type PermissionBehavior = "allow" | "deny" | "ask";


export interface ParsedRule {
  
  raw: string;
  
  toolName: string;
  
  ruleContent?: string;
  
  behavior: PermissionBehavior;
}


export interface MatchDecision {
  decision: PermissionBehavior;
  
  reason: string;
  
  rule: ParsedRule | null;
}




export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}


export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}


function findFirstUnescapedChar(str: string, ch: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === ch && countPrecedingBackslashes(str, i) % 2 === 0) {
      return i;
    }
  }
  return -1;
}


function findLastUnescapedChar(str: string, ch: string): number {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === ch && countPrecedingBackslashes(str, i) % 2 === 0) {
      return i;
    }
  }
  return -1;
}

function countPrecedingBackslashes(str: string, index: number): number {
  let count = 0;
  let j = index - 1;
  while (j >= 0 && str[j] === "\\") {
    count++;
    j--;
  }
  return count;
}




export function parseRule(rule: string): { toolName: string; ruleContent?: string } {
  const trimmed = rule.trim();
  const openIdx = findFirstUnescapedChar(trimmed, "(");
  if (openIdx === -1) {
    
    return { toolName: trimmed };
  }

  const closeIdx = findLastUnescapedChar(trimmed, ")");
  
  if (closeIdx === -1 || closeIdx <= openIdx || closeIdx !== trimmed.length - 1) {
    return { toolName: trimmed };
  }

  const toolName = trimmed.substring(0, openIdx);
  const rawContent = trimmed.substring(openIdx + 1, closeIdx);

  
  if (!toolName) {
    return { toolName: trimmed };
  }

  
  if (rawContent === "" || rawContent === "*") {
    return { toolName };
  }

  return { toolName, ruleContent: unescapeRuleContent(rawContent) };
}


export function parseRules(
  rules: readonly string[],
  behavior: PermissionBehavior,
): ParsedRule[] {
  const out: ParsedRule[] = [];
  for (const raw of rules) {
    if (!raw || !raw.trim()) continue;
    const { toolName, ruleContent } = parseRule(raw);
    if (!toolName) continue;
    out.push({ raw: raw.trim(), toolName, ruleContent, behavior });
  }
  return out;
}




export function globToRegex(pattern: string, workingDir?: string): RegExp {
  let p = pattern;

  
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    p = p === "~" ? home : `${home}${p.slice(1)}`;
  }

  
  
  p = p.replace(/\\/g, "/");

  
  
  while (p.startsWith("./")) p = p.slice(2);
  if (p === ".") p = "";

  let re = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i] as string;

    if (c === "*" && p[i + 1] === "*") {
      
      
      i += 2;
      if (p[i] === "/") i++;
      re += "(?:.*)";
      continue;
    }

    if (c === "*") {
      
      re += "[^/]*";
      i++;
      continue;
    }

    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }

    if (c === "[") {
      
      const end = p.indexOf("]", i + 1);
      if (end === -1) {
        
        re += "\\[";
        i++;
        continue;
      }
      let cls = p.substring(i + 1, end);
      if (cls.startsWith("!")) cls = `^${cls.slice(1)}`; 
      
      cls = cls.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
      re += `[${cls}]`;
      i = end + 1;
      continue;
    }

    
    if (".+^${}()|".includes(c)) {
      re += `\\${c}`;
      i++;
      continue;
    }

    if (c === "/") {
      
      re += "[/\\\\]";
      i++;
      continue;
    }

    re += c;
    i++;
  }

  
  
  const anchored = workingDir && !pattern.startsWith("/") && !pattern.startsWith("~")
    ? `${escapeRegex(stripTrailingSlash(workingDir))}[\\/\\\\]${re}`
    : re;

  return new RegExp(`^${anchored}$`, "s");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingSlash(s: string): string {
  return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}


export function matchGlob(pattern: string, value: string, workingDir?: string): boolean {
  try {
    return globToRegex(pattern, workingDir).test(value);
  } catch {
    
    return false;
  }
}




export function matchShellCommand(pattern: string, command: string): boolean {
  const pat = pattern.trim();
  const cmd = command.trim();

  
  const prefixMatch = pat.match(/^(.+):\*$/);
  if (prefixMatch && prefixMatch[1] !== undefined) {
    const prefix = prefixMatch[1];
    return cmd === prefix || cmd.startsWith(`${prefix} `);
  }

  
  if (hasUnescapedWildcard(pat)) {
    return matchWildcardPattern(pat, cmd);
  }

  
  return cmd === pat;
}


function hasUnescapedWildcard(pattern: string): boolean {
  if (pattern.endsWith(":*")) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && countPrecedingBackslashes(pattern, i) % 2 === 0) {
      return true;
    }
  }
  return false;
}



const ESCAPED_STAR = "\x00STAR\x00";
const ESCAPED_BACKSLASH = "\x00BSLASH\x00";
const STAR_RE = new RegExp(ESCAPED_STAR, "g");
const BSLASH_RE = new RegExp(ESCAPED_BACKSLASH, "g");


export function matchWildcardPattern(pattern: string, command: string): boolean {
  const pat = pattern.trim();

  
  let processed = "";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i] as string;
    if (c === "\\" && i + 1 < pat.length) {
      const next = pat[i + 1];
      if (next === "*") {
        processed += ESCAPED_STAR;
        i += 2;
        continue;
      }
      if (next === "\\") {
        processed += ESCAPED_BACKSLASH;
        i += 2;
        continue;
      }
    }
    processed += c;
    i++;
  }

  
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*");

  let regexPattern = withWildcards
    .replace(STAR_RE, "\\*")
    .replace(BSLASH_RE, "\\\\");

  
  const unescapedStarCount = (processed.match(/\*/g) || []).length;
  if (regexPattern.endsWith(" .*") && unescapedStarCount === 1) {
    regexPattern = regexPattern.slice(0, -3) + "( .*)?";
  }

  try {
    return new RegExp(`^${regexPattern}$`, "s").test(command);
  } catch {
    return false;
  }
}




function extractSubjects(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): { kind: "path" | "shell" | "domain" | "generic"; values: string[] } {
  const tn = toolName.toLowerCase();

  if (tn === "bash" || tn === "bashoutput") {
    const cmd = pickString(input, ["command", "cmd"]) ?? "";
    return { kind: "shell", values: [cmd] };
  }

  // WebFetch rules match on the URL's hostname (rule content "domain:<host>").
  if (tn === "webfetch") {
    const url = pickString(input, ["url"]);
    if (url) {
      try {
        const hostname = new URL(url).hostname;
        if (hostname) return { kind: "domain", values: [hostname] };
      } catch {
        // Malformed URL — fall through to the generic matcher.
      }
    }
  }

  
  
  
  const concretePaths = pickStrings(
    input,
    ["file_path", "path", "notebook_path"],
  );
  if (concretePaths.length > 0) {
    return {
      kind: "path",
      values: concretePaths.map((p) => resolveAgainst(workingDir, p)),
    };
  }

  if (tn === "glob" || tn === "grep") {
    const pats = pickStrings(input, ["pattern", "glob", "path_pattern", "path"]);
    if (pats.length > 0) {
      return { kind: "generic", values: pats };
    }
  }

  const strs: string[] = [];
  for (const v of Object.values(input)) {
    if (typeof v === "string") strs.push(v);
  }
  strs.push(JSON.stringify(input));
  return { kind: "generic", values: strs };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function pickStrings(obj: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

function resolveAgainst(workingDir: string, p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const expanded = p === "~" ? home : `${home}${p.slice(1)}`;
    return canonicalize(expanded);
  }
  if (p.startsWith("/")) return canonicalize(p);
  
  const base = stripTrailingSlash(workingDir);
  return canonicalize(`${base}/${p}`);
}


function canonicalize(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "." || seg === "") {
      
      
      if (out.length === 0 && seg === "") out.push("");
      continue;
    }
    out.push(seg);
  }
  let joined = out.join("/");
  if (joined.length > 1 && joined.endsWith("/")) joined = joined.slice(0, -1);
  return joined || ".";
}


export function matchToolInput(
  rule: ParsedRule,
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): boolean {
  
  if (rule.toolName !== "*" && rule.toolName.toLowerCase() !== toolName.toLowerCase()) {
    return false;
  }

  
  if (!rule.ruleContent) return true;

  const { kind, values } = extractSubjects(toolName, input, workingDir);
  const pat = rule.ruleContent;

  for (const v of values) {
    if (kind === "shell") {
      if (matchShellCommand(pat, v)) return true;
    } else if (kind === "path") {

      const expandedPat =
        pat === "~" || pat.startsWith("~/")
          ? resolveAgainst(workingDir, pat)
          : pat;
      if (matchGlob(expandedPat, v)) return true;
    } else if (kind === "domain") {
      // Rule content is "domain:<host>" (optionally a wildcard like "*.example.com").
      const domain = pat.startsWith("domain:") ? pat.slice("domain:".length) : pat;
      if (hasUnescapedWildcard(domain) || domain.includes("*")) {
        if (matchWildcardPattern(domain, v)) return true;
      } else if (v === domain) {
        return true;
      }
    } else {

      if (hasUnescapedWildcard(pat) || pat.includes("*")) {
        if (matchWildcardPattern(pat, v)) return true;
      } else if (v.includes(pat)) {
        return true;
      }
    }
  }
  return false;
}




export function matchDecision(
  rules: readonly ParsedRule[],
  toolName: string,
  inputJson: unknown,
  workingDir: string,
): MatchDecision {
  const input = coerceInput(inputJson);

  let matchedDeny: ParsedRule | null = null;
  let matchedAsk: ParsedRule | null = null;
  let matchedAllow: ParsedRule | null = null;

  for (const rule of rules) {
    if (matchToolInput(rule, toolName, input, workingDir)) {
      if (rule.behavior === "deny" && !matchedDeny) matchedDeny = rule;
      else if (rule.behavior === "ask" && !matchedAsk) matchedAsk = rule;
      else if (rule.behavior === "allow" && !matchedAllow) matchedAllow = rule;
    }
  }

  if (matchedDeny) {
    return {
      decision: "deny",
      rule: matchedDeny,
      reason: ruleReason(matchedDeny, "deny"),
    };
  }
  if (matchedAsk) {
    return {
      decision: "ask",
      rule: matchedAsk,
      reason: ruleReason(matchedAsk, "ask"),
    };
  }
  if (matchedAllow) {
    return {
      decision: "allow",
      rule: matchedAllow,
      reason: ruleReason(matchedAllow, "allow"),
    };
  }

  return {
    decision: "ask",
    rule: null,
    reason: `No permission rule matched for ${toolName}; defaulting to ask.`,
  };
}

function coerceInput(inputJson: unknown): Record<string, unknown> {
  if (inputJson && typeof inputJson === "object" && !Array.isArray(inputJson)) {
    return inputJson as Record<string, unknown>;
  }
  if (typeof inputJson === "string") {
    try {
      const parsed = JSON.parse(inputJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      
    }
  }
  return {};
}

function ruleReason(rule: ParsedRule, behavior: PermissionBehavior): string {
  const verb = behavior === "allow" ? "allowed by" : behavior === "deny" ? "denied by" : "prompted by";
  const target = rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
  return `${verb} rule: ${target}`;
}




export function parsePermissionSettings(permissions: {
  allow?: readonly string[];
  deny?: readonly string[];
  ask?: readonly string[];
}): ParsedRule[] {
  return [
    ...parseRules(permissions.allow ?? [], "allow"),
    ...parseRules(permissions.ask ?? [], "ask"),
    ...parseRules(permissions.deny ?? [], "deny"),
  ];
}

/* ------------------------------------------------------------------ */
/* Prompt-facing helpers (persist, explanation, path + bash utilities) */
/* ------------------------------------------------------------------ */

/** Best-effort persist of a `ToolName(content)` allow rule into the user
 *  settings (deduped). A failed persist must not crash the caller. */
export function persistAllowRule(rule: string): void {
  try {
    const settings = loadSettings();
    const allow = settings.permissions?.allow ?? [];
    if (!allow.includes(rule)) {
      saveSettings({
        ...settings,
        permissions: {
          ...settings.permissions,
          allow: [...allow, rule],
        },
      });
    }
  } catch {
    // A failed persist must not crash the prompt dialog.
  }
}

/** Format a parsed rule for display, e.g. `Bash(npm run:*)`. */
export function formatRuleForDisplay(rule: ParsedRule): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

/** Dim explanation line for a prompt raised by a matched ask rule, or null
 *  when the decision came from elsewhere (no rule, deny/allow). */
export function permissionRuleExplanation(decision: MatchDecision): string | null {
  if (decision.decision !== "ask" || !decision.rule) return null;
  return `Permission rule ${formatRuleForDisplay(decision.rule)} requires confirmation for this tool. /permissions to update rules`;
}

/** Case-insensitive "path is inside folder" check with a separator boundary
 *  (macOS/Windows filesystems are case-insensitive, so `.cLauDe/Settings.json`
 *  must count as inside `.claude/`). The folder itself is NOT inside. */
export function isPathInFolder(path: string, folder: string): boolean {
  const p = path.toLowerCase();
  const f = folder.toLowerCase();
  return p.startsWith(f + "/") || p.startsWith(f + "\\");
}

/** True when `path` is the working path itself or lives underneath it.
 *  Normalizes the macOS /var -> /private/var and /tmp -> /private/tmp
 *  symlinks and compares case-insensitively so resolved input paths match
 *  an unresolved working directory. */
export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const normalize = (p: string) =>
    p
      .replace(/^\/private\/var\//, "/var/")
      .replace(/^\/private\/tmp(\/|$)/, "/tmp$1")
      .toLowerCase();
  const p = normalize(path);
  const w = normalize(workingPath);
  if (p === w) return true;
  if (p.startsWith(w + "/") || p.startsWith(w + "\\")) return true;
  return false;
}

/** Clamp multi-line text to `maxLines`, appending an ellipsis when truncated. */
export function clampLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

const REDIRECTION_RE = /\s*[12]?>>?(\s*&[12]|\s*[^\s|;&]*)/g;

/** Strip output redirections (`> f`, `2>&1`, `>> log`) so filenames don't
 *  show up as part of a suggested command prefix. */
export function stripBashRedirections(command: string): string {
  return command.replace(REDIRECTION_RE, "").trim();
}

/** Command-name shape: lowercase letters/digits with optional `-` segments
 *  (e.g. `npm`, `git`, `docker-compose`). */
const COMMAND_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Shells/wrappers a bare one-word prefix rule would over-permit (a `bash:*`
 *  rule auto-approves arbitrary code via `bash -c`, `sudo:*` any sudo call). */
const BARE_SHELL_PREFIXES = new Set([
  "sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash", "cmd",
  "powershell", "pwsh", "env", "xargs", "nice", "stdbuf", "nohup",
  "timeout", "time", "sudo", "doas", "pkexec",
]);

/** Suggest a stable command prefix for a "don't ask again" Bash rule.
 *  Strips redirections first; prefers the two-word subcommand form
 *  (`npm run`), falls back to the bare command (`git`), and declines for
 *  paths, flags, bare shells, and empty input. */
export function suggestBashPrefix(command: string): string | null {
  const tokens = stripBashRedirections(command).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // Skip leading env-var assignments (NODE_ENV=prod npm run build).
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i]!)) i++;
  const rest = tokens.slice(i);
  if (rest.length === 0) return null;

  // Two words when the second looks like a subcommand ("commit", "run", ...).
  if (rest.length >= 2 && COMMAND_NAME_RE.test(rest[1]!)) {
    return `${rest[0]} ${rest[1]}`;
  }

  const first = rest[0]!;
  if (!COMMAND_NAME_RE.test(first)) return null;
  if (BARE_SHELL_PREFIXES.has(first)) return null;
  return first;
}
