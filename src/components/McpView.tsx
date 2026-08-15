
import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select } from "../ui/design-system/Select.js";
import { theme, resolveColor } from "../utils/theme.js";
import Spinner from "./Spinner.js";
import type { DeepSeekCodeConfig, MCPServerConfig } from "../types/index.js";

export interface McpViewProps {
  servers: Record<string, MCPServerConfig>;
  onToggle: (name: string, enabled: boolean) => void;
  /** Reconnect: resets the native session so servers re-handshake on the next
   *  message. May be async; resolves to a concrete result the dialog reports. */
  onReconnect: (name?: string) => Promise<void> | void;
  onClose: () => void;
}

/** Config file lookup order — mirrors the merge order in utils/config.ts. */
const MCP_CONFIG_PATHS = [
  join(process.cwd(), ".deepseek-code.json"),
  join(homedir(), ".config", "deepseek-code", "config.json"),
  join(homedir(), ".deepseek-code.json"),
  join(process.cwd(), ".zcode.json"),
  join(homedir(), ".config", "z-code", "config.json"),
  join(homedir(), ".zcode.json"),
];

/** Minimum spinner dwell so a synchronous session reset still paints once. */
const RECONNECT_MIN_MS = 350;

type Notice =
  | { kind: "reconnect-ok" }
  | { kind: "reconnect-fail"; detail?: string }
  | { kind: "persist-ok"; enabled: boolean }
  | { kind: "persist-fail"; detail?: string }
  | null;

export interface ScopeGroup {
  /** Heading shown above the group's options (null when it's the only group). */
  heading: string;
  /** Config file the group's servers come from (null = dynamic/plugin). */
  file: string | null;
  names: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Resolve the first existing config file in the documented lookup order. */
export function findExistingConfigFiles(): string[] {
  return MCP_CONFIG_PATHS.filter((p) => existsSync(p));
}

export function resolveMcpConfigFile(): string | null {
  return findExistingConfigFiles()[0] ?? null;
}

/** File a toggle persists into when no config file exists yet. */
export function defaultMcpConfigFile(): string {
  return join(homedir(), ".deepseek-code.json");
}

/** Short scope name for an option description (project/user/home/legacy/dynamic). */
export function scopeLabel(file: string | null): string {
  if (!file) return "dynamic";
  if (file === join(process.cwd(), ".deepseek-code.json")) return "project";
  if (file === join(homedir(), ".config", "deepseek-code", "config.json")) return "user";
  if (file === join(homedir(), ".deepseek-code.json")) return "home";
  return "legacy";
}

/** Human-readable config provenance, e.g. "project — .deepseek-code.json". */
export function describeScope(file: string): string {
  if (file === join(process.cwd(), ".deepseek-code.json")) return "project — .deepseek-code.json";
  if (file === join(homedir(), ".config", "deepseek-code", "config.json"))
    return "user — ~/.config/deepseek-code/config.json";
  if (file === join(homedir(), ".deepseek-code.json")) return "home — ~/.deepseek-code.json";
  if (file === join(process.cwd(), ".zcode.json")) return "legacy — .zcode.json";
  if (file === join(homedir(), ".config", "z-code", "config.json"))
    return "legacy — ~/.config/z-code/config.json";
  return "legacy — ~/.zcode.json";
}

/** mcpServers map from a config file, or null when unreadable/absent. */
export function readMcpServers(file: string): Record<string, MCPServerConfig> | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<DeepSeekCodeConfig>;
    return parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : null;
  } catch {
    return null;
  }
}

/**
 * Group servers by the config file that defines them (first file wins, per the
 * config merge order); servers defined nowhere land in a trailing "dynamic"
 * group. Names sort alphabetically within each group.
 */
export function groupServersByScope(
  servers: Record<string, MCPServerConfig>,
  files: string[],
): ScopeGroup[] {
  const groups: ScopeGroup[] = [];
  const assigned = new Set<string>();
  for (const file of files) {
    const defined = readMcpServers(file);
    if (!defined) continue;
    const names = Object.keys(servers)
      .filter((n) => n in defined)
      .sort((a, b) => a.localeCompare(b));
    if (names.length === 0) continue;
    for (const n of names) assigned.add(n);
    groups.push({ heading: describeScope(file), file, names });
  }
  const dynamic = Object.keys(servers)
    .filter((n) => !assigned.has(n))
    .sort((a, b) => a.localeCompare(b));
  if (dynamic.length > 0) {
    groups.push({ heading: "dynamic — not in a config file", file: null, names: dynamic });
  }
  return groups;
}

