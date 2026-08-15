import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout, type Key } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select } from "../ui/design-system/Select.js";
import InputDialog from "./InputDialog.js";
import { resolveColor, theme } from "../utils/theme.js";
import { fuzzyFilter } from "../utils/fuzzy.js";
import { updateSession, type SessionData } from "../state/storage.js";
import stringWidth from "string-width";

export interface SessionPickerProps {
  sessions: SessionData[];
  currentDirectory: string;
  /** Resume the focused session (App loads its messages into the chat). */
  onResume: (session: SessionData) => void;
  /** Dismiss the picker entirely (Esc with an empty query). */
  onClose: () => void;
  /** Optional — lets App refresh its session list after a ctrl+r rename. */
  onRename?: (hash: string, title: string) => void;
}

const MAX_VISIBLE = 8;

/**
 * Matches `<lowercase-tag …>…</tag>` blocks injected by the tooling layer
 * (slash commands, hook output, task notifications). Only lowercase tag
 * names match so user prose mentioning HTML/JSX passes through.
 */
const DISPLAY_TAG_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g;

/** Strip system-injected XML wrapper tags from message text for display. */
export function stripDisplayTags(text: string): string {
  const result = text.replace(DISPLAY_TAG_PATTERN, "").trim();
  return result || text;
}

/** Like stripDisplayTags but empty when all content was tags (title fallback). */
function stripDisplayTagsAllowEmpty(text: string): string {
  return text.replace(DISPLAY_TAG_PATTERN, "").trim();
}

/** Truncate to `maxCols` display columns, appending a unicode ellipsis. */
export function truncateText(text: string, maxCols: number): string {
  if (stringWidth(text) <= maxCols) return text;
  let result = "";
  let width = 0;
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (width + charWidth > maxCols - 1) break;
    result += char;
    width += charWidth;
  }
  return `${result}…`;
}

/** Human title for a session row: user title → first user message → agent. */
export function deriveSessionTitle(session: SessionData): string {
  const custom = session.title?.trim();
  if (custom) return custom;
  const firstUser = session.messages.find((m) => m.role === "user" && m.content.trim().length > 0);
  if (firstUser) {
    const cleaned = stripDisplayTagsAllowEmpty(firstUser.content).replace(/\s+/g, " ").trim();
    if (cleaned) return truncateText(cleaned, 60);
  }
  return session.agent;
}

/** Narrow relative age — "2h ago", "3d ago", "just now" for fresh sessions. */
export function formatRelativeTimeAgo(timestamp: number, now: number = Date.now()): string {
  const diffSeconds = Math.max(0, Math.trunc((now - timestamp) / 1000));
  const intervals: Array<[number, string]> = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [seconds, unit] of intervals) {
    if (diffSeconds >= seconds) return `${Math.trunc(diffSeconds / seconds)}${unit} ago`;
  }
  return "just now";
}

/** `~/…` shorthand for the home directory. */
export function shortenHomePath(dir: string): string {
  const home = process.env.HOME;
  if (home && dir.startsWith(home)) return "~" + dir.slice(home.length);
  return dir;
}

/** Printable single-character input (not a named key, not a modifier combo). */
function isTypeable(input: string, key: Key): boolean {
  return (
    input.length === 1 &&
    !key.ctrl &&
    !key.meta &&
    !key.escape &&
    !key.return &&
    !key.upArrow &&
    !key.downArrow &&
    !key.pageUp &&
    !key.pageDown &&
    !key.tab
  );
}

/** Dim transcript list for the preview stage (last 12 messages). */
function PreviewTranscript({ session, columns }: { session: SessionData; columns: number }): React.ReactElement {
  const maxCols = Math.max(20, columns - 4);
  const rows = session.messages.slice(-12);
  return (
    <Box flexDirection="column">
      {rows.map((m, i) => (
        <Text key={i} dimColor>
          <Text
            color={m.role === "user" ? resolveColor(theme.claude) : m.role === "system" ? resolveColor(theme.warning) : undefined}
            bold={m.role === "user"}
          >
            {m.role === "user" ? "› " : "· "}
          </Text>
          {truncateText(stripDisplayTags(m.content).replace(/\s+/g, " ").trim() || "(empty)", maxCols)}
        </Text>
      ))}
      {session.messages.length > 12 && (
        <Text dimColor>… {session.messages.length - 12} earlier message{session.messages.length - 12 === 1 ? "" : "s"}</Text>
      )}
    </Box>
  );
}

