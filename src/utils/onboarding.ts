















import { join, relative, sep, basename } from "node:path";




export interface ProjectSummary {
  
  workingDir: string;
  
  name: string;
  
  languages: string[];
  
  frameworks: string[];
  
  packageManager: string | null;
  
  isMonorepo: boolean;
  
  workspaces: string[];
  
  scripts: Record<string, string>;
  
  readmeHighlights: string[];
  
  topDirs: string[];
  
  existingAiConfigs: string[];
  
  notableConfigs: string[];
  
  notes: string[];
}



async function readTextIfExists(path: string): Promise<string | null> {
  try {
    
    const file = (globalThis as any).Bun?.file;
    if (typeof file === "function") {
      const f = file(path);
      const exists = await f.exists();
      if (!exists) return null;
      return await f.text();
    }
  } catch {
    
  }
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const file = (globalThis as any).Bun?.file;
    if (typeof file === "function") {
      return await file(path).exists();
    }
  } catch {
    
  }
  try {
    const { stat } = await import("node:fs/promises");
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function listDirSync(dir: string): { name: string; isDirectory: boolean }[] {
  try {
    const { readdirSync, statSync } = require("node:fs");
    const entries = readdirSync(dir, { withFileTypes: true }) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    return [];
  }
}


async function readJson<T = any>(path: string): Promise<T | null> {
  const text = await readTextIfExists(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}


function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}



interface ParsedManifest {
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  scripts: Record<string, string>;
  workspaces: string[];
  name: string | null;
}


const LANGUAGE_MARKERS: Record<string, string> = {
  "package.json": "TypeScript/JavaScript",
  "tsconfig.json": "TypeScript",
  "Cargo.toml": "Rust",
  "go.mod": "Go",
  "pyproject.toml": "Python",
  "requirements.txt": "Python",
  "setup.py": "Python",
  "pom.xml": "Java/Kotlin",
  "build.gradle": "Java/Kotlin",
  "build.gradle.kts": "Kotlin",
  "Gemfile": "Ruby",
  "mix.exs": "Elixir",
  "composer.json": "PHP",
  "Package.swift": "Swift",
  "Package.resolved": "Swift",
  "CMakeLists.txt": "C/C++",
  "Makefile": "Make",
};


function detectFrameworks(pkg: any): string[] {
  const out = new Set<string>();
  const deps = {
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
    ...(pkg?.peerDependencies || {}),
  };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(deps, k);
  if (has("react")) out.add("React");
  if (has("next")) out.add("Next.js");
  if (has("vue")) out.add("Vue");
  if (has("svelte")) out.add("Svelte");
  if (has("solid-js")) out.add("Solid");
  if (has("@angular/core")) out.add("Angular");
  if (has("express")) out.add("Express");
  if (has("fastify")) out.add("Fastify");
  if (has("koa")) out.add("Koa");
  if (has("hono")) out.add("Hono");
  if (has("nestjs") || has("@nestjs/core")) out.add("NestJS");
  if (has("ink")) out.add("Ink (React TUI)");
  if (has("electron")) out.add("Electron");
  if (has("tailwindcss")) out.add("Tailwind CSS");
  if (has("prisma")) out.add("Prisma");
  if (has("@prisma/client")) out.add("Prisma");
  if (has("drizzle-orm")) out.add("Drizzle ORM");
  if (has("ai")) out.add("Vercel AI SDK");
  if (has("zod")) out.add("Zod");
  if (has("playwright")) out.add("Playwright");
  if (has("jest") || has("vitest")) out.add("Test runner");
  if (has("expo")) out.add("Expo / React Native");
  if (has("react-native")) out.add("React Native");
  return [...out];
}

async function parsePackageJson(path: string): Promise<ParsedManifest | null> {
  const pkg = await readJson<any>(path);
  if (!pkg || typeof pkg !== "object") return null;

  const workspacesRaw = pkg.workspaces;
  let workspaces: string[] = [];
  if (Array.isArray(workspacesRaw)) {
    workspaces = workspacesRaw.filter((w) => typeof w === "string");
  } else if (workspacesRaw && Array.isArray(workspacesRaw.packages)) {
    workspaces = workspacesRaw.packages.filter(
      (w: unknown) => typeof w === "string",
    );
  }

  const scripts: Record<string, string> = {};
  if (pkg.scripts && typeof pkg.scripts === "object") {
    for (const [k, v] of Object.entries(pkg.scripts)) {
      if (typeof v === "string") scripts[k] = v;
    }
  }

  return {
    languages: ["TypeScript", "JavaScript"],
    frameworks: detectFrameworks(pkg),
    packageManager: null, 
    scripts,
    workspaces,
    name: typeof pkg.name === "string" ? pkg.name : null,
  };
}

async function detectPackageManager(dir: string): Promise<string | null> {
  
  const candidates: Array<[string, string]> = [
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["Cargo.lock", "cargo"],
    ["go.sum", "go"],
    ["poetry.lock", "poetry"],
    ["uv.lock", "uv"],
    ["Gemfile.lock", "bundler"],
    ["composer.lock", "composer"],
  ];
  for (const [file, pm] of candidates) {
    if (await pathExists(join(dir, file))) return pm;
  }
  return null;
}

async function detectManifest(dir: string): Promise<ParsedManifest | null> {
  
  const pj = await parsePackageJson(join(dir, "package.json"));
  if (pj) {
    
    return pj;
  }
  
  const py = await readTextIfExists(join(dir, "pyproject.toml"));
  if (py !== null) {
    return {
      languages: ["Python"],
      frameworks: [],
      packageManager: await detectPackageManager(dir),
      scripts: {},
      workspaces: [],
      name: null,
    };
  }
  const cargo = await readTextIfExists(join(dir, "Cargo.toml"));
  if (cargo !== null) {
    return {
      languages: ["Rust"],
      frameworks: [],
      packageManager: await detectPackageManager(dir),
      scripts: {},
      workspaces: [],
      name: null,
    };
  }
  const goMod = await readTextIfExists(join(dir, "go.mod"));
  if (goMod !== null) {
    return {
      languages: ["Go"],
      frameworks: [],
      packageManager: await detectPackageManager(dir),
      scripts: {},
      workspaces: [],
      name: null,
    };
  }
  return null;
}


function detectLanguagesByMarkers(
  dir: string,
  entries: { name: string }[],
): string[] {
  const names = new Set(entries.map((e) => e.name));
  const langs = new Set<string>();
  for (const [marker, lang] of Object.entries(LANGUAGE_MARKERS)) {
    if (names.has(marker)) langs.add(lang);
  }
  
  if (entries.some((e) => e.name === "src")) {
    
  }
  void dir;
  return [...langs];
}




function extractReadmeHighlights(text: string, max = 12): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (m) {
      const h = m[1]!.replace(/[*_`]/g, "").trim();
      if (h && !out.includes(h)) out.push(h);
    }
    if (out.length >= max) break;
  }
  return out;
}



const NOTABLE_CONFIGS = [
  "tsconfig.json",
  "jsconfig.json",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.cjs",
  ".eslintrc.js",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  "prettier.config.js",
  "biome.json",
  "biome.jsonc",
  ".babelrc",
  "babel.config.js",
  "vite.config.ts",
  "vite.config.js",
  "webpack.config.js",
  "rollup.config.js",
  "next.config.js",
  "next.config.mjs",
  "tailwind.config.js",
  "tailwind.config.ts",
  "jest.config.js",
  "vitest.config.ts",
  "playwright.config.ts",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".github",
  "Makefile",
  "CMakeLists.txt",
];

const AI_CONFIG_FILES = [
  "CLAUDE.md",
  "DEEP.md",
  "AGENTS.md",
  ".cursorrules",
  "GEMINI.md",
  ".github/copilot-instructions.md",
];



export async function generateProjectSummary(
  workingDir: string,
): Promise<ProjectSummary> {
  const dir = workingDir || process.cwd();
  const topEntries = listDirSync(dir);
  const topNames = topEntries.map((e) => e.name);

  const manifest = await detectManifest(dir);
  const pkgManager = manifest?.packageManager ?? (await detectPackageManager(dir));

  const languages = new Set<string>();
  if (manifest) for (const l of manifest.languages) languages.add(l);
  for (const l of detectLanguagesByMarkers(dir, topEntries)) languages.add(l);

  const frameworks = manifest?.frameworks ?? [];
  const workspaces = manifest?.workspaces ?? [];
  const scripts = manifest?.scripts ?? {};

  
  const name =
    manifest?.name ||
    (await readJson<any>(join(dir, "package.json")))?.name ||
    basename(dir);

  
  let readmeHighlights: string[] = [];
  for (const cand of ["README.md", "README.MD", "README", "readme.md"]) {
    const txt = await readTextIfExists(join(dir, cand));
    if (txt) {
      readmeHighlights = extractReadmeHighlights(txt);
      break;
    }
  }

  
  const NOISE_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "out",
    "coverage",
    ".cache",
    ".turbo",
    ".svelte-kit",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    "vendor",
  ]);
  const topDirs = topEntries
    .filter((e) => e.isDirectory && !NOISE_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  const existingAiConfigs = AI_CONFIG_FILES.filter((f) => topNames.includes(f));
  const notableConfigs = NOTABLE_CONFIGS.filter((f) =>
    topNames.includes(f) || f === ".github" && topEntries.some((e) => e.isDirectory && e.name === ".github"),
  );

  const notes: string[] = [];
  if (workspaces.length > 0) {
    notes.push(
      `Monorepo with ${workspaces.length} workspace glob(s): ${clip(workspaces.join(", "), 120)}`,
    );
  }
  if (topEntries.some((e) => e.name === ".deepseek-code")) {
    notes.push("Found a `.deepseek-code/` config dir (settings, commands, or MCP).");
  }
  if (topEntries.some((e) => e.name === ".mcp.json")) {
    notes.push("Found an MCP server config at `.mcp.json`.");
  }

  return {
    workingDir: dir,
    name: String(name),
    languages: [...languages],
    frameworks,
    packageManager: pkgManager,
    isMonorepo: workspaces.length > 0,
    workspaces,
    scripts,
    readmeHighlights,
    topDirs,
    existingAiConfigs,
    notableConfigs,
    notes,
  };
}



function bulletList(items: string[]): string {
  if (items.length === 0) return "_(none detected)_";
  return items.map((i) => `- ${i}`).join("\n");
}


export function renderSummaryBody(s: ProjectSummary): string {
  const pm = s.packageManager ?? "(unknown)";
  const lines: string[] = [];

  lines.push(`This file documents the \`${s.name}\` project so future agents can be productive quickly. It was generated by \`/init\` and should be reviewed and refined by a human.`);
  lines.push("");

  lines.push("## Project overview");
  lines.push("");
  lines.push(`- **Name:** ${s.name}`);
  lines.push(`- **Path:** \`${s.workingDir}\``);
  lines.push(`- **Languages:** ${s.languages.join(", ") || "(undetected)"}`);
  lines.push(`- **Frameworks / libraries:** ${s.frameworks.join(", ") || "(undetected)"}`);
  lines.push(`- **Package manager:** ${pm}`);
  lines.push(`- **Monorepo:** ${s.isMonorepo ? "yes" : "no"}`);
  lines.push("");

  
  lines.push("## Commands");
  lines.push("");
  const cmd = (key: string, fallback: string): string => {
    if (s.scripts[key]) return `npm run ${key}`;
    return fallback;
  };
  const devCmd = cmd("dev", pm === "bun" ? "bun run dev" : pm === "cargo" ? "cargo run" : pm === "go" ? "go run ." : "npm run dev");
  const buildCmd = cmd("build", pm === "bun" ? "bun run build" : pm === "cargo" ? "cargo build" : pm === "go" ? "go build" : "npm run build");
  const testCmd = cmd("test", pm === "bun" ? "bun test" : pm === "cargo" ? "cargo test" : pm === "go" ? "go test ./..." : "npm test");
  const lintCmd = cmd("lint", "npm run lint");
  const typecheckCmd = cmd("typecheck", pm === "bun" ? "bun run typecheck" : "npx tsc --noEmit");
  lines.push("```bash");
  lines.push(`${devCmd.padEnd(22)}# run / dev server`);
  lines.push(`${buildCmd.padEnd(22)}# build`);
  lines.push(`${testCmd.padEnd(22)}# tests`);
  if (s.scripts.lint) lines.push(`${lintCmd.padEnd(22)}# lint`);
  if (s.scripts.typecheck) lines.push(`${typecheckCmd.padEnd(22)}# type checking`);
  lines.push("```");
  if (Object.keys(s.scripts).length > 0) {
    lines.push("");
    lines.push("**Detected npm scripts:**");
    lines.push("");
    for (const [k, v] of Object.entries(s.scripts)) {
      lines.push(`- \`npm run ${k}\` — \`${clip(v, 80)}\``);
    }
  }
  lines.push("");

  
  lines.push("## Structure");
  lines.push("");
  if (s.topDirs.length > 0) {
    lines.push("Top-level directories:");
    lines.push("");
    lines.push("```");
    for (const d of s.topDirs.slice(0, 24)) {
      lines.push(`${d}/`);
    }
    if (s.topDirs.length > 24) {
      lines.push(`... (${s.topDirs.length - 24} more)`);
    }
    lines.push("```");
  } else {
    lines.push("_(no top-level directories detected)_");
  }
  if (s.isMonorepo) {
    lines.push("");
    lines.push("Workspaces:");
    lines.push("");
    lines.push(bulletList(s.workspaces));
  }
  lines.push("");

  
  if (s.readmeHighlights.length > 0) {
    lines.push("## README highlights");
    lines.push("");
    lines.push(bulletList(s.readmeHighlights));
    lines.push("");
  }

  
  const tooling = [
    ...s.notableConfigs,
    ...(s.existingAiConfigs.length > 0 ? [`AI configs: ${s.existingAiConfigs.join(", ")}`] : []),
  ];
  if (tooling.length > 0) {
    lines.push("## Tooling & config");
    lines.push("");
    lines.push(bulletList(tooling));
    lines.push("");
  }

  if (s.notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    lines.push(bulletList(s.notes));
    lines.push("");
  }

  lines.push("## Conventions");
  lines.push("");
  lines.push("_(Fill these in after reviewing the codebase: code style, branching/PR conventions, required env vars, testing quirks, and non-obvious gotchas. `/init` can re-scan anytime.)_");
  lines.push("");

  return lines.join("\n");
}


export async function generateMarkdown(workingDir: string): Promise<string | null> {
  let summary: ProjectSummary;
  try {
    summary = await generateProjectSummary(workingDir);
  } catch {
    return null;
  }
  const body = renderSummaryBody(summary);
  const title = `# DEEP.md\n\nThis file provides guidance to DeepSeek Code when working with code in the \`${summary.name}\` repository.\n`;
  return `${title}\n${body}\n`;
}




export async function buildInitPrompt(workingDir: string): Promise<string> {
  const draft = (await generateMarkdown(workingDir)) ?? "(project scan failed)";
  const summary = await generateProjectSummary(workingDir).catch(() => null);
  const alreadyHas =
    summary?.existingAiConfigs.includes("DEEP.md") ||
    summary?.existingAiConfigs.includes("CLAUDE.md");

  const existingClause = alreadyHas
    ? `A CLAUDE.md or DEEP.md already exists in this repo. **Do NOT silently overwrite it.** Read the existing file, propose specific additions/improvements as diffs, and explain why each change helps. Preserve user-written content.`
    : `No DEEP.md exists yet. Create one at the project root named \`DEEP.md\` (DeepSeek Code loads this like CLAUDE.md).`;

  return `## Task: generate / refine the project's DEEP.md

${existingClause}

You are given an auto-generated DRAFT below (produced by scanning package.json, README, lockfiles, and the top-level directory structure). Use it as a starting point — verify it against the real files, then make it accurate and useful.

### What to include
- Build / dev / test / lint commands the agent could not guess from manifest files (non-standard scripts, flags, or sequences).
- High-level architecture that requires reading multiple files to understand (the "big picture"), not a file-by-file listing.
- Languages, frameworks, and package manager.
- Code style rules that DIFFER from language defaults.
- Testing instructions and quirks (e.g., how to run a single test).
- Required env vars or setup steps.
- Non-obvious gotchas or architectural decisions.
- If a README, AGENTS.md, .cursorrules, or copilot-instructions.md exists, fold in the important parts.

### What to exclude
- File-by-file structure or component listings the agent can discover by reading the code.
- Standard language conventions the model already knows.
- Generic advice ("write clean code", "handle errors").
- Made-up sections like "Common Development Tasks" unless they come from a real file you read.
- Information that changes frequently — reference the source file instead.

### Steps
1. Read the key files to verify the draft: manifest(s), README, build/CI config, and any existing DEEP.md/CLAUDE.md.
2. Refine the DRAFT into a concise, accurate DEEP.md. Every line must pass: "Would removing this cause the agent to make mistakes?" If no, cut it.
3. Write the file with the Write tool (or propose diffs if one exists). Prefix it with:

\`\`\`
# DEEP.md

This file provides guidance to DeepSeek Code when working with code in this repository.
\`\`\`

4. Briefly tell the user what you included and what they should review next.

### Auto-generated DRAFT (verify before trusting)
\`\`\`markdown
${draft}
\`\`\`
`;
}
