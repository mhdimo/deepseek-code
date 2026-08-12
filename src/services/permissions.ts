// Permission rule engine
//
// A pure-TS permission RULE engine. It parses "Tool(spec:pattern)" rules
// (allow / deny / ask) and matches a (toolName, inputJson) tuple against them,
// with filesystem path scoping for path-bearing tools.
//
// Adapted from Claude Code's permission rule parser / matcher, but rewritten
// to fit DeepSeek Code's patterns: it consumes the persisted settings shape
// `permissions: { allow?: string[]; deny?: string[]; ask?: string[] }` and is
// free of any Claude-specific types or backend coupling. Pure TS, no UI, no
// C++ dependency.
//
// Public API:
//   - parseRules(rules: string[]) -> ParsedRule[]
//   - matchDecision(rules, toolName, inputJson, workingDir) -> MatchDecision
//   - helpers: parseRule, globToRegex, matchGlob, matchToolInput

// ─── Types ───────────────────────────────────────────────────────────────────

/** The behavior a rule prescribes (or the effective decision we return). */
export type PermissionBehavior = "allow" | "deny" | "ask";

/** A single parsed permission rule, e.g. { toolName: "Bash", ruleContent: "git push:*", behavior: "allow" }. */
export interface ParsedRule {
  /** The original rule string, kept for debugging / round-tripping. */
  raw: string;
  /** Tool name this rule targets, e.g. "Bash", "Read", "Edit", "*". */
  toolName: string;
  /** Optional content inside the parentheses (the spec/pattern). Absent = tool-wide. */
  ruleContent?: string;
  /** What this rule does when it matches. */
  behavior: PermissionBehavior;
}

/**
 * The effective decision after matching a (tool, input) against the rule set.
 * `rule` is the specific rule that determined the outcome (if any).
 */
export interface MatchDecision {
  decision: PermissionBehavior;
  /** Human-readable explanation, suitable for surfacing in a permission prompt. */
  reason: string;
  /** The rule that produced this decision, or null when no rule matched. */
  rule: ParsedRule | null;
}

// ─── Paren-aware escaping (for rule content) ─────────────────────────────────

/**
 * Escape backslashes and parentheses in rule content so it round-trips
 * through the `Tool(content)` textual format. Backslashes first, then parens.
 *
 * Example: escapeRuleContent('psycopg2.connect()') => 'psycopg2.connect\\(\\)'
 */
export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * Reverse of escapeRuleContent. Unescape parens first, then backslashes.
 *
 * Example: unescapeRuleContent('psycopg2.connect\\(\\)') => 'psycopg2.connect()'
 */
export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

/** Find the index of the first occurrence of `char` not preceded by an odd number of backslashes. */
function findFirstUnescapedChar(str: string, ch: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === ch && countPrecedingBackslashes(str, i) % 2 === 0) {
      return i;
    }
  }
  return -1;
}

/** Find the index of the last occurrence of `char` not preceded by an odd number of backslashes. */
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

// ─── Rule parsing ────────────────────────────────────────────────────────────

/**
 * Parse a single rule string of the form "ToolName" or "ToolName(content)"
 * into a `{ toolName, ruleContent? }` pair. Handles escaped parentheses and
 * trailing-comment whitespace. Content "()" or "(*)" is treated as a tool-wide
 * rule (no ruleContent).
 *
 * Examples:
 *   parseRule("Bash")                         => { toolName: "Bash" }
 *   parseRule("Bash(npm install)")            => { toolName: "Bash", ruleContent: "npm install" }
 *   parseRule("Bash(python -c print\\(1\\))") => { toolName: "Bash", ruleContent: 'python -c print(1)' }
 *   parseRule("Read(./src/**)")               => { toolName: "Read", ruleContent: "./src/**" }
 *   parseRule("Bash()") / parseRule("Bash(*)")=> { toolName: "Bash" }  (tool-wide)
 */
