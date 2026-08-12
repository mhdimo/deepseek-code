// Jupyter notebook (.ipynb) reading for FileReadTool.
//
// Parses the notebook JSON and renders all cells — markdown and code — with
// their outputs as a plain-text listing. Image outputs are noted but not
// included (the model cannot view them; see the tool prompt).

import { readFile } from "fs/promises";

/** Per-output character cap before truncation with a marker. */
const MAX_OUTPUT_CHARS = 2000;

/** Cap on cells rendered per read; larger notebooks are truncated with a marker. */
export const MAX_NOTEBOOK_CELLS = 200;

export interface NotebookCellOutput {
  output_type: string;
  text: string;
  hasImage?: boolean;
}

export interface NotebookCell {
  cell_type: string;
  execution_count: number | null;
  source: string;
  outputs: NotebookCellOutput[];
}

export interface Notebook {
  cells: NotebookCell[];
  nbformat: number;
}

function joinLines(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : String(part)))
      .join("");
  }
  return value === undefined || value === null ? "" : String(value);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const kept = text.slice(0, maxChars);
  const omitted = text.length - maxChars;
  return `${kept}\n... [output truncated: ${omitted} chars omitted]`;
}

function processOutput(output: any): NotebookCellOutput {
  const outType = String(output?.output_type ?? "unknown");
  switch (outType) {
    case "stream":
      return { output_type: outType, text: truncateText(joinLines(output.text), MAX_OUTPUT_CHARS) };
    case "execute_result":
    case "display_data": {
      const data = output?.data ?? {};
      const text = joinLines(data["text/plain"]);
      const hasImage =
        typeof data["image/png"] === "string" || typeof data["image/jpeg"] === "string";
      const mimeKeys = Object.keys(data);
      const note =
        text.trim() === ""
          ? `[no text/plain representation; MIME types: ${mimeKeys.join(", ") || "none"}]`
          : "";
      return {
        output_type: outType,
        text: truncateText(text || note, MAX_OUTPUT_CHARS),
        ...(hasImage ? { hasImage: true } : {}),
      };
    }
    case "error": {
      const traceback = Array.isArray(output.traceback)
        ? output.traceback.slice(0, 5).map((line: unknown) => String(line)).join("\n")
        : "";
      return {
        output_type: outType,
        text: truncateText(
          `${output.ename ?? "Error"}: ${output.evalue ?? ""}${traceback ? `\n${traceback}` : ""}`,
          MAX_OUTPUT_CHARS,
        ),
      };
    }
    default:
      return { output_type: outType, text: truncateText(JSON.stringify(output), MAX_OUTPUT_CHARS) };
  }
}

function processCell(raw: any): NotebookCell | null {
  if (raw === null || typeof raw !== "object") return null;
  const cellType = String(raw.cell_type ?? "raw");
  const source = joinLines(raw.source);
  const outputs: NotebookCellOutput[] = Array.isArray(raw.outputs)
    ? raw.outputs.map(processOutput)
    : [];
  const executionCount =
    raw.execution_count === null || raw.execution_count === undefined
      ? null
      : Number(raw.execution_count) || null;
  return { cell_type: cellType, execution_count: executionCount, source, outputs };
}

/** Parse a notebook file from disk. Throws with a descriptive message on
 *  invalid JSON or a non-notebook structure. */
export async function readNotebook(filePath: string): Promise<Notebook> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read notebook: ${(error as Error).message}`);
  }

  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Not a valid Jupyter notebook (invalid JSON): ${(error as Error).message}`);
  }
  if (json === null || typeof json !== "object" || !Array.isArray(json.cells)) {
    throw new Error("Not a valid Jupyter notebook (missing 'cells' array)");
  }

  const cells = json.cells
    .map(processCell)
    .filter((cell: NotebookCell | null): cell is NotebookCell => cell !== null);

  return {
    cells,
    nbformat: typeof json.nbformat === "number" ? json.nbformat : 0,
  };
}

/** Render a notebook as readable text: one block per cell, outputs indented. */
export function formatNotebook(notebook: Notebook): string {
  const blocks: string[] = [];
  for (let i = 0; i < notebook.cells.length; i++) {
    if (i >= MAX_NOTEBOOK_CELLS) {
      blocks.push(
        `... [${notebook.cells.length - MAX_NOTEBOOK_CELLS} more cells not shown; ` +
          `use a code tool (e.g. Bash with jq) to inspect specific cells]`,
      );
      break;
    }
    const cell = notebook.cells[i]!;
    const label =
      cell.cell_type === "code" && cell.execution_count !== null
        ? `Cell ${i + 1} [code] (execution ${cell.execution_count})`
        : `Cell ${i + 1} [${cell.cell_type}]`;
    const lines = cell.source === "" ? ["(empty cell)"] : cell.source.split("\n");
    const body = lines.map((line) => `  ${line}`).join("\n");
    blocks.push(`${label}:\n${body}`);

    if (cell.cell_type === "code" && cell.outputs.length > 0) {
      const outLines = cell.outputs
        .map((out) => {
          const imageNote = out.hasImage ? " [image output not shown]" : "";
          const bodyText = out.text === "" ? "(no text output)" : out.text;
          return bodyText
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n") + imageNote;
        })
        .join("\n");
      blocks.push(`  ── output ──\n${outLines}`);
    }
  }
  return blocks.join("\n\n");
}

/** Convenience wrapper used by the tool: parse + format. */
export async function readNotebookText(filePath: string): Promise<{
  text: string;
  cellCount: number;
}> {
  const notebook = await readNotebook(filePath);
  return {
    text: formatNotebook(notebook),
    cellCount: notebook.cells.length,
  };
}
