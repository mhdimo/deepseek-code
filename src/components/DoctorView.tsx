import React, { useCallback, useEffect, useRef, useState } from "react";
import { join } from "path";
import { homedir } from "os";
import { Box, Text, useInput } from "ink";
import { Pane } from "../ui/design-system/Pane.js";
import { theme, resolveColor } from "../utils/theme.js";
import { dataDir } from "../utils/dataDir.js";
import {
  runDoctorChecks,
  type ContextWarnings,
  type DoctorDiagnostics,
  type SettingsError,
} from "../utils/doctorChecks.js";

export interface DoctorViewProps {
  provider: string;
  model: string;
  baseURL?: string;
  apiKeyPreview?: string;
  onClose: () => void;
}

type CheckStatus = "pending" | "success" | "error" | "warning";

interface CheckRow {
  label: string;
  status: CheckStatus;
  detail: string;
}

/** figures.warning — the marker the reference prefixes warning lines with. */
const WARNING_MARKER = "⚠";

/**
 * Interactive /doctor view — runs the same diagnostics as the old text
 * command (runtime, native bindings, git, rg, API key, network) plus the
 * deep-dive sections (context usage warnings, unreachable permission rules,
 * invalid settings, agent/plugin/MCP parse errors, env-var bounds) as a live
 * checklist with re-run support.
 *
 * Laid out like the reference Diagnostics pane: a `└ label: value` line per
 * check, the deep-dive sections below, and a permission-colored
 * "Press Enter to continue…" line last.
 */
