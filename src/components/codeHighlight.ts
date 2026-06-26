// Lightweight, dependency-free syntax highlighter for terminal code blocks.
//
// Tokenizes a single source line into colored spans for Ink <Text>. Covers the
// common cases (comments, strings, numbers, keywords, booleans, function calls,
// punctuation) across c-like and scripting languages — enough to make code
// output read like a real editor without pulling in a grammar engine.

export interface CodeSpan {
  text: string;
  color?: string; // Ink named color or hex
  bold?: boolean;
}

const KEYWORDS = new Set([
  // JS / TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "new", "class", "extends", "super", "this",
  "typeof", "instanceof", "in", "of", "void", "delete", "yield", "async", "await",
  "static", "get", "set", "public", "private", "protected", "readonly", "interface",
  "type", "enum", "implements", "namespace", "module", "declare", "abstract", "as",
  "is", "keyof", "infer", "satisfies", "never", "unknown", "any", "string", "number",
  "boolean", "object", "symbol", "bigint", "from", "import", "export", "default",
  "try", "catch", "finally", "throw",
  // Python
  "def", "lambda", "elif", "and", "or", "not", "with", "pass", "raise", "global",
  "nonlocal", "assert", "del", "print", "self", "cls",
  // Go / Rust / C / C++
  "func", "package", "go", "chan", "select", "defer", "map", "struct", "mut", "fn",
  "impl", "trait", "use", "pub", "match", "move", "ref", "unsafe", "extern", "crate",
  "mod", "where", "int", "char", "float", "double", "long", "short", "unsigned",
  "signed", "union", "typedef", "include", "sizeof", "auto", "register", "volatile",
  // Shell / misc
  "echo", "export", "source", "alias", "then", "fi", "esac", "end", "fun", "val",
  "var", "when", "redo", "next",
]);

const BOOL_LITERALS = new Set([
  "true", "false", "null", "undefined", "None", "True", "False", "nil", "NaN", "nullptr",
]);

// Languages whose line comment starts with '#'
const HASH_LANGS = new Set([
  "sh", "bash", "shell", "zsh", "fish", "python", "py", "ruby", "rb", "yaml", "yml",
  "toml", "perl", "pl", "r", "makefile", "make", "dockerfile", "docker", "ps1",
  "powershell", "yaml-doc", "gitignore", "properties", "conf", "ini", "gnuplot",
]);

// Build the combined tokenizer. Group order is significant (1..8).
function buildRegex(useHashComments: boolean): RegExp {
  const commentBlock = String.raw`/\*[\s\S]*?\*/`;           // /* ... */ (single-line)
  const commentLine = useHashComments ? String.raw`#[^\n]*` : String.raw`//[^\n]*`;
  const strings = String.raw`(?:r|R|b|f|rb|br)?(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|` + "`(?:\\\\.|[^`\\\\])*`)";
  const numbers = String.raw`\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;
  const ident = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;
  const punct = String.raw`[{}()\[\]<>;:,.=+\-*/%&|!?^~@]`;
  const ws = String.raw`\s+`;
  const fallback = String.raw`[\s\S]`;
  return new RegExp(
    [commentBlock, commentLine, strings, numbers, ident, punct, ws, fallback]
      .map((src) => `(${src})`)
      .join("|"),
    "g",
  );
}

const CLIKE_RE = buildRegex(false);
const HASH_RE = buildRegex(true);

/** Tokenize one source line into colored spans. */
export function highlightLine(line: string, lang: string): CodeSpan[] {
  const re = HASH_LANGS.has(lang.toLowerCase()) ? HASH_RE : CLIKE_RE;
  re.lastIndex = 0;
  const spans: CodeSpan[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(line)) !== null) {
    const text = m[0];
    if (text === "") {
      re.lastIndex++;
      continue;
    }
    // 1:commentBlock 2:commentLine 3:string 4:number 5:ident 6:punct 7:ws 8:fallback
    if (m[1] || m[2]) {
      spans.push({ text, color: "gray" });
    } else if (m[3]) {
      spans.push({ text, color: "green" });
    } else if (m[4]) {
      spans.push({ text, color: "yellow" });
    } else if (m[5]) {
      if (KEYWORDS.has(text)) spans.push({ text, color: "magenta", bold: true });
      else if (BOOL_LITERALS.has(text)) spans.push({ text, color: "yellow", bold: true });
      else if (/^\s*\(/.test(line.slice(m.index + text.length))) spans.push({ text, color: "cyan" });
      else spans.push({ text });
    } else if (m[6]) {
      spans.push({ text, color: "gray" });
    } else {
      spans.push({ text });
    }
    if (re.lastIndex === m.index) re.lastIndex++; // safety: always advance
  }
  return spans;
}
