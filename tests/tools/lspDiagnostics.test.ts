/**
 * The other half of the LSP client: listening.
 *
 * The manager has advertised `publishDiagnostics` in its initialize
 * capabilities since the port and never registered a handler for one, so a
 * server reporting a broken build was talking to nobody. Nothing collected
 * diagnostics, nothing could ask for them, and an edit that broke a file was
 * indistinguishable — to the model and to the transcript — from one that did
 * not.
 *
 * The server is the real subprocess fixture, which derives its diagnostics
 * from the text it was last given: every line containing `BROKEN` is an error
 * with code 9001. Diagnostics as a function of the document is what makes the
 * interesting cases testable — a stale buffer reports on text the file no
 * longer holds, and a pre-existing problem shows up in both baselines unless
 * something diffs them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  formatDiagnosticsReport,
  formatNewDiagnostics,
  newDiagnostics,
  type ServerDiagnostic,
} from "../../src/services/lsp/editDiagnostics.js";
import type { LspDiagnostic, LspFileDiagnostics } from "../../src/services/lsp/manager.js";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-lsp-diag-"));
const dataDir = join(sandbox, "data");
const workDir = join(sandbox, "work");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const logPath = join(sandbox, "lsp.log");
const fixture = join(import.meta.dir, "../fixtures/fakeLspServer.ts");

const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
const savedLog = process.env.FAKE_LSP_LOG;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;
process.env.FAKE_LSP_LOG = logPath;

writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({
    schemaVersion: 3,
    lsp: { servers: { typescript: [process.execPath, [fixture]] } },
  }),
);

const { getLspServerManager, initializeLspServerManager, shutdownLspServerManager, waitForInitialization } =
  await import("../../src/services/lsp/manager.js");
const { FileEditTool } = await import("../../src/tools/FileEditTool/FileEditTool.js");
const { FileWriteTool } = await import("../../src/tools/FileWriteTool/FileWriteTool.js");
const { buildLSPTool } = await import("../../src/tools/LSPTool/LSPTool.js");

let manager: NonNullable<ReturnType<typeof getLspServerManager>>;

function fileFor(name: string): string {
  return join(workDir, name);
}

function context() {
  return {
    workingDir: workDir,
    readFileState: { record: () => {}, get: () => undefined },
  } as never;
}

async function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function diagnostic(overrides: Partial<LspDiagnostic> = {}): LspDiagnostic {
  return { severity: 1, message: "boom", line: 1, character: 1, ...overrides };
}

function entry(server: string, diagnostics: LspDiagnostic[], publishedAt = 1): LspFileDiagnostics {
  return { server, diagnostics, publishedAt };
}

function call(tool: { call: (input: never, context: never) => Promise<unknown> }, input: object) {
  return tool.call(input as never, context()) as Promise<{ data: string }>;
}

beforeAll(async () => {
  initializeLspServerManager();
  await waitForInitialization();
  manager = getLspServerManager()!;
  expect(manager).toBeDefined();
});

afterAll(async () => {
  await shutdownLspServerManager();
  if (savedDataDir === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
  else process.env.DEEPSEEK_CODE_DATA_DIR = savedDataDir;
  if (savedLog === undefined) delete process.env.FAKE_LSP_LOG;
  else process.env.FAKE_LSP_LOG = savedLog;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("collecting what a server publishes", () => {
  test("a publish is stored against its file, in 1-based coordinates", async () => {
    const path = fileFor("collected.ts");
    await manager.openFile(path, "const ok = 1;\nconst BROKEN = 2;\n");

    await waitFor(() => manager.getDiagnostics(path).length > 0);

    const [reported] = manager.getDiagnostics(path);
    expect(reported?.server).toBe("typescript");
    expect(reported?.diagnostics).toHaveLength(1);

    const found = reported!.diagnostics[0]!;
    // The fixture reports the second line, 0-based column 6 — the wire's
    // coordinates, not the ones an editor (or the model) reads.
    expect(found.line).toBe(2);
    expect(found.character).toBe(7);
    expect(found.severity).toBe(1);
    expect(found.source).toBe("fake-lsp");
    expect(found.code).toBe(9001);
  });

  test("a later clean publish replaces the findings rather than adding to them", async () => {
    const path = fileFor("cleaned.ts");
    await manager.openFile(path, "const BROKEN = 1;\n");
    await waitFor(() => (manager.getDiagnostics(path)[0]?.diagnostics.length ?? 0) > 0);

    await manager.changeFile(path, "const fine = 1;\n");
    await waitFor(() => manager.getDiagnostics(path)[0]?.diagnostics.length === 0);

    // The entry stays — it is the clock a later comparison reads — but it
    // carries nothing, which is what a fixed file looks like.
    expect(manager.getDiagnostics(path)[0]?.diagnostics).toEqual([]);
  });

  test("waiting for a fresh publish gives up rather than hanging", async () => {
    const path = fileFor("quiet.ts");
    await manager.openFile(path, "const quiet = 1;\n");
    await waitFor(() => manager.getDiagnostics(path).length > 0);

    // Nothing changes, so nothing is published: the budget is the ceiling.
    const started = Date.now();
    const fresh = await manager.waitForDiagnostics(path, {
      afterMs: Date.now(),
      timeoutMs: 150,
    });
    expect(fresh).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("the diff between two publishes", () => {
  test("keeps only what is new, per server", () => {
    const before = [
      entry("typescript", [diagnostic({ message: "old", line: 3 })]),
      entry("eslint", [diagnostic({ message: "lint", line: 9 })]),
    ];
    const after = [
      entry("typescript", [
        diagnostic({ message: "old", line: 3 }),
        diagnostic({ message: "new", line: 4 }),
      ]),
      entry("eslint", [diagnostic({ message: "lint", line: 9 })]),
      entry("other", [diagnostic({ message: "from elsewhere", line: 1 })]),
    ];

    expect(newDiagnostics(before, after).map((f) => f.diagnostic.message)).toEqual([
      "new",
      "from elsewhere",
    ]);
  });

  test("an identical message on another server is not the same finding", () => {
    const before = [entry("typescript", [diagnostic({ message: "same" })])];
    const after = [entry("eslint", [diagnostic({ message: "same" })])];
    expect(newDiagnostics(before, after)).toHaveLength(1);
  });

  test("nothing new renders as nothing at all", () => {
    // A "no new problems" line on every edit is a line the reader learns to
    // skip, which is how the one that matters gets skipped too.
    expect(formatNewDiagnostics([])).toBeNull();
  });

  test("findings are wrapped in a marker and capped with a stated remainder", () => {
    const many: ServerDiagnostic[] = Array.from({ length: 40 }, (_, i) => ({
      server: "typescript",
      diagnostic: diagnostic({ message: `problem number ${i}`, line: i + 1 }),
    }));

    const capped = formatNewDiagnostics(many, 600)!;
    expect(capped.startsWith("<new-diagnostics>")).toBe(true);
    expect(capped.endsWith("</new-diagnostics>")).toBe(true);
    expect(capped).toContain("40 new problems after your edit:");
    expect(capped).toContain("dropped to fit");
    expect(capped.length).toBeLessThanOrEqual(600);
    expect(capped).not.toContain("problem number 39");

    const uncapped = formatNewDiagnostics(many)!;
    expect(uncapped).toContain("problem number 39");
    expect(uncapped).not.toContain("dropped");
  });

  test("a single finding longer than the whole budget is still reported", () => {
    const huge: ServerDiagnostic[] = [
      { server: "typescript", diagnostic: diagnostic({ message: "x".repeat(5_000) }) },
    ];
    const rendered = formatNewDiagnostics(huge, 200)!;
    // Truncated, but present: an error that exists beats one that vanished
    // because it did not fit the box.
    expect(rendered).toContain("<new-diagnostics>");
    expect(rendered.length).toBeLessThanOrEqual(200);
  });

  test("a clean file answers plainly", () => {
    expect(formatDiagnosticsReport([], "src/app.ts")).toBe(
      "No problems reported for src/app.ts.",
    );
    const one = formatDiagnosticsReport(
      [{ server: "typescript", diagnostic: diagnostic({ message: "boom", line: 2, character: 5 }) }],
      "src/app.ts",
    );
    expect(one).toContain("src/app.ts: 1 problem");
    expect(one).toContain("2:5 error: boom (typescript)");
  });
});

describe("an edit that breaks the file", () => {
  test("hands the model what the edit broke, and only that", async () => {
    const path = fileFor("regression.ts");
    // One problem already there, one introduced by the edit. Only the second
    // belongs in the tool result; the first was the model's starting point.
    const before = "const BROKEN_ALREADY = 1;\nconst value = 2;\n";
    writeFileSync(path, before);

    await manager.openFile(path, before);
    await waitFor(() => manager.getDiagnostics(path).length > 0);

    const result = await call(FileEditTool, {
      file_path: path,
      old_string: "const value = 2;",
      new_string: "const value = BROKEN;\nconst other = 3;",
    });

    expect(result.data).toContain("<new-diagnostics>");
    expect(result.data).toContain("1 new problem after your edit:");
    expect(result.data).toContain("other = 3");

    // The pre-existing one is not news. Scoped to the block, because the diff
    // preview above it quotes the whole edit, old line included.
    const block = result.data.slice(result.data.indexOf("<new-diagnostics>"));
    expect(block).toContain("2:15 error");
    expect(block).not.toContain("1:7");
  });

  test("an edit that breaks nothing adds no diagnostics block", async () => {
    const path = fileFor("clean-edit.ts");
    const before = "const a = 1;\nconst b = 2;\n";
    writeFileSync(path, before);

    await manager.openFile(path, before);
    await waitFor(() => manager.getDiagnostics(path).length > 0);

    const result = await call(FileEditTool, {
      file_path: path,
      old_string: "const b = 2;",
      new_string: "const b = 3;",
    });

    expect(result.data).toContain("Diff preview:");
    expect(result.data).not.toContain("<new-diagnostics>");
  });

  test("a Write that breaks the file reports it too", async () => {
    const path = fileFor("write-regression.ts");
    const before = "const c = 1;\n";
    writeFileSync(path, before);

    await manager.openFile(path, before);
    await waitFor(() => manager.getDiagnostics(path).length > 0);

    const result = await call(FileWriteTool, {
      file_path: path,
      content: "const c = 1;\nconst BROKEN_WRITE = 2;\n",
    });

    expect(result.data).toContain("<new-diagnostics>");
    expect(result.data).toContain("BROKEN_WRITE");
  });

  test("a file no server is running for is left alone", async () => {
    // Nothing must start a language server just to have something to report:
    // the diagnostics loop rides on a server the user already turned on.
    const path = fileFor("no-server.log");
    writeFileSync(path, "plain\n");

    const result = await call(FileWriteTool, { file_path: path, content: "plain\nmore\n" });
    expect(result.data).not.toContain("<new-diagnostics>");
  });
});

describe("asking for diagnostics directly", () => {
  test("reports the file's problems, pre-existing ones included", async () => {
    const tool = buildLSPTool(manager);
    const path = fileFor("asked.ts");
    await manager.openFile(path, "const fine = 1;\nconst BROKEN = 2;\n");
    await waitFor(() => manager.getDiagnostics(path).length > 0);

    const result = (await tool.call(
      { operation: "diagnostics", filePath: path },
      context(),
    )) as { data: { result: string; resultCount: number; operation: string } };

    expect(result.data.operation).toBe("diagnostics");
    expect(result.data.resultCount).toBe(1);
    expect(result.data.result).toContain("asked.ts: 1 problem");
    expect(result.data.result).toContain("fake: BROKEN on this line");
    // A query is not an edit: what was already wrong is exactly the answer.
    expect(result.data.result).toContain("2:7 error");
  });

  test("says so plainly when the server reports nothing", async () => {
    const tool = buildLSPTool(manager);
    const path = fileFor("asked-clean.ts");
    await manager.openFile(path, "const fine = 1;\n");
    await waitFor(() => manager.getDiagnostics(path).length > 0);

    const result = (await tool.call(
      { operation: "diagnostics", filePath: path },
      context(),
    )) as { data: { result: string; resultCount: number } };

    expect(result.data.resultCount).toBe(0);
    expect(result.data.result).toBe(`No problems reported for ${path}.`);
  });

  test("an operation that needs a position asks for one instead of guessing", async () => {
    const tool = buildLSPTool(manager);
    const result = (await tool.call(
      { operation: "hover", filePath: fileFor("asked-clean.ts") },
      context(),
    )) as { data: { result: string; resultCount?: number } };

    expect(result.data.result).toContain("needs a line and character");
    expect(result.data.resultCount).toBeUndefined();
  });
});
