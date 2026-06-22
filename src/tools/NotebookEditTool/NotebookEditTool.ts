// NotebookEditTool — read/write Jupyter .ipynb cells
//
// Supports replacing, inserting, and deleting cells in Jupyter notebooks.
// Uses Bun.file() for efficient file I/O with JSON parse/stringify.

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { resolvePath } from "../../utils/toolUtils.js";
import { DESCRIPTION } from "./prompt.js";

type CellType = "code" | "markdown";
type EditMode = "replace" | "insert" | "delete";

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

const inputSchema = z.object({
  notebook_path: z.string().describe("Path to the .ipynb file"),
  cell_number: z.number().describe("0-indexed cell number to edit"),
  new_source: z
    .string()
    .optional()
    .describe("New cell source content"),
  cell_type: z
    .enum(["code", "markdown"])
    .optional()
    .describe("Cell type (code or markdown)"),
  edit_mode: z
    .enum(["replace", "insert", "delete"])
    .default("replace")
    .describe("Edit mode: replace, insert, or delete"),
}) satisfies z.ZodType;

function cellSourceToString(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

function stringToCellSource(content: string): string[] {
  // Jupyter convention: each line except the last ends with \n
  const lines = content.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
}

/** Build a new cell with the given type and source */
function buildCell(cellType: CellType, source: string): NotebookCell {
  const base: NotebookCell = {
    cell_type: cellType,
    source: stringToCellSource(source),
    metadata: {},
  };
  if (cellType === "code") {
    base.outputs = [];
    base.execution_count = null;
  }
  return base;
}

export const NotebookEditTool = buildTool({
  name: "NotebookEdit",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const fullPath = resolvePath(context.workingDir, args.notebook_path);

    try {
      const file = Bun.file(fullPath);

      // Read and parse the notebook
      const exists = await file.exists();
      if (!exists) {
        return { data: `Notebook not found: ${args.notebook_path}` };
      }

      const nb = (await file.json()) as Notebook;

      if (!Array.isArray(nb.cells)) {
        return { data: `Invalid notebook format: no cells array found.` };
      }

      const { cell_number, edit_mode, new_source, cell_type } = args;

      switch (edit_mode) {
        case "delete": {
          if (cell_number < 0 || cell_number >= nb.cells.length) {
            return {
              data: `Cell index ${cell_number} out of range (0-${nb.cells.length - 1}).`,
            };
          }
          const deleted = nb.cells.splice(cell_number, 1);
          await Bun.write(fullPath, JSON.stringify(nb, null, 1) + "\n");
          return {
            data: `Deleted cell ${cell_number} (was ${deleted[0]!.cell_type}). Notebook now has ${nb.cells.length} cells.`,
          };
        }

        case "insert": {
          const type = cell_type ?? "code";
          const source = new_source ?? "";
          const newCell = buildCell(type as CellType, source);
          const insertAt = Math.min(cell_number, nb.cells.length);
          nb.cells.splice(insertAt, 0, newCell);
          await Bun.write(fullPath, JSON.stringify(nb, null, 1) + "\n");
          return {
            data: `Inserted ${type} cell at index ${insertAt}. Notebook now has ${nb.cells.length} cells.`,
          };
        }

        case "replace":
        default: {
          if (cell_number < 0 || cell_number >= nb.cells.length) {
            return {
              data: `Cell index ${cell_number} out of range (0-${nb.cells.length - 1}).`,
            };
          }

          const existing = nb.cells[cell_number]!;
          const type = (cell_type ?? existing.cell_type) as CellType;
          const source = new_source ?? cellSourceToString(existing.source);

          nb.cells[cell_number] = buildCell(type, source);
          // Preserve execution count for code cells
          if (
            type === "code" &&
            existing.cell_type === "code" &&
            existing.execution_count != null
          ) {
            nb.cells[cell_number]!.execution_count = existing.execution_count;
          }

          await Bun.write(fullPath, JSON.stringify(nb, null, 1) + "\n");
          return {
            data: `Replaced cell ${cell_number} (${type}). Source:\n${source.slice(0, 500)}`,
          };
        }
      }
    } catch (error) {
      return {
        data: `Error editing notebook: ${(error as Error).message}`,
      };
    }
  },

  isReadOnly: (input: z.infer<typeof inputSchema>) =>
    input.edit_mode === undefined,

  isConcurrencySafe: () => false,

  async checkPermissions(
    input: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ) {
    // Only need write permission for non-read operations
    if (input.edit_mode === "delete" || input.edit_mode === "insert" || input.edit_mode === "replace") {
      if (!context.permissions.allowWrite) {
        return { approved: false, feedback: "Write permission denied for this agent." };
      }
      const desc = [
        `NotebookEdit: ${input.edit_mode} cell ${input.cell_number} in ${input.notebook_path}`,
        input.new_source
          ? `New source preview:\n${input.new_source.slice(0, 500)}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");

      return context.requestPermission("NotebookEdit", desc);
    }
    return { approved: true };
  },

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `${input.edit_mode ?? "replace"} cell ${input.cell_number} in ${input.notebook_path}`,
}) satisfies import("../../Tool.js").Tool;
