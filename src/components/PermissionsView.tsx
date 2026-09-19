
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { join } from "node:path";
import { homedir } from "node:os";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Pane } from "../ui/design-system/Pane.js";
import { Select, type SelectOption } from "../ui/design-system/Select.js";
import { Tab, Tabs, useTabHeaderFocus } from "../ui/design-system/Tabs.js";
import InputDialog from "./InputDialog.js";
import { theme, resolveColor } from "../utils/theme.js";
import { parseRule } from "../services/permissions.js";
import { stripMouseSequences } from "./useMouseWheelScroll.js";
import {
  addRuleToScope,
  behaviorLabel,
  computeShadowedMap,
  describeRule,
  findShadowingRules,
  removeRuleFromScope,
  type RuleEntry,
  type RuleSections,
  type Section,
} from "./permissionsRuleUtils.js";

export type PermissionRulesShape = RuleSections;

export interface PermissionsViewProps {
  /** The user's own rules, from ~/.deepseek-code/settings.json. */
  userRules: PermissionRulesShape;
  /** The workspace's rules, from its .deepseek-code.json. Only a trusted
   *  workspace has any — that is also the only state in which the engine reads
   *  them — and they are shown only when they can be edited. */
  projectRules?: PermissionRulesShape;
  sessionRules: { allow: string[]; deny: string[] };
  /** Persist the user's rules (writes settings.json). */
  onPersistRules: (rules: PermissionRulesShape) => void;
  /** Persist the workspace's rules (writes its .deepseek-code.json). Absent for
   *  an untrusted workspace, which also hides that destination and its rows. */
  onPersistProjectRules?: (rules: PermissionRulesShape) => void;
  /** Update the live session-only rules. */
  onSessionRulesChange: (rules: { allow: string[]; deny: string[] }) => void;
  /** Report a joined summary of changes when closing (system note). */
  onSummary?: (summary: string) => void;
  onClose: () => void;
}

/** Where a rule lives. Each scope is edited and persisted on its own: writing
 *  one scope's rules into the other's file would move rules the user did not
 *  touch, and for the workspace file that write is trust-gated. */
type RuleSource = "user" | "project" | "session";

interface RuleRow {
  id: string;
  section: Section;
  source: RuleSource;
  text: string;
}

function sourceLabel(source: RuleSource): string {
  if (source === "session") return "From this session";
  if (source === "project") return "From project settings";
  return "From settings";
}

/** One tab per behavior. The reference's pane also carries "Recently denied"
 *  and "Workspace" tabs; neither has a backing store here (there is no denial
 *  history, and a workspace's rules live in its own config file), so the tab
 *  set stops at the three rule lists the app can actually read and write. */
const TABS: Section[] = ["allow", "ask", "deny"];

const TAB_TITLES: Record<Section, string> = {
  allow: "Allow",
  ask: "Ask",
  deny: "Deny",
};

/** The reference's per-tab explanation, in this product's name. */
const TAB_EXPLANATIONS: Record<Section, string> = {
  allow: "DeepSeek Code won't ask before using allowed tools.",
  ask: "DeepSeek Code will always ask for confirmation before using these tools.",
  deny: "DeepSeek Code will always reject requests to use denied tools.",
};

const USER_SETTINGS_PATH = join(homedir(), ".deepseek-code", "settings.json");
const PROJECT_CONFIG_PATH = join(process.cwd(), ".deepseek-code.json");

function sectionRules(rules: PermissionRulesShape, section: Section): string[] {
  return rules[section] ?? [];
}

/**
 * All rules (each scope + session) as flat entries for the shadowing scan.
 *
 * Identical rules from two scopes collapse into one entry, because that is what
 * they are in force: the engine merges the scopes and drops duplicates, so
 * reporting one copy as shadowing the other would describe a conflict that does
 * not exist. The list still shows both rows, so either can be deleted.
 */
