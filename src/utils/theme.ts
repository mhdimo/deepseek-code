// Theme system — semantic color tokens branded for DeepSeek Code
// Adapted from Claude Code's theme structure with DeepSeek branding.

export const theme = {
  // Brand
  assistant: "rgb(0, 180, 216)",       // DeepSeek teal
  assistantDim: "rgb(0, 140, 170)",

  // Permission
  permission: "rgb(147, 165, 255)",
  permissionShimmer: "rgb(207, 215, 255)",

  // Borders
  promptBorder: "rgb(136, 136, 136)",
  promptBorderShimmer: "rgb(166, 166, 166)",
  bashBorder: "rgb(253, 93, 177)",

  // Text
  text: "rgb(255, 255, 255)",
  inverseText: "rgb(0, 0, 0)",
  subtle: "rgb(80, 80, 80)",
  inactive: "rgb(153, 153, 153)",

  // Semantic
  success: "rgb(78, 186, 101)",
  error: "rgb(255, 107, 128)",
  warning: "rgb(255, 193, 7)",
  suggestion: "rgb(177, 185, 249)",
  remember: "rgb(177, 185, 249)",

  // Diff colors (dark theme)
  diffAdded: "rgb(34, 92, 43)",
  diffRemoved: "rgb(122, 41, 54)",
  diffAddedDimmed: "rgb(71, 88, 74)",
  diffRemovedDimmed: "rgb(105, 72, 77)",
  diffAddedWord: "rgb(56, 166, 96)",
  diffRemovedWord: "rgb(179, 89, 107)",
  diffAddedText: "rgb(56, 166, 96)",
  diffRemovedText: "rgb(179, 89, 107)",

  // Tool label badge colors (bold text on colored bg)
  toolLabel: {
    Read: "rgb(0, 140, 170)",       // Teal
    Edit: "rgb(180, 130, 0)",       // Amber
    Write: "rgb(147, 51, 234)",     // Purple
    Bash: "rgb(22, 163, 74)",       // Green
    Glob: "rgb(37, 99, 235)",       // Blue
    Grep: "rgb(37, 99, 235)",       // Blue
    LS: "rgb(107, 114, 128)",       // Gray
    WebFetch: "rgb(0, 140, 170)",   // Teal
    WebSearch: "rgb(0, 140, 170)",  // Teal
    NotebookEdit: "rgb(147, 51, 234)", // Purple
    Agent: "rgb(0, 140, 170)",      // Teal
  } as Record<string, string>,

  // Message backgrounds (for tool block rows)
  userMessageBg: "rgb(55, 55, 55)",
  toolMessageBg: "rgb(55, 55, 55)",

  // Indicators
  fastMode: "rgb(255, 120, 20)",
  thinking: "rgb(177, 185, 249)",
};

const darkPalette = {
  assistant: "rgb(0, 180, 216)",
  assistantDim: "rgb(0, 140, 170)",
  text: "rgb(255, 255, 255)",
  inverseText: "rgb(0, 0, 0)",
  subtle: "rgb(80, 80, 80)",
  inactive: "rgb(153, 153, 153)",
  userMessageBg: "rgb(55, 55, 55)",
  toolMessageBg: "rgb(55, 55, 55)",
  promptBorder: "rgb(136, 136, 136)",
};

const lightPalette = {
  assistant: "rgb(0, 140, 170)",
  assistantDim: "rgb(0, 100, 120)",
  text: "rgb(0, 0, 0)",
  inverseText: "rgb(255, 255, 255)",
  subtle: "rgb(150, 150, 150)",
  inactive: "rgb(100, 100, 100)",
  userMessageBg: "rgb(230, 230, 230)",
  toolMessageBg: "rgb(230, 230, 230)",
  promptBorder: "rgb(180, 180, 180)",
};

let currentThemeMode: "dark" | "light" = "dark";

export function getThemeMode(): "dark" | "light" {
  return currentThemeMode;
}

export function setThemeMode(mode: "dark" | "light"): void {
  currentThemeMode = mode;
  const palette = mode === "light" ? lightPalette : darkPalette;
  Object.assign(theme, palette);
}
