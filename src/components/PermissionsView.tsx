
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { join } from "node:path";
import { homedir } from "node:os";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select, type SelectOption } from "../ui/design-system/Select.js";
import InputDialog from "./InputDialog.js";
import { theme, resolveColor } from "../utils/theme.js";
import { parseRule } from "../services/permissions.js";
import {
  behaviorLabel,
  computeShadowedMap,
  describeRule,
  findShadowingRules,
  type RuleEntry,
  type Section,
} from "./permissionsRuleUtils.js";

export interface PermissionRulesShape {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface PermissionsViewProps {
  persistedRules: PermissionRulesShape;
  sessionRules: { allow: string[]; deny: string[] };
  /** Persist the settings-level rules (writes settings.json). */
  onPersistRules: (rules: PermissionRulesShape) => void;
  /** Persist to the project .deepseek-code.json (optional — hides that destination). */
  onPersistProjectRules?: (rules: PermissionRulesShape) => void;
  /** Update the live session-only rules. */
  onSessionRulesChange: (rules: { allow: string[]; deny: string[] }) => void;
  /** Report a joined summary of changes when closing (system note). */
  onSummary?: (summary: string) => void;
  onClose: () => void;
}

interface RuleRow {
  id: string;
  section: Section;
  source: "settings" | "session";
  text: string;
}

const SECTION_ORDER: Section[] = ["allow", "ask", "deny"];

const USER_SETTINGS_PATH = join(homedir(), ".deepseek-code", "settings.json");
const PROJECT_CONFIG_PATH = join(process.cwd(), ".deepseek-code.json");

function sectionRules(rules: PermissionRulesShape, section: Section): string[] {
  return rules[section] ?? [];
}

/** All rules (settings + session) as flat entries for the shadowing scan. */
function ruleEntries(
  rules: PermissionRulesShape,
  session: { allow: string[]; deny: string[] },
): RuleEntry[] {
  const out: RuleEntry[] = [];
  for (const section of SECTION_ORDER) {
    for (const text of sectionRules(rules, section)) out.push({ section, text });
  }
  for (const section of ["allow", "deny"] as const) {
    for (const text of session[section]) out.push({ section, text });
  }
  return out;
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

/**
 * Interactive /permissions manager (Claude Code PermissionRuleList equivalent):
 * allow/ask/deny rules from settings plus this-session rules, with add (choose
 * a save destination), delete (Enter a rule → Yes/No confirmation panel),
 * type-to-filter, and shadowed-rule warnings. Rules use the Tool(spec:pattern)
 * syntax from the permission engine.
 */
export default function PermissionsView({
  persistedRules,
  sessionRules,
  onPersistRules,
  onPersistProjectRules,
  onSessionRulesChange,
  onSummary,
  onClose,
}: PermissionsViewProps): React.ReactElement {
  const [rules, setRules] = useState<PermissionRulesShape>(() => ({
    allow: [...sectionRules(persistedRules, "allow")],
    ask: [...sectionRules(persistedRules, "ask")],
    deny: [...sectionRules(persistedRules, "deny")],
  }));
  const [session, setSession] = useState(() => ({
    allow: [...sessionRules.allow],
    deny: [...sessionRules.deny],
  }));
  const [detailsRule, setDetailsRule] = useState<RuleRow | null>(null);
  const [mode, setMode] = useState<"list" | "add-section" | "add-rule" | "add-destination">("list");
  const [addSection, setAddSection] = useState<Section>("allow");
  const [pendingRule, setPendingRule] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // rule text -> higher-precedence rules that shadow it (dim row warnings).
  const [shadowedBy, setShadowedBy] = useState<Record<string, string[]>>(() => {
    const r: PermissionRulesShape = {
      allow: [...sectionRules(persistedRules, "allow")],
      ask: [...sectionRules(persistedRules, "ask")],
      deny: [...sectionRules(persistedRules, "deny")],
    };
    const s = { allow: [...sessionRules.allow], deny: [...sessionRules.deny] };
    return computeShadowedMap(ruleEntries(r, s));
  });
  const focusedIdRef = useRef<string | null>(null);
  const changeRef = useRef<string[]>([]);

  // Rows sorted within each section by lowercase rule text (localeCompare).
  const rows = useMemo<RuleRow[]>(() => {
    const out: RuleRow[] = [];
    for (const section of SECTION_ORDER) {
      sectionRules(rules, section)
        .slice()
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .forEach((text, i) => {
          out.push({ id: `settings:${section}:${i}`, section, source: "settings", text });
        });
    }
    for (const section of ["allow", "deny"] as const) {
      session[section]
        .slice()
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .forEach((text, i) => {
          out.push({ id: `session:${section}:${i}`, section, source: "session", text });
        });
    }
    return out;
  }, [rules, session]);

  const filteredRows = useMemo(() => {
    if (!filterQuery) return rows;
    const q = filterQuery.toLowerCase();
    return rows.filter((r) => r.text.toLowerCase().includes(q));
  }, [rows, filterQuery]);

  const options = useMemo<SelectOption[]>(
    () =>
      filteredRows.map((row) => {
        const shadowers = shadowedBy[row.text];
        const warning =
          shadowers && shadowers.length > 0
            ? ` · Warning: shadowed by ${shadowers.join(", ")}`
            : "";
        return {
          value: row.id,
          label: row.text,
          description: `${row.section} rule · ${
            row.source === "settings" ? "From settings" : "(this session)"
          }${warning}`,
        };
      }),
    [filteredRows, shadowedBy],
  );

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

  const commitSession = (next: { allow: string[]; deny: string[] }) => {
    setSession(next);
    onSessionRulesChange(next);
  };

  const deleteRow = (row: RuleRow) => {
    if (row.source === "session") {
      const next = { ...session };
      next[row.section as "allow" | "deny"] = next[row.section as "allow" | "deny"].filter(
        (r) => r !== row.text,
      );
      commitSession(next);
      setShadowedBy(computeShadowedMap(ruleEntries(rules, next)));
    } else {
      const next = { ...rules };
      next[row.section] = sectionRules(next, row.section).filter((r) => r !== row.text);
      commit(next);
      setShadowedBy(computeShadowedMap(ruleEntries(next, session)));
    }
    changeRef.current = [...changeRef.current, `Deleted ${row.section} rule ${row.text}`];
    setDetailsRule(null);
    setNote(`Removed ${row.section} rule: ${row.text}`);
    clearFilter();
  };

  const commitAdd = (destination: "project" | "user") => {
    if (!pendingRule) return;
    const next = { ...rules };
    next[addSection] = [...sectionRules(next, addSection), pendingRule];
    setRules(next);
    if (destination === "project") onPersistProjectRules?.(next);
    else onPersistRules(next);
    const shadowers = findShadowingRules(pendingRule, addSection, ruleEntries(next, session));
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

  // List-mode commands + type-to-filter trigger. Select owns arrows/enter/esc
  // while it is rendered; Esc falls back to this handler when no Select shows.
  useInput((input, key) => {
    if (mode !== "list" || detailsRule || searchActive) return;

    if (key.escape) {
      if (rows.length === 0 || filteredRows.length === 0) {
        if (filterQuery) clearFilter();
        else close();
      }
      return;
    }
    if (key.ctrl || key.meta || input.length !== 1 || input.startsWith("[<")) return;

    if (input === "a") {
      setMode("add-section");
      return;
    }
    if (input === "d") {
      const target = rows.find((r) => r.id === focusedIdRef.current) ?? rows[0];
      if (target) setDetailsRule(target);
      return;
    }
    // j/k are Select navigation; space makes no sense as a filter start.
    if (input === "j" || input === "k" || input === " ") return;
    setFilterQuery(input);
    setSearchActive(true);
  });

  // The filter input owns the keyboard while searchActive (Select keysActive off).
  useInput((input, key) => {
    if (mode !== "list" || detailsRule || !searchActive) return;

    if (key.escape) {
      clearFilter();
      return;
    }
    if (key.return) {
      setSearchActive(false); // back to the list with the filter applied
      return;
    }
    if (key.backspace || key.delete) {
      if (filterQuery.length <= 1) clearFilter();
      else setFilterQuery((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || input.startsWith("[<") || input.length === 0) return;
    setFilterQuery((prev) => prev + input);
  });

  const handleListCancel = () => {
    if (filterQuery) clearFilter();
    else close();
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

  return (
    <>
      {detailsRule ? (
        <Dialog
          title={`Delete ${behaviorLabel(detailsRule.section)} tool?`}
          onCancel={() => setDetailsRule(null)}
          color="error"
          footer={
            <Text>
              <Text bold>↑↓</Text> choose · <Text bold>enter</Text> confirm · <Text bold>esc</Text>{" "}
              cancel
            </Text>
          }
        >
          <Box flexDirection="column" gap={1}>
            <Text bold>{detailsRule.text}</Text>
            <RuleDescriptionText text={detailsRule.text} />
            <Text dimColor>
              {detailsRule.source === "settings" ? "From settings" : "From this session"}
            </Text>
            <Text>Are you sure you want to delete this permission rule?</Text>
            <Select
              options={[
                { label: "Yes", value: "yes" },
                { label: "No", value: "no" },
              ]}
              onChange={(value) => (value === "yes" ? deleteRow(detailsRule) : setDetailsRule(null))}
              onCancel={() => setDetailsRule(null)}
            />
          </Box>
        </Dialog>
      ) : mode === "add-section" ? (
        <Dialog
          title="Add permission rule"
          subtitle="Which section should the rule live in?"
          onCancel={() => setMode("list")}
          footer="↑↓ to choose · enter to continue · esc to cancel"
        >
          <Select
            options={[
              { label: "allow", value: "allow", description: "Auto-approve matching tool calls" },
              { label: "ask", value: "ask", description: "Always prompt, even if another rule allows" },
              { label: "deny", value: "deny", description: "Hard-block matching tool calls" },
            ]}
            defaultValue={addSection}
            onChange={(value) => {
              setAddSection(value);
              setMode("add-rule");
            }}
            onCancel={() => setMode("list")}
            enableNumberKeys
          />
        </Dialog>
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
        <Dialog
          title="Permission rules"
          subtitle="Tool(spec:pattern) · deny > ask > allow · settings + this-session rules"
          onCancel={close}
          cancelActive={false}
          footer={
            <Text>
              <Text bold>type</Text> to filter · <Text bold>enter</Text>/<Text bold>↓</Text> select ·{" "}
              <Text bold>esc</Text> clear/close · <Text bold>a</Text> add
            </Text>
          }
        >
          {searchActive && (
            <Box marginBottom={1}>
              <Text color={resolveColor(theme.claude)}>{"> "}</Text>
              <Text>{filterQuery}</Text>
              <Text inverse> </Text>
            </Box>
          )}
          {rows.length === 0 ? (
            <Text dimColor>
              No rules configured — tools prompt interactively. Press <Text bold>a</Text> to add one.
            </Text>
          ) : filteredRows.length === 0 ? (
            <Text dimColor>
              No rules match the filter — press <Text bold>esc</Text> to clear.
            </Text>
          ) : (
            <Select
              options={options}
              onChange={(id) => {
                const row = rows.find((r) => r.id === id);
                if (row) setDetailsRule(row);
              }}
              onCancel={handleListCancel}
              onFocus={(id) => {
                focusedIdRef.current = id;
              }}
              defaultValue={focusedIdRef.current ?? undefined}
              visibleOptionCount={10}
              highlightText={filterQuery || undefined}
              keysActive={!searchActive}
            />
          )}
          {note && (
            <Box marginTop={1}>
              <Text dimColor>{note}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>
              Settings rules persist to ~/.deepseek-code/settings.json · session rules vanish on
              /clear or exit
            </Text>
          </Box>
        </Dialog>
      )}
    </>
  );
}
