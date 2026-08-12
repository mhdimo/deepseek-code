// Theme system — semantic color tokens branded for DeepSeek Code
//
// Two layers live in this module:
//
// 1. Legacy mutable `theme` object (backward compatible — many components do
//    `import { theme } from "../utils/theme.js"` and read tokens directly).
//    `setThemeMode()` swaps a subset of its tokens between dark/light palettes.
//
// 2. Claude Code-shaped Theme module (the design system): the full `Theme`
//    type, dark/light RGB themes + dark/light ANSI fallback themes, `getTheme()`,
//    `resolveColor()`, and theme-selection helpers (system preference + explicit
//    override). The `claude` token is branded to DeepSeek Blue `rgb(77,107,254)`
//    (#4D6BFE — the DeepSeek whale logo color, secondary #6377DC), and
//    `permission` maps to `rgb(177,185,249)`; every other semantic token stays
//    faithful to Claude
//    Code's themes. The two daltonized themes from the reference are omitted —
//    this app only needs dark/light plus the ANSI fallbacks (note: the
//    rainbow_* tokens stay in the type for keyof-Theme completeness).
//
// Ported from claude-code-main/src/utils/theme.ts (Theme type, dark/light/ANSI
// themes, getTheme) + claude-code-main/src/utils/systemTheme.ts (COLORFGBG
// seed). The OSC 11 live-watcher is intentionally not ported.

// ────────────────────────────────────────────────────────────────────────────
// Claude Code-shaped Theme module
// ────────────────────────────────────────────────────────────────────────────

export type Theme = {
  autoAccept: string
  bashBorder: string
  claude: string
  claudeShimmer: string // Lighter version of claude color for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: string
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: string
  permission: string
  permissionShimmer: string // Lighter version of permission color for shimmer effect
  planMode: string
  ide: string
  promptBorder: string
  promptBorderShimmer: string // Lighter version of promptBorder color for shimmer effect
  text: string
  inverseText: string
  inactive: string
  inactiveShimmer: string // Lighter version of inactive color for shimmer effect
  subtle: string
  suggestion: string
  remember: string
  background: string
  // Semantic colors
  success: string
  error: string
  warning: string
  merged: string
  warningShimmer: string // Lighter version of warning color for shimmer effect
  // Diff colors
  diffAdded: string
  diffRemoved: string
  diffAddedDimmed: string
  diffRemovedDimmed: string
  // Word-level diff highlighting
  diffAddedWord: string
  diffRemovedWord: string
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: string
  blue_FOR_SUBAGENTS_ONLY: string
  green_FOR_SUBAGENTS_ONLY: string
  yellow_FOR_SUBAGENTS_ONLY: string
  purple_FOR_SUBAGENTS_ONLY: string
  orange_FOR_SUBAGENTS_ONLY: string
  pink_FOR_SUBAGENTS_ONLY: string
  cyan_FOR_SUBAGENTS_ONLY: string
  // Grove colors
  professionalBlue: string
  // Chrome colors
  chromeYellow: string
  // TUI V2 colors
  clawd_body: string
  clawd_background: string
  userMessageBackground: string
  userMessageBackgroundHover: string
  /** Message-actions selection. Cool shift toward `suggestion` blue. */
  messageActionsBackground: string
  /** Text-selection highlight background (alt-screen mouse selection). */
  selectionBg: string
  bashMessageBackgroundColor: string

  memoryBackgroundColor: string
  rate_limit_fill: string
  rate_limit_empty: string
  fastMode: string
  fastModeShimmer: string
  // Brief/assistant mode label colors
  briefLabelYou: string
  briefLabelClaude: string
  // Rainbow colors for ultrathink keyword highlighting
  rainbow_red: string
  rainbow_orange: string
  rainbow_yellow: string
  rainbow_green: string
  rainbow_blue: string
  rainbow_indigo: string
  rainbow_violet: string
  rainbow_red_shimmer: string
  rainbow_orange_shimmer: string
  rainbow_yellow_shimmer: string
  rainbow_green_shimmer: string
  rainbow_blue_shimmer: string
  rainbow_indigo_shimmer: string
  rainbow_violet_shimmer: string
}

