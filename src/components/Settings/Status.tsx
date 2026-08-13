










import React from "react";
import { Box, Text } from "ink";
import { loadConfig } from "../../utils/config.js";
import { loadSettings } from "../../state/storage.js";
import { isTrusted } from "../../services/projectTrust.js";
import { listSkills } from "../../skills/skillService.js";
import { loadHooks } from "../../services/hooks.js";
import { resolveThemeSetting } from "../../utils/theme.js";


const APP_VERSION = "0.1.0";

export type Property = {
  label?: string;
  value: string | string[] | React.ReactNode;
};


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
  
  
  const sections = React.useMemo(
    () => [buildPrimarySection(), buildSecondarySection()],
    [],
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" gap={1}>
        {sections.map(
          (properties, i) =>
            properties.length > 0 && (
              <Box key={i} flexDirection="column">
                {properties.map(({ label, value }, j) => (
                  <Box key={j} flexDirection="row" gap={1} flexShrink={0}>
                    {label !== undefined && <Text bold>{label}:</Text>}
                    <PropertyValue value={value} />
                  </Box>
                ))}
              </Box>
            ),
        )}
      </Box>
      <Text dimColor>
        esc to cancel
      </Text>
    </Box>
  );
}
