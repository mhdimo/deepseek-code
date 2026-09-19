import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";

import PermissionPrompt from "../../src/components/PermissionPrompt.js";
import { settleFor } from "../helpers/inkFrames.js";
import {
  bashOptionRows,
  buildOptionRow,
  DONT_ASK_AGAIN_JOINER,
  DONT_ASK_AGAIN_LABEL,
  EDIT_PREFIX_LABEL,
  LABEL_VALUE_SEPARATOR,
  optionIndexWidth,
  SESSION_EDIT_SHORTCUT,
  sessionEditLabelParts,
  type PermissionSegment,
} from "../../src/components/permissionLayout.js";

const text = (segments: PermissionSegment[]): string =>
  segments.map((segment) => segment.text).join("");

const rowText = (options: {
  index: number;
  optionCount: number;
  focused: boolean;
  label?: string;
  labelSeparator?: string;
}): string => {
  const row = buildOptionRow(options);
  return text([...row.prefix, ...row.label]);
};

/** Column a row's content starts in (0-based), i.e. where its label sits. */
const labelColumn = (options: {
  index: number;
  optionCount: number;
  focused: boolean;
  label?: string;
  labelSeparator?: string;
}): number => text(buildOptionRow(options).prefix).length;

test("reserves the marker gutter on every row, focused or not", () => {
  expect(rowText({ index: 0, optionCount: 4, focused: true })).toBe("❯ 1. ");
  expect(rowText({ index: 1, optionCount: 4, focused: false })).toBe("  2. ");
});

test("numbers editable rows in the same column as plain rows", () => {
  // The Bash prompt's second option is an editable rule field. It used to
  // render without the gutter, so its "2." sat one column left of "1." — the
  // ragged list this test pins down.
  const columns = [
    labelColumn({ index: 0, optionCount: 4, focused: true }),
    labelColumn({ index: 1, optionCount: 4, focused: false, label: "Yes, and don't ask again for", labelSeparator: ": " }),
    labelColumn({ index: 2, optionCount: 4, focused: false }),
    labelColumn({ index: 3, optionCount: 4, focused: false }),
  ];
  expect(columns).toEqual([5, 5, 5, 5]);
  expect(rowText({ index: 1, optionCount: 4, focused: false, label: "Yes, and don't ask again for", labelSeparator: ": " })).toBe(
    "  2. Yes, and don't ask again for: ",
  );
});

test("keeps a row's label and description in one column", () => {
  const labelled = buildOptionRow({
    index: 1,
    optionCount: 3,
    focused: false,
    label: "Yes, and don't ask again for",
    labelSeparator: ": ",
  });
  expect(labelled.descriptionIndent).toBe(text(labelled.prefix).length);
  expect(rowText({ index: 1, optionCount: 3, focused: false })).toBe("  2. ");
});

test("widens the index column for two-digit option counts", () => {
  expect(optionIndexWidth(9)).toBe(1);
  expect(optionIndexWidth(10)).toBe(2);
  expect(rowText({ index: 8, optionCount: 10, focused: false })).toBe("  9.  ");
  expect(rowText({ index: 9, optionCount: 10, focused: false })).toBe("  10. ");
  // Both label columns agree once the index column has grown.
  expect(labelColumn({ index: 8, optionCount: 10, focused: false })).toBe(6);
  expect(labelColumn({ index: 9, optionCount: 10, focused: false })).toBe(6);
  expect(buildOptionRow({ index: 9, optionCount: 10, focused: false }).descriptionIndent).toBe(6);
});

test("colors only the focused row's marker and inline label", () => {
  const focused = buildOptionRow({
    index: 0,
    optionCount: 2,
    focused: true,
    label: "Yes, and don't ask again for",
    focusedColor: "#123456",
  });
  expect(focused.prefix[0]).toEqual({ text: "❯ ", color: "#123456" });
  expect(focused.label[0]).toEqual({ text: "Yes, and don't ask again for", color: "#123456" });
  const plain = buildOptionRow({ index: 0, optionCount: 2, focused: false, focusedColor: "#123456" });
  expect(plain.prefix[0]).toEqual({ text: "  " });
  expect(plain.label).toEqual([]);
});

test("dims the number cell on every row, the focused one included", () => {
  // The focus marker carries the colour; the number never does, and never
  // stops being dimmed — upstream pads and dims `${i}.` on both kinds of row.
  const focused = buildOptionRow({ index: 0, optionCount: 3, focused: true, focusedColor: "#123456" });
  expect(focused.prefix[1]).toEqual({ text: "1. ", dim: true });
  const unfocused = buildOptionRow({ index: 1, optionCount: 3, focused: false, focusedColor: "#123456" });
  expect(unfocused.prefix[1]).toEqual({ text: "2. ", dim: true });
  expect(focused.prefix[1]!.color).toBeUndefined();
});