/**
 * Interactive /resume session picker (Claude Code SessionsScreen equivalent).
 * Self-contained: ↑↓/j/k navigation, type-to-filter (exact-substring before
 * fuzzy subsequence, Esc clears the query before closing), Enter opens a
 * transcript preview (Enter resumes, Esc returns without resuming), ctrl+a
 * toggles this-project ⇄ all-projects scope, ctrl+r renames inline.
 */
export default function SessionPicker({
  sessions,
  currentDirectory,
  onResume,
  onClose,
  onRename,
}: SessionPickerProps): React.ReactElement {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const [scope, setScope] = useState<"local" | "all">("local");
  const [query, setQuery] = useState("");
  const [focusedHash, setFocusedHash] = useState<string | null>(null);
  const [previewSession, setPreviewSession] = useState<SessionData | null>(null);
  const [renamingHash, setRenamingHash] = useState<string | null>(null);
  const [localTitles, setLocalTitles] = useState<Record<string, string>>({});

  const sessionsInScope = useMemo(
    () =>
      scope === "all" ? sessions : sessions.filter((s) => s.workingDirectory === currentDirectory),
    [sessions, scope, currentDirectory],
  );

  const displayed = useMemo(() => {
    if (!query) return sessionsInScope;
    return fuzzyFilter(
      query,
      sessionsInScope,
      (s) => `${localTitles[s.hash] ?? deriveSessionTitle(s)} ${s.workingDirectory} ${s.agent}`,
      sessionsInScope.length,
    ).map((scored) => scored.item);
  }, [query, sessionsInScope, localTitles]);

  // Keep the focused row valid as the list changes (query/scope).
  useEffect(() => {
    if (displayed.length > 0 && !displayed.some((s) => s.hash === focusedHash)) {
      setFocusedHash(displayed[0]!.hash);
    }
  }, [displayed, focusedHash]);

  const moveFocus = useCallback(
    (delta: number) => {
      setFocusedHash((prev) => {
        const idx = displayed.findIndex((s) => s.hash === prev);
        const base = idx >= 0 ? idx : 0;
        const next = Math.max(0, Math.min(displayed.length - 1, base + delta));
        return displayed[next]?.hash ?? prev;
      });
    },
    [displayed],
  );

  const focusedSession = useMemo(
    () => displayed.find((s) => s.hash === focusedHash) ?? displayed[0],
    [displayed, focusedHash],
  );

  const commitRename = (title: string) => {
    const hash = renamingHash;
    if (hash) {
      const clean = title.trim();
      if (clean) {
        updateSession(hash, { title: clean });
        setLocalTitles((prev) => ({ ...prev, [hash]: clean }));
        onRename?.(hash, clean);
      }
    }
    setRenamingHash(null);
  };

  useInput((input, key) => {
    if (renamingHash) return; // InputDialog owns the keyboard
    if (previewSession) {
      // Preview stage: Enter resumes, Esc returns to the list (no resume).
      if (key.return) onResume(previewSession);
      else if (key.escape) setPreviewSession(null);
      return;
    }
    if (key.ctrl && input === "a") {
      // This-project ⇄ all-projects scope.
      setScope((s) => (s === "local" ? "all" : "local"));
      setQuery("");
      return;
    }
    if (key.ctrl && input === "r") {
      if (focusedSession) setRenamingHash(focusedSession.hash);
      return;
    }
    if (query) {
      // The query owns the keyboard: letters type, arrows navigate.
      if (key.escape) {
        setQuery("");
        return;
      }
      if (key.return) {
        if (focusedSession) setPreviewSession(focusedSession);
        return;
      }
      if (key.upArrow || (key.ctrl && input === "p")) {
        moveFocus(-1);
        return;
      }
      if (key.downArrow || (key.ctrl && input === "n")) {
        moveFocus(1);
        return;
      }
      if (key.pageUp) {
        moveFocus(-MAX_VISIBLE);
        return;
      }
      if (key.pageDown) {
        moveFocus(MAX_VISIBLE);
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (isTypeable(input, key)) {
        setQuery((q) => (q + input).slice(0, 60));
      }
      return;
    }
    // Clean list: Select owns navigation/enter/esc; printable chars start a
    // filter (j/k navigate, so they stay with the Select).
    if (isTypeable(input, key) && input !== "j" && input !== "k") {
      setQuery(input);
    }
  });

  if (sessions.length === 0) {
    return (
      <Dialog title="Resume a session" subtitle="Sessions live in ~/.deepseek-code/sessions" onCancel={onClose}>
        <Text dimColor>No saved sessions found — start a conversation and it will appear here.</Text>
      </Dialog>
    );
  }

  const renamingSession = renamingHash ? sessions.find((s) => s.hash === renamingHash) : undefined;
  if (renamingSession) {
    return (
      <InputDialog
        title="Rename session"
        subtitle="ctrl+r rename — stored on the session file"
        initial={localTitles[renamingSession.hash] ?? deriveSessionTitle(renamingSession)}
        onSubmit={commitRename}
        onCancel={() => setRenamingHash(null)}
      />
    );
  }

  // Width-aware truncation: the working-directory column gets the row width
  // left over after the title, badge, agent, age and message count.
  const dirBudget = Math.max(8, columns - 40);
  const rows = displayed.map((s) => {
    const isLocal = s.workingDirectory === currentDirectory;
    const count = s.messages.length;
    return {
      value: s.hash,
      label: localTitles[s.hash] ?? deriveSessionTitle(s),
      description: `${isLocal ? "[local]" : "[remote]"} ${truncateText(shortenHomePath(s.workingDirectory), dirBudget)} · ${s.agent} · ${formatRelativeTimeAgo(s.updatedAt || s.createdAt)} · ${count} msg${count === 1 ? "" : "s"}`,
    };
  });

  return (
    <Dialog
      title={previewSession ? deriveSessionTitle(previewSession) : "Resume a session"}
      subtitle={
        previewSession
          ? `${formatRelativeTimeAgo(previewSession.updatedAt || previewSession.createdAt)} · ${previewSession.messages.length} message${previewSession.messages.length === 1 ? "" : "s"}`
          : `${scope === "local" ? "This project" : "All projects"} — type to filter`
      }
      onCancel={onClose}
      cancelActive={false}
      footer={
        previewSession ? (
          <>
            <Text bold>enter</Text> to resume · <Text bold>esc</Text> back to list
          </>
        ) : query ? (
          <>
            type to filter · <Text bold>↑↓</Text> navigate · <Text bold>enter</Text> preview · <Text bold>esc</Text> clears
          </>
        ) : (
          <>
            <Text bold>↑↓</Text> navigate · <Text bold>enter</Text> preview · type to filter ·{" "}
            <Text bold>ctrl+a</Text> {scope === "local" ? "all projects" : "this project"} ·{" "}
            <Text bold>ctrl+r</Text> rename · <Text bold>esc</Text> dismiss
          </>
        )
      }
    >
      {previewSession ? (
        <PreviewTranscript session={previewSession} columns={columns} />
      ) : (
        <Select
          key={query ? `filter-${query}-${focusedHash ?? ""}` : `list-${scope}`}
          options={rows}
          defaultValue={focusedHash ?? displayed[0]?.hash}
          onFocus={(value) => setFocusedHash(value)}
          onCancel={onClose}
          onChange={(value) => {
            const session = sessionsInScope.find((s) => s.hash === value);
            if (session) setPreviewSession(session);
          }}
          keysActive={query === ""}
          highlightText={query || undefined}
          visibleOptionCount={MAX_VISIBLE}
        />
      )}
    </Dialog>
  );
}
