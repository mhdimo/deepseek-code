import { basename, extname } from "node:path";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cmake from "highlight.js/lib/languages/cmake";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { SYNTAX_SCOPES, type Theme } from "../utils/theme.js";

/** highlight.js ships one module per grammar and `common` bundles 40 of them.
 *  Registering the set explicitly keeps the ones a coding agent actually
 *  meets in a diff, without pulling in all 190. */
const GRAMMARS = {
  bash,
  c,
  cmake,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  perl,
  php,
  powershell,
  python,
  r,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
} as const;

for (const [name, grammar] of Object.entries(GRAMMARS)) {
  hljs.registerLanguage(name, grammar);
}

export interface CodeSpan {
  text: string;
  /** The scope's colour, or undefined where the scope has none — the caller's
   *  base colour then stands (the diff's line foreground, say). */
  color?: string;
}

/** Keywords syntect scopes as storage.type rather than keyword.control.
 *  highlight.js lumps these under `keyword`, so the highlighter re-splits
 *  them — const/function/class take the storage colour, not the control-flow
 *  one. */
const STORAGE_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "type",
  "interface",
  "enum",
  "namespace",
  "module",
  "def",
  "fn",
  "func",
  "struct",
  "trait",
  "impl",
]);

/** A node of highlight.js's token tree: leaves are strings, branches carry
 *  the scope their children inherit. */
type HljsNode = string | { children?: HljsNode[]; scope?: string; kind?: string };

function scopeColor(
  scope: string | undefined,
  text: string,
  scopes: Record<string, string>,
): string | undefined {
  if (!scope) return undefined;
  if (scope === "keyword" && STORAGE_KEYWORDS.has(text.trim())) {
    return scopes["_storage"];
  }
  // Fall back to the scope's parent, so `title.class.inherited` still finds
  // an entry when only `title` is tabled.
  return scopes[scope] ?? scopes[scope.split(".")[0]!];
}

function flatten(
  node: HljsNode,
  scopes: Record<string, string>,
  parentScope: string | undefined,
  out: CodeSpan[],
): void {
  if (typeof node === "string") {
    out.push({ text: node, color: scopeColor(parentScope, node, scopes) });
    return;
  }
  const scope = node.scope ?? node.kind ?? parentScope;
  for (const child of node.children ?? []) {
    flatten(child, scopes, scope, out);
  }
}

/** Files whose name, rather than their extension, names the grammar. */
const FILENAME_LANGS: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  Rakefile: "ruby",
  Gemfile: "ruby",
  CMakeLists: "cmake",
};

/**
 * The grammar to highlight a file with, or "" when none applies: the file name
 * first (Dockerfile, Makefile, CMakeLists.txt), then the extension, then the
 * first line's shebang or `<?php` / `<?xml` marker. Extensions are checked
 * against the registered grammars, so an unknown one highlights as plain text
 * rather than being guessed at.
 */
export function languageFromPath(filePath: string, firstLine?: string | null): string {
  const base = basename(filePath);
  const ext = extname(filePath).slice(1);
  const stem = base.split(".")[0] ?? "";
  const byName = FILENAME_LANGS[base] ?? FILENAME_LANGS[stem];
  if (byName && hljs.getLanguage(byName)) return byName;
  if (ext && hljs.getLanguage(ext)) return ext;
  if (firstLine) {
    const line = firstLine.startsWith("\ufeff") ? firstLine.slice(1) : firstLine;
    if (line.startsWith("#!")) {
      if (line.includes("bash") || line.includes("/sh")) return "bash";
      if (line.includes("python")) return "python";
      if (line.includes("node")) return "javascript";
      if (line.includes("ruby")) return "ruby";
      if (line.includes("perl")) return "perl";
    }
    if (line.startsWith("<?php")) return "php";
    if (line.startsWith("<?xml")) return "xml";
  }
  return "";
}

/** The token tree hangs off the emitter. The public HighlightResult type
 *  spells it `emitter`; highlight.js 11 actually sets `_emitter`, so accept
 *  either rather than quietly rendering every line in one colour. */
function rootNodeOf(result: unknown): HljsNode | null {
  const emitter = (result as { emitter?: unknown; _emitter?: unknown } | null)?.emitter ??
    (result as { _emitter?: unknown } | null)?._emitter;
  if (typeof emitter !== "object" || emitter === null) return null;
  const root = (emitter as { rootNode?: unknown }).rootNode;
  if (typeof root !== "object" || root === null || !("children" in root)) return null;
  return root as HljsNode;
}

/** Drop the trailing newline the line was highlighted with, and any empty
 *  leaves, so the spans concatenate to exactly the line that went in. */
function tidy(spans: CodeSpan[]): CodeSpan[] {
  const kept = spans.filter((span) => span.text !== "");
  const last = kept[kept.length - 1];
  if (!last || !last.text.endsWith("\n")) return kept;
  const trimmed = last.text.replace(/\n$/, "");
  return trimmed === ""
    ? kept.slice(0, -1)
    : [...kept.slice(0, -1), { ...last, text: trimmed }];
}

/**
 * Tokenize one line and colour it from the theme's scope table.
 *
 * A line is highlighted as `line + "\n"` so that a line comment terminates,
 * then the newline is trimmed back off. An empty or unknown language is not an
 * error — the line comes back as a single uncoloured span.
 */
export function highlightLine(line: string, lang: string, theme: Theme): CodeSpan[] {
  // On a language it has no grammar for, hljs announces the miss on the
  // console before throwing — and a stray line of output lands in the middle
  // of the TUI's render — so ask the registry first.
  if (!lang || !hljs.getLanguage(lang)) return [{ text: line }];
  const scopes = SYNTAX_SCOPES[theme.syntaxScopes];
  let result: unknown;
  try {
    result = hljs.highlight(line + "\n", { language: lang, ignoreIllegals: true });
  } catch {
    // A grammar that throws on a line should cost the colouring, not the render.
    return [{ text: line }];
  }
  const root = rootNodeOf(result);
  if (!root) return [{ text: line }];
  const spans: CodeSpan[] = [];
  flatten(root, scopes, undefined, spans);
  return tidy(spans);
}
