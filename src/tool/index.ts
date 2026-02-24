// Tool definitions — AI SDK native tools for the agentic loop
//
// Returns tools as `Record<string, any>` to avoid Zod v4 ↔ AI SDK v6
// type inference issues. The tools work correctly at runtime.

import { z } from "zod";
import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { resolve, relative, dirname } from "path";
import type { PermissionRuleset } from "../core/types.js";

// ─── Permission callback type ───────────────────────────────────────────────

export type PermissionCallback = (
  toolName: string,
  description: string,
) => Promise<boolean>;

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

  const checkPermission = async (toolName: string, desc: string): Promise<boolean> => {
    if (!requestPermission) return true;
    return requestPermission(toolName, desc);
  };

  // ── Read ────────────────────────────────────────────────────────────────

  const Read = {
    description:
      "Read the contents of a file. Returns lines with line numbers. " +
      "Use offset and limit for large files.",
    parameters: z.object({
      file_path: z.string().describe("Path to the file (relative to cwd or absolute)"),
      offset: z.number().optional().describe("Start line (0-indexed)"),
      limit: z.number().optional().describe("Max number of lines to read"),
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
    parameters: z.object({
      file_path: z.string().describe("Path to the file"),
      content: z.string().describe("Full file content to write"),
    }),
    execute: async (params: Record<string, any>) => {
      if (!permissions.allowWrite) return "❌ Write permission denied for this agent.";
      const filePath: string | undefined =
        params.file_path ?? params.filePath ?? params.path ?? params.file;
      if (!filePath) return `❌ Missing file_path parameter. Received: ${Object.keys(params).join(", ")}`;
      const content = (params.content ?? params.text ?? "") as string;
      const fullPath = resolvePath(filePath);
      const approved = await checkPermission("Write", `Write ${relative(cwd, fullPath)}`);
      if (!approved) return "⚠️ Permission denied by user.";
      try {
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf-8");
        return `✅ Wrote ${relative(cwd, fullPath)} (${content.split("\n").length} lines)`;
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
    parameters: z.object({
      file_path: z.string().describe("Path to the file"),
      old_string: z.string().describe("Exact string to find and replace"),
      new_string: z.string().describe("Replacement string"),
    }),
    execute: async (params: Record<string, any>) => {
      if (!permissions.allowWrite) return "❌ Write permission denied for this agent.";
      const filePath: string | undefined =
        params.file_path ?? params.filePath ?? params.path ?? params.file;
      if (!filePath) return `❌ Missing file_path parameter. Received: ${Object.keys(params).join(", ")}`;
      const oldString = (params.old_string ?? params.oldString ?? "") as string;
      const newString = (params.new_string ?? params.newString ?? "") as string;
      const fullPath = resolvePath(filePath);
      const approved = await checkPermission("Edit", `Edit ${relative(cwd, fullPath)}`);
      if (!approved) return "⚠️ Permission denied by user.";
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
        return `✅ Edited ${relative(cwd, fullPath)}`;
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
    parameters: z.object({
      command: z.string().describe("Shell command to execute"),
      timeout: z.number().optional().describe("Timeout in ms (default: 120000)"),
    }),
    execute: async (params: { command: string; timeout?: number }) => {
      if (!permissions.allowExecute) return "❌ Execute permission denied for this agent.";
      const approved = await checkPermission("Bash", params.command);
      if (!approved) return "⚠️ Permission denied by user.";
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
    parameters: z.object({
      pattern: z.string().describe("File name or extension to search for (e.g. '*.ts', 'package.json')"),
      path: z.string().optional().describe("Directory to search in (default: cwd)"),
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
    parameters: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      path: z.string().optional().describe("Directory or file to search in (default: cwd)"),
      include: z.string().optional().describe("File glob to filter (e.g. '*.ts')"),
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
    parameters: z.object({
      path: z.string().optional().describe("Directory path (default: cwd)"),
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
