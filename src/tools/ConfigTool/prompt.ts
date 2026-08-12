export const CONFIG_TOOL_NAME = "Config";

export const DESCRIPTION = `Read or update persisted DeepSeek Code user settings.

View or change DeepSeek Code's persisted settings (stored in ~/.deepseek-code/settings.json). Use this when the user asks to change a setting, check the current value of a setting, or when adjusting a setting would help them (e.g. switching the model, enabling verbose logging, changing the theme).

## Usage
- **Get current value:** pass only "setting" (omit "value").
- **Set new value:** pass both "setting" and "value".
- Set a value to "default" / null to clear a key and restore its default.

## Configurable settings
- model: string - Override the default model. Options: "deepseek-chat", "deepseek-reasoner", or a full model ID.
- baseURL: string - Override the API endpoint (e.g. for a proxy). Set to "default" / null to clear.
- provider: string - Provider type (currently only "deepseek").
- apiKey: string - Override the API key. The user will be asked to approve writes to this field.
- defaultAgent: string - Default agent to start with. Options: "code", "plan", "review".
- thinkingMode: string - Extended-thinking mode. Options: "off", "whale".
- themeMode: string - Color theme. Options: "dark", "light".
- verbose: boolean - Show detailed debug output. true/false.
- spinnerTipsEnabled: boolean - Show the spinner tip/elapsed line. true/false.
- outputStyle: string - Default output style label (default "default").
- includeCoAuthoredBy: boolean - Add a Co-Authored-By trailer to /commit messages. true/false.
- cleanupPeriodDays: number - Delete saved sessions older than N days on startup (default 30).
- env: object - Environment variables injected into the session/tool environment (e.g. { "FOO": "bar" }).
- permissions.allow: string[] - Tool permission allow rules (Tool(spec:pattern) syntax).
- permissions.deny: string[] - Tool permission deny rules.
- permissions.ask: string[] - Tool permission ask rules.

## Notes
- Reads (omitting "value") require no permission and run without prompting the user.
- Writes require Write permission and the user is shown a confirmation prompt.
- apiKey writes are always treated as sensitive; the prompt hides the new value.
- Some settings (model, baseURL, thinkingMode, themeMode, verbose) only take full effect on the next turn or app restart - tell the user this.

## Examples
- Get theme: { "setting": "themeMode" }
- Set light theme: { "setting": "themeMode", "value": "light" }
- Enable verbose: { "setting": "verbose", "value": true }
- Change model: { "setting": "model", "value": "deepseek-reasoner" }
- Add a permission allow rule: { "setting": "permissions.allow", "value": ["Bash(npm test:*)"] }
`;
