


























export type Theme = {
  autoAccept: string
  bashBorder: string
  claude: string
  claudeShimmer: string 
  claudeBlue_FOR_SYSTEM_SPINNER: string
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: string
  permission: string
  permissionShimmer: string 
  planMode: string
  ide: string
  promptBorder: string
  promptBorderShimmer: string 
  text: string
  inverseText: string
  inactive: string
  inactiveShimmer: string 
  subtle: string
  suggestion: string
  remember: string
  background: string
  
  success: string
  error: string
  warning: string
  merged: string
  warningShimmer: string 
  
  diffAdded: string
  diffRemoved: string
  diffAddedDimmed: string
  diffRemovedDimmed: string
  
  diffAddedWord: string
  diffRemovedWord: string

  /** Text color for add/remove lines (white on the dark green/red line
   *  backgrounds; syntax-highlighted tokens override it per-run). */
  diffAddedText?: string
  diffRemovedText?: string
  /** Gutter (line number + sigil) text color for add/remove rows. */
  diffAddedGutter: string
  diffRemovedGutter: string

  red_FOR_SUBAGENTS_ONLY: string
  blue_FOR_SUBAGENTS_ONLY: string
  green_FOR_SUBAGENTS_ONLY: string
  yellow_FOR_SUBAGENTS_ONLY: string
  purple_FOR_SUBAGENTS_ONLY: string
  orange_FOR_SUBAGENTS_ONLY: string
  pink_FOR_SUBAGENTS_ONLY: string
  cyan_FOR_SUBAGENTS_ONLY: string
  
  professionalBlue: string
  
  chromeYellow: string
  
  clawd_body: string
  clawd_background: string
  userMessageBackground: string
  userMessageBackgroundHover: string
  
  messageActionsBackground: string
  
  selectionBg: string
  bashMessageBackgroundColor: string

  memoryBackgroundColor: string
  rate_limit_fill: string
  rate_limit_empty: string
  fastMode: string
  fastModeShimmer: string
  
  briefLabelYou: string
  briefLabelClaude: string
  
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


export type ThemeName = (typeof THEME_NAMES)[number]

export const THEME_SETTINGS = ['auto', ...THEME_NAMES] as const


export type ThemeSetting = (typeof THEME_SETTINGS)[number]









const BRAND_BLUE_DARK = 'rgb(77,107,254)'       
const BRAND_BLUE_LIGHT = 'rgb(47,74,208)'       
const BRAND_BLUE_SHIM_DARK = 'rgb(127,150,255)' 
const BRAND_BLUE_SHIM_LIGHT = 'rgb(99,119,220)' 
const BRAND_PERMISSION = 'rgb(177,185,249)'
const BRAND_PERMISSION_SHIM_LIGHT = 'rgb(217,225,255)' 


const lightTheme: Theme = {
  autoAccept: 'rgb(135,0,255)', 
  bashBorder: 'rgb(255,0,135)', 
  claude: BRAND_BLUE_LIGHT, 
  claudeShimmer: BRAND_BLUE_SHIM_LIGHT, 
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(87,105,247)', 
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(117,135,255)', 
  permission: BRAND_PERMISSION, 
  permissionShimmer: BRAND_PERMISSION_SHIM_LIGHT, 
  planMode: 'rgb(0,102,102)', 
  ide: 'rgb(71,130,200)', 
  promptBorder: 'rgb(153,153,153)', 
  promptBorderShimmer: 'rgb(183,183,183)', 
  text: 'rgb(0,0,0)', 
  inverseText: 'rgb(255,255,255)', 
  inactive: 'rgb(102,102,102)', 
  inactiveShimmer: 'rgb(142,142,142)', 
  subtle: 'rgb(175,175,175)', 
  suggestion: 'rgb(87,105,247)', 
  remember: 'rgb(0,0,255)', 
  background: 'rgb(0,153,153)', 
  success: 'rgb(44,122,57)', 
  error: 'rgb(171,43,63)', 
  warning: 'rgb(150,108,30)', 
  merged: 'rgb(135,0,255)', 
  warningShimmer: 'rgb(200,158,80)', 
  diffAdded: '#022900',
  diffRemoved: '#3D0100',
  diffAddedDimmed: 'rgb(199,225,203)',
  diffRemovedDimmed: 'rgb(253,210,216)',
  diffAddedWord: '#054601',
  diffRemovedWord: '#5C0100',
  diffAddedText: 'rgb(255,255,255)',
  diffRemovedText: 'rgb(255,255,255)',
  diffAddedGutter: '#50c850',
  diffRemovedGutter: '#db5b5a',

  red_FOR_SUBAGENTS_ONLY: 'rgb(220,38,38)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(37,99,235)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(22,163,74)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(202,138,4)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(147,51,234)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(234,88,12)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(219,39,119)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(8,145,178)',

  professionalBlue: 'rgb(106,155,204)',

  chromeYellow: 'rgb(251,188,4)',

  clawd_body: 'rgb(215,119,87)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(240, 240, 240)', 
  userMessageBackgroundHover: 'rgb(252, 252, 252)', 
  messageActionsBackground: 'rgb(232, 236, 244)', 
  selectionBg: 'rgb(180, 213, 255)', 
  bashMessageBackgroundColor: 'rgb(250, 245, 250)',

  memoryBackgroundColor: 'rgb(230, 245, 250)',
  rate_limit_fill: 'rgb(87,105,247)', 
  rate_limit_empty: 'rgb(39,47,111)', 
  fastMode: 'rgb(255,106,0)', 
  fastModeShimmer: 'rgb(255,150,50)', 
  
  briefLabelYou: 'rgb(37,99,235)', 
  briefLabelClaude: 'rgb(215,119,87)', 
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


const lightAnsiTheme: Theme = {
  autoAccept: 'ansi:magenta',
  bashBorder: 'ansi:magenta',
  claude: 'ansi:blueBright', 
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
  diffAddedGutter: 'ansi:greenBright',
  diffRemovedGutter: 'ansi:redBright',

  red_FOR_SUBAGENTS_ONLY: 'ansi:red',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blue',
  green_FOR_SUBAGENTS_ONLY: 'ansi:green',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellow',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magenta',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyan',
  
  professionalBlue: 'ansi:blueBright',
  
  chromeYellow: 'ansi:yellow', 
  
  clawd_body: 'ansi:redBright',
  clawd_background: 'ansi:black',
  userMessageBackground: 'ansi:white',
  userMessageBackgroundHover: 'ansi:whiteBright',
  messageActionsBackground: 'ansi:white',
  selectionBg: 'ansi:cyan', 
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


const darkAnsiTheme: Theme = {
  autoAccept: 'ansi:magentaBright',
  bashBorder: 'ansi:magentaBright',
  claude: 'ansi:blue', 
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
  diffAddedGutter: 'ansi:greenBright',
  diffRemovedGutter: 'ansi:redBright',

  red_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blueBright',
  green_FOR_SUBAGENTS_ONLY: 'ansi:greenBright',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellowBright',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyanBright',
  
  professionalBlue: 'rgb(106,155,204)',
  
  chromeYellow: 'ansi:yellowBright', 
  
  clawd_body: 'ansi:redBright',
  clawd_background: 'ansi:black',
  userMessageBackground: 'ansi:blackBright',
  userMessageBackgroundHover: 'ansi:white',
  messageActionsBackground: 'ansi:blackBright',
  selectionBg: 'ansi:blue', 
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


const darkTheme: Theme = {
  autoAccept: 'rgb(175,135,255)', 
  bashBorder: 'rgb(253,93,177)', 
  claude: BRAND_BLUE_DARK, 
  claudeShimmer: BRAND_BLUE_SHIM_DARK, 
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(147,165,255)', 
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(177,195,255)', 
  permission: BRAND_PERMISSION, 
  permissionShimmer: 'rgb(207,215,255)', 
  planMode: 'rgb(72,150,140)', 
  ide: 'rgb(71,130,200)', 
  promptBorder: 'rgb(136,136,136)', 
  promptBorderShimmer: 'rgb(166,166,166)', 
  text: 'rgb(255,255,255)', 
  inverseText: 'rgb(0,0,0)', 
  inactive: 'rgb(153,153,153)', 
  inactiveShimmer: 'rgb(193,193,193)', 
  subtle: 'rgb(80,80,80)', 
  suggestion: 'rgb(177,185,249)', 
  remember: 'rgb(177,185,249)', 
  background: 'rgb(0,204,204)', 
  success: 'rgb(78,186,101)', 
  error: 'rgb(255,107,128)', 
  warning: 'rgb(255,193,7)', 
  merged: 'rgb(175,135,255)', 
  warningShimmer: 'rgb(255,223,57)', 
  diffAdded: '#022900',
  diffRemoved: '#3D0100',
  diffAddedDimmed: 'rgb(71,88,74)',
  diffRemovedDimmed: 'rgb(105,72,77)',
  diffAddedWord: '#054601',
  diffRemovedWord: '#5C0100',
  diffAddedText: 'rgb(255,255,255)',
  diffRemovedText: 'rgb(255,255,255)',
  diffAddedGutter: '#50c850',
  diffRemovedGutter: '#db5b5a',

  red_FOR_SUBAGENTS_ONLY: 'rgb(220,38,38)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(37,99,235)', 
  green_FOR_SUBAGENTS_ONLY: 'rgb(22,163,74)', 
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(202,138,4)', 
  purple_FOR_SUBAGENTS_ONLY: 'rgb(147,51,234)', 
  orange_FOR_SUBAGENTS_ONLY: 'rgb(234,88,12)', 
  pink_FOR_SUBAGENTS_ONLY: 'rgb(219,39,119)', 
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(8,145,178)', 
  
  professionalBlue: 'rgb(106,155,204)',
  
  chromeYellow: 'rgb(251,188,4)', 
  
  clawd_body: 'rgb(215,119,87)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(55, 55, 55)', 
  userMessageBackgroundHover: 'rgb(70, 70, 70)',
  messageActionsBackground: 'rgb(44, 50, 62)', 
  selectionBg: 'rgb(38, 79, 120)', 
  bashMessageBackgroundColor: 'rgb(65, 60, 65)',

  memoryBackgroundColor: 'rgb(55, 65, 70)',
  rate_limit_fill: 'rgb(177,185,249)', 
  rate_limit_empty: 'rgb(80,83,112)', 
  fastMode: 'rgb(255,120,20)', 
  fastModeShimmer: 'rgb(255,165,70)', 
  briefLabelYou: 'rgb(122,180,232)', 
  briefLabelClaude: 'rgb(215,119,87)', 
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







const lightDaltonizedTheme: Theme = {
  ...lightTheme,
  bashBorder: 'rgb(0,102,204)', 
  claude: BRAND_BLUE_LIGHT, 
  claudeShimmer: BRAND_BLUE_SHIM_LIGHT, 
  permission: 'rgb(51,102,255)', 
  permissionShimmer: 'rgb(101,152,255)', 
  planMode: 'rgb(51,102,102)', 
  suggestion: 'rgb(51,102,255)', 
  remember: 'rgb(51,102,255)', 
  background: 'rgb(0,153,153)', 
  success: 'rgb(0,102,153)', 
  error: 'rgb(204,0,0)', 
  warning: 'rgb(255,153,0)', 
  warningShimmer: 'rgb(255,183,50)', 
  diffAdded: 'rgb(153,204,255)', 
  diffRemoved: 'rgb(255,204,204)', 
  diffAddedDimmed: 'rgb(209,231,253)', 
  diffRemovedDimmed: 'rgb(255,233,233)', 
  diffAddedWord: 'rgb(51,102,204)', 
  diffRemovedWord: 'rgb(153,51,51)', 
  userMessageBackground: 'rgb(220, 220, 220)', 
  userMessageBackgroundHover: 'rgb(232, 232, 232)',
  messageActionsBackground: 'rgb(210, 216, 226)', 
}

const darkDaltonizedTheme: Theme = {
  ...darkTheme,
  bashBorder: 'rgb(51,153,255)', 
  claude: BRAND_BLUE_DARK, 
  claudeShimmer: BRAND_BLUE_SHIM_DARK, 
  permission: 'rgb(153,204,255)', 
  permissionShimmer: 'rgb(183,224,255)', 
  planMode: 'rgb(102,153,153)', 
  suggestion: 'rgb(153,204,255)', 
  remember: 'rgb(153,204,255)', 
  background: 'rgb(0,204,204)', 
  success: 'rgb(51,153,255)', 
  error: 'rgb(255,102,102)', 
  warning: 'rgb(255,204,0)', 
  warningShimmer: 'rgb(255,234,50)', 
  diffAdded: 'rgb(0,68,102)', 
  diffRemoved: 'rgb(102,0,0)', 
  diffAddedDimmed: 'rgb(62,81,91)', 
  diffRemovedDimmed: 'rgb(62,44,44)', 
  diffAddedWord: 'rgb(0,119,179)',
  diffRemovedWord: 'rgb(179,0,0)',
  diffAddedText: 'rgb(153,204,255)',
  diffRemovedText: 'rgb(255,204,204)',
  rate_limit_fill: 'rgb(153,204,255)',
  rate_limit_empty: 'rgb(23,46,114)', 
  fastMode: 'rgb(255,178,102)', 
  fastModeShimmer: 'rgb(255,204,153)', 
}


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


export function resolveColor(token: string): string {
  if (!token) return token
  if (token.startsWith('ansi:')) return token.slice('ansi:'.length)
  return token
}







export type SystemTheme = 'dark' | 'light'

let cachedSystemTheme: SystemTheme | undefined


export function getSystemThemeName(): SystemTheme {
  if (cachedSystemTheme === undefined) {
    cachedSystemTheme = detectFromColorFgBg() ?? 'dark'
  }
  return cachedSystemTheme
}


export function setCachedSystemTheme(theme: SystemTheme): void {
  cachedSystemTheme = theme
}


export function resolveThemeSetting(setting: ThemeSetting): ThemeName {
  if (setting === 'auto') {
    return getSystemThemeName()
  }
  return setting
}


function detectFromColorFgBg(): SystemTheme | undefined {
  const colorfgbg = process.env['COLORFGBG']
  if (!colorfgbg) return undefined
  const parts = colorfgbg.split(';')
  const bg = parts[parts.length - 1]
  if (bg === undefined || bg === '') return undefined
  const bgNum = Number(bg)
  if (!Number.isInteger(bgNum) || bgNum < 0 || bgNum > 15) return undefined
  
  return bgNum <= 6 || bgNum === 8 ? 'dark' : 'light'
}







const themeBase = {
  
  
  assistant: "rgb(77, 107, 254)",       
  assistantDim: "rgb(56, 86, 220)",     

  
  permission: "rgb(177, 185, 249)",
  permissionShimmer: "rgb(207, 215, 255)",

  
  promptBorder: "rgb(136, 136, 136)",
  promptBorderShimmer: "rgb(166, 166, 166)",
  bashBorder: "rgb(253, 93, 177)",

  
  text: "rgb(255, 255, 255)",
  inverseText: "rgb(0, 0, 0)",
  subtle: "rgb(80, 80, 80)",
  inactive: "rgb(153, 153, 153)",

  
  success: "rgb(78, 186, 101)",
  error: "rgb(255, 107, 128)",
  warning: "rgb(255, 193, 7)",
  suggestion: "rgb(177, 185, 249)",
  remember: "rgb(177, 185, 249)",

  
  diffAdded: "rgb(34, 92, 43)",
  diffRemoved: "rgb(122, 41, 54)",
  diffAddedDimmed: "rgb(71, 88, 74)",
  diffRemovedDimmed: "rgb(105, 72, 77)",
  diffAddedWord: "rgb(56, 166, 96)",
  diffRemovedWord: "rgb(179, 89, 107)",
  diffAddedText: "rgb(56, 166, 96)",
  diffRemovedText: "rgb(179, 89, 107)",
  diffAddedGutter: "rgb(56, 166, 96)",
  diffRemovedGutter: "rgb(179, 89, 107)",

  
  toolLabel: {
    Read: "rgb(77, 107, 254)",      
    Edit: "rgb(180, 130, 0)",       
    Write: "rgb(147, 51, 234)",     
    Bash: "rgb(22, 163, 74)",       
    Glob: "rgb(37, 99, 235)",       
    Grep: "rgb(37, 99, 235)",       
    LS: "rgb(107, 114, 128)",       
    WebFetch: "rgb(77, 107, 254)",  
    WebSearch: "rgb(77, 107, 254)", 
    NotebookEdit: "rgb(147, 51, 234)", 
    Agent: "rgb(77, 107, 254)",     
  } as Record<string, string>,

  
  userMessageBg: "rgb(55, 55, 55)",
  toolMessageBg: "rgb(55, 55, 55)",

  
  fastMode: "rgb(255, 120, 20)",
  thinking: "rgb(177, 185, 249)",
};





for (const [key, value] of Object.entries(getTheme("dark"))) {
  if (!(key in themeBase)) {
    (themeBase as unknown as Record<string, unknown>)[key] = value;
  }
}


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