export default function DoctorView({
  provider,
  model,
  baseURL,
  apiKeyPreview,
  onClose,
}: DoctorViewProps): React.ReactElement {
  const [rows, setRows] = useState<CheckRow[]>([]);
  const [diag, setDiag] = useState<DoctorDiagnostics | null>(null);
  const [running, setRunning] = useState(true);
  const runIdRef = useRef(0);

  const patchRow = (label: string, patch: Partial<CheckRow>) => {
    setRows((prev) => prev.map((row) => (row.label === label ? { ...row, ...patch } : row)));
  };

  const runChecks = useCallback(async () => {
    const runId = ++runIdRef.current;
    setRunning(true);

    const isBun = typeof Bun !== "undefined";
    const initial: CheckRow[] = [
      {
        label: "Runtime",
        status: isBun ? "success" : "warning",
        detail: isBun ? `Bun v${Bun.version}` : `Node ${process.version}`,
      },
      { label: "C++ native engine", status: "pending", detail: "checking…" },
      { label: "Git CLI", status: "pending", detail: "checking…" },
      { label: "Search (rg)", status: "pending", detail: "checking…" },
      {
        label: "API key",
        status: apiKeyPreview ? "success" : "warning",
        detail: apiKeyPreview ? `configured (${apiKeyPreview})` : "not set — use /setup or /apikey",
      },
      { label: "Model", status: "success", detail: `${provider}/${model}` },
      { label: "Network", status: "pending", detail: "checking…" },
    ];
    setRows(initial);

    let bindingsOk = false;
    let bindingsError = "";
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const native = require("ai-sdk-cpp") as { getOrCreateMemorySession?: unknown };
      bindingsOk = typeof native.getOrCreateMemorySession === "function";
    } catch (e) {
      bindingsError = (e as Error).message;
    }
    if (runId !== runIdRef.current) return;
    patchRow("C++ native engine", {
      status: bindingsOk ? "success" : "error",
      detail: bindingsOk ? "loaded successfully" : `failed to load: ${bindingsError}`,
    });

    let gitOk = false;
    let gitVersion = "";
    try {
      const proc = Bun.spawnSync(["git", "--version"]);
      gitVersion = proc.stdout?.toString().trim() ?? "";
      gitOk = gitVersion.length > 0 && proc.exitCode === 0;
    } catch {
      gitOk = false;
    }
    if (runId !== runIdRef.current) return;
    patchRow("Git CLI", {
      status: gitOk ? "success" : "warning",
      detail: gitOk ? gitVersion : "not found or not executable",
    });

    const targetUrl = baseURL || "https://api.deepseek.com/v1";
    let connOk = false;
    let timeMs = 0;
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      await fetch(targetUrl, { signal: controller.signal }).catch(() => {});
      clearTimeout(timer);
      timeMs = Date.now() - start;
      connOk = true;
    } catch {
      connOk = false;
    }
    if (runId !== runIdRef.current) return;
    patchRow("Network", {
      status: connOk ? "success" : "error",
      detail: connOk
        ? `reachable: ${targetUrl} (${timeMs}ms)`
        : `cannot reach ${targetUrl}`,
    });

    // Deep-dive diagnostics (sync fs/env checks).
    const d = runDoctorChecks();
    if (runId !== runIdRef.current) return;
    setDiag(d);
    patchRow("Search (rg)", {
      status: d.ripgrep.ok ? "success" : "warning",
      detail: d.ripgrep.detail,
    });

    setRunning(false);
  }, [provider, model, baseURL, apiKeyPreview]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  useInput((input, key) => {
    // The reference dismisses the Diagnostics pane on either confirm key.
    if (key.escape || key.return || input === "q") {
      onClose();
      return;
    }
    if (input === "r" && !running) {
      void runChecks();
    }
  });

  const warningColor = resolveColor(theme.warning);
  const errorColor = resolveColor(theme.error);

  const contextWarnings: ContextWarnings | null = diag?.contextWarnings ?? null;
  const cw = contextWarnings;

  return (
    <Box flexDirection="column">
      <Pane>
        <Text bold>Diagnostics</Text>

        {rows.map((row) => (
          <Text
            key={row.label}
            color={
              row.status === "warning"
                ? warningColor
                : row.status === "error"
                  ? errorColor
                  : undefined
            }
            dimColor={row.status === "pending"}
            wrap="truncate-end"
          >
            └ {row.label}: {row.detail}
          </Text>
        ))}

        {!running && diag && (
          <Box flexDirection="column">
            {diag.invalidSettings.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={errorColor}>Invalid Settings</Text>
                <SettingsErrorsTree errors={diag.invalidSettings} />
              </Box>
            )}

            {diag.envVarErrors.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={errorColor}>Environment Variables</Text>
                {diag.envVarErrors.map((v, i) => (
                  <Text key={i}>
                    └ {v.name}:{" "}
                    <Text color={resolveColor(v.status === "capped" ? theme.warning : theme.error)}>
                      {v.message}
                    </Text>
                  </Text>
                ))}
              </Box>
            )}

            {diag.agentParseErrors.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={errorColor}>Agent Parse Errors</Text>
                <Text color={errorColor}>
                  └ Failed to parse {diag.agentParseErrors.length} agent file(s):
                </Text>
                {diag.agentParseErrors.map((f, i) => (
                  <Text key={i} dimColor>{"  "}└ {f.path}: {f.error}</Text>
                ))}
              </Box>
            )}

            {diag.pluginErrors.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={errorColor}>Plugin Errors</Text>
                <Text color={errorColor}>└ {diag.pluginErrors.length} plugin error(s) detected:</Text>
                {diag.pluginErrors.map((f, i) => (
                  <Text key={i} dimColor>{"  "}└ {f.path}: {f.error}</Text>
                ))}
              </Box>
            )}

            {diag.mcpParsingWarnings.length > 0 && (
              <Box flexDirection="column" marginTop={1} marginBottom={1}>
                <Text bold color={warningColor}>MCP Config Diagnostics</Text>
                <Box marginTop={1}>
                  <Text dimColor>
                    For help configuring MCP servers, see: https://api-docs.deepseek.com
                  </Text>
                </Box>
                {diag.mcpParsingWarnings.map((w, i) => {
                  const failedToParse = /^invalid JSON/.test(w.error);
                  return (
                    <Box key={i} flexDirection="column" marginTop={1}>
                      <Box>
                        <Text color={failedToParse ? errorColor : warningColor}>
                          [{failedToParse ? "Failed to parse" : "Contains warnings"}]{" "}
                        </Text>
                        <Text>{configFileLabel(w.path)}</Text>
                      </Box>
                      <Box>
                        <Text dimColor>Location: </Text>
                        <Text dimColor>{w.path}</Text>
                      </Box>
                      <Box marginLeft={1} flexDirection="column">
                        <Text>
                          <Text dimColor>└ </Text>
                          <Text color={failedToParse ? errorColor : warningColor}>
                            [{failedToParse ? "Error" : "Warning"}]
                          </Text>
                          <Text dimColor> {w.error}</Text>
                        </Text>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            )}

            {cw?.unreachableRulesWarning && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={warningColor}>Unreachable Permission Rules</Text>
                <Text>
                  └ <Text color={warningColor}>{WARNING_MARKER} {cw.unreachableRulesWarning.message}</Text>
                </Text>
                {cw.unreachableRulesWarning.details.map((d, i) => (
                  <Text key={i} dimColor>{"  "}└ {d}</Text>
                ))}
              </Box>
            )}

            {cw && (cw.claudeMdWarning || cw.agentWarning || cw.mcpWarning) && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={warningColor}>Context Usage Warnings</Text>
                {cw.claudeMdWarning && (
                  <>
                    <Text>└ <Text color={warningColor}>{WARNING_MARKER} {cw.claudeMdWarning.message}</Text></Text>
                    <Text>{"  "}└ Files:</Text>
                    {cw.claudeMdWarning.details.map((d, i) => (
                      <Text key={i} dimColor>{"    "}└ {d}</Text>
                    ))}
                  </>
                )}
                {cw.agentWarning && (
                  <>
                    <Text>└ <Text color={warningColor}>{WARNING_MARKER} {cw.agentWarning.message}</Text></Text>
                    <Text>{"  "}└ Top contributors:</Text>
                    {cw.agentWarning.details.map((d, i) => (
                      <Text key={i} dimColor>{"    "}└ {d}</Text>
                    ))}
                  </>
                )}
                {cw.mcpWarning && (
                  <>
                    <Text>└ <Text color={warningColor}>{WARNING_MARKER} {cw.mcpWarning.message}</Text></Text>
                    <Text>{"  "}└ MCP servers:</Text>
                    {cw.mcpWarning.details.map((d, i) => (
                      <Text key={i} dimColor>{"    "}└ {d}</Text>
                    ))}
                  </>
                )}
              </Box>
            )}
          </Box>
        )}

        <Box marginTop={1}>
          {running ? (
            <Text dimColor italic>Running checks…</Text>
          ) : (
            <Text color={resolveColor(theme.permission)}>
              Press <Text bold>Enter</Text> to continue…
            </Text>
          )}
        </Box>
      </Pane>
    </Box>
  );
}

