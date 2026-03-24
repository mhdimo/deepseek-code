// Tool definitions — AI SDK native tools for the agentic loop
//
// Uses explicit JSON Schema for parameters instead of Zod to ensure
// compatibility with DeepSeek's OpenAI-compatible API.

import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { resolve, relative, dirname } from "path";
import { jsonSchema } from "ai";
import type { PermissionRuleset } from "../core/types.js";

function previewTextBlock(text: string, maxLines = 16, maxChars = 900): string {
  const lines = text.split("\n");
  const clipped = lines.slice(0, maxLines);
  const numbered = clipped
    .map((line, i) => `${String(i + 1).padStart(3)}│${line}`)
    .join("\n");
  const hasMoreLines = lines.length > maxLines;
  const withLineNotice = hasMoreLines
    ? `${numbered}\n... (${lines.length - maxLines} more lines)`
    : numbered;

  if (withLineNotice.length <= maxChars) return withLineNotice;
  return withLineNotice.slice(0, maxChars) + "\n... (truncated)";
}

function previewRawBlock(text: string, maxLines = 40, maxChars = 1200): string {
  const lines = text.split("\n");
  const clipped = lines.slice(0, maxLines);
  const withLineNotice = lines.length > maxLines
    ? `${clipped.join("\n")}\n... (${lines.length - maxLines} more lines)`
    : clipped.join("\n");

  if (withLineNotice.length <= maxChars) return withLineNotice;
  return withLineNotice.slice(0, maxChars) + "\n... (truncated)";
}

function buildSimpleDiffPreview(oldText: string, newText: string, maxLines = 40): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const out: string[] = [];

  for (let i = 0; i < max; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) continue;

    if (oldLine !== undefined) out.push(`-${oldLine}`);
    if (newLine !== undefined) out.push(`+${newLine}`);

    if (out.length >= maxLines) break;
  }

  if (out.length === 0) return "(no textual diff)";
  if (out.length >= maxLines) out.push("... (diff truncated)");
  return out.join("\n");
}

// ─── Permission callback type ───────────────────────────────────────────────

export type PermissionCallback = (
  toolName: string,
  description: string,
) => Promise<PermissionDecision>;

export interface PermissionDecision {
  approved: boolean;
  feedback?: string;
}

function asAddedLines(text: string, maxLines = 40): string {
  const lines = text.split("\n");
  const clipped = lines.slice(0, maxLines).map((l) => `+${l}`);
  if (lines.length > maxLines) clipped.push(`... (${lines.length - maxLines} more lines)`);
  return clipped.join("\n");
}