export function parseRule(rule: string): { toolName: string; ruleContent?: string } {
  const trimmed = rule.trim();
  const openIdx = findFirstUnescapedChar(trimmed, "(");
  if (openIdx === -1) {
    // No parens — pure tool name (possibly a wildcard like "*").
    return { toolName: trimmed };
  }

  const closeIdx = findLastUnescapedChar(trimmed, ")");
  // Malformed: no closing paren, closing before opening, or trailing junk after it.
  if (closeIdx === -1 || closeIdx <= openIdx || closeIdx !== trimmed.length - 1) {
    return { toolName: trimmed };
  }

  const toolName = trimmed.substring(0, openIdx);
  const rawContent = trimmed.substring(openIdx + 1, closeIdx);

  // Missing tool name (e.g. "(foo)") — treat the whole string as a tool name.
  if (!toolName) {
    return { toolName: trimmed };
  }

  // Empty content or a bare "*" => tool-wide rule.
  if (rawContent === "" || rawContent === "*") {
    return { toolName };
  }

  return { toolName, ruleContent: unescapeRuleContent(rawContent) };
}

/**
 * Parse an array of raw rule strings into ParsedRules, attaching the given
 * behavior. Blank/whitespace-only lines and lines that fail to yield a
 * tool name are skipped. This is what consumers call with each of the
 * allow/deny/ask arrays.
 */
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

// ─── Glob matching ───────────────────────────────────────────────────────────

/**
 * Convert a glob pattern into a RegExp. Supports:
 *   - `**`  → match any path segment sequence (incl. across slashes)
 *   - `*`   → match any run of chars except a path separator
 *   - `?`   → match a single non-separator char
 *   - `[abc]` / `[a-z]` / `[!abc]` character classes
 *   - `~/`  expanded to the user home directory BEFORE regex compilation
 *   - `.` (leading dot) is matched literally like any other segment start
 *
 * Special regex metacharacters are escaped; only the glob tokens above are
 * translated. Separator-aware: `/` and `\` are both treated as separators on
 * all platforms so Windows-style and POSIX-style paths compare consistently.
 */
export function globToRegex(pattern: string, workingDir?: string): RegExp {
  let p = pattern;

  // Expand a leading "~/" (or bare "~") to the home directory.
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    p = p === "~" ? home : `${home}${p.slice(1)}`;
  }

  // Normalize backslashes to forward slashes so glob tokens are portable,
  // but remember we'll match both separators in the resulting regex.
  p = p.replace(/\\/g, "/");

  // Strip a redundant leading "./" — it's a no-op path prefix that, left in,
  // would anchor the workingDir path with a literal "." segment.
  while (p.startsWith("./")) p = p.slice(2);
  if (p === ".") p = "";

  let re = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i] as string;

    if (c === "*" && p[i + 1] === "*") {
      // `**` matches anything including separators. Optionally consume a
      // following slash so `a/**/b` does not leave an empty segment.
      i += 2;
      if (p[i] === "/") i++;
      re += "(?:.*)";
      continue;
    }

    if (c === "*") {
      // Single `*` matches any run of non-separator chars.
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
      // Character class: find the matching `]`.
      const end = p.indexOf("]", i + 1);
      if (end === -1) {
        // No closing bracket — treat `[` literally.
        re += "\\[";
        i++;
        continue;
      }
      let cls = p.substring(i + 1, end);
      if (cls.startsWith("!")) cls = `^${cls.slice(1)}`; // negate
      // Characters that are regex-special inside a class need minimal escaping.
      cls = cls.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
      re += `[${cls}]`;
      i = end + 1;
      continue;
    }

    // Escape regex metacharacters.
    if (".+^${}()|".includes(c)) {
      re += `\\${c}`;
      i++;
      continue;
    }

    if (c === "/") {
      // Match either separator.
      re += "[/\\\\]";
      i++;
      continue;
    }

    re += c;
    i++;
  }

  // Anchor fully; allow the workingDir prefix when the pattern is relative
  // (mirrors how `resolve()` would anchor a relative glob).
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

/** Test whether `value` matches glob `pattern`. */
export function matchGlob(pattern: string, value: string, workingDir?: string): boolean {
  try {
    return globToRegex(pattern, workingDir).test(value);
  } catch {
    // A malformed pattern should never throw the matcher — treat as no match.
    return false;
  }
}

// ─── Shell / command matching (Bash-style prefix + wildcard) ─────────────────

/**
 * Match a shell command against a rule content pattern. Supports three forms,
 * mirroring Claude Code's shell rule matching:
 *
 *   1. Legacy prefix syntax ending in `:*`  →  prefix match
 *      e.g. "npm:*" matches "npm install", "npm run build"
 *   2. Wildcard syntax containing unescaped `*`  →  wildcard match
 *      e.g. "git *" matches "git push", "git commit -m ...", and bare "git"
 *   3. Otherwise  →  exact match (after trimming)
 *
 * `\*` and `\\` escape a literal asterisk / backslash.
 */
