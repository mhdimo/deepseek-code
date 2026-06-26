// Build a bounded, pruned index of relative file paths under a directory for
// @-file autocompletion. Prunes dependency/build dirs and hidden VCS dirs so the
// index stays small and relevant even in large projects.

import { readdirSync } from "fs";
import { join } from "path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache", "coverage",
  ".turbo", "out", "vendor", ".idea", ".vscode", "target", "__pycache__",
  ".pytest_cache", ".venv", "venv", ".mypy_cache", ".gradle",
]);

const MAX_FILES = 4000;

export function buildFileIndex(root: string): string[] {
  const out: string[] = [];
  try {
    walk(root, "");
  } catch {
    // ignore — best effort
  }
  return out;

  function walk(dir: string, prefix: string): void {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name === ".git") continue;
        walk(join(dir, e.name), rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  }
}
