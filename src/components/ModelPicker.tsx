import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select } from "../ui/design-system/Select.js";
import { resolveColor, theme } from "../utils/theme.js";
import type { EffortLevel } from "../state/storage.js";

export interface ModelPickerProfile {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

export interface ModelPickerProps {
  currentModel: string;
  currentProvider: string;
  profiles?: Record<string, ModelPickerProfile>;
  /** Allowlist of selectable model ids; when absent every built-in is offered. */
  availableModels?: string[];
  /** Active reasoning effort from app state; when absent the focused model's default is shown. */
  currentEffort?: EffortLevel;
  /**
   * Receives a model id or a profile name — same value `/model <arg>` accepts.
   * A second argument carries an effort chosen with ←/→ in the picker
   * (undefined when the user never cycled it).
   */
  onSelect: (name: string, effort?: EffortLevel) => void;
  onCancel: () => void;
}

const MODEL_DESCRIPTIONS: Record<string, string> = {
  "deepseek-chat": "General-purpose coding assistant — default",
  "deepseek-reasoner": "Advanced reasoning with extended thinking",
};

/** Default reasoning effort per model id; anything unlisted defaults to off. */
const DEFAULT_EFFORT_FOR_MODEL: Record<string, EffortLevel> = {
  "deepseek-chat": "off",
  "deepseek-reasoner": "medium",
};

/** Mirrors StatusBar's effort chip glyphs, extended with an "off" (auto) glyph. */
const EFFORT_SYMBOLS: Record<string, string> = {
  off: "○",
  low: "○",
  medium: "◐",
  high: "●",
  xhigh: "◈",
  max: "◉",
};

/** The port's full effort ladder — keep in sync with services/effort.ts. */
const EFFORT_LEVELS: readonly EffortLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

/** Default effort level for a model id. */
export function defaultEffortForModel(model: string): EffortLevel {
  return DEFAULT_EFFORT_FOR_MODEL[model] ?? "off";
}

/** Wraps ←/→ cycling across the port's effort levels. */
export function cycleEffortLevel(current: EffortLevel, direction: "left" | "right"): EffortLevel {
  const index = EFFORT_LEVELS.indexOf(current);
  const i = index >= 0 ? index : 0;
  if (direction === "right") return EFFORT_LEVELS[(i + 1) % EFFORT_LEVELS.length]!;
  return EFFORT_LEVELS[(i - 1 + EFFORT_LEVELS.length) % EFFORT_LEVELS.length]!;
}

function defaultEffortForOption(
  value: string,
  profiles: Record<string, ModelPickerProfile>,
): EffortLevel {
  return defaultEffortForModel(profiles[value]?.model ?? value);
}

/**
 * Interactive /model picker: DeepSeek models plus configured profiles,
 * mirroring Claude Code's ModelPicker (current entry marked, Enter applies).
 * ←/→ cycles the reasoning effort for the focused model.
 */
export default function ModelPicker({
  currentModel,
  currentProvider,
  profiles = {},
  availableModels,
  currentEffort,
  onSelect,
  onCancel,
}: ModelPickerProps): React.ReactElement {
  const profileEntries = Object.entries(profiles);

  // The ✓ marker follows whatever is active right now: a profile that fully
  // matches the live provider config, or the raw model id.
  const activeProfileName = profileEntries.find(
    ([, p]) => p.model === currentModel && p.provider === currentProvider,
  )?.[0];
  const defaultValue = activeProfileName ?? currentModel;

  const builtinOptions = Object.keys(MODEL_DESCRIPTIONS)
    .filter(
      (m) => !availableModels || availableModels.length === 0 || availableModels.includes(m),
    )
    .map((model) => ({
      label: model,
      value: model,
      description: MODEL_DESCRIPTIONS[model],
    }));

  // The active profile stays in the list (labeled "(current)") so the ✓
  // marker and the initial focus land on it — filtering it out made the
  // default unfocusable.
  const profileOptions = profileEntries.map(([name, p]) => ({
    label: name === activeProfileName ? `${name} (current)` : `${name} (profile)`,
    value: name,
    description: `${p.provider}/${p.model}${p.baseURL ? ` · ${p.baseURL}` : ""}`,
  }));

  const hasCurrentModelOption =
    builtinOptions.some((o) => o.value === currentModel) ||
    profileOptions.some((o) => o.value === currentModel);

  const options = [
    ...builtinOptions,
    ...profileOptions,
    // Keep an unlisted (or allowlist-filtered) current model selectable.
    ...(activeProfileName === undefined && !hasCurrentModelOption
      ? [
          {
            label: `${currentModel} (current)`,
            value: currentModel,
            description: "Currently active model",
          },
        ]
      : []),
  ];

  const [focusedValue, setFocusedValue] = useState(defaultValue);
  const [effort, setEffort] = useState<EffortLevel>(() =>
    currentEffort ?? defaultEffortForOption(defaultValue, profiles),
  );
  const [hasToggledEffort, setHasToggledEffort] = useState(false);

  const handleFocus = useCallback(
    (value: string) => {
      setFocusedValue(value);
      // Until the user cycles effort, follow the focused model's default.
      if (!hasToggledEffort) setEffort(currentEffort ?? defaultEffortForOption(value, profiles));
    },
    [hasToggledEffort, currentEffort, profiles],
  );

  const handleCycleEffort = useCallback((direction: "left" | "right") => {
    setEffort((prev) => cycleEffortLevel(prev, direction));
    setHasToggledEffort(true);
  }, []);

  useInput((_input, key) => {
    if (key.leftArrow) handleCycleEffort("left");
    else if (key.rightArrow) handleCycleEffort("right");
  });

  const handleSelect = useCallback(
    (name: string) => {
      onSelect(name, hasToggledEffort ? effort : undefined);
    },
    [onSelect, hasToggledEffort, effort],
  );

  const focusedDefaultEffort = defaultEffortForOption(focusedValue, profiles);

  return (
    <Dialog
      title="Select model"
      subtitle={`Current: ${currentProvider}/${currentModel}`}
      onCancel={onCancel}
      footer={
        <Text>
          <Text bold>↑↓</Text> to choose · <Text bold>← →</Text> effort · <Text bold>enter</Text> to
          switch · <Text bold>esc</Text> to cancel
        </Text>
      }
    >
      <Select
        options={options}
        defaultValue={defaultValue}
        onChange={handleSelect}
        onFocus={handleFocus}
        onCancel={onCancel}
        enableNumberKeys
        visibleOptionCount={7}
      />
      <Box marginTop={1}>
        <Text dimColor>
          {EFFORT_SYMBOLS[effort] ?? "●"} {effort} effort{effort === focusedDefaultEffort ? " (default)" : ""}{" "}
          <Text color={resolveColor(theme.subtle)}>← → to adjust</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Profiles come from .deepseek-code.json · switching rebuilds the session on the next message
        </Text>
      </Box>
    </Dialog>
  );
}
