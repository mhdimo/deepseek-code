







import React from "react";
import { render } from "ink";
import App from "./components/App.js";
import AlternateScreen from "./components/AlternateScreen.js";
import { loadConfig, printHelp } from "./utils/config.js";
import { loadSettings as loadPersistedSettings } from "./state/storage.js";
import { resolveThemeSetting, syncLiveTheme } from "./utils/theme.js";
import { existsSync, readFileSync } from "fs";

const VERSION = "0.1.0";






function isRunningAsRoot(): boolean {
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  
  if (process.env.SUDO_UID !== undefined || process.env.SUDO_USER !== undefined) return true;
  return false;
}

function isInContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env.container) return true;
  try {
    
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (/docker|containerd|kubepods|lxc/.test(cgroup)) return true;
  } catch {
    
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

  
  if (config.help) {
    printHelp();
    process.exit(0);
  }

  
  if (config.version) {
    console.log(`DeepSeek Code v${VERSION}`);
    process.exit(0);
  }

  
  assertBypassSafe(config);

  
  
  if ((config as any).print !== undefined) {
    const { runPrint } = await import("./cli/print.js");
    let prompt = (config as any).print as string;
    if (!prompt) {
      
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
      
      process.exit(1);
    }
  }

  
  if (!config.apiKey) {
    
  }

  const workingDirectory = process.cwd();
  const resumeHash = config.resumeSession;

  
  
  const themeMode = (config as any).themeMode || "dark";
  syncLiveTheme(resolveThemeSetting(themeMode));

  
  try {
    const { loadSettings } = require("./state/storage.js");
    const env = loadSettings().env;
    if (env && typeof env === "object") {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string") process.env[k] = v;
      }
    }
  } catch {
    
  }

  const { waitUntilExit } = render(
    <AlternateScreen>
      <App config={config} workingDirectory={workingDirectory} resumeSessionHash={resumeHash} />
    </AlternateScreen>,
    
    
    
    
    
    
    
    
    { incrementalRendering: true },
  );

  await waitUntilExit();

  
  
  
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
            turns: 0, 
          })}`,
        );
      }
    }
  } catch {
    
  }

  
  try {
    const settings = loadPersistedSettings();
    if (settings.lastSessionHash) {
      console.log(`\n  Resume this session: deepseek-code --resume ${settings.lastSessionHash}\n`);
    }
  } catch {
    
  }
}

main().catch((error) => {
  console.error("Fatal error:", error.message || error);
  process.exit(1);
});