/**
 * Persist an `enabled` flag for `name` into `file`'s mcpServers BEFORE the
 * in-memory toggle takes effect. Existing entries keep every other field
 * (env: refs stay unresolved). Servers absent from the file are written from
 * the live config minus `env` (its values may already be resolved secrets).
 */
export function persistMcpServerEnabled(
  servers: Record<string, MCPServerConfig>,
  name: string,
  enabled: boolean,
  file: string,
): { ok: boolean; file: string; error?: string } {
  try {
    let config: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        config = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      } catch {
        config = {};
      }
    }
    if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
    const mcpServers = config.mcpServers as Record<string, unknown>;
    const existing = mcpServers[name];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      mcpServers[name] = { ...(existing as Record<string, unknown>), enabled };
    } else {
      const { env: _env, ...base } = servers[name] ?? {};
      mcpServers[name] = { ...base, enabled };
    }
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    return { ok: true, file };
  } catch (err) {
    return { ok: false, file, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Await `promise` but never resolve before `minMs` — keeps a spinner visible. */
export async function withMinDuration<T>(promise: Promise<T> | T, minMs: number): Promise<T> {
  const started = Date.now();
  const value = await promise;
  const remaining = minMs - (Date.now() - started);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return value;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function renderNotice(notice: Exclude<Notice, null>, name: string): React.ReactNode {
  switch (notice.kind) {
    case "reconnect-ok":
      return <Text color={resolveColor(theme.success)}>✓ Reconnected to {name}.</Text>;
    case "reconnect-fail":
      return (
        <Text color={resolveColor(theme.error)}>
          ✗ Failed to reconnect to {name}.{notice.detail ? ` ${notice.detail}` : ""}
        </Text>
      );
    case "persist-ok":
      return (
        <Text color={resolveColor(theme.success)}>
          ✓ {notice.enabled ? "Enabled" : "Disabled"} {name} — persisted, applies on your next message.
        </Text>
      );
    case "persist-fail":
      return (
        <Text color={resolveColor(theme.error)}>
          ✗ Failed to persist — toggle not applied.{notice.detail ? ` ${notice.detail}` : ""}
        </Text>
      );
  }
}

/**
 * Interactive /mcp view — server list grouped by config scope; Enter opens a
 * per-server detail dialog (Status/Command/Args/config provenance) with
 * Reconnect / Enable|Disable / Back. Toggles persist to the config file
 * BEFORE taking effect and apply on the next message. Esc: list → close.
 */
export default function McpView({
  servers,
  onToggle,
  onReconnect,
  onClose,
}: McpViewProps): React.ReactElement {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const configFiles = useMemo(() => findExistingConfigFiles(), []);
  const groups = useMemo(() => groupServersByScope(servers, configFiles), [servers, configFiles]);
  const names = useMemo(() => groups.flatMap((g) => g.names), [groups]);
  const enabledCount = useMemo(
    () => names.filter((n) => servers[n]!.enabled !== false).length,
    [names, servers],
  );

  const server = selectedName ? servers[selectedName] : undefined;

  // --- empty state ---------------------------------------------------------
  if (names.length === 0) {
    return (
      <Dialog
        title="MCP servers"
        subtitle="Model Context Protocol tools and resources"
        onCancel={onClose}
        footer="esc to close"
      >
        <Box flexDirection="column">
          <Text dimColor>No MCP servers configured.</Text>
          <Text dimColor>Add {"\"mcpServers\""} to your .deepseek-code.json, e.g.:</Text>
          <Text dimColor>
            {"  \"mcpServers\": { \"filesystem\": { \"command\": \"npx\", \"args\": [\"-y\", \"@modelcontextprotocol/server-filesystem\", \".\"] } }"}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>Note: only stdio servers (command + args) are fully supported.</Text>
          </Box>
        </Box>
      </Dialog>
    );
  }

  // --- list view -----------------------------------------------------------
  if (!selectedName || !server) {
    const options = groups.flatMap((group) => [
      ...(groups.length > 1
        ? [{ label: `▪ ${group.heading}`, value: `__scope:${group.file ?? "dynamic"}`, disabled: true }]
        : []),
      ...group.names.map((name) => {
        const enabled = servers[name]!.enabled !== false;
        const args = (servers[name]!.args ?? []).join(" ");
        return {
          label: `${enabled ? "●" : "○"} ${name}`,
          value: name,
          description: `${servers[name]!.command ?? "(url)"}${args ? ` ${args}` : ""} · ${scopeLabel(group.file)}`,
        };
      }),
    ]);

    return (
      <Dialog
        title="MCP servers"
        subtitle={`${enabledCount} of ${names.length} enabled`}
        onCancel={onClose}
        footer={
          <Text>
            <Text bold>enter</Text> details · <Text bold>esc</Text> close
          </Text>
        }
      >
        <Select
          options={options}
          onChange={(name) => {
            setNotice(null);
            setSelectedName(name);
          }}
          onCancel={onClose}
          enableNumberKeys
          visibleOptionCount={6}
        />
        <Box marginTop={1}>
          <Text dimColor>Toggling persists to the config file and applies on your next message.</Text>
        </Box>
      </Dialog>
    );
  }

  // --- per-server detail view ----------------------------------------------
  const enabled = server.enabled !== false;
  const group = groups.find((g) => g.names.includes(selectedName)) ?? null;

  const backToList = (): void => {
    setSelectedName(null);
    setNotice(null);
    setReconnecting(false);
  };

  const handleReconnect = async (): Promise<void> => {
    setReconnecting(true);
    setNotice(null);
    try {
      await withMinDuration(Promise.resolve(onReconnect?.(selectedName)), RECONNECT_MIN_MS);
      setNotice({ kind: "reconnect-ok" });
    } catch (err) {
      setNotice({
        kind: "reconnect-fail",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setReconnecting(false);
    }
  };

  const handleToggle = (): void => {
    const target = resolveMcpConfigFile() ?? defaultMcpConfigFile();
    const result = persistMcpServerEnabled(servers, selectedName, !enabled, target);
    if (!result.ok) {
      setNotice({ kind: "persist-fail", detail: result.error ?? "" });
      return;
    }
    setNotice({ kind: "persist-ok", enabled: !enabled });
    onToggle(selectedName, !enabled);
  };

  const actionOptions = [
    ...(enabled ? [{ label: "Reconnect", value: "reconnect" }] : []),
    { label: enabled ? "Disable" : "Enable", value: "toggle" },
    { label: "Back", value: "back" },
  ];

  const handleAction = (value: string): void => {
    if (value === "reconnect") void handleReconnect();
    else if (value === "toggle") handleToggle();
    else if (value === "back") backToList();
  };

  return (
    <Dialog
      title={selectedName}
      subtitle={group ? group.heading : "dynamic — not in a config file"}
      onCancel={backToList}
      footer={
        <Text>
          <Text bold>enter</Text> select · <Text bold>esc</Text> back
        </Text>
      }
    >
      <Box flexDirection="column">
        <Box>
          <Text bold>Status: </Text>
          {enabled ? (
            <Text color={resolveColor(theme.success)}>● enabled</Text>
          ) : (
            <Text color={resolveColor(theme.inactive)}>○ disabled</Text>
          )}
        </Box>
        <Box>
          <Text bold>Command: </Text>
          <Text dimColor>{server.command ?? "(remote — url-based)"}</Text>
        </Box>
        {server.args && server.args.length > 0 && (
          <Box>
            <Text bold>Args: </Text>
            <Text dimColor>{server.args.join(" ")}</Text>
          </Box>
        )}
        <Box>
          <Text bold>Config: </Text>
          <Text dimColor>{group?.file ?? "not in a config file (dynamic)"}</Text>
        </Box>
      </Box>

      {reconnecting ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>Reconnecting to <Text bold>{selectedName}</Text></Text>
          <Spinner label="Restarting MCP server process" />
          <Text dimColor>This may take a few moments.</Text>
        </Box>
      ) : (
        <>
          {notice && (
            <Box marginTop={1}>{renderNotice(notice, selectedName)}</Box>
          )}
          <Box marginTop={1}>
            <Select options={actionOptions} onChange={handleAction} onCancel={backToList} visibleOptionCount={3} />
          </Box>
        </>
      )}
    </Dialog>
  );
}