export function matchShellCommand(pattern: string, command: string): boolean {
  const pat = pattern.trim();
  const cmd = command.trim();

  // 1. Legacy `:*` prefix.
  const prefixMatch = pat.match(/^(.+):\*$/);
  if (prefixMatch && prefixMatch[1] !== undefined) {
    const prefix = prefixMatch[1];
    return cmd === prefix || cmd.startsWith(`${prefix} `);
  }

  // 2. Wildcard.
  if (hasUnescapedWildcard(pat)) {
    return matchWildcardPattern(pat, cmd);
  }

  // 3. Exact.
  return cmd === pat;
}

/** True if `pattern` contains an unescaped `*` (and is not legacy `:*` form). */
function hasUnescapedWildcard(pattern: string): boolean {
  if (pattern.endsWith(":*")) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && countPrecedingBackslashes(pattern, i) % 2 === 0) {
      return true;
    }
  }
  return false;
}

// Sentinels used while building the wildcard regex so escaped literals survive
// the regex-metacharacter escaping pass.
const ESCAPED_STAR = "\x00STAR\x00";
const ESCAPED_BACKSLASH = "\x00BSLASH\x00";
const STAR_RE = new RegExp(ESCAPED_STAR, "g");
const BSLASH_RE = new RegExp(ESCAPED_BACKSLASH, "g");

/**
 * Wildcard matcher: `*` matches any run of characters (incl. whitespace and
 * newlines via the `s` flag). `\*` matches a literal `*`, `\\` a literal `\`.
 *
 * Special case: a pattern ending in ` *` whose only wildcard is that trailing
 * one (`git *`) matches both `git push` and bare `git`, aligning with prefix
 * semantics (`git:*`).
 */
export function matchWildcardPattern(pattern: string, command: string): boolean {
  const pat = pattern.trim();

  // First pass: pull escape sequences out into sentinels.
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

  // Escape regex metacharacters, then turn the surviving (unescaped) `*` into `.*`.
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*");

  let regexPattern = withWildcards
    .replace(STAR_RE, "\\*")
    .replace(BSLASH_RE, "\\\\");

  // Trailing single-wildcard → optional args, so `git *` also matches bare `git`.
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

// ─── Per-tool input extraction & matching ────────────────────────────────────

/**
 * Per-tool extraction of the "subject string(s)" from an input JSON object.
 *
 * For path-bearing tools (Read, Write, Edit, NotebookEdit, LS, Glob, Grep), we
 * pull out the path-like fields and resolve them against `workingDir` so that
 * globs can be matched in absolute form. For Bash, we treat `command` as a
 * shell command (prefix/wildcard). For everything else we fall back to matching
 * against the stringified input or any string-valued field.
 */
function extractSubjects(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): { kind: "path" | "shell" | "generic"; values: string[] } {
  const tn = toolName.toLowerCase();

  if (tn === "bash" || tn === "bashoutput") {
    const cmd = pickString(input, ["command", "cmd"]) ?? "";
    return { kind: "shell", values: [cmd] };
  }

  // 1. Concrete path fields → resolve against cwd and match as paths (glob).
  //    These are files that the tool will actually open/write, so path-scoped
  //    globbing is the right model.
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

  // 2. Search/pattern tools (Glob, Grep) expose a glob/regex *pattern*, not a
  //    concrete file. Resolving + glob-matching a glob against a glob is wrong,
  //    so treat those as generic subjects matched as raw strings (substring or
  //    wildcard). A rule like `Glob(src/**)` thus matches an input pattern that
  //    lives under src/.
  if (tn === "glob" || tn === "grep") {
    const pats = pickStrings(input, ["pattern", "glob", "path_pattern", "path"]);
    if (pats.length > 0) return { kind: "generic", values: pats };
  }

  // 3. Generic fallback: gather every string-valued top-level field plus the
  //    whole stringified object, so a rule like `WebFetch(example.com)` can
  //    still hit a `url` field even though we don't special-case it.
  const strs: string[] = [];
  for (const v of Object.values(input)) {
    if (typeof v === "string") strs.push(v);
  }
  strs.push(JSON.stringify(input));
  return { kind: "generic", values: strs };
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
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

/** Resolve `p` against `workingDir` (unless already absolute or a home path).
 *  Redundant `./` and `//` segments are collapsed so the canonical form matches
 *  what `globToRegex` produces. */
function resolveAgainst(workingDir: string, p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const expanded = p === "~" ? home : `${home}${p.slice(1)}`;
    return canonicalize(expanded);
  }
  if (p.startsWith("/")) return canonicalize(p);
  // Resolve relative to cwd without importing node:path to keep this file pure.
  const base = stripTrailingSlash(workingDir);
  return canonicalize(`${base}/${p}`);
}

/** Collapse redundant `./`, `../`-free `//` runs and trailing slashes for
 *  consistent path/glob comparison. Does NOT touch `..`. */
function canonicalize(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "." || seg === "") {
      // Skip "." segments; collapse repeated separators. Keep a leading "" so
      // absolute paths stay absolute.
      if (out.length === 0 && seg === "") out.push("");
      continue;
    }
    out.push(seg);
  }
  let joined = out.join("/");
  if (joined.length > 1 && joined.endsWith("/")) joined = joined.slice(0, -1);
  return joined || ".";
}

