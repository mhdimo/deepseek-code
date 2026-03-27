// Main entry point for DeepSeek Code
//
// Supports:
//   - CLI arguments: deepseek-code --model deepseek-reasoner
//   - Environment variables: DEEPSEEK_API_KEY, DEEPSEEK_MODEL, etc.
//   - Config file: .deepseek-code.json
//   - Session resume: deepseek-code --resume <hash>

import React from "react";
import { render } from "ink";
import App from "./tui/App.js";
import { loadConfig, printHelp } from "./core/config.js";
import { loadSettings as loadPersistedSettings } from "./core/storage.js";

const VERSION = "0.1.0";

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

  // Warn (but don't exit) if no API key — the TUI will show instructions
  if (!config.apiKey) {
    // Let it through, the App will show a helpful message when user tries to chat
  }

  const workingDirectory = process.cwd();
  const resumeHash = config.resumeSession;

  const { waitUntilExit } = render(
    <App config={config} workingDirectory={workingDirectory} resumeSessionHash={resumeHash} />,
  );

  await waitUntilExit();

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
