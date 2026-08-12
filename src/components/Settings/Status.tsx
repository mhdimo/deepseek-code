// Status — the Settings "Status" tab: diagnostic rows about the current
// session, grouped with dividers.
//
// Ported from claude-code-main/src/components/Settings/Status.tsx, adapted to
// DeepSeek Code's data: no OAuth account properties, no IDE/sandbox/updater
// diagnostics, no installation-health probes. Instead the rows report the
// local configuration surface: API key status (masked), model, provider,
// base URL, version, session id, working directory + trust, MCP server count,
// hooks, skills, effort level, and theme. Rows are [dim fixed-width label]
// [value], with the sections separated by dividers.

import React from "react";
import { Box, Text } from "ink";
import { Divider } from "../../ui/design-system/Divider.js";
import { loadConfig } from "../../utils/config.js";
import { loadSettings } from "../../state/storage.js";
import { isTrusted } from "../../services/projectTrust.js";
import { listSkills } from "../../skills/skillService.js";
import { loadHooks } from "../../services/hooks.js";
import { resolveThemeSetting } from "../../utils/theme.js";

// Keep in sync with src/index.tsx (`const VERSION = "0.1.0"`).
const APP_VERSION = "0.1.0";

/** Fixed width for the dim label column — covers "Working directory". */
const LABEL_WIDTH = 18;

export type Property = {
  label?: string;
  value: string | string[] | React.ReactNode;
};

/** Mask an API key, keeping only the head and tail readable. */
function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function buildPrimarySection(): Property[] {
  const settings = loadSettings();
  const config = loadConfig();
  const cwd = process.cwd();
  return [
    { label: "Version", value: APP_VERSION },
    { label: "Session ID", value: settings.lastSessionHash ?? "(none yet)" },
    { label: "Working directory", value: cwd },
    {
      label: "Trust",
      value: isTrusted(cwd) ? "Trusted" : "Not trusted",
    },
    {
      label: "API key",
      value: config.apiKey
        ? `Set (${maskKey(config.apiKey)})`
        : "Not set",
    },
  ];
}

function buildSecondarySection(): Property[] {
  const settings = loadSettings();
  const config = loadConfig();
  const mcpCount = Object.keys(config.mcpServers ?? {}).length;
  const hookEvents = Object.keys(loadHooks());
  const skillCount = listSkills().length;
  const themeSetting = settings.themeMode ?? "auto";
  const themeName = resolveThemeSetting(themeSetting);
  return [
    { label: "Model", value: config.model },
    { label: "Provider", value: config.provider },
    {
      label: "Base URL",
      value: config.baseURL ?? "https://api.deepseek.com/v1 (default)",
    },
    { label: "MCP servers", value: String(mcpCount) },
    {
      label: "Hooks",
      value:
        hookEvents.length > 0 ? hookEvents.join(", ") : "None configured",
    },
    { label: "Skills", value: String(skillCount) },
    { label: "Effort", value: settings.effort ?? "off" },
    {
      label: "Theme",
      value:
        themeSetting === themeName
          ? themeSetting
          : `${themeSetting} (${themeName})`,
    },
  ];
}

function PropertyValue({ value }: { value: Property["value"] }): React.ReactNode {
  if (Array.isArray(value)) {
    return (
      <Box flexWrap="wrap" columnGap={1} flexShrink={99}>
        {value.map((item, i) => (
          <Text key={i}>
            {item}
            {i < value.length - 1 ? "," : ""}
          </Text>
        ))}
      </Box>
    );
  }
  if (typeof value === "string") {
    return <Text>{value}</Text>;
  }
  return value;
}

export function Status(): React.ReactNode {
  const sections = [buildPrimarySection(), buildSecondarySection()];

  return (
    <Box flexDirection="column" gap={1}>
      {sections.map(
        (properties, i) =>
          properties.length > 0 && (
            <Box key={i} flexDirection="column">
              {i > 0 && <Divider />}
              {properties.map(({ label, value }, j) => (
                <Box key={j} flexDirection="row" gap={1} flexShrink={0}>
                  {label !== undefined && (
                    <Text dimColor>{label.padEnd(LABEL_WIDTH)}</Text>
                  )}
                  <PropertyValue value={value} />
                </Box>
              ))}
            </Box>
          ),
      )}
      <Box>
        <Text dimColor italic>
          esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
