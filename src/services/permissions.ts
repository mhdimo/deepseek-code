



















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
): { kind: "path" | "shell" | "generic"; values: string[] } {
  const tn = toolName.toLowerCase();

  if (tn === "bash" || tn === "bashoutput") {
    const cmd = pickString(input, ["command", "cmd"]) ?? "";
    return { kind: "shell", values: [cmd] };
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