export const THEME_NAMES = [
  'dark',
  'light',
  'light-daltonized',
  'dark-daltonized',
  'light-ansi',
  'dark-ansi',
] as const

/** A renderable theme. Always resolvable to a concrete color palette. */
export type ThemeName = (typeof THEME_NAMES)[number]

export const THEME_SETTINGS = ['auto', ...THEME_NAMES] as const

/**
 * A theme preference as stored in user config. `'auto'` follows the system
 * dark/light mode and is resolved to a ThemeName at runtime.
 */
export type ThemeSetting = (typeof THEME_SETTINGS)[number]

// ── DeepSeek Code brand override ────────────────────────────────────────────
// The brand accent is DeepSeek Blue '#4D6BFE' (rgb(77,107,254)) — the color of
// the DeepSeek whale logo, with secondary '#6377DC' (rgb(99,119,220)). In every
// theme below the `claude` token maps to the DeepSeek blue (bright blue on
// dark, deeper blue on light for contrast) and `permission` maps to
// 'rgb(177,185,249)'. Everything else is faithful to Claude Code's reference
// themes. ANSI themes use blueBright/blue as the blue analog and keep
// blueBright/blue for permission (the blue-purple analog of rgb(177,185,249)).
const BRAND_BLUE_DARK = 'rgb(77,107,254)'       // DeepSeek Blue #4D6BFE (dark bg)
const BRAND_BLUE_LIGHT = 'rgb(47,74,208)'       // deeper blue (light bg contrast)
const BRAND_BLUE_SHIM_DARK = 'rgb(127,150,255)' // lighter blue shimmer
const BRAND_BLUE_SHIM_LIGHT = 'rgb(99,119,220)' // DeepSeek secondary #6377DC
const BRAND_PERMISSION = 'rgb(177,185,249)'
const BRAND_PERMISSION_SHIM_LIGHT = 'rgb(217,225,255)' // lighter blue-purple

/**
 * Light theme using explicit RGB values to avoid inconsistencies
 * from users' custom terminal ANSI color definitions
 */
