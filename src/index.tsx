







import React from "react";
import { render } from "ink";
import App from "./components/App.js";
import AlternateScreen from "./components/AlternateScreen.js";
import { loadConfig, printHelp } from "./utils/config.js";
import { loadSettings as loadPersistedSettings, hardenDataDir } from "./state/storage.js";
import { resolveThemeSetting, syncLiveTheme } from "./utils/theme.js";
import { APP_VERSION } from "./utils/version.js";
import { existsSync, readFileSync } from "fs";
import { INK_RENDER_OPTIONS } from "./components/terminalLayout.js";
import { createSanitizedStdin } from "./components/inkStdin.js";
import { EMPTY_FINISH_REASON } from "./services/recovery.js";
import { LIMIT_FINISH_REASON } from "./services/stepLimit.js";
import { assertBypassSafe } from "./services/bypassMode.js";
import { contextWindowFor } from "./services/contextManager.js";

const VERSION = APP_VERSION;






// The root/sandbox gate and the permission-mode cycle both live in
// services/bypassMode.ts: the TUI can reach `bypassPermissions` by keypress as
// well as by flag, and the two paths have to agree on when it is allowed.

async function main() {
  const config = loadConfig();


  // ~/.deepseek-code holds the API key and full session transcripts. Repair its
  // permissions before anything reads or writes there; the App reports what was
  // fixed via takeHardeningNotes().
  hardenDataDir();

  if (config.help) {
    printHelp();
    process.exit(0);
  }

  
  if (config.version) {
    console.log(`DeepSeek Code v${VERSION}`);
    process.exit(0);
  }


  assertBypassSafe(config, (config as any).print !== undefined);

  
  
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
      const result = await runPrint({
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
        dangerouslySkipPermissions: config.dangerouslySkipPermissions,
        // The TUI passes this and headless did not, so the engine fell back to
        // its own 128K while everything else here believed the model's real
        // window — headless runs compacted a million-token model eight times
        // too early and never said why.
        maxContextTokens: contextWindowFor(config.model),
      });
      // A run cut off at its step budget is not a successful run — CI has to
      // be able to tell a finished task from a truncated one. Neither is one
      // that produced nothing at all: a rejected request and a completed turn
      // are the same event, and silently exiting 0 makes them the same result.
      process.exit(
        result.finishReason === LIMIT_FINISH_REASON || result.finishReason === EMPTY_FINISH_REASON
          ? 1
          : 0,
      );
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
    
    
    
    
    
    
    
    
    {
      ...INK_RENDER_OPTIONS,
      // Ink's keypress parser throws on escape sequences it has no key for —
      // pasting a coloured diff kills the app mid-keystroke. Filter them at the
      // source; see components/inkStdin.ts.
      stdin: createSanitizedStdin(process.stdin),
    },
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
