/**
 * Line builders for the permission prompt's option list.
 *
 * These live apart from the component so the column arithmetic — the whole
 * point of a numbered list — can be exercised without a TTY. PermissionSelect
 * renders the rows this builds, so the list and the layout can't disagree.
 *
 * Every row opens with the same two-column marker gutter (`❯ ` when focused,
 * two spaces otherwise) and the same index padded to `maxIndexWidth + 2`.
 * The editable rows (Tab to amend, the editable "don't ask again for" rule)
 * take that gutter too: they used to start straight at the index, which slid
 * their number one column left of every sibling as soon as an input row was
 * on screen — a feedback row among plain rows reads as a ragged list.
 */

export interface PermissionSegment {
  text: string;
  color?: string;
  dim?: boolean;
}

export interface PermissionOptionRow {
  /** Marker gutter + index — the columns every row shares. */
  prefix: PermissionSegment[];
  /** Label and its separator, for rows that carry one inline before an
   *  editable value (upstream's `showLabelWithValue` +
   *  `labelValueSeparator`). Empty for plain rows, whose label is content. */
  label: PermissionSegment[];
  /** Indent for the row's description: the same column the row's label
   *  starts in, so a description never hangs short of what it describes. */
  descriptionIndent: number;
}

/** Width of the focus marker that opens every option row ("❯" plus its gap). */
export const OPTION_GUTTER_WIDTH = 2;

/** The focus marker, matching the reference's ListItem pointer. */
export const FOCUS_MARKER = "❯";

/** Digits in the widest index for `count` options — "10." needs one column
 *  more than "9.". Zero options still reserve a single digit so an empty list
 *  can't collapse the column. */
export function optionIndexWidth(count: number): number {
  return Math.max(1, String(Math.max(1, count)).length);
}

/** Build one option row's columns. `index` is 0-based; the rendered number is
 *  the 1-based one the 1..N shortcuts use. */
export function buildOptionRow({
  index,
  optionCount,
  focused,
  label,
  labelSeparator = ", ",
  focusedColor,
}: {
  index: number;
  optionCount: number;
  focused: boolean;
  label?: string;
  labelSeparator?: string;
  /** Resolved theme color for the focused marker and label. */
  focusedColor?: string;
}): PermissionOptionRow {
  const focusStyle = focused && focusedColor ? { color: focusedColor } : {};
  const prefix: PermissionSegment[] = [
    { text: focused ? `${FOCUS_MARKER} ` : " ".repeat(OPTION_GUTTER_WIDTH), ...focusStyle },
    { text: `${index + 1}.`.padEnd(optionIndexWidth(optionCount) + 2), dim: true },
  ];
  return {
    prefix,
    label: label
      ? [
          { text: label, ...focusStyle },
          ...(labelSeparator ? [{ text: labelSeparator, ...focusStyle }] : []),
        ]
      : [],
    descriptionIndent: OPTION_GUTTER_WIDTH + optionIndexWidth(optionCount) + 2,
  };
}

/** Separator between an editable row's label and its value (upstream's
 *  `labelValueSeparator`, which the Bash prompt sets explicitly). */
export const LABEL_VALUE_SEPARATOR = ": ";

/** The Bash prompt's editable "don't ask again" label. Upstream spells this
 *  one with a typographic apostrophe (U+2019); the shared / fallback label
 *  below uses a straight one (U+0027). The inconsistency is upstream's, and
 *  the port preserves it per site rather than normalising. */
export const EDIT_PREFIX_LABEL = "Yes, and don’t ask again for";

/** Placeholder for the editable rule field, as upstream writes it. */
export const EDIT_PREFIX_PLACEHOLDER = "command prefix (e.g., npm run:*)";

/** The shared "don't ask again" label — straight quote (U+0027), trailing
 *  space because the tool name follows it in bold. */
export const DONT_ASK_AGAIN_LABEL = "Yes, and don't ask again for ";

/** Connects the tool name and the directory in the shared label. Upstream
 *  says "… for Bash commands in /cwd", not "… for Bash in /cwd". */
export const DONT_ASK_AGAIN_JOINER = " commands in ";

export type BashOptionValue = "yes" | "yes-prefix" | "no";

/** One row of the Bash prompt's option list, before it is turned into the
 *  component's option shape. */
export interface BashOptionSpec {
  value: BashOptionValue;
  label: string;
  /** Tab turns the focused row into a feedback input. */
  feedbackType?: "accept" | "reject";
  /** Editable rule field: the label renders inline before the input. */
  editable?: boolean;
  placeholder?: string;
}

/** The Bash prompt's option list, in order.
 *
 *  Three rows is the whole list. Upstream has no session-wide / "allow all
 *  commands" row here, and a fourth row in ours made the list read as a
 *  different dialog from every other tool's. The session-wide grant itself
 *  does not go away with the row: Shift+Tab walks the permission-mode cycle
 *  (`permissionModeCycle` → `bypassPermissions`, which auto-approves), so the
 *  reach is still there — one keypress instead of one row. */
export function bashOptionRows(): BashOptionSpec[] {
  return [
    { value: "yes", label: "Yes", feedbackType: "accept" },
    {
      value: "yes-prefix",
      label: EDIT_PREFIX_LABEL,
      editable: true,
      placeholder: EDIT_PREFIX_PLACEHOLDER,
    },
    { value: "no", label: "No", feedbackType: "reject" },
  ];
}

/** Shortcut that grants the same thing as the session-scope edit option: the
 *  Shift+Tab permission-mode cycle. Named in the label so the option and the
 *  key read as one act. */
export const SESSION_EDIT_SHORTCUT = "shift+tab";

/** Text of the session-scope edit option. Edits inside the working directory
 *  have no directory worth naming, so that variant names the shortcut
 *  instead; edits elsewhere still call out their directory so the reach of
 *  the grant stays visible. */
export function sessionEditLabelParts(dirName: string | null): {
  prefix: string;
  scope: string;
  suffix: string;
} {
  return dirName
    ? {
        prefix: "Yes, allow all edits in ",
        scope: `${dirName}/`,
        suffix: " during this session ",
      }
    : { prefix: "Yes, allow all edits during this session ", scope: "", suffix: "" };
}