const lightTheme: Theme = {
  autoAccept: 'rgb(135,0,255)', // Electric violet
  bashBorder: 'rgb(255,0,135)', // Vibrant pink
  claude: BRAND_BLUE_LIGHT, // DeepSeek Blue (brand) — replaces Claude orange
  claudeShimmer: BRAND_BLUE_SHIM_LIGHT, // Lighter blue for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(87,105,247)', // Medium blue for system spinner
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(117,135,255)', // Lighter blue for system spinner shimmer
  permission: BRAND_PERMISSION, // Brand light blue-purple
  permissionShimmer: BRAND_PERMISSION_SHIM_LIGHT, // Lighter blue-purple for shimmer
  planMode: 'rgb(0,102,102)', // Muted teal
  ide: 'rgb(71,130,200)', // Muted blue
  promptBorder: 'rgb(153,153,153)', // Medium gray
  promptBorderShimmer: 'rgb(183,183,183)', // Lighter gray for shimmer effect
  text: 'rgb(0,0,0)', // Black
  inverseText: 'rgb(255,255,255)', // White
  inactive: 'rgb(102,102,102)', // Dark gray
  inactiveShimmer: 'rgb(142,142,142)', // Lighter gray for shimmer effect
  subtle: 'rgb(175,175,175)', // Light gray
  suggestion: 'rgb(87,105,247)', // Medium blue
  remember: 'rgb(0,0,255)', // Blue
  background: 'rgb(0,153,153)', // Cyan
  success: 'rgb(44,122,57)', // Green
  error: 'rgb(171,43,63)', // Red
  warning: 'rgb(150,108,30)', // Amber
  merged: 'rgb(135,0,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(200,158,80)', // Lighter amber for shimmer effect
  diffAdded: 'rgb(105,219,124)', // Light green
  diffRemoved: 'rgb(255,168,180)', // Light red
  diffAddedDimmed: 'rgb(199,225,203)', // Very light green
  diffRemovedDimmed: 'rgb(253,210,216)', // Very light red
  diffAddedWord: 'rgb(47,157,68)', // Medium green
  diffRemovedWord: 'rgb(209,69,75)', // Medium red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(220,38,38)', // Red 600
  blue_FOR_SUBAGENTS_ONLY: 'rgb(37,99,235)', // Blue 600
  green_FOR_SUBAGENTS_ONLY: 'rgb(22,163,74)', // Green 600
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(202,138,4)', // Yellow 600
  purple_FOR_SUBAGENTS_ONLY: 'rgb(147,51,234)', // Purple 600
  orange_FOR_SUBAGENTS_ONLY: 'rgb(234,88,12)', // Orange 600
  pink_FOR_SUBAGENTS_ONLY: 'rgb(219,39,119)', // Pink 600
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(8,145,178)', // Cyan 600
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'rgb(251,188,4)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(215,119,87)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(240, 240, 240)', // Slightly darker grey for optimal contrast
  userMessageBackgroundHover: 'rgb(252, 252, 252)', // ≥250 to quantize distinct from base at 256-color level
  messageActionsBackground: 'rgb(232, 236, 244)', // cool gray — darker than userMsg 240 (visible on white), slight blue toward `suggestion`
  selectionBg: 'rgb(180, 213, 255)', // classic light-mode selection blue (macOS/VS Code-ish); dark fgs stay readable
  bashMessageBackgroundColor: 'rgb(250, 245, 250)',

  memoryBackgroundColor: 'rgb(230, 245, 250)',
  rate_limit_fill: 'rgb(87,105,247)', // Medium blue
  rate_limit_empty: 'rgb(39,47,111)', // Dark blue
  fastMode: 'rgb(255,106,0)', // Electric orange
  fastModeShimmer: 'rgb(255,150,50)', // Lighter orange for shimmer
  // Brief/assistant mode
  briefLabelYou: 'rgb(37,99,235)', // Blue
  briefLabelClaude: 'rgb(215,119,87)', // (kept faithful to reference)
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
}

/**
 * Light ANSI theme using only the 16 standard ANSI colors
 * for terminals without true color support
 */
const lightAnsiTheme: Theme = {
  autoAccept: 'ansi:magenta',
  bashBorder: 'ansi:magenta',
  claude: 'ansi:blueBright', // DeepSeek Blue analog (brand) — replaces redBright
  claudeShimmer: 'ansi:blueBright',
  claudeBlue_FOR_SYSTEM_SPINNER: 'ansi:blue',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  permission: 'ansi:blue',
  permissionShimmer: 'ansi:blueBright',
  planMode: 'ansi:cyan',
  ide: 'ansi:blueBright',
  promptBorder: 'ansi:white',
  promptBorderShimmer: 'ansi:whiteBright',
  text: 'ansi:black',
  inverseText: 'ansi:white',
  inactive: 'ansi:blackBright',
  inactiveShimmer: 'ansi:white',
  subtle: 'ansi:blackBright',
  suggestion: 'ansi:blue',
  remember: 'ansi:blue',
  background: 'ansi:cyan',
  success: 'ansi:green',
  error: 'ansi:red',
  warning: 'ansi:yellow',
  merged: 'ansi:magenta',
  warningShimmer: 'ansi:yellowBright',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedDimmed: 'ansi:green',
  diffRemovedDimmed: 'ansi:red',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'ansi:red',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blue',
  green_FOR_SUBAGENTS_ONLY: 'ansi:green',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellow',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magenta',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyan',
  // Grove colors
  professionalBlue: 'ansi:blueBright',
  // Chrome colors
  chromeYellow: 'ansi:yellow', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'ansi:redBright',
  clawd_background: 'ansi:black',
  userMessageBackground: 'ansi:white',
  userMessageBackgroundHover: 'ansi:whiteBright',
  messageActionsBackground: 'ansi:white',
  selectionBg: 'ansi:cyan', // lighter named bg for light-ansi; dark fgs stay readable
  bashMessageBackgroundColor: 'ansi:whiteBright',

  memoryBackgroundColor: 'ansi:white',
  rate_limit_fill: 'ansi:yellow',
  rate_limit_empty: 'ansi:black',
  fastMode: 'ansi:red',
  fastModeShimmer: 'ansi:redBright',
  briefLabelYou: 'ansi:blue',
  briefLabelClaude: 'ansi:redBright',
  rainbow_red: 'ansi:red',
  rainbow_orange: 'ansi:redBright',
  rainbow_yellow: 'ansi:yellow',
  rainbow_green: 'ansi:green',
  rainbow_blue: 'ansi:cyan',
  rainbow_indigo: 'ansi:blue',
  rainbow_violet: 'ansi:magenta',
  rainbow_red_shimmer: 'ansi:redBright',
  rainbow_orange_shimmer: 'ansi:yellow',
  rainbow_yellow_shimmer: 'ansi:yellowBright',
  rainbow_green_shimmer: 'ansi:greenBright',
  rainbow_blue_shimmer: 'ansi:cyanBright',
  rainbow_indigo_shimmer: 'ansi:blueBright',
  rainbow_violet_shimmer: 'ansi:magentaBright',
}

