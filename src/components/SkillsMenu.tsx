
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { homedir } from "node:os";
import { Dialog } from "../ui/design-system/Dialog.js";
import { theme, resolveColor } from "../utils/theme.js";
import {
  listSkills,
  getSkill,
  getSkillSourceDir,
  type SkillContent,
  type SkillInfo,
  type SkillSource,
} from "../skills/skillService.js";

export interface SkillsMenuProps {
  onClose: () => void;
}

const DETAIL_HEIGHT = 14;
const VISIBLE_ROWS = 6;

export interface SkillGroup {
  source: SkillSource;
  title: string;
  subtitle: string;
  rows: SkillInfo[];
}

const GROUP_TITLES: Record<SkillSource, string> = {
  project: "Project skills",
  user: "User skills",
  bundled: "Bundled skills",
  plugin: "Plugin skills",
};

/** Shorten an on-disk path for display: `.` for cwd (checked first — the
 *  repo usually lives under the home dir), `~` for home. */
function displayPath(p: string): string {
  const cwd = process.cwd();
  if (p.startsWith(cwd)) return p.replace(cwd, ".");
  const home = homedir();
  if (p.startsWith(home)) return p.replace(home, "~");
  return p;
}

function normalizeFullWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
}

function groupSubtitle(source: SkillSource): string {
  return displayPath(getSkillSourceDir(source));
}

/** Group skills by source (project > user > bundled > plugin), each sorted by name. */
export function groupSkills(skills: SkillInfo[]): SkillGroup[] {
  const bySource = new Map<SkillSource, SkillInfo[]>();
  for (const skill of skills) {
    const list = bySource.get(skill.source) ?? [];
    list.push(skill);
    bySource.set(skill.source, list);
  }
  const groups: SkillGroup[] = [];
  for (const source of ["project", "user", "bundled", "plugin"] as const) {
    const rows = bySource.get(source);
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ source, title: GROUP_TITLES[source], subtitle: groupSubtitle(source), rows });
  }
  return groups;
}

/**
 * Interactive /skills menu (Claude Code SkillsMenu equivalent): skills grouped
 * by source with bold dim headers showing their on-disk directory, arrow
 * through them, Enter opens the SKILL.md body in a scrollable pane.
 */
