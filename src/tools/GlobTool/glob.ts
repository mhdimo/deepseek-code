/**
 * Glob matching for the Glob tool.
 *
 * The tool used to shell out to `find <dir> -name <pattern>`, and `-name`
 * matches against the basename only. Patterns containing a separator therefore
 * matched nothing at all — `**` was handed to a matcher that had no idea what
 * it meant, so `src/**` + `*.ts` was the only thing that ever worked. The
 * patterns the tool advertises (`**` + `/*.ts`, `src/**` + `/*.tsx`) returned
 * "No files matched" with exit 0, which the model reads as "the file does not
 * exist" rather than "the search was malformed".
 *
 * These helpers implement the semantics ripgrep's `--glob` gives the reference
 * implementation, which is what those advertised patterns assume.
 */

/** Escapes the regex metacharacters that are not glob syntax. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glob to an anchored regex.
 *
 * - `**` crosses separators (`**` + `/` also matches zero directories, so
 *   `**` + `/*.ts` finds `a.ts` at the root as well as `src/a.ts`)
 * - `*` and `?` stay within one path segment
 * - `[abc]`, `[!abc]` and `{a,b}` are supported, as ripgrep supports them
 */
export function compileGlob(pattern: string): RegExp {
  let out = "";

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;

    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (c === "?") {
      out += "[^/]";
      continue;
    }

    if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      let cls = pattern.slice(i + 1, end);
      i = end;
      // ripgrep spells negation `[!...]`; POSIX spells it `[^...]`.
      const negated = cls.startsWith("!") || cls.startsWith("^");
      if (negated) cls = cls.slice(1);
      cls = cls.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
      out += `[${negated ? "^" : ""}${cls}]`;
      continue;
    }

    if (c === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end === -1) {
        out += "\\{";
        continue;
      }
      const alternatives = pattern.slice(i + 1, end).split(",");
      i = end;
      out += `(?:${alternatives.map(escapeLiteral).join("|")})`;
      continue;
    }

    out += escapeLiteral(c);
  }

  return new RegExp(`^${out}$`);
}

/**
 * Build a matcher for `pattern`, compiling once so a walk over a large tree
 * does not recompile per file.
 *
 * A pattern with no separator is matched against the file name at any depth —
 * what `rg --glob '*.ts'` does, and what a model writing `*.ts` means by it.
 */
export function globMatcher(pattern: string): (relativePath: string) => boolean {
  const normalized = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  const againstNameOnly = !normalized.includes("/");
  const re = compileGlob(normalized);

  return (relativePath: string): boolean => {
    if (!againstNameOnly) return re.test(relativePath);
    const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    return re.test(name);
  };
}

/** One-shot form of {@link globMatcher}, for callers testing a single path. */
export function matchGlob(pattern: string, relativePath: string): boolean {
  return globMatcher(pattern)(relativePath);
}