/**
 * Dark ANSI theme using only the 16 standard ANSI colors
 * for terminals without true color support
 */
const darkAnsiTheme: Theme = {
  autoAccept: 'ansi:magentaBright',
  bashBorder: 'ansi:magentaBright',
  claude: 'ansi:blue', // DeepSeek Blue analog (brand) — replaces redBright
  claudeShimmer: 'ansi:blueBright',
  claudeBlue_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  permission: 'ansi:blueBright',
  permissionShimmer: 'ansi:blueBright',
  planMode: 'ansi:cyanBright',
  ide: 'ansi:blue',
  promptBorder: 'ansi:white',
  promptBorderShimmer: 'ansi:whiteBright',
  text: 'ansi:whiteBright',
  inverseText: 'ansi:black',
  inactive: 'ansi:white',
  inactiveShimmer: 'ansi:whiteBright',
  subtle: 'ansi:white',
  suggestion: 'ansi:blueBright',
  remember: 'ansi:blueBright',
  background: 'ansi:cyanBright',
  success: 'ansi:greenBright',
  error: 'ansi:redBright',
  warning: 'ansi:yellowBright',
  merged: 'ansi:magentaBright',
  warningShimmer: 'ansi:yellowBright',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedDimmed: 'ansi:green',
  diffRemovedDimmed: 'ansi:red',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blueBright',
  green_FOR_SUBAGENTS_ONLY: 'ansi:greenBright',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellowBright',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyanBright',
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'ansi:yellowBright', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'ansi:redBright',
  clawd_background: 'ansi:black',
  userMessageBackground: 'ansi:blackBright',
  userMessageBackgroundHover: 'ansi:white',
  messageActionsBackground: 'ansi:blackBright',
  selectionBg: 'ansi:blue', // darker named bg for dark-ansi; bright fgs stay readable
  bashMessageBackgroundColor: 'ansi:black',

  memoryBackgroundColor: 'ansi:blackBright',
  rate_limit_fill: 'ansi:yellow',
  rate_limit_empty: 'ansi:white',
  fastMode: 'ansi:redBright',
  fastModeShimmer: 'ansi:redBright',
  briefLabelYou: 'ansi:blueBright',
  briefLabelClaude: 'ansi:redBright',
  rainbow_red: 'ansi:red',
  rainbow_orange: 'ansi:redBright',
  rainbow_yellow: 'ansi:yellow',
  rainbow_green: 'ansi:green',
  rainbow_blue: 'ansi:cyan',
  rainbow_indigo: 'ansi:blue',
  rainbow_violet: 'ansi:magenta',
  rainbow_red_shimmer: 'ansi:redBright',
  rainbow_orange_shimmer: 'ansi:yellow',
  rainbow_yellow_shimmer: 'ansi:yellowBright',
  rainbow_green_shimmer: 'ansi:greenBright',
  rainbow_blue_shimmer: 'ansi:cyanBright',
  rainbow_indigo_shimmer: 'ansi:blueBright',
  rainbow_violet_shimmer: 'ansi:magentaBright',
}

