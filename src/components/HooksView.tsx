
import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select } from "../ui/design-system/Select.js";
import InputDialog from "./InputDialog.js";
import { theme, resolveColor } from "../utils/theme.js";
import {
  HOOK_EVENTS,
  countHooks,
  eventSupportsMatcher,
  getHookDisplayText,
  getHookFieldLabel,
  getHookTypeLabel,
  loadHooks,
  type HookConfig,
  type HookEvent,
  type HookGroup,
  type HooksConfig,
} from "../services/hooks.js";
import { saveSettings } from "../state/storage.js";

export interface HooksViewProps {
  onClose: () => void;
}

const EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
  PreToolUse: "before a tool runs — exit 2 or JSON block decision can veto",
  PostToolUse: "after a tool finishes",
  UserPromptSubmit: "when you submit a prompt",
  Stop: "when a response turn completes",
  Notification: "when the app notifies (e.g. permission needed)",
};

/** Matchers are never evaluated for these events, so the add flow skips the step. */
const NO_MATCHER_EVENTS: readonly HookEvent[] = ["UserPromptSubmit", "Stop"];

interface HookRow {
  event: HookEvent;
  groupIdx: number;
  hookIdx: number;
  matcher: string;
  hook: HookConfig;
  enabled: boolean;
}

type Mode =
  | "list"
  | "add-event"
  | "add-matcher"
  | "add-command"
  | "detail";

/**
 * Interactive /hooks manager (Claude Code HooksConfigMenu equivalent): hooks
 * grouped by lifecycle event with add, delete, enable/disable, and an inspect
 * view for full command/matcher/type details. Changes save to settings.json
 * and take effect immediately.
 */
