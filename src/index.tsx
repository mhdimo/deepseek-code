// Main entry point for z-code
//
// Supports:
//   - CLI arguments: z-code --model glm-4 --base-url https://...
//   - Environment variables: ZCODE_API_KEY, ZCODE_MODEL, etc.
//   - Config file: .zcode.json

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
    console.log(`z-code v${VERSION}`);
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