/**
 * Dark theme using explicit RGB values to avoid inconsistencies
 * from users' custom terminal ANSI color definitions
 */
const darkTheme: Theme = {
  autoAccept: 'rgb(175,135,255)', // Electric violet
  bashBorder: 'rgb(253,93,177)', // Bright pink
  claude: BRAND_BLUE_DARK, // DeepSeek Blue (brand) — replaces Claude orange
  claudeShimmer: BRAND_BLUE_SHIM_DARK, // Lighter blue for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(147,165,255)', // Blue for system spinner
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(177,195,255)', // Lighter blue for system spinner shimmer
  permission: BRAND_PERMISSION, // Light blue-purple
  permissionShimmer: 'rgb(207,215,255)', // Lighter blue-purple for shimmer
  planMode: 'rgb(72,150,140)', // Muted sage green
  ide: 'rgb(71,130,200)', // Muted blue
  promptBorder: 'rgb(136,136,136)', // Medium gray
  promptBorderShimmer: 'rgb(166,166,166)', // Lighter gray for shimmer
  text: 'rgb(255,255,255)', // White
  inverseText: 'rgb(0,0,0)', // Black
  inactive: 'rgb(153,153,153)', // Light gray
  inactiveShimmer: 'rgb(193,193,193)', // Lighter gray for shimmer effect
  subtle: 'rgb(80,80,80)', // Dark gray
  suggestion: 'rgb(177,185,249)', // Light blue-purple
  remember: 'rgb(177,185,249)', // Light blue-purple
  background: 'rgb(0,204,204)', // Bright cyan
  success: 'rgb(78,186,101)', // Bright green
  error: 'rgb(255,107,128)', // Bright red
  warning: 'rgb(255,193,7)', // Bright amber
  merged: 'rgb(175,135,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(255,223,57)', // Lighter amber for shimmer
  diffAdded: 'rgb(34,92,43)', // Dark green
  diffRemoved: 'rgb(122,41,54)', // Dark red
  diffAddedDimmed: 'rgb(71,88,74)', // Very dark green
  diffRemovedDimmed: 'rgb(105,72,77)', // Very dark red
  diffAddedWord: 'rgb(56,166,96)', // Medium green
  diffRemovedWord: 'rgb(179,89,107)', // Softer red (less intense than bright red)
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(220,38,38)', // Red 600
  blue_FOR_SUBAGENTS_ONLY: 'rgb(37,99,235)', // Blue 600
  green_FOR_SUBAGENTS_ONLY: 'rgb(22,163,74)', // Green 600
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(202,138,4)', // Yellow 600
  purple_FOR_SUBAGENTS_ONLY: 'rgb(147,51,234)', // Purple 600
  orange_FOR_SUBAGENTS_ONLY: 'rgb(234,88,12)', // Orange 600
  pink_FOR_SUBAGENTS_ONLY: 'rgb(219,39,119)', // Pink 600
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(8,145,178)', // Cyan 600
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'rgb(251,188,4)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(215,119,87)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(55, 55, 55)', // Lighter grey for better visual contrast
  userMessageBackgroundHover: 'rgb(70, 70, 70)',
  messageActionsBackground: 'rgb(44, 50, 62)', // cool gray, slight blue
  selectionBg: 'rgb(38, 79, 120)', // classic dark-mode selection blue (VS Code dark default); light fgs stay readable
  bashMessageBackgroundColor: 'rgb(65, 60, 65)',

  memoryBackgroundColor: 'rgb(55, 65, 70)',
  rate_limit_fill: 'rgb(177,185,249)', // Light blue-purple
  rate_limit_empty: 'rgb(80,83,112)', // Medium blue-purple
  fastMode: 'rgb(255,120,20)', // Electric orange for dark bg
  fastModeShimmer: 'rgb(255,165,70)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(122,180,232)', // Light blue
  briefLabelClaude: 'rgb(215,119,87)', // (kept faithful to reference)
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
}