test("session edit option names the shortcut it stands in for", () => {
  const inCwd = sessionEditLabelParts(null);
  expect(`${inCwd.prefix}(${SESSION_EDIT_SHORTCUT})`).toBe(
    "Yes, allow all edits during this session (shift+tab)",
  );
  const outside = sessionEditLabelParts("tmp");
  expect(`${outside.prefix}${outside.scope}${outside.suffix}(${SESSION_EDIT_SHORTCUT})`).toBe(
    "Yes, allow all edits in tmp/ during this session (shift+tab)",
  );
});

test("the Bash list is three rows — no session-wide row", () => {
  const rows = bashOptionRows();
  expect(rows.map((row) => row.value)).toEqual(["yes", "yes-prefix", "no"]);
  expect(rows.map((row) => row.label)).toEqual(["Yes", EDIT_PREFIX_LABEL, "No"]);
  // The reference's shell dialog has no "allow all commands" / bypass row. A
  // fourth row here made the list read as a different dialog from every other
  // tool's.
  expect(rows.some((row) => /allow all|session|bypass/i.test(row.label))).toBe(false);
  expect(rows[1]).toMatchObject({
    editable: true,
    placeholder: "command prefix (e.g., npm run:*)",
  });
});

test("keeps upstream's apostrophe per site", () => {
  // The Bash prompt's editable row uses a typographic apostrophe (U+2019)…
  expect(EDIT_PREFIX_LABEL).toBe("Yes, and don’t ask again for");
  expect(EDIT_PREFIX_LABEL).not.toContain("'");
  // …while the shared / fallback label uses a straight one (U+0027) and says
  // "commands in <cwd>", not "in <cwd>".
  expect(DONT_ASK_AGAIN_LABEL).not.toContain("’");
  expect(
    `${DONT_ASK_AGAIN_LABEL}Bash${DONT_ASK_AGAIN_JOINER}/tmp/proj`,
  ).toBe("Yes, and don't ask again for Bash commands in /tmp/proj");
});

test("the editable row's separator is the reference's ': '", () => {
  expect(LABEL_VALUE_SEPARATOR).toBe(": ");
  // With the separator applied, the editable row reads the way upstream renders
  // it: label, ": ", then the value.
  expect(`${EDIT_PREFIX_LABEL}${LABEL_VALUE_SEPARATOR}npm run:*`).toBe(
    "Yes, and don’t ask again for: npm run:*",
  );
});

test("the Bash list's editable row shares the plain rows' columns", () => {
  const rows = bashOptionRows();
  const optionCount = rows.length;
  // Row 2 is an input row: buildOptionRow still owns its gutter, so its number
  // sits in the same column as row 1's and row 3's.
  const columns = rows.map((row, index) => {
    const built = buildOptionRow({
      index,
      optionCount,
      focused: index === 0,
      label: row.editable ? row.label : undefined,
      labelSeparator: LABEL_VALUE_SEPARATOR,
    });
    return text(built.prefix).length;
  });
  expect(columns).toEqual([5, 5, 5]);
  expect(rowText({
    index: 1,
    optionCount,
    focused: false,
    label: EDIT_PREFIX_LABEL,
    labelSeparator: LABEL_VALUE_SEPARATOR,
  })).toBe("  2. Yes, and don’t ask again for: ");
});

/* Rendered frame: the pure builders are what PermissionSelect renders, so the
   two can only agree — but the complaint was about the pixels, so one test
   drives the real prompt through Ink and reads the frame back. */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