// ─── Tool factory ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTools(
  workingDir: string,
  permissions: PermissionRuleset,
  requestPermission?: PermissionCallback,
): Record<string, any> {
  const cwd = resolve(workingDir);

  const resolvePath = (p: string | undefined | null): string => {
    if (!p || typeof p !== "string") return cwd;
    return p.startsWith("/") ? p : resolve(cwd, p);
  };

  const checkPermission = async (toolName: string, desc: string): Promise<PermissionDecision> => {
    if (!requestPermission) return { approved: true };
    return requestPermission(toolName, desc);
  };

  // ── Read ────────────────────────────────────────────────────────────────

  const Read = {
    description:
      "Read the contents of a file. Returns lines with line numbers. " +
      "Use offset and limit for large files.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file (relative to cwd or absolute)",
        },
        offset: {
          type: "number",
          description: "Start line (0-indexed)",
        },
        limit: {
          type: "number",
          description: "Max number of lines to read",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    }),
    execute: async (params: Record<string, any>) => {
      if (!permissions.allowRead) return "❌ Read permission denied for this agent.";
      // Flexible parameter resolution — models sometimes use different names
      const filePath: string | undefined =
        params.file_path ?? params.filePath ?? params.path ?? params.file;
      if (!filePath) {
        return `❌ Missing file_path parameter. Received keys: ${Object.keys(params).join(", ") || "(none)"}`;
      }
      try {
        const fullPath = resolvePath(filePath);
        const content = await readFile(fullPath, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, (params.offset as number) ?? 0);
        const end = params.limit ? Math.min(lines.length, start + (params.limit as number)) : lines.length;
        const result = lines
          .slice(start, end)
          .map((line, i) => `${String(start + i + 1).padStart(4)}│${line}`)
          .join("\n");
        return result || "(empty file)";
      } catch (error) {
        return `❌ ${(error as Error).message}`;
      }
    },
  };

  // ── Write ───────────────────────────────────────────────────────────────

  const Write = {
    description:
      "Create or overwrite a file with the given content. " +
      "Creates parent directories automatically.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file",
        },
        content: {
          type: "string",
          description: "Full file content to write",
        },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    }),
    execute: async (params: Record<string, any>) => {
      if (!permissions.allowWrite) return "❌ Write permission denied for this agent.";
      const filePath: string | undefined =
        params.file_path ?? params.filePath ?? params.path ?? params.file;
      if (!filePath) return `❌ Missing file_path parameter. Received: ${Object.keys(params).join(", ")}`;
      const content = (params.content ?? params.text ?? "") as string;
      const fullPath = resolvePath(filePath);

      let previousContent = "";
      let exists = false;
      try {
        previousContent = await readFile(fullPath, "utf-8");
        exists = true;
      } catch {
        exists = false;
      }

      const writePermissionPreview = [
        `Write ${relative(cwd, fullPath)}`,
        exists ? "Mode: overwrite existing file" : "Mode: create new file",
        "",
        exists ? "Diff preview:" : "Content preview:",
        exists
          ? previewRawBlock(buildSimpleDiffPreview(previousContent, content), 60, 1200)
          : previewTextBlock(content, 20, 1200),
      ].join("\n");

      const decision = await checkPermission("Write", writePermissionPreview);
      if (!decision.approved) {
        return decision.feedback
          ? `⚠️ Permission denied by user: ${decision.feedback}`
          : "⚠️ Permission denied by user.";
      }
      try {
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf-8");
        const diffPreview = exists
          ? buildSimpleDiffPreview(previousContent, content, 80)
          : asAddedLines(content, 80);
        return [
          `✅ Wrote ${relative(cwd, fullPath)} (${content.split("\n").length} lines)`,
          "",
          exists ? "Diff preview:" : "Added lines:",
          previewRawBlock(diffPreview, 80, 2500),
        ].join("\n");
      } catch (error) {
        return `❌ ${(error as Error).message}`;
      }
    },
  };

  // ── Edit ────────────────────────────────────────────────────────────────

  const Edit = {
    description:
      "Edit a file by replacing an exact string occurrence. " +
      "Provide enough context in old_string to uniquely match.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file",
        },
        old_string: {
          type: "string",
          description: "Exact string to find and replace",
        },
        new_string: {
          type: "string",
          description: "Replacement string",
        },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    }),
    execute: async (params: Record<string, any>) => {
      if (!permissions.allowWrite) return "❌ Write permission denied for this agent.";
      const filePath: string | undefined =
        params.file_path ?? params.filePath ?? params.path ?? params.file;
      if (!filePath) return `❌ Missing file_path parameter. Received: ${Object.keys(params).join(", ")}`;
      const oldString = (params.old_string ?? params.oldString ?? "") as string;
      const newString = (params.new_string ?? params.newString ?? "") as string;
      const fullPath = resolvePath(filePath);
      const editPermissionPreview = [
        `Edit ${relative(cwd, fullPath)}`,
        "",
        "Diff preview:",
        previewRawBlock(buildSimpleDiffPreview(oldString, newString), 60, 1200),
      ].join("\n");
      const decision = await checkPermission("Edit", editPermissionPreview);
      if (!decision.approved) {
        return decision.feedback
          ? `⚠️ Permission denied by user: ${decision.feedback}`
          : "⚠️ Permission denied by user.";
      }
      try {
        const content = await readFile(fullPath, "utf-8");
        if (!oldString) return `❌ old_string is empty or missing.`;
        if (!content.includes(oldString)) {
          return `❌ old_string not found in ${relative(cwd, fullPath)}. Make sure it matches exactly.`;
        }
        const occurrences = content.split(oldString).length - 1;
        if (occurrences > 1) {
          return `❌ old_string found ${occurrences} times. Add more context to match uniquely.`;
        }
        const newContent = content.replace(oldString, newString);
        await writeFile(fullPath, newContent, "utf-8");
        const diffPreview = buildSimpleDiffPreview(oldString, newString, 80);
        return [
          `✅ Edited ${relative(cwd, fullPath)}`,
          "",
          "Diff preview:",
          previewRawBlock(diffPreview, 80, 2500),
        ].join("\n");
      } catch (error) {
        return `❌ ${(error as Error).message}`;
      }
    },
  };

  // ── Bash ────────────────────────────────────────────────────────────────

  const Bash = {
    description:
      "Execute a shell command. Use for running builds, tests, git, installs, etc. " +
      "Commands run in the working directory. Timeout default is 120s.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in ms (default: 120000)",
        },
      },
      required: ["command"],
      additionalProperties: false,
    }),
    execute: async (params: { command: string; timeout?: number }) => {
      if (!permissions.allowExecute) return "❌ Execute permission denied for this agent.";
      const decision = await checkPermission("Bash", params.command);
      if (!decision.approved) {
        return decision.feedback
          ? `⚠️ Permission denied by user: ${decision.feedback}`
          : "⚠️ Permission denied by user.";
      }
      const timeout = params.timeout ?? 120_000;

      return new Promise<string>((resolvePromise) => {
        const child = spawn("sh", ["-c", params.command], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, FORCE_COLOR: "0" },
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
          if (stdout.length > 50_000) {
            child.kill();
            resolvePromise(`(output truncated at 50KB)\n${stdout.slice(0, 50_000)}`);
          }
        });

        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        const timer = setTimeout(() => {
          child.kill();
          resolvePromise(`❌ Command timed out after ${timeout}ms\n${stdout}\n${stderr}`);
        }, timeout);

        child.on("close", (code: number | null) => {
          clearTimeout(timer);
          const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
          if (code === 0) {
            resolvePromise(output || "(no output)");
          } else {
            resolvePromise(`Exit code ${code}\n${output}`);
          }
        });

        child.on("error", (error: Error) => {
          clearTimeout(timer);
          resolvePromise(`❌ ${error.message}`);
        });
      });
    },
  };

  // ── Glob ────────────────────────────────────────────────────────────────

  const Glob = {
    description:
      "Find files matching a glob-like pattern. " +
      "Returns matching file paths relative to the working directory.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "File name or extension to search for (e.g. '*.ts', 'package.json')",
        },
        path: {
          type: "string",
          description: "Directory to search in (default: cwd)",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    }),
    execute: async (params: { pattern: string; path?: string }) => {
      if (!permissions.allowRead) return "❌ Read permission denied.";
      try {
        const dir = resolvePath(params.path || ".");
        return new Promise<string>((resolvePromise) => {
          const child = spawn(
            "find",
            [dir, "-name", params.pattern, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-type", "f"],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let out = "";
          child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
          child.on("close", () => {
            const results = out.trim().split("\n").filter(Boolean)
              .map((p) => relative(cwd, p)).slice(0, 200);
            resolvePromise(results.length ? results.join("\n") : "No matches found.");
          });
          child.on("error", () => resolvePromise("❌ find command not available"));
        });
      } catch (error) {
        return `❌ ${(error as Error).message}`;
      }
    },
  };

  // ── Grep ────────────────────────────────────────────────────────────────

  const Grep = {
    description:
      "Search for a text pattern in files. Returns matching lines with file paths and line numbers.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory or file to search in (default: cwd)",
        },
        include: {
          type: "string",
          description: "File glob to filter (e.g. '*.ts')",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    }),
    execute: async (params: { pattern: string; path?: string; include?: string }) => {
      if (!permissions.allowRead) return "❌ Read permission denied.";
      try {
        const dir = resolvePath(params.path || ".");
        const args = ["-rn", "--color=never", "-E", params.pattern, dir,
          "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist"];
        if (params.include) args.push(`--include=${params.include}`);

        return new Promise<string>((resolvePromise) => {
          const child = spawn("grep", args, { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
          child.on("close", () => {
            const lines = out.trim().split("\n").filter(Boolean);
            if (!lines.length) return resolvePromise("No matches found.");
            const results = lines.slice(0, 100).map((l) => {
              const [filePart, ...rest] = l.split(":");
              return `${relative(cwd, filePart!)}:${rest.join(":")}`;
            }).join("\n");
            resolvePromise(lines.length > 100
              ? `${results}\n... (${lines.length - 100} more matches)` : results);
          });
          child.on("error", () => resolvePromise("❌ grep command not available"));
        });
      } catch (error) {
        return `❌ ${(error as Error).message}`;
      }
    },
  };

  // ── LS ──────────────────────────────────────────────────────────────────

  const LS = {
    description:
      "List the contents of a directory. Shows files and subdirectories with types.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path (default: cwd)",
        },
      },
      required: [],
      additionalProperties: false,
    }),
    execute: async (params: Record<string, any>) => {
      if (!permissions.allowRead) return "❌ Read permission denied.";
      try {
        const p = (params.path ?? params.dir ?? params.directory ?? ".") as string;
        const fullPath = resolvePath(p);
        const entries = await readdir(fullPath, { withFileTypes: true });
        const filtered = entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });
        const lines = filtered.map((e) => {
          const icon = e.isDirectory() ? "📁" : "📄";
          return `${icon} ${e.name}${e.isDirectory() ? "/" : ""}`;
        });
        return lines.length
          ? `${relative(cwd, fullPath) || "."}/\n${lines.join("\n")}`
          : "(empty directory)";
      } catch (error) {
        return `❌ ${(error as Error).message}`;
      }
    },
  };

  // ── Build tools object based on permissions ─────────────────────────────

  const tools: Record<string, any> = {};
  if (permissions.allowRead) {
    tools.Read = Read;
    tools.Glob = Glob;
    tools.Grep = Grep;
    tools.LS = LS;
  }
  if (permissions.allowWrite) {
    tools.Write = Write;
    tools.Edit = Edit;
  }
  if (permissions.allowExecute) {
    tools.Bash = Bash;
  }

  return tools;
}

/** Get all tool names and descriptions for display */
export function getToolDescriptions(): Array<{ name: string; description: string }> {
  return [
    { name: "Read", description: "Read file contents" },
    { name: "Write", description: "Create or overwrite a file" },
    { name: "Edit", description: "Edit a file by replacing text" },
    { name: "Bash", description: "Execute a shell command" },
    { name: "Glob", description: "Find files by pattern" },
    { name: "Grep", description: "Search for text in files" },
    { name: "LS", description: "List directory contents" },
  ];
}
