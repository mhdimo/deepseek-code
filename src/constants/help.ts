import { getHelpGroups } from "../services/commands/commandRegistry.js";

export interface HelpCommand {
  name: string;
  description: string;
  usage?: string[];
  aliases?: string[];
}

export interface CommandGroup {
  title: string;
  commands: HelpCommand[];
}

export const HELP_INTRO =
  "DeepSeek Code understands your codebase, makes edits with your permission, and executes commands — right from your terminal.";

export const HELP_FOOTER = "For more help: https://api-docs.deepseek.com";

export const KEYBOARD_SHORTCUTS: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: "↑↓", description: "Navigate command picker (type / first)" },
  { keys: "Tab", description: "Confirm picker selection / autocomplete" },
  { keys: "Shift+Tab", description: "Cycle permission mode (default → accept edits → plan → bypass)" },
  { keys: "Ctrl+O", description: "Toggle transcript mode (expand thinking/tool blocks)" },
  { keys: "Ctrl+E", description: "Toggle Inspect Mode (expand/collapse tool outputs)" },
  { keys: "Ctrl+Q", description: "Clear queued prompts" },
  { keys: "?", description: "Toggle shortcuts panel" },
  { keys: "Esc", description: "Interrupt generation / dismiss picker" },
  { keys: "Ctrl+C", description: "Exit DeepSeek Code" },
];

export const HELP_GROUPS: CommandGroup[] = getHelpGroups().map((group) => ({
  title: group.title,
  commands: group.commands.map((command) => ({
    name: `/${command.name}`,
    description: command.description,
    usage: command.usage ? [...command.usage] : undefined,
    aliases: command.aliases?.map((alias) => `/${alias}`),
  })),
}));

export function allCommandNames(): string[] {
  const names: string[] = [];
  for (const group of HELP_GROUPS) {
    for (const cmd of group.commands) {
      names.push(cmd.name);
      for (const alias of cmd.aliases ?? []) {
        names.push(alias);
      }
    }
  }
  return names;
}
