import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select, type SelectOption } from "../ui/design-system/Select.js";
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  listOutputStyles,
  loadCustomOutputStyles,
} from "../services/outputStyles.js";

export interface OutputStylePickerProps {
  /** Persisted style name; undefined means default. */
  current?: string;
  onSelect: (name: string) => void;
  onCancel: () => void;
}

function toOptions(): Array<SelectOption<string>> {
  return listOutputStyles().map((style) => ({
    label: style.name,
    value: style.name,
    description: style.description,
  }));
}

/**
 * Interactive /output-style picker over built-in plus custom styles from
 * .claude/output-styles (project and user dirs). Selecting `default` clears
 * the persisted setting.
 */
export default function OutputStylePicker({
  current,
  onSelect,
  onCancel,
}: OutputStylePickerProps): React.ReactElement {
  const [options, setOptions] = useState<Array<SelectOption<string>>>(() => toOptions());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadCustomOutputStyles()
      .then(() => {
        if (cancelled) return;
        setOptions(toOptions());
        setIsLoading(false);
      })
      .catch(() => {
        // On error, fall back to the built-in styles already in state.
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Dialog
      title="Preferred output style"
      onCancel={onCancel}
      footer="↑↓ to choose · enter to apply · esc to cancel"
    >
      <Box flexDirection="column" gap={1}>
        {/* Reference OutputStylePicker: the explanation is a dim body line
            above the list, not a subtitle under the heading. */}
        <Box marginTop={1}>
          <Text dimColor>This changes how DeepSeek Code communicates with you</Text>
        </Box>
        {isLoading ? (
          <Text dimColor>Loading output styles…</Text>
        ) : (
          <Select
            options={options}
            defaultValue={current ?? DEFAULT_OUTPUT_STYLE_NAME}
            onChange={onSelect}
            onCancel={onCancel}
            enableNumberKeys
            visibleOptionCount={10}
          />
        )}
      </Box>
    </Dialog>
  );
}