export default function SkillsMenu({ onClose }: SkillsMenuProps): React.ReactElement {
  const [mode, setMode] = useState<"list" | "detail">("list");
  const [detail, setDetail] = useState<SkillContent | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmedName, setConfirmedName] = useState<string | undefined>();
  const detailRef = useRef(detail);
  detailRef.current = detail;

  const skills = listSkills();
  const groups = groupSkills(skills);
  const rows: SkillInfo[] = [];
  for (const group of groups) rows.push(...group.rows);
  // Group owning each flat row, for header placement inside the window.
  const rowGroups: SkillGroup[] = [];
  for (const group of groups) {
    for (const _row of group.rows) rowGroups.push(group);
  }
  const groupStart = new Map<SkillSource, number>();
  let acc = 0;
  for (const group of groups) {
    groupStart.set(group.source, acc);
    acc += group.rows.length;
  }

  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    setScrollTop(0);
  }, [detail]);

  const openSkill = (name: string) => {
    const skill = getSkill(name);
    if (!skill) return;
    setConfirmedName(skill.name);
    setDetail(skill);
    setMode("detail");
  };

  const moveTo = (index: number) => {
    if (rowsRef.current.length === 0) return;
    setSelectedIndex(((index % rowsRef.current.length) + rowsRef.current.length) % rowsRef.current.length);
  };

  useInput((_input, key) => {
    if (mode !== "list" || rowsRef.current.length === 0) return;
    if (key.upArrow || _input === "k") {
      moveTo(selectedIndexRef.current - 1);
    } else if (key.downArrow || _input === "j") {
      moveTo(selectedIndexRef.current + 1);
    } else if ((key.ctrl && _input === "p") || (key.ctrl && _input === "n")) {
      moveTo(selectedIndexRef.current + (_input === "p" ? -1 : 1));
    } else if (key.pageUp) {
      moveTo(selectedIndexRef.current - VISIBLE_ROWS);
    } else if (key.pageDown) {
      moveTo(selectedIndexRef.current + VISIBLE_ROWS);
    } else if (key.return) {
      const row = rowsRef.current[selectedIndexRef.current];
      if (row) openSkill(row.name);
    } else if (key.escape) {
      onClose();
    } else if (!key.ctrl && /^[0-9]+$/.test(normalizeFullWidthDigits(_input))) {
      // Digit keys jump to absolute index (reference Select semantics).
      const row = rowsRef.current[parseInt(normalizeFullWidthDigits(_input), 10) - 1];
      if (row) {
        setSelectedIndex(rowsRef.current.indexOf(row));
        openSkill(row.name);
      }
    }
  });

  useInput((_input, key) => {
    if (mode !== "detail" || !detailRef.current) return;
    const lines = detailRef.current.content.split("\n");
    const maxTop = Math.max(0, lines.length - DETAIL_HEIGHT);
    if (key.escape || _input === "q" || key.return) {
      setMode("list");
      setDetail(null);
      return;
    }
    if (key.upArrow) {
      setScrollTop((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setScrollTop((prev) => Math.min(maxTop, prev + 1));
      return;
    }
    if (key.pageUp) {
      setScrollTop((prev) => Math.max(0, prev - DETAIL_HEIGHT));
      return;
    }
    if (key.pageDown) {
      setScrollTop((prev) => Math.min(maxTop, prev + DETAIL_HEIGHT));
      return;
    }
    if (_input === "g") {
      setScrollTop(0);
      return;
    }
    if (_input === "G") {
      setScrollTop(maxTop);
    }
  });

  if (skills.length === 0) {
    return (
      <Dialog
        title="Skills"
        subtitle="SKILL.md instructions the agent can load on demand"
        onCancel={onClose}
        footer="esc to close"
      >
        <Text dimColor>
          No skills available. Add SKILL.md files to .claude/skills/&lt;name&gt;/ in this project
          or ~/.claude/skills/&lt;name&gt;/ for user-wide skills.
        </Text>
      </Dialog>
    );
  }

  if (mode === "detail" && detail) {
    const lines = detail.content.split("\n");
    const visible = lines.slice(scrollTop, scrollTop + DETAIL_HEIGHT);
    return (
      <Dialog
        title={`Skill: ${detail.name}`}
        subtitle={`${detail.description || "no description"} · ${detail.source} · ${detail.path}`}
        onCancel={onClose}
        footer="↑↓ scroll · pgup/pgdn page · esc back to list"
      >
        <Box flexDirection="column">
          {visible.map((line, i) => (
            <Text key={scrollTop + i} wrap="truncate-end">
              {line === "" ? " " : line}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {`lines ${scrollTop + 1}–${Math.min(lines.length, scrollTop + DETAIL_HEIGHT)} of ${lines.length}`}
          </Text>
        </Box>
      </Dialog>
    );
  }

  const focusColor = resolveColor(theme.claude);
  const successColor = resolveColor(theme.success);

  const windowSize = Math.max(1, Math.min(VISIBLE_ROWS, rows.length));
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(windowSize / 2), rows.length - windowSize));
  const end = start + windowSize;
  const moreAbove = start > 0;
  const moreBelow = end < rows.length;
  const indexLabelWidth = String(rows.length).length;

  return (
    <Dialog
      title="Skills"
      subtitle={`${skills.length} available · project > user > bundled precedence`}
      onCancel={onClose}
      footer="↑↓ to choose · enter to read · esc to cancel"
    >
      <Box flexDirection="column">
        {Array.from({ length: end - start }, (_, k) => start + k).map((i) => {
          const row = rows[i]!;
          const group = rowGroups[i]!;
          const focused = i === selectedIndex;
          const isSelected = row.name === confirmedName;

          let marker: string;
          if (focused) marker = "❯ ";
          else if (isSelected) marker = "✓ ";
          else if (moreAbove && i === start) marker = "↑ ";
          else if (moreBelow && i === end - 1) marker = "↓ ";
          else marker = "  ";

          const markerColor = focused ? focusColor : isSelected ? successColor : undefined;
          const suffix = [
            row.pluginName ? ` · ${row.pluginName}` : "",
            ` · ~${row.estimatedTokens} description tokens`,
          ].join("");

          return (
            <Box key={`${row.name}-${row.source}`} flexDirection="column">
              {i === groupStart.get(group.source) && (
                <Box>
                  <Text bold dimColor>
                    {group.title}
                  </Text>
                  <Text dimColor>{` (${group.subtitle})`}</Text>
                </Box>
              )}
              <Box>
                <Text color={markerColor}>{marker}</Text>
                <Text dimColor>{`${String(i + 1).padStart(indexLabelWidth)}. `}</Text>
                <Text color={focused ? focusColor : undefined} bold={focused}>
                  {row.name}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {suffix}
                </Text>
              </Box>
            </Box>
          );
        })}
        {rows.length > end && (
          <Text dimColor>{`  and ${rows.length - end} more…`}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Invoke from the prompt with /skills &lt;name&gt; or let the model load them via the Skill tool</Text>
      </Box>
    </Dialog>
  );
}
