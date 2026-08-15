
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { StatusIcon } from "../ui/design-system/StatusIcon.js";
import { theme, resolveColor } from "../utils/theme.js";
import {
  runDoctorChecks,
  type ContextWarnings,
  type DoctorDiagnostics,
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

/**
 * Interactive /doctor view — runs the same diagnostics as the old text
 * command (runtime, native bindings, git, rg, API key, network) plus the
 * deep-dive sections (context usage warnings, unreachable permission rules,
 * invalid settings, agent/plugin/MCP parse errors, env-var bounds) as a live
 * checklist with re-run support.
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
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (input === "r" && !running) {
      void runChecks();
    }
  });

  const diagIssueCount =
    (diag?.invalidSettings.length ?? 0) +
    (diag?.agentParseErrors.length ?? 0) +
    (diag?.pluginErrors.length ?? 0) +
    (diag?.envVarErrors.filter((v) => v.status === "invalid").length ?? 0);
  const allOk =
    !running &&
    diag !== null &&
    rows.every((row) => row.status === "success" || row.status === "warning") &&
    diagIssueCount === 0;

  const warningColor = resolveColor(theme.warning);
  const errorColor = resolveColor(theme.error);

  const contextWarnings: ContextWarnings | null = diag?.contextWarnings ?? null;
  const cw = contextWarnings;

  return (
    <Dialog
      title="DeepSeek Code doctor"
      subtitle="Installation and connectivity diagnostics"
      onCancel={onClose}
      footer={
        <Text>
          <Text bold>r</Text> to re-run · <Text bold>esc</Text> to close
        </Text>
      }
    >
      <Box flexDirection="column">
        {rows.map((row) => (
          <Box key={row.label}>
            <StatusIcon
              status={row.status === "pending" ? "loading" : row.status}
              withSpace
            />
            <Text>{row.label.padEnd(18)}</Text>
            <Text dimColor wrap="truncate-end">{row.detail}</Text>
          </Box>
        ))}
      </Box>

      {!running && diag && (
        <Box flexDirection="column">
          {diag.invalidSettings.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color={errorColor}>Invalid Settings</Text>
              {diag.invalidSettings.map((e, i) => (
                <Text key={i} dimColor>
                  └ {e.key}: <Text color={errorColor}>{e.message}</Text>
                </Text>
              ))}
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
            <Box flexDirection="column" marginTop={1}>
              <Text bold color={warningColor}>MCP Config Parsing Warnings</Text>
              {diag.mcpParsingWarnings.map((w, i) => (
                <Text key={i} dimColor>
                  └ {w.path}: <Text color={warningColor}>{w.error}</Text>
                </Text>
              ))}
            </Box>
          )}

          {cw?.unreachableRulesWarning && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color={warningColor}>Unreachable Permission Rules</Text>
              <Text>
                └ <Text color={warningColor}>! {cw.unreachableRulesWarning.message}</Text>
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
                  <Text>└ <Text color={warningColor}>! {cw.claudeMdWarning.message}</Text></Text>
                  <Text>{"  "}└ Files:</Text>
                  {cw.claudeMdWarning.details.map((d, i) => (
                    <Text key={i} dimColor>{"    "}└ {d}</Text>
                  ))}
                </>
              )}
              {cw.agentWarning && (
                <>
                  <Text>└ <Text color={warningColor}>! {cw.agentWarning.message}</Text></Text>
                  <Text>{"  "}└ Top contributors:</Text>
                  {cw.agentWarning.details.map((d, i) => (
                    <Text key={i} dimColor>{"    "}└ {d}</Text>
                  ))}
                </>
              )}
              {cw.mcpWarning && (
                <>
                  <Text>└ <Text color={warningColor}>! {cw.mcpWarning.message}</Text></Text>
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
          <Text color={resolveColor(allOk ? theme.success : theme.error)} dimColor={allOk}>
            {allOk
              ? "Everything looks healthy — you are ready to code."
              : "Diagnostics finished with issues — review the failures above."}
          </Text>
        )}
      </Box>
    </Dialog>
  );
}