// ── Colorblind-friendly themes (deuteranopia) ──────────────────────────────
// Ported verbatim from claude-code-main/src/utils/theme.ts
// (lightDaltonizedTheme / darkDaltonizedTheme): greens shift to blues, reds
// stay pure red, oranges shift toward yellow. The `claude` token keeps the
// DeepSeek Blue brand override instead of the reference's orange.

const lightDaltonizedTheme: Theme = {
  ...lightTheme,
  bashBorder: 'rgb(0,102,204)', // Blue instead of pink
  claude: BRAND_BLUE_LIGHT, // DeepSeek Blue (brand)
  claudeShimmer: BRAND_BLUE_SHIM_LIGHT, // Lighter blue for shimmer effect
  permission: 'rgb(51,102,255)', // Bright blue
  permissionShimmer: 'rgb(101,152,255)', // Lighter bright blue for shimmer
  planMode: 'rgb(51,102,102)', // Muted blue-gray (works for color-blind)
  suggestion: 'rgb(51,102,255)', // Bright blue
  remember: 'rgb(51,102,255)', // Bright blue
  background: 'rgb(0,153,153)', // Cyan (color-blind friendly)
  success: 'rgb(0,102,153)', // Blue instead of green for deuteranopia
  error: 'rgb(204,0,0)', // Pure red for better distinction
  warning: 'rgb(255,153,0)', // Orange adjusted for deuteranopia
  warningShimmer: 'rgb(255,183,50)', // Lighter orange for shimmer
  diffAdded: 'rgb(153,204,255)', // Light blue instead of green
  diffRemoved: 'rgb(255,204,204)', // Light red
  diffAddedDimmed: 'rgb(209,231,253)', // Very light blue
  diffRemovedDimmed: 'rgb(255,233,233)', // Very light red
  diffAddedWord: 'rgb(51,102,204)', // Medium blue
  diffRemovedWord: 'rgb(153,51,51)', // Softer red
  userMessageBackground: 'rgb(220, 220, 220)', // Slightly darker grey for optimal contrast
  userMessageBackgroundHover: 'rgb(232, 232, 232)',
  messageActionsBackground: 'rgb(210, 216, 226)', // cool gray — slight blue
}

const darkDaltonizedTheme: Theme = {
  ...darkTheme,
  bashBorder: 'rgb(51,153,255)', // Bright blue
  claude: BRAND_BLUE_DARK, // DeepSeek Blue (brand)
  claudeShimmer: BRAND_BLUE_SHIM_DARK, // Lighter blue for shimmer effect
  permission: 'rgb(153,204,255)', // Light blue
  permissionShimmer: 'rgb(183,224,255)', // Lighter blue for shimmer
  planMode: 'rgb(102,153,153)', // Muted gray-teal (works for color-blind)
  suggestion: 'rgb(153,204,255)', // Light blue
  remember: 'rgb(153,204,255)', // Light blue
  background: 'rgb(0,204,204)', // Bright cyan (color-blind friendly)
  success: 'rgb(51,153,255)', // Blue instead of green
  error: 'rgb(255,102,102)', // Bright red
  warning: 'rgb(255,204,0)', // Yellow-orange for deuteranopia
  warningShimmer: 'rgb(255,234,50)', // Lighter yellow-orange for shimmer
  diffAdded: 'rgb(0,68,102)', // Dark blue
  diffRemoved: 'rgb(102,0,0)', // Dark red
  diffAddedDimmed: 'rgb(62,81,91)', // Dimmed blue
  diffRemovedDimmed: 'rgb(62,44,44)', // Dimmed red
  diffAddedWord: 'rgb(0,119,179)', // Medium blue
  diffRemovedWord: 'rgb(179,0,0)', // Medium red
  rate_limit_fill: 'rgb(153,204,255)', // Light blue
  rate_limit_empty: 'rgb(23,46,114)', // Dark blue
  fastMode: 'rgb(255,178,102)', // Bright orange (color-blind safe)
  fastModeShimmer: 'rgb(255,204,153)', // Lighter orange for shimmer
}