function ruleEntries(
  scopes: readonly PermissionRulesShape[],
  session: { allow: string[]; deny: string[] },
): RuleEntry[] {
  const out: RuleEntry[] = [];
  const seen = new Set<string>();
  const add = (section: Section, text: string) => {
    const key = `${section} ${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ section, text });
  };
  for (const rules of scopes) {
    for (const section of ["allow", "ask", "deny"] as const) {
      for (const text of sectionRules(rules, section)) add(section, text);
    }
  }
  for (const section of ["allow", "deny"] as const) {
    for (const text of session[section]) add(section, text);
  }
  return out;
}

/** The reference's state-dependent input guide: what the keys do right now.
 *  (Its fourth branch — "Enter approve · r retry" — waits on a denial history
 *  this app does not keep.) */
export function permissionsGuide(headerFocused: boolean, searchActive: boolean): string {
  if (headerFocused) return "←/→ tab switch · ↓ return · Esc cancel";
  if (searchActive) return "Type to filter · Enter/↓ select · ↑ tabs · Esc clear";
  return "↑↓ navigate · Enter select · Type to search · ←/→ switch · Esc cancel";
}

/** Rounded red confirmation card for deleting a rule — the reference's
 *  RuleDetails screen, with the rule, its plain-English reading and its
 *  source, then the Yes/No select and a single "Esc to cancel" line. */
export function DeleteRuleCard({
  rule,
  shadowers,
  onDelete,
  onCancel,
}: {
  rule: RuleRow;
  shadowers?: string[];
  onDelete: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <>
      <Box
        flexDirection="column"
        gap={1}
        borderStyle="round"
        paddingLeft={1}
        paddingRight={1}
        borderColor={resolveColor(theme.error)}
      >
        <Text bold color={resolveColor(theme.error)}>
          Delete {behaviorLabel(rule.section)} tool?
        </Text>
        <Box flexDirection="column" marginX={2}>
          <Text bold>{rule.text}</Text>
          <RuleDescriptionText text={rule.text} />
          <Text dimColor>{sourceLabel(rule.source)}</Text>
          {/* The shadow warning used to ride on the list row's second line;
              the rows are single-line now, so it lives with the rest of the
              rule's details. */}
          {shadowers && shadowers.length > 0 && (
            <Text dimColor>Warning: shadowed by {shadowers.join(", ")}</Text>
          )}
        </Box>
        <Text>Are you sure you want to delete this permission rule?</Text>
        <Select
          options={[
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ]}
          onChange={(value) => (value === "yes" ? onDelete() : onCancel())}
          onCancel={onCancel}
        />
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </>
  );
}

/** Dim natural-language rendering of a rule ("Any Bash command starting with ls"). */
function RuleDescriptionText({ text }: { text: string }): React.ReactElement | null {
  const desc = describeRule(text);
  if (!desc) return null;
  return (
    <Text dimColor>
      {desc.prefix}
      {desc.bold !== undefined && <Text bold>{desc.bold}</Text>}
      {desc.suffix}
    </Text>
  );
}

/** The reference SearchBox: a rounded, full-width field with a ⌕ prefix that
 *  is always on screen (focused while typing, dim while the list has focus). */
function RuleSearchBox({
  query,
  focused,
}: {
  query: string;
  focused: boolean;
}): React.ReactElement {
  return (
    <Box
      flexShrink={0}
      borderStyle="round"
      borderColor={focused ? resolveColor(theme.suggestion) : undefined}
      borderDimColor={!focused}
      paddingX={1}
    >
      <Text dimColor={!focused}>
        {"⌕ "}
        {query ? (
          focused ? (
            <>
              <Text>{query.slice(0, query.length)}</Text>
              <Text inverse>{" "}</Text>
            </>
          ) : (
            <Text>{query}</Text>
          )
        ) : (
          <Text dimColor>Search…</Text>
        )}
      </Text>
    </Box>
  );
}

interface RulesTabContentProps {
  /** Rules of the active tab, already filtered by the search query. */
  rows: RuleRow[];
  explanation: string;
  searchQuery: string;
  searchActive: boolean;
  onSelectRow: (value: string) => void;
  onClose: () => void;
  onSearchQueryChange: (query: string) => void;
  onSearchActiveChange: (active: boolean) => void;
  onHeaderFocusChange: (focused: boolean) => void;
  defaultFocusValue?: string;
  onFocusRow: (value: string) => void;
}

/**
 * One allow/ask/deny tab: the tab's explanation, its search box, and the rule
 * list with the create action as its first row. The tab header and this content
 * take turns owning the arrow keys — the Select is muted while the header or
 * the search box is in focus.
 */
function RulesTabContent({
  rows,
  explanation,
  searchQuery,
  searchActive,
  onSelectRow,
  onClose,
  onSearchQueryChange,
  onSearchActiveChange,
  onHeaderFocusChange,
  defaultFocusValue,
  onFocusRow,
}: RulesTabContentProps): React.ReactElement {
  const { headerFocused } = useTabHeaderFocus();

  useEffect(() => {
    onHeaderFocusChange(headerFocused);
  }, [headerFocused, onHeaderFocusChange]);

  const searchFocused = searchActive && !headerFocused;

  // The search box owns the keyboard while it is active.
  useInput((input, key) => {
    if (!searchActive) return;
    if (key.escape) {
      onSearchQueryChange("");
      onSearchActiveChange(false);
      return;
    }
    if (key.return) {
      onSearchActiveChange(false); // back to the list with the filter applied
      return;
    }
    if (key.backspace || key.delete) {
      if (searchQuery.length <= 1) {
        onSearchQueryChange("");
        onSearchActiveChange(false);
      } else {
        onSearchQueryChange(searchQuery.slice(0, -1));
      }
      return;
    }
    // The old guard tested `input.startsWith("[<")` — a report that was not
    // first in the chunk still got typed, and a paste starting with those two
    // characters was dropped whole. Strip the reports and keep the rest.
    const typed = stripMouseSequences(input);
    if (key.ctrl || key.meta || typed.length === 0) return;
    onSearchQueryChange(searchQuery + typed);
  });

  // List keys: Esc leaves the screen (or returns from the header), and the
  // first typed character starts a search. j/k stay with the Select.
  useInput((input, key) => {
    if (searchActive) return;
    if (headerFocused) {
      if (key.escape) onClose();
      return;
    }
    if (key.escape) return; // the focused list's Select owns Esc (→ close)
    if (key.ctrl || key.meta || input.length !== 1 || input.startsWith("[<")) return;
    if (input === "j" || input === "k" || input === " ") return;
    onSearchQueryChange(input);
    onSearchActiveChange(true);
  });

  const options: SelectOption[] = [];
  // The create action is the first row of every tab, and disappears while a
  // query is active (the reference drops it from search results).
  if (!searchQuery) options.push({ label: "Add a new rule…", value: "add-new-rule" });
  for (const row of rows) options.push({ label: row.text, value: row.id });

  return (
    <Box flexDirection="column">
      <Text>{explanation}</Text>
      <Box marginBottom={1} flexDirection="column">
        <RuleSearchBox query={searchQuery} focused={searchFocused} />
      </Box>
      {options.length > 0 && (
        <Select
          options={options}
          onChange={onSelectRow}
          onCancel={onClose}
          onFocus={onFocusRow}
          defaultValue={defaultFocusValue}
          visibleOptionCount={10}
          highlightText={searchQuery || undefined}
          keysActive={!searchActive && !headerFocused}
        />
      )}
    </Box>
  );
}

/**
 * Interactive /permissions manager (Claude Code PermissionRuleList equivalent):
 * a "Permissions:" tabbed pane with one list per behavior (Allow / Ask / Deny),
 * an always-present search box, "Add a new rule…" as the first row of each tab,
 * and a rounded delete confirmation. Rules come from settings, the workspace
 * config and this session; they use the Tool(spec:pattern) syntax from the
 * permission engine.
 */
export default function PermissionsView({
  userRules,
  projectRules,
  sessionRules,
  onPersistRules,
  onPersistProjectRules,
  onSessionRulesChange,
  onSummary,
  onClose,
}: PermissionsViewProps): React.ReactElement {
  const copy = (rules: PermissionRulesShape | undefined): PermissionRulesShape => ({
    allow: [...sectionRules(rules ?? {}, "allow")],
    ask: [...sectionRules(rules ?? {}, "ask")],
    deny: [...sectionRules(rules ?? {}, "deny")],
  });
  const [rules, setRules] = useState<PermissionRulesShape>(() => copy(userRules));
  // Shown only when they can be written back: a workspace's rules exist to be
  // read only in a trusted workspace, and that is also when the callback is
  // supplied. Rows that cannot be deleted would be a lie about the file.
  const [project, setProject] = useState<PermissionRulesShape>(() =>
    onPersistProjectRules ? copy(projectRules) : copy({}),
  );
  const [session, setSession] = useState(() => ({
    allow: [...sessionRules.allow],
    deny: [...sessionRules.deny],
  }));
  const [tab, setTab] = useState<Section>("allow");
  const [detailsRule, setDetailsRule] = useState<RuleRow | null>(null);
  const [mode, setMode] = useState<"list" | "add-rule" | "add-destination">("list");
  const [addSection, setAddSection] = useState<Section>("allow");
  const [pendingRule, setPendingRule] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [headerFocused, setHeaderFocused] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  // rule text -> higher-precedence rules that shadow it (dim row warnings).
  const [shadowedBy, setShadowedBy] = useState<Record<string, string[]>>(() => {
    const r = copy(userRules);
    const p = onPersistProjectRules ? copy(projectRules) : {};
    const s = { allow: [...sessionRules.allow], deny: [...sessionRules.deny] };
    return computeShadowedMap(ruleEntries([r, p], s));
  });
  const focusedIdRef = useRef<string | null>(null);
  const changeRef = useRef<string[]>([]);

  // Rows of the active tab, sorted by lowercase rule text (localeCompare).
  const rows = useMemo<RuleRow[]>(() => {
    const out: RuleRow[] = [];
    const append = (source: RuleSource, settings: PermissionRulesShape) => {
      sectionRules(settings, tab)
        .slice()
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .forEach((text, i) => {
          out.push({ id: `${source}:${tab}:${i}`, section: tab, source, text });
        });
    };
    append("user", rules);
    append("project", project);
    // Session rules are allow/deny only — the engine has no session "ask".
    if (tab === "allow" || tab === "deny") {
      session[tab]
        .slice()
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .forEach((text, i) => {
          out.push({ id: `session:${tab}:${i}`, section: tab, source: "session", text });
        });
    }
    return out;
  }, [rules, project, session, tab]);

  const filteredRows = useMemo(() => {
    if (!filterQuery) return rows;
    const q = filterQuery.toLowerCase();
    return rows.filter((r) => r.text.toLowerCase().includes(q));
  }, [rows, filterQuery]);

  // Keep the focused-row ref valid as the list changes underneath us.
  useEffect(() => {
    if (!rows.some((r) => r.id === focusedIdRef.current)) {
      focusedIdRef.current = rows[0]?.id ?? null;
    }
  }, [rows]);

  const clearFilter = () => {
    setFilterQuery("");
    setSearchActive(false);
  };

  const commit = (next: PermissionRulesShape) => {
    setRules(next);
    onPersistRules(next);
  };

  const commitProject = (next: PermissionRulesShape) => {
    setProject(next);
    onPersistProjectRules?.(next);
  };

  const commitSession = (next: { allow: string[]; deny: string[] }) => {
    setSession(next);
    onSessionRulesChange(next);
  };

  /** The shadow scan runs over every scope, since that is what the engine
   *  matches against: a rule can be shadowed by one written in another file. */
  const rescan = (
    user: PermissionRulesShape,
    proj: PermissionRulesShape,
    sess: { allow: string[]; deny: string[] },
  ) => setShadowedBy(computeShadowedMap(ruleEntries([user, proj], sess)));

  const deleteRow = (row: RuleRow) => {
    if (row.source === "session") {
      const next = { ...session };
      next[row.section as "allow" | "deny"] = next[row.section as "allow" | "deny"].filter(
        (r) => r !== row.text,
      );
      commitSession(next);
      rescan(rules, project, next);
    } else if (row.source === "project") {
      const next = removeRuleFromScope(project, row.section, row.text);
      commitProject(next);
      rescan(rules, next, session);
    } else {
      const next = removeRuleFromScope(rules, row.section, row.text);
      commit(next);
      rescan(next, project, session);
    }
    changeRef.current = [...changeRef.current, `Deleted ${row.section} rule ${row.text}`];
    setDetailsRule(null);
    setNote(`Removed ${row.section} rule: ${row.text}`);
    clearFilter();
  };

  const commitAdd = (destination: "project" | "user") => {
    if (!pendingRule) return;
    // Only the chosen scope is rewritten. Adding a rule to one file must not
    // copy the other file's rules into it — for a workspace that write is
    // trust-gated, and the two scopes are not interchangeable.
    let user = rules;
    let proj = project;
    if (destination === "project") {
      proj = addRuleToScope(project, addSection, pendingRule);
      commitProject(proj);
    } else {
      user = addRuleToScope(rules, addSection, pendingRule);
      commit(user);
    }
    const shadowers = findShadowingRules(pendingRule, addSection, ruleEntries([user, proj], session));
    if (shadowers.length > 0) {
      setShadowedBy((prev) => ({ ...prev, [pendingRule]: shadowers }));
    }
    changeRef.current = [...changeRef.current, `Added ${addSection} rule ${pendingRule}`];
    setNote(
      `Added ${addSection} rule: ${pendingRule}${
        shadowers.length > 0 ? ` · Warning: rule is shadowed by ${shadowers.join(", ")}` : ""
      }`,
    );
    setPendingRule(null);
    clearFilter();
    setMode("list");
  };

  const close = () => {
    const changes = changeRef.current;
    onSummary?.(changes.length > 0 ? changes.join("; ") : "Permissions dialog dismissed");
    onClose();
  };

  const handleHeaderFocusChange = useCallback((focused: boolean) => setHeaderFocused(focused), []);

  /** Enter on a row: the create action starts the add flow for this tab,
   *  anything else opens that rule's delete confirmation. */
  const selectRow = (value: string) => {
    if (value === "add-new-rule") {
      setAddSection(tab);
      setNote(null);
      setMode("add-rule");
      return;
    }
    const row = rows.find((r) => r.id === value);
    if (row) setDetailsRule(row);
  };

  const destinationOptions = useMemo<SelectOption<"project" | "user">[]>(() => {
    const opts: SelectOption<"project" | "user">[] = [
      { label: "User settings", value: "user", description: USER_SETTINGS_PATH },
    ];
    if (onPersistProjectRules) {
      opts.unshift({ label: "Project settings", value: "project", description: PROJECT_CONFIG_PATH });
    }
    return opts;
  }, [onPersistProjectRules]);

  const guide = permissionsGuide(headerFocused, searchActive);

  return (
    <>
      {detailsRule ? (
        <DeleteRuleCard
          rule={detailsRule}
          shadowers={shadowedBy[detailsRule.text]}
          onDelete={() => deleteRow(detailsRule)}
          onCancel={() => setDetailsRule(null)}
        />
      ) : mode === "add-rule" ? (
        <InputDialog
          title={`Add ${addSection} rule`}
          subtitle='Syntax: Tool(spec:pattern) — e.g. Read(**), Edit(src/**), Bash(git *)'
          placeholder="Edit(src/**)"
          onSubmit={(value) => {
            const parsed = parseRule(value);
            if (!parsed.toolName) {
              setNote("Rule didn't parse — use Tool(spec:pattern) syntax.");
              setMode("list");
              return;
            }
            setPendingRule(value);
            setMode("add-destination");
          }}
          onCancel={() => setMode("list")}
        />
      ) : mode === "add-destination" ? (
        <Dialog
          title="Where should this rule be saved?"
          subtitle={`${pendingRule ?? ""} — ${addSection} rule`}
          onCancel={() => setMode("list")}
          footer="↑↓ to choose · enter to save · esc to cancel"
        >
          <Select
            options={destinationOptions}
            defaultValue="user"
            onChange={(destination) => commitAdd(destination)}
            onCancel={() => setMode("list")}
          />
        </Dialog>
      ) : (
        <Pane color="permission">
          <Tabs
            title="Permissions:"
            color="permission"
            selectedTab={tab}
            onTabChange={(id) => setTab(id as Section)}
            navFromContent={!searchActive}
            initialHeaderFocused
          >
            {TABS.map((section) => (
              <Tab key={section} id={section} title={TAB_TITLES[section]}>
                <RulesTabContent
                  rows={filteredRows}
                  explanation={TAB_EXPLANATIONS[section]}
                  searchQuery={filterQuery}
                  searchActive={searchActive}
                  onSelectRow={selectRow}
                  onClose={close}
                  onSearchQueryChange={setFilterQuery}
                  onSearchActiveChange={setSearchActive}
                  onHeaderFocusChange={handleHeaderFocusChange}
                  defaultFocusValue={focusedIdRef.current ?? undefined}
                  onFocusRow={(id) => {
                    focusedIdRef.current = id;
                  }}
                />
              </Tab>
            ))}
          </Tabs>
          {note && (
            <Box marginTop={1}>
              <Text dimColor>{note}</Text>
            </Box>
          )}
          <Box marginTop={1} paddingLeft={1}>
            <Text dimColor>{guide}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Settings rules persist to ~/.deepseek-code/settings.json
              {onPersistProjectRules ? ` · project rules to ${PROJECT_CONFIG_PATH}` : ""} · session
              rules vanish on /clear or exit
            </Text>
          </Box>
        </Pane>
      )}
    </>
  );
}
