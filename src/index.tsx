// Main entry point for DeepSeek Code
//
// Supports:
//   - CLI arguments: deepseek-code --model deepseek-reasoner
//   - Environment variables: DEEPSEEK_API_KEY, DEEPSEEK_MODEL, etc.
//   - Config file: .deepseek-code.json

import React from "react";
import { render } from "ink";
import App from "./tui/App.js";
import { loadConfig, printHelp } from "./core/config.js";

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

  const { waitUntilExit } = render(
    <App config={config} workingDirectory={workingDirectory} />,
  );

  await waitUntilExit();
}

main().catch((error) => {
  console.error("Fatal error:", error.message || error);
  process.exit(1);
});