/**
 * Decide whether a single rule matches the (toolName, input) tuple.
 * Handles tool-name wildcards (`*`), tool-wide rules (no ruleContent), and the
 * per-input-subject matching above.
 */
export function matchToolInput(
  rule: ParsedRule,
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): boolean {
  // Tool name match: exact (case-insensitive) or a wildcard tool rule.
  if (rule.toolName !== "*" && rule.toolName.toLowerCase() !== toolName.toLowerCase()) {
    return false;
  }

  // Tool-wide rule (no content) matches any input for that tool.
  if (!rule.ruleContent) return true;

  const { kind, values } = extractSubjects(toolName, input, workingDir);
  const pat = rule.ruleContent;

  for (const v of values) {
    if (kind === "shell") {
      if (matchShellCommand(pat, v)) return true;
    } else if (kind === "path") {
      // Path subjects are absolute; expand any `~/` in the pattern for symmetry.
      const expandedPat =
        pat === "~" || pat.startsWith("~/")
          ? resolveAgainst(workingDir, pat)
          : pat;
      if (matchGlob(expandedPat, v)) return true;
    } else {
      // Generic: prefer wildcard/glob, fall back to substring contains.
      if (hasUnescapedWildcard(pat) || pat.includes("*")) {
        if (matchWildcardPattern(pat, v)) return true;
      } else if (v.includes(pat)) {
        return true;
      }
    }
  }
  return false;
}

// ─── Decision orchestration ──────────────────────────────────────────────────

/**
 * Evaluate a fully-parsed rule list against a (toolName, inputJson) tuple and
 * return an effective decision.
 *
 * Precedence (highest first), mirroring Claude Code:
 *   1. deny  — an explicit deny always wins
 *   2. ask   — an explicit ask forces a prompt even if an allow also matches
 *   3. allow — auto-approve
 *   4. (no rule matched) — default to `ask`
 *
 * `rules` may be a flat list combining allow/deny/ask (in any order); order
 * within the list does not change precedence. When multiple behaviors match,
 * the strongest (deny > ask > allow) wins. This is the standard, predictable
 * model and avoids surprises when a deny is added after an allow.
 *
 * @param rules       Parsed rules (see parseRules). May mix behaviors.
 * @param toolName    The tool being invoked, e.g. "Bash".
 * @param inputJson   The tool's input. Either a parsed object or a JSON string.
 * @param workingDir  Used to resolve relative paths and anchor relative globs.
 */
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
      // fall through
    }
  }
  return {};
}

function ruleReason(rule: ParsedRule, behavior: PermissionBehavior): string {
  const verb = behavior === "allow" ? "allowed by" : behavior === "deny" ? "denied by" : "prompted by";
  const target = rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
  return `${verb} rule: ${target}`;
}

// ─── Convenience: parse the persisted settings shape in one shot ─────────────

/**
 * Parse the persisted `settings.permissions` shape
 * (`{ allow?: string[]; deny?: string[]; ask?: string[] }`) into a single flat
 * ParsedRule list, ready to hand to `matchDecision`.
 */
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