// ── Invalid-settings rendering ─────────────────────────────────────────────
// The reference renders settings validation errors as the offending file
// followed by a dim, indented tree of the bad paths (ValidationErrorsList).
// Our validator reports flat dot-paths, so build that same shape here.

type TreeNode = { [key: string]: TreeNode | string };

function buildNestedTree(errors: readonly SettingsError[]): TreeNode {
  const tree: TreeNode = {};
  for (const error of errors) {
    const parts = error.key.split(".").filter((part) => part.length > 0);
    if (parts.length === 0) {
      tree[error.key] = error.message;
      continue;
    }
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (typeof node[part] !== "object") node[part] = {};
      node = node[part] as TreeNode;
    }
    node[parts[parts.length - 1]!] = error.message;
  }
  return tree;
}

/** Renders the tree with the same branch glyphs treeify uses (├ / └ / │). */
function renderTree(node: TreeNode, prefix = "", depth = 0): string[] {
  const keys = Object.keys(node);
  const lines: string[] = [];
  keys.forEach((key, index) => {
    const value = node[key]!;
    const isLast = index === keys.length - 1;
    const nodePrefix = depth === 0 && index === 0 ? "" : prefix;
    const line = `${nodePrefix}${isLast ? "└" : "├"} ${key}`;
    if (typeof value === "string") {
      lines.push(`${line}: ${value}`);
      return;
    }
    lines.push(line);
    lines.push(...renderTree(value, `${nodePrefix}${isLast ? " " : "│"} `, depth + 1));
  });
  return lines;
}

/** Which settings file the validation errors came from (settings.json is the
 *  only store validateSettings reads). */
function settingsFilePath(): string {
  return join(dataDir(), "settings.json");
}

function SettingsErrorsTree({ errors }: { errors: readonly SettingsError[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{settingsFilePath()}</Text>
      <Box marginLeft={1}>
        <Text dimColor>{renderTree(buildNestedTree(errors)).join("\n")}</Text>
      </Box>
    </Box>
  );
}

/** Human label for a config file's scope — the closest match to the
 *  reference's per-scope heading (user vs project config). */
function configFileLabel(path: string): string {
  const cwd = process.cwd();
  const home = homedir();
  const scope = path.startsWith(cwd) ? "Project config" : path.startsWith(home) ? "User config" : "Config";
  return /z[-_]?code/i.test(path) ? `${scope} (legacy)` : scope;
}
