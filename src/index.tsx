// Main entry point for DeepSeek Code
//
// Supports:
//   - CLI arguments: deepseek-code --model deepseek-reasoner
//   - Environment variables: DEEPSEEK_API_KEY, DEEPSEEK_MODEL, etc.
//   - Config file: .deepseek-code.json
//   - Session resume: deepseek-code --resume <hash>

import React from "react";
import { render } from "ink";
import App from "./components/App.js";
import { loadConfig, printHelp } from "./utils/config.js";
import { loadSettings as loadPersistedSettings } from "./state/storage.js";
import { resolveThemeSetting, syncLiveTheme } from "./utils/theme.js";
import { existsSync, readFileSync } from "fs";

const VERSION = "0.1.0";

// ── Bypass-permissions safety gate ──────────────────────────────────────────
// When --dangerously-skip-permissions / bypassPermissions is on, the agent can
// run ANY command without asking. Refusing to do that as root/sudo outside a
// sandbox prevents the model from running unrestricted as root on the host.

function isRunningAsRoot(): boolean {
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  // `sudo` may preserve the invoking user's uid via SUDO_UID; treat sudo as root.
  if (process.env.SUDO_UID !== undefined || process.env.SUDO_USER !== undefined) return true;
  return false;
}

function isInContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env.container) return true;
  try {
    // Linux: /proc/1/cgroup or /proc/1/mountinfo reveals docker/containerd/k8s.
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (/docker|containerd|kubepods|lxc/.test(cgroup)) return true;
  } catch {
    // not on Linux or unreadable — treat as not-in-container
  }
  return false;
}

function assertBypassSafe(config: { dangerouslySkipPermissions?: boolean }): void {
  if (!config.dangerouslySkipPermissions) return;
  if (isRunningAsRoot() && !isInContainer()) {
    console.error(
      "\n  Refusing to run with --dangerously-skip-permissions as root/sudo outside a sandbox.\n" +
        "  That would let the agent execute arbitrary commands unrestricted as root on your host.\n\n" +
        "  Options:\n" +
        "    • Run as a non-root user.\n" +
        "    • Run inside a container/sandbox (detected automatically).\n" +
        "    • Drop --dangerously-skip-permissions and approve commands individually.\n",
    );
    process.exit(1);
  }
}

async function main() {
  const config = loadConfig();

  // Handle --help
  if (config.help) {
    printHelp();
    process.exit(0);
  }

  // Handle --version
  if (config.version) {
    console.log(`DeepSeek Code v${VERSION}`);
    process.exit(0);
  }

  // Safety: refuse bypass-permissions as root/sudo outside a sandbox.
  assertBypassSafe(config);

  // Headless / print mode: run one prompt non-interactively, then exit.
  // Used for scripting/CI (`--print`, `--output-format json`, etc.).
  if ((config as any).print !== undefined) {
    const { runPrint } = await import("./cli/print.js");
    let prompt = (config as any).print as string;
    if (!prompt) {
      // `-p` / `--print` with no argument → read the prompt from stdin.
      prompt = await new Response(Bun.stdin).text();
    }
    const providerConfig = {
      type: config.provider,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
    };
    try {
      await runPrint({
        prompt,
        model: config.model,
        outputFormat: (config as any).printOutputFormat,
        maxTurns: (config as any).printMaxTurns,
        systemPromptFile: (config as any).printSystemPromptFile,
        providerConfig,
        agent: config.defaultAgent,
        verbose: (config as any).printVerbose,
        streamText: (config as any).printStreamText,
        mcpServers: config.mcpServers,
        workingDir: process.cwd(),
      });
      process.exit(0);
    } catch {
      // runPrint already reported the error; set a non-zero exit code for CI.
      process.exit(1);
    }
  }

  // Warn (but don't exit) if no API key — the TUI will show instructions
  if (!config.apiKey) {
    // Let it through, the App will show a helpful message when user tries to chat
  }

  const workingDirectory = process.cwd();
  const resumeHash = config.resumeSession;

  // Initialize the live theme object from the persisted setting (resolves
  // 'auto' via the terminal, and handles ANSI/daltonized variants).
  const themeMode = (config as any).themeMode || "dark";
  syncLiveTheme(resolveThemeSetting(themeMode));

  // Apply configured env vars to the process environment (inherited by BashTool).
  try {
    const { loadSettings } = require("./state/storage.js");
    const env = loadSettings().env;
    if (env && typeof env === "object") {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string") process.env[k] = v;
      }
    }
  } catch {
    // best-effort
  }

  const { waitUntilExit } = render(
    <App config={config} workingDirectory={workingDirectory} resumeSessionHash={resumeHash} />,
    // IMPORTANT: do NOT enable `incrementalRendering: true`. It switches Ink to
    // log-update's incremental mode, which rewrites only the *changed* lines via
    // cursor navigation based on the previous frame's measured height. With this
    // app's dynamic content (streaming text, tool blocks, status bar, and the
    // placeholder↔text node-type switch in MultilineTextInput), that positioning
    // desyncs and every keystroke/append stacks a new line instead of overwriting
    // the previous frame (the "input doesn't refresh" / streaming-overlap bug).
    // The default (false) does a full erase+redraw per frame — robust and immune
    // to this. Re-render frequency is already capped by Ink's maxFps (30) and our
    // 80ms streaming flush, so there is no performance cost to leaving this off.
    { incrementalRendering: false },
  );

  await waitUntilExit();

  // After TUI exits, print a compact session summary from the latest
  // persisted stats record (duration · model · tokens · cost), then the
  // resume hint. Skip silently when no session was ever recorded.
  try {
    const { loadGlobalStats } = await import("./state/stats.js");
    const stats = loadGlobalStats();
    let latest: { createdAt: number; updatedAt: number; model: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number } | null = null;
    for (const s of stats.sessions) {
      if (latest === null || s.updatedAt > latest.updatedAt) latest = s;
    }
    if (latest) {
      const { formatSessionSummaryLine } = await import("./utils/costSummary.js");
      const totalTokens = (latest.tokens?.input ?? 0) + (latest.tokens?.output ?? 0);
      if (totalTokens > 0 || latest.cost > 0) {
        console.log(
          `\n  ${formatSessionSummaryLine({
            startedAtMs: latest.createdAt,
            endedAtMs: latest.updatedAt,
            inputTokens: latest.tokens?.input ?? 0,
            outputTokens: latest.tokens?.output ?? 0,
            totalTokens,
            cost: latest.cost ?? 0,
            model: latest.model || "unknown",
            turns: 0, // SessionRecord does not track turn count
          })}`,
        );
      }
    }
  } catch {
    // Silently skip — a summary must never break exit
  }

  // After TUI exits, show resume hint
  try {
    const settings = loadPersistedSettings();
    if (settings.lastSessionHash) {
      console.log(`\n  Resume this session: deepseek-code --resume ${settings.lastSessionHash}\n`);
    }
  } catch {
    // Silently skip
  }
}

main().catch((error) => {
  console.error("Fatal error:", error.message || error);
  process.exit(1);
});