export default function HooksView({ onClose }: HooksViewProps): React.ReactElement {
  const [config, setConfig] = useState<HooksConfig>(() => loadHooks());
  const [focusIndex, setFocusIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("list");
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [addEvent, setAddEvent] = useState<HookEvent>("PreToolUse");
  const [addMatcher, setAddMatcher] = useState("*");
  const [note, setNote] = useState<string | null>(null);

  const counts = useMemo(() => countHooks(config), [config]);

  const rows = useMemo<HookRow[]>(() => {
    const out: HookRow[] = [];
    for (const event of HOOK_EVENTS) {
      const groups = config[event] ?? [];
      groups.forEach((group, groupIdx) => {
        (group.hooks ?? []).forEach((hook, hookIdx) => {
          out.push({
            event,
            groupIdx,
            hookIdx,
            matcher: group.matcher ?? "*",
            hook,
            enabled: group.enabled !== false,
          });
        });
      });
    }
    return out;
  }, [config]);

  const commit = (next: HooksConfig) => {
    setConfig(next);
    saveSettings({ hooks: next });
  };

  const deleteRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const groups = [...(config[row.event] ?? [])];
    const group = { ...groups[row.groupIdx]! };
    const hooks = [...(group.hooks ?? [])];
    hooks.splice(row.hookIdx, 1);
    if (hooks.length === 0) {
      groups.splice(row.groupIdx, 1);
    } else {
      group.hooks = hooks;
      groups[row.groupIdx] = group;
    }
    const next = { ...config, [row.event]: groups };
    commit(next);
    setPendingDelete(null);
    setFocusIndex((prev) => Math.min(prev, Math.max(0, rows.length - 2)));
    setNote(`Removed ${row.event} hook: ${getHookDisplayText(row.hook)}`);
  };

  const toggleRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const groups = [...(config[row.event] ?? [])];
    const group = { ...groups[row.groupIdx]!, enabled: !(row.enabled) };
    groups[row.groupIdx] = group;
    commit({ ...config, [row.event]: groups });
    setNote(
      group.enabled === false
        ? `Disabled ${row.event} hook: ${getHookDisplayText(row.hook)}`
        : `Enabled ${row.event} hook: ${getHookDisplayText(row.hook)}`,
    );
  };

  const addHook = (command: string) => {
    const groups: HookGroup[] = [...(config[addEvent] ?? [])];
    const existing = groups.find((g) => (g.matcher ?? "*") === addMatcher);
    if (existing) {
      const updated = {
        ...existing,
        hooks: [...(existing.hooks ?? []), { type: "command" as const, command }],
      };
      groups[groups.indexOf(existing)] = updated;
    } else {
      groups.push({ matcher: addMatcher, hooks: [{ type: "command" as const, command }] });
    }
    commit({ ...config, [addEvent]: groups });
    setNote(`Added ${addEvent} hook: ${command}`);
    setMode("list");
  };

  useInput((input, key) => {
    if (mode !== "list") return; // Select/InputDialog/Dialog own the keys elsewhere.

    if (key.escape) {
      if (pendingDelete !== null) {
        setPendingDelete(null);
        return;
      }
      onClose();
      return;
    }
    if (key.upArrow) {
      setFocusIndex((prev) => Math.max(0, prev - 1));
      setPendingDelete(null);
      return;
    }
    if (key.downArrow) {
      setFocusIndex((prev) => Math.min(Math.max(0, rows.length - 1), prev + 1));
      setPendingDelete(null);
      return;
    }
    if (rows.length === 0) {
      if (input === "a") setMode("add-event");
      return;
    }
    const index = Math.min(focusIndex, rows.length - 1);

    if (pendingDelete === index && (input === "d" || input === "y")) {
      deleteRow(index);
      return;
    }
    if (pendingDelete === null && (key.return || input === "v")) {
      setDetailIndex(index);
      setMode("detail");
      return;
    }
    if (input === "d") {
      setPendingDelete(index);
      return;
    }
    if (input === "e") {
      toggleRow(index);
      return;
    }
    if (input === "a") {
      setMode("add-event");
      return;
    }
    if (pendingDelete !== null) setPendingDelete(null);
  });

  const focusedRow = rows.length > 0 ? rows[Math.min(focusIndex, rows.length - 1)] : null;
  const detailRow = detailIndex !== null ? rows[detailIndex] : null;

  return (
    <>
      {mode === "add-event" && (
        <Dialog
          title="Add hook"
          subtitle="Which lifecycle event should fire the hook?"
          onCancel={() => setMode("list")}
          footer="↑↓ to choose · enter to continue · esc to cancel"
        >
          <Select
            options={HOOK_EVENTS.map((event) => ({
              label: event,
              value: event,
              description: EVENT_DESCRIPTIONS[event],
            }))}
            defaultValue={addEvent}
            onChange={(value) => {
              setAddEvent(value);
              // Runtime never evaluates matchers for these events — skip the step.
              if (NO_MATCHER_EVENTS.includes(value)) {
                setMode("add-command");
              } else {
                setMode("add-matcher");
              }
            }}
            onCancel={() => setMode("list")}
          />
        </Dialog>
      )}

      {mode === "add-matcher" && (
        <InputDialog
          title={`${addEvent} — matcher`}
          subtitle={
            addEvent === "Notification"
              ? "Matcher is stored for settings.json parity but ignored at runtime — hooks always run"
              : "Tool name(s) this hook applies to (comma-separated), or * for all"
          }
          initial={addMatcher === "*" ? "" : addMatcher}
          placeholder="*  (Bash for a single tool, Bash|Edit comma list for several)"
          allowEmpty
          onSubmit={(value) => {
            setAddMatcher(value.trim() || "*");
            setMode("add-command");
          }}
          onCancel={() => setMode("list")}
        />
      )}

      {mode === "add-command" && (
        <InputDialog
          title={`${addEvent} — command`}
          subtitle="Shell command to run. Payload arrives on stdin as JSON; PreToolUse can block with exit code 2"
          placeholder="./scripts/notify.sh"
          onSubmit={(value) => addHook(value)}
          onCancel={() => setMode("list")}
        />
      )}

      {mode === "detail" && detailRow && (
        <Dialog
          title="Hook details"
          onCancel={() => setMode("list")}
          footer="esc to close"
        >
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text>
                Event: <Text bold>{detailRow.event}</Text>
              </Text>
              <Text>
                Matcher: <Text bold>{detailRow.matcher}</Text>
                {!eventSupportsMatcher(detailRow.event) && (
                  <Text dimColor>{" (ignored at runtime)"}</Text>
                )}
              </Text>
              <Text>
                Type: <Text bold>{getHookTypeLabel(detailRow.hook)}</Text>
                {!detailRow.enabled && <Text dimColor>{" (disabled)"}</Text>}
              </Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor>{`${getHookFieldLabel(detailRow.hook)}:`}</Text>
              <Box borderStyle="round" borderDimColor paddingX={1}>
                <Text wrap="wrap">{getHookDisplayText(detailRow.hook)}</Text>
              </Box>
            </Box>
            <Text dimColor>To modify, edit ~/.deepseek-code/settings.json directly.</Text>
          </Box>
        </Dialog>
      )}

      {mode === "list" && (
        <Dialog
          title="Lifecycle hooks"
          subtitle={`${counts.total} ${counts.total === 1 ? "hook" : "hooks"} configured · fires shell commands on app events · saved to settings.json`}
          onCancel={onClose}
          footer={
            <Text>
              <Text bold>↑↓</Text> focus · <Text bold>a</Text> add · <Text bold>e</Text> enable/disable · <Text bold>d</Text> delete · <Text bold>v</Text> inspect · <Text bold>esc</Text> close
            </Text>
          }
        >
          {rows.length === 0 ? (
            <Text dimColor>
              No hooks configured. Press <Text bold>a</Text> to add one, or edit
              ~/.deepseek-code/settings.json directly.
            </Text>
          ) : (
            <Box flexDirection="column">
              {HOOK_EVENTS.map((event) => {
                const eventRows = rows
                  .map((row, index) => ({ row, index }))
                  .filter(({ row }) => row.event === event);
                if (eventRows.length === 0) return null;
                return (
                  <Box flexDirection="column" key={event}>
                    <Text bold color={resolveColor(theme.suggestion)}>
                      {event} ({counts.perEvent[event] ?? 0})
                    </Text>
                    {eventRows.map(({ row, index }) => {
                      const focused = index === Math.min(focusIndex, rows.length - 1);
                      return (
                        <Box key={`${row.groupIdx}-${row.hookIdx}`}>
                          <Text color={focused ? resolveColor(theme.claude) : undefined} bold={focused}>
                            {focused ? "❯ " : "  "}
                          </Text>
                          <Text dimColor>{`[${row.matcher}] `}</Text>
                          <Text dimColor>{`[${getHookTypeLabel(row.hook)}] `}</Text>
                          <Text
                            color={row.enabled ? (focused ? resolveColor(theme.claude) : undefined) : resolveColor(theme.inactive)}
                            dimColor={!row.enabled}
                            wrap="truncate-end"
                          >
                            {getHookDisplayText(row.hook)}
                          </Text>
                          {!row.enabled && <Text dimColor>{" (disabled)"}</Text>}
                          {pendingDelete === index && (
                            <Text color={resolveColor(theme.error)}>{"  ✂ delete? press d/y"}</Text>
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                );
              })}
            </Box>
          )}
          {note && (
            <Box marginTop={1}>
              <Text dimColor>{note}</Text>
            </Box>
          )}
          {focusedRow && (
            <Box marginTop={1}>
              <Text dimColor>{EVENT_DESCRIPTIONS[focusedRow.event]}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>
              Payload arrives on stdin as JSON — fields: event, cwd, tool + input (Pre/PostToolUse), prompt (UserPromptSubmit), notification (Notification)
            </Text>
          </Box>
        </Dialog>
      )}
    </>
  );
}