/** Resolve a ThemeName (or 'auto' via `resolveThemeSetting`) to a Theme. */
export function getTheme(themeName: ThemeName = 'dark'): Theme {
  switch (themeName) {
    case 'light':
      return lightTheme
    case 'light-daltonized':
      return lightDaltonizedTheme
    case 'dark-daltonized':
      return darkDaltonizedTheme
    case 'light-ansi':
      return lightAnsiTheme
    case 'dark-ansi':
      return darkAnsiTheme
    default:
      return darkTheme
  }
}

/**
 * Converts a raw theme token into a value stock Ink's `color` /
 * `backgroundColor` props accept. Ink (chalk) handles 'rgb(r,g,b)', '#hex',
 * 'ansi256(n)' and named colors natively; only the claude-code fork's
 * 'ansi:name' notation needs translating to 'name'.
 */
export function resolveColor(token: string): string {
  if (!token) return token
  if (token.startsWith('ansi:')) return token.slice('ansi:'.length)
  return token
}

// ── System-preference detection (ported from claude-code systemTheme.ts) ────
// Seeds from $COLORFGBG (synchronous, set by some terminals at launch).
// The OSC 11 live watcher from the reference is NOT ported — in this app the
// explicit themeMode override is authoritative; 'auto' resolves once at
// provider mount.

export type SystemTheme = 'dark' | 'light'

let cachedSystemTheme: SystemTheme | undefined

/**
 * Get the current terminal theme ('dark' unless $COLORFGBG says otherwise).
 */
export function getSystemThemeName(): SystemTheme {
  if (cachedSystemTheme === undefined) {
    cachedSystemTheme = detectFromColorFgBg() ?? 'dark'
  }
  return cachedSystemTheme
}

/** Update the cached terminal theme (e.g. from a future OSC 11 watcher). */
export function setCachedSystemTheme(theme: SystemTheme): void {
  cachedSystemTheme = theme
}

/**
 * Resolve a ThemeSetting (which may be 'auto') to a concrete ThemeName.
 */
export function resolveThemeSetting(setting: ThemeSetting): ThemeName {
  if (setting === 'auto') {
    return getSystemThemeName()
  }
  return setting
}

/**
 * Read $COLORFGBG for a synchronous initial guess. Format is `fg;bg` (or
 * `fg;other;bg`) where values are ANSI color indices. rxvt convention:
 * bg 0–6 or 8 are dark; bg 7 and 9–15 are light. Only set by some terminals,
 * so this is a best-effort hint.
 */
function detectFromColorFgBg(): SystemTheme | undefined {
  const colorfgbg = process.env['COLORFGBG']
  if (!colorfgbg) return undefined
  const parts = colorfgbg.split(';')
  const bg = parts[parts.length - 1]
  if (bg === undefined || bg === '') return undefined
  const bgNum = Number(bg)
  if (!Number.isInteger(bgNum) || bgNum < 0 || bgNum > 15) return undefined
  // 0–6 and 8 are dark ANSI colors; 7 (white) and 9–15 (bright) are light.
  return bgNum <= 6 || bgNum === 8 ? 'dark' : 'light'
}

