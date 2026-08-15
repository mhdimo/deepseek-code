
import {
  parseRule,
  matchShellCommand,
  matchWildcardPattern,
  matchGlob,
} from "../services/permissions.js";

/** Rule sections in the permission engine (higher precedence first in checks). */
export type Section = "allow" | "ask" | "deny";

/** A single rule as rendered in the permissions list. */
export interface RuleEntry {
  section: Section;
  text: string;
}

/** Engine check order: deny wins, then ask, then allow. */
const SECTION_PRECEDENCE: Record<Section, number> = { deny: 0, ask: 1, allow: 2 };

/** Reference delete-panel wording: "Delete allowed tool?" etc. */
export function behaviorLabel(section: Section): string {
  return section === "allow" ? "allowed" : section === "deny" ? "denied" : "ask";
}

/** Natural-language rendering of a rule, mirroring PermissionRuleDescription. */
export interface RuleDescription {
  prefix: string;
  bold?: string;
  suffix?: string;
}

export function describeRule(text: string): RuleDescription | null {
  const { toolName, ruleContent } = parseRule(text);
  if (toolName.toLowerCase() === "bash") {
    if (ruleContent === undefined) return { prefix: "Any Bash command" };
    if (ruleContent.endsWith(":*")) {
      return { prefix: "Any Bash command starting with ", bold: ruleContent.slice(0, -2) };
    }
    return { prefix: "The Bash command ", bold: ruleContent };
  }
  if (ruleContent === undefined) {
    return { prefix: "Any use of the ", bold: toolName, suffix: " tool" };
  }
  return null;
}

/** Does `shadow` cover every match of `target` (same tool, wider pattern)? */
export function ruleCovers(
  shadow: { toolName: string; ruleContent?: string },
  target: { toolName: string; ruleContent?: string },
): boolean {
  if (shadow.toolName !== "*" && shadow.toolName.toLowerCase() !== target.toolName.toLowerCase()) {
    return false;
  }
  // A tool-wide rule covers every pattern of that tool.
  if (shadow.ruleContent === undefined) return true;
  if (target.ruleContent === undefined) return false;
  if (shadow.ruleContent === target.ruleContent) return true;
  return (
    matchShellCommand(shadow.ruleContent, target.ruleContent) ||
    matchWildcardPattern(shadow.ruleContent, target.ruleContent) ||
    matchGlob(shadow.ruleContent, target.ruleContent)
  );
}

/** Higher-precedence rules (deny > ask > allow) that shadow the given rule. */
export function findShadowingRules(ruleText: string, section: Section, all: RuleEntry[]): string[] {
  const parsed = parseRule(ruleText);
  if (!parsed.toolName) return [];
  const out: string[] = [];
  for (const candidate of all) {
    if (candidate.section === section && candidate.text === ruleText) continue;
    if (SECTION_PRECEDENCE[candidate.section] >= SECTION_PRECEDENCE[section]) continue;
    const candParsed = parseRule(candidate.text);
    if (!candParsed.toolName) continue;
    if (ruleCovers(candParsed, parsed)) out.push(candidate.text);
  }
  return out;
}

/** Map of rule text -> shadowing rule texts for a full rule set. */
export function computeShadowedMap(entries: RuleEntry[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const entry of entries) {
    const shadowers = findShadowingRules(entry.text, entry.section, entries);
    if (shadowers.length > 0) map[entry.text] = shadowers;
  }
  return map;
}