async function renderPrompt(node: React.ReactElement): Promise<string> {
  let out = "";
  // Poll for the frame to settle rather than sleeping a fixed 60ms: under load
  // the renderer has not always written by the time a sleep elapsed, and the
  // failure reads as a rendering bug. See tests/helpers/inkFrames.ts.
  const settle = settleFor(() => out);
  // Ink needs an EventEmitter-shaped stdout and a raw-mode-capable stdin, and
  // only the parts it touches: this process has no TTY.
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 40,
    isTTY: true,
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream;

  const { unmount, cleanup } = render(node, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  await settle();
  unmount();
  cleanup();
  return out.replace(ANSI, "");
}

test("bash prompt renders one number column, preview outdented", async () => {
  const frame = await renderPrompt(
    React.createElement(PermissionPrompt, {
      toolName: "Bash",
      description: "npm run build",
      input: { command: "npm run build" },
      workingDir: "/tmp/proj",
      onApprove: () => {},
      onDeny: () => {},
    }),
  );

  // The command preview is indented 3 (dialog padding + its own), the options
  // hang at 1 — the reference's outdent — and every row's number lands in the
  // same column. Three rows is the whole list, and the editable rule field is
  // spelled with U+2019, unlike the shared label's straight quote.
  expect(frame).toContain(
    [
      "   npm run build",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don’t ask again for: npm run:*",
      "   3. No",
      "",
      " Esc to cancel · Tab to amend",
    ].join("\n"),
  );
  expect(frame).not.toContain("allow all commands during this session");
});

test("bash preview shows the command, and the description under it", async () => {
  // The reference renders the tool-use message (the full command, no prefix, no
  // truncation) and then the tool-call description on its own line. Here the
  // two differ, as they do upstream.
  const frame = await renderPrompt(
    React.createElement(PermissionPrompt, {
      toolName: "Bash",
      description: "Build the project",
      input: { command: "npm run build" },
      workingDir: "/tmp/proj",
      onApprove: () => {},
      onDeny: () => {},
    }),
  );
  expect(frame).toContain(
    ["   npm run build", "   Build the project", "", " Do you want to proceed?"].join("\n"),
  );
  // The preview is the command verbatim — no `$` prefix, no truncation.
  expect(frame).not.toContain("$ npm run build");
  expect(frame).toContain("npm run build");
});

/* The dialog is where the user approves the change, so it has to show all of
   it. The reference caps nothing — FileWriteToolDiff hands HighlightedCode the
   whole new-file body (or every hunk of the patch when the file exists) and
   FileEditToolDiff hands StructuredDiffList the whole patch — while ours
   stopped the preview at 12 rows, hiding lines of the very change under
   review. */

const writePrompt = (workingDir: string, file_path: string, content: string) =>
  React.createElement(PermissionPrompt, {
    toolName: "Write",
    description: "Write file",
    input: { file_path, content },
    workingDir,
    onApprove: () => {},
    onDeny: () => {},
  });

test("a created file's preview shows every line, not the first 12", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsc-perm-write-"));
  try {
    const content = Array.from(
      { length: 24 },
      (_, i) => `export const row${String(i + 1).padStart(2, "0")} = ${i + 1};`,
    ).join("\n");
    const frame = await renderPrompt(writePrompt(dir, join(dir, "new.ts"), content));

    expect(frame).toContain("export const row01 = 1;");
    // Past the old 12-row cap, and the last line of what is being approved.
    expect(frame).toContain("export const row24 = 24;");
    expect(frame).not.toContain("…");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an overwritten file's diff shows rows past the old 12-row cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsc-perm-overwrite-"));
  try {
    // Every line changes, so the patch is one long hunk and the marker sits
    // well past the twelfth row of it.
    const before = Array.from(
      { length: 30 },
      (_, i) => `const row${String(i + 1).padStart(2, "0")} = ${i + 1};`,
    ).join("\n");
    const after = before
      .split("\n")
      .map((line, i) => (i === 29 ? `${line} // LAST-LINE-MARKER` : `${line} // revised`))
      .join("\n");
    const path = join(dir, "existing.ts");
    writeFileSync(path, before);

    const frame = await renderPrompt(writePrompt(dir, path, after));
    expect(frame).toContain("LAST-LINE-MARKER");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edit's diff shows the rows past the old 12-row cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsc-perm-edit-"));
  try {
    const original = Array.from(
      { length: 30 },
      (_, i) => `const row${String(i + 1).padStart(2, "0")} = ${i + 1};`,
    );
    const path = join(dir, "existing.ts");
    writeFileSync(path, original.join("\n"));

    // A 20-line replacement: header + 3 context + 20 removed + 20 added rows,
    // so a 12-row cap cuts inside the removal block and never reaches the
    // added lines.
    const oldString = original.slice(10, 30).join("\n");
    const newString = original
      .slice(10, 30)
      .map((line, i) => (i === 19 ? 'const last = "EDIT-LAST-MARKER";' : `${line} // edited`))
      .join("\n");

    const frame = await renderPrompt(
      React.createElement(PermissionPrompt, {
        toolName: "Edit",
        description: "Edit file",
        input: { file_path: path, old_string: oldString, new_string: newString },
        workingDir: dir,
        onApprove: () => {},
        onDeny: () => {},
      }),
    );

    expect(frame).toContain("EDIT-LAST-MARKER");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash preview keeps a long command whole", async () => {
  const command =
    "npm run build -- --filter=@deepseek/very-long-package-name-and-then-some-more-characters-to-be-sure-it-overflows-eighty-columns";
  const frame = await renderPrompt(
    React.createElement(PermissionPrompt, {
      toolName: "Bash",
      description: command,
      input: { command },
      workingDir: "/tmp/proj",
      onApprove: () => {},
      onDeny: () => {},
    }),
  );
  // Offset 3, and the command's tail survives: `verbose: true` means the whole
  // string, not the display-truncated one. Ink wraps at the terminal width —
  // mid-word, so the comparison drops whitespace from both sides.
  expect(frame).toContain(`   ${command.slice(0, 40)}`);
  expect(frame.replace(/\s+/g, "")).toContain(command.replace(/\s+/g, ""));
});
