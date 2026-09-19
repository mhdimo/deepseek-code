
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select } from "../ui/design-system/Select.js";
import { theme, resolveColor } from "../utils/theme.js";
import { activeProjectConfigPaths } from "../utils/config.js";
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

/**
 * Config file lookup order — mirrors the merge order in utils/config.ts, since
 * a toggle has to persist into the same file the app reads back.
 *
 * The workspace's own files are only in this list once the directory is
 * trusted. Reading an untrusted workspace's config here would list servers the
 * app has refused to load, and writing to it would drop the user's toggle into
 * a file that is ignored until the day it isn't.
 */
function mcpConfigPaths(): string[] {
  return [
    ...activeProjectConfigPaths(),
    join(homedir(), ".config", "deepseek-code", "config.json"),
    join(homedir(), ".deepseek-code.json"),
    join(homedir(), ".config", "z-code", "config.json"),
    join(homedir(), ".zcode.json"),
  ];
}

/** Minimum spinner dwell so a synchronous session reset still paints once. */
const RECONNECT_MIN_MS = 350;

export type Notice =
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
  return mcpConfigPaths().filter((p) => existsSync(p));
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

/** Bold group label plus its dim, parenthesized path — the reference's scope
 *  headings ("Project MCPs" + "(.deepseek-code.json)"). The scope names are
 *  ours; the shape is the reference's. */
export function scopeHeading(file: string | null): { label: string; path?: string } {
  if (!file) return { label: "Dynamic MCPs", path: "not in a config file" };
  if (file === join(process.cwd(), ".deepseek-code.json"))
    return { label: "Project MCPs", path: ".deepseek-code.json" };
  if (file === join(homedir(), ".config", "deepseek-code", "config.json"))
    return { label: "User MCPs", path: "~/.config/deepseek-code/config.json" };
  if (file === join(homedir(), ".deepseek-code.json"))
    return { label: "User MCPs", path: "~/.deepseek-code.json" };
  if (file === join(process.cwd(), ".zcode.json")) return { label: "Legacy MCPs", path: ".zcode.json" };
  if (file === join(homedir(), ".config", "z-code", "config.json"))
    return { label: "Legacy MCPs", path: "~/.config/z-code/config.json" };
  return { label: "Legacy MCPs", path: "~/.zcode.json" };
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

  const server = selectedName ? servers[selectedName] : undefined;

  // The list is a plain cursor, not a Select: the reference renders scope
  // headings (bold label + dim path) that a Select option cannot carry.
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => {
    if (selectedIndex >= names.length) setSelectedIndex(Math.max(0, names.length - 1));
  }, [names.length, selectedIndex]);

  useInput((input, key) => {
    if (selectedName || names.length === 0) return;
    if (key.upArrow || input === "k") {
      setSelectedIndex((i) => (i - 1 + names.length) % names.length);
    } else if (key.downArrow || input === "j") {
      setSelectedIndex((i) => (i + 1) % names.length);
    } else if (key.return) {
      const name = names[selectedIndex];
      if (name) {
        setNotice(null);
        setSelectedName(name);
      }
    }
  });

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
    return (
      <>
        <Dialog
          title="Manage MCP servers"
          subtitle={`${names.length} server${names.length === 1 ? "" : "s"}`}
          onCancel={onClose}
          hideInputGuide
        >
          <Box flexDirection="column">
            {groups.map((group) => {
              const heading = scopeHeading(group.file);
              return (
                <Box key={group.file ?? "dynamic"} flexDirection="column" marginBottom={1}>
                  <Box paddingLeft={2}>
                    <Text bold>{heading.label}</Text>
                    {heading.path !== undefined && <Text dimColor> ({heading.path})</Text>}
                  </Box>
                  {group.names.map((name) => {
                    const index = names.indexOf(name);
                    const isSelected = index === selectedIndex;
                    const enabled = servers[name]!.enabled !== false;
                    return (
                      <Box key={name}>
                        <Text color={isSelected ? resolveColor(theme.suggestion) : undefined}>
                          {isSelected ? "❯ " : "  "}
                        </Text>
                        <Text color={isSelected ? resolveColor(theme.suggestion) : undefined}>
                          {name}
                        </Text>
                        {!enabled && (
                          <Text dimColor={!isSelected}>
                            {" · "}
                            <Text color={resolveColor(theme.inactive)}>○</Text>
                            {" "}
                          </Text>
                        )}
                        {!enabled && <Text dimColor={!isSelected}>disabled</Text>}
                      </Box>
                    );
                  })}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Toggling persists to the config file and applies on your next message.</Text>
          </Box>
        </Dialog>
        <Box paddingX={1}>
          <Text dimColor italic>↑↓ to navigate · Enter to confirm · Esc to cancel</Text>
        </Box>
      </>
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

  const handleAction = (value: string): void => {
    if (value === "reconnect") void handleReconnect();
    else if (value === "toggle") handleToggle();
    else if (value === "back") backToList();
  };

  return (
    <McpServerDetail
      name={selectedName}
      server={server}
      configScope={group ? group.heading : null}
      reconnecting={reconnecting}
      notice={notice}
      onReconnect={handleAction}
      onBack={backToList}
    />
  );
}

export interface McpServerDetailProps {
  name: string;
  server: MCPServerConfig;
  /** Present when the server comes from a config file; null for a dynamic one. */
  configScope: string | null;
  reconnecting: boolean;
  notice: Notice;
  onReconnect: (action: string) => void;
  onBack: () => void;
}

/**
 * Per-server detail pane: capitalized "<Name> MCP Server" header (the reference
 * names the server, not the raw id), Status/Command/Args/Config location rows,
 * the reconnect spinner or a notice, and the Reconnect / Enable|Disable / Back
 * menu.
 */
export function McpServerDetail({
  name,
  server,
  configScope,
  reconnecting,
  notice,
  onReconnect,
  onBack,
}: McpServerDetailProps): React.ReactElement {
  const enabled = server.enabled !== false;
  const capitalizedName = name.charAt(0).toUpperCase() + name.slice(1);
  const actionOptions = [
    ...(enabled ? [{ label: "Reconnect", value: "reconnect" }] : []),
    { label: enabled ? "Disable" : "Enable", value: "toggle" },
    { label: "Back", value: "back" },
  ];

  return (
    <Dialog
      title={`${capitalizedName} MCP Server`}
      subtitle={configScope ?? "dynamic — not in a config file"}
      onCancel={onBack}
      footer={
        <Text>
          <Text bold>↑↓</Text> to navigate · <Text bold>Enter</Text> to select · <Text bold>Esc</Text> to
          back
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
          <Text bold>Config location: </Text>
          <Text dimColor>{configScope ?? "not in a config file (dynamic)"}</Text>
        </Box>
      </Box>

      {reconnecting ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>Reconnecting to <Text bold>{name}</Text></Text>
          <Spinner label="Restarting MCP server process" />
          <Text dimColor>This may take a few moments.</Text>
        </Box>
      ) : (
        <>
          {notice && (
            <Box marginTop={1}>{renderNotice(notice, name)}</Box>
          )}
          <Box marginTop={1}>
            <Select options={actionOptions} onChange={onReconnect} onCancel={onBack} visibleOptionCount={3} />
          </Box>
        </>
      )}
    </Dialog>
  );
}