// ────────────────────────────────────────────────────────────────────────────
// Legacy mutable `theme` object (backward compatible)
// ────────────────────────────────────────────────────────────────────────────
// Many components read `theme.<token>` directly. Token names and dark values
// are frozen exactly as before; `setThemeMode()` swaps the light-mode subset.

const themeBase = {
  // Brand — DeepSeek Blue (deepseek-code identity); all other colors match the
  // reference dark theme.
  assistant: "rgb(77, 107, 254)",       // DeepSeek Blue #4D6BFE
  assistantDim: "rgb(56, 86, 220)",     // Dimmer variant of the brand blue

  // Permission
  permission: "rgb(177, 185, 249)",
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
    Read: "rgb(77, 107, 254)",      // DeepSeek Blue
    Edit: "rgb(180, 130, 0)",       // Amber
    Write: "rgb(147, 51, 234)",     // Purple
    Bash: "rgb(22, 163, 74)",       // Green
    Glob: "rgb(37, 99, 235)",       // Blue
    Grep: "rgb(37, 99, 235)",       // Blue
    LS: "rgb(107, 114, 128)",       // Gray
    WebFetch: "rgb(77, 107, 254)",  // DeepSeek Blue
    WebSearch: "rgb(77, 107, 254)", // DeepSeek Blue
    NotebookEdit: "rgb(147, 51, 234)", // Purple
    Agent: "rgb(77, 107, 254)",     // DeepSeek Blue
  } as Record<string, string>,

  // Message backgrounds (for tool block rows)
  userMessageBg: "rgb(55, 55, 55)",
  toolMessageBg: "rgb(55, 55, 55)",

  // Indicators
  fastMode: "rgb(255, 120, 20)",
  thinking: "rgb(177, 185, 249)",
};

// Seed the mutable object with the FULL Theme token set (claude,
// claudeShimmer, userMessageBackground, …) so `theme.<newToken>` works for
// both legacy and ported consumers from a single live object. Keys managed
// by darkPalette/lightPalette below are skipped — those stay legacy-owned.
for (const [key, value] of Object.entries(getTheme("dark"))) {
  if (!(key in themeBase)) {
    (themeBase as unknown as Record<string, unknown>)[key] = value;
  }
}

/** Live mutable theme — legacy tokens + the full Theme token set, kept in
 *  sync by setThemeMode(). Components read tokens per render and repaint on
 *  mode changes without re-importing. */
export const theme: Theme & typeof themeBase = themeBase as Theme & typeof themeBase;

const darkPalette = {
  assistant: "rgb(77, 107, 254)",
  assistantDim: "rgb(56, 86, 220)",
  text: "rgb(255, 255, 255)",
  inverseText: "rgb(0, 0, 0)",
  subtle: "rgb(80, 80, 80)",
  inactive: "rgb(153, 153, 153)",
  userMessageBg: "rgb(55, 55, 55)",
  toolMessageBg: "rgb(55, 55, 55)",
  promptBorder: "rgb(136, 136, 136)",
};

const lightPalette = {
  assistant: "rgb(47, 74, 208)",
  assistantDim: "rgb(35, 55, 165)",
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

/**
 * Sync the live mutable `theme` object to a concrete ThemeName (dark, light,
 * ANSI or daltonized): legacy-owned keys take the dark/light palette for
 * that name, every other Theme token takes the resolved theme's value. This
 * is what makes ANSI / colorblind theme choices actually repaint the ported
 * components that read `theme` directly.
 */
export function syncLiveTheme(themeName: ThemeName): void {
  const isLight = themeName.startsWith("light");
  Object.assign(theme, isLight ? lightPalette : darkPalette);
  for (const [key, value] of Object.entries(getTheme(themeName))) {
    if (!(key in darkPalette) && !(key in lightPalette)) {
      (theme as unknown as Record<string, unknown>)[key] = value;
    }
  }
}

export function setThemeMode(mode: "dark" | "light"): void {
  currentThemeMode = mode;
  syncLiveTheme(mode === "light" ? "light" : "dark");
}
