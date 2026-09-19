/**
 * What the language server is told when the agent rewrites a file.
 *
 * `changeFile` was written with the LSP client and then never called from
 * anywhere, so a server that had been handed a file kept its own copy of the
 * old text for the life of the process: every definition, reference and hover
 * it answered afterwards was computed against a file that no longer existed,
 * and delivered with the server's full confidence.
 *
 * The server here is a real subprocess (`tests/fixtures/fakeLspServer.ts`)
 * because the facts under test are wire facts — which notification is sent,
 * and what `version` it carries — and a stubbed client can only confirm what
 * the manager believes it sent. The fixture appends every notification to a
 * JSONL log, which is what these assertions read.
 *
 * The version is not incidental. LSP requires it to increase per change, and
 * the old code sent a literal `1` forever: a server that has seen version 1
 * may ignore a second state that also claims to be version 1, which leaves the
 * buffer stale while every call appears to succeed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-lsp-sync-"));
const dataDir = join(sandbox, "data");
const workDir = join(sandbox, "work");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const logPath = join(sandbox, "lsp.log");
const fixture = join(import.meta.dir, "../fixtures/fakeLspServer.ts");

// Read at module load by `state/storage.ts`, so they have to be in place
// before the manager is imported — hence the dynamic imports below.
const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
const savedLog = process.env.FAKE_LSP_LOG;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;
process.env.FAKE_LSP_LOG = logPath;

writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({
    schemaVersion: 3,
    lsp: {
      servers: {
        // Two servers, and only ever one of them is used. The second is what
        // makes "does not start a server" a claim this suite can check: a
        // language with a configured server that was never opened is exactly
        // the case an edit must not spawn.
        typescript: [process.execPath, [fixture]],
        python: [process.execPath, [fixture]],
      },
    },
  }),
);

const {
  getLspServerManager,
  initializeLspServerManager,
  shutdownLspServerManager,
  waitForInitialization,
} = await import("../../src/services/lsp/manager.js");
const { FileEditTool } = await import("../../src/tools/FileEditTool/FileEditTool.js");
const { FileWriteTool } = await import("../../src/tools/FileWriteTool/FileWriteTool.js");

interface LoggedEvent {
  event: string;
  uri?: string;
  version?: number;
  text?: string;
}

function events(): LoggedEvent[] {
  try {
    return readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LoggedEvent);
  } catch {
    return [];
  }
}

function eventsFor(path: string): LoggedEvent[] {
  return events().filter((e) => e.uri?.endsWith(path));
}

/** The server reads its stdin asynchronously, so the log trails the call. */
async function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fileFor(name: string): string {
  return join(workDir, name);
}

function context() {
  return {
    workingDir: workDir,
    readFileState: { record: () => {}, get: () => undefined },
  } as never;
}

let manager: NonNullable<ReturnType<typeof getLspServerManager>>;

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

describe("an edit to an open document", () => {
  test("is sent as a change, with a version the server has not seen", async () => {
    const path = fileFor("version.ts");
    const first = "const a = 1;\n";
    const second = "const a = 2;\n";

    await manager.openFile(path, first);
    await waitFor(() => eventsFor("version.ts").length >= 1);
    await manager.changeFile(path, second);
    await waitFor(() => eventsFor("version.ts").length >= 2);

    const seen = eventsFor("version.ts");
    expect(seen.map((e) => e.event)).toEqual(["didOpen", "didChange"]);
    expect(seen[0]!.version).toBe(1);
    expect(seen[1]!.version).toBe(2);
    // The text, not just the notification: what makes a stale buffer wrong.
    expect(seen[1]!.text).toBe(second);
  });

  test("a second open of the same file carries the new text as a change", async () => {
    // `openFile` used to return early when the document was already open —
    // correct as a guard against a duplicate didOpen, but it dropped the
    // content the caller was handing it, so a file could be "opened" any
    // number of times and the server would never see past the first text.
    const path = fileFor("reopen.ts");
    const first = "const b = 1;\n";
    const second = "const b = 2;\n";

    await manager.openFile(path, first);
    await waitFor(() => eventsFor("reopen.ts").length >= 1);
    await manager.openFile(path, second);
    await waitFor(() => eventsFor("reopen.ts").length >= 2);

    const seen = eventsFor("reopen.ts");
    expect(seen.map((e) => e.event)).toEqual(["didOpen", "didChange"]);
    expect(seen[1]!.version).toBe(2);
    expect(seen[1]!.text).toBe(second);
  });

  test("versions keep climbing across many edits", async () => {
    const path = fileFor("many.ts");
    await manager.openFile(path, "const c = 0;\n");
    await waitFor(() => eventsFor("many.ts").length >= 1);

    for (let i = 1; i <= 3; i++) {
      await manager.changeFile(path, `const c = ${i};\n`);
      await waitFor(() => eventsFor("many.ts").length >= i + 1);
    }

    expect(eventsFor("many.ts").map((e) => e.version)).toEqual([1, 2, 3, 4]);
  });
});

describe("a file whose language has no running server", () => {
  test("is not synced, and does not start one", async () => {
    // The whole reason `changeFile` must not fall back to `openFile`: every
    // Write in a session would otherwise be able to spawn a language server
    // for a feature the user never turned on.
    const python = manager.getAllServers().get("python")!;
    expect(python.state).toBe("stopped");

    await manager.changeFile(fileFor("untouched.py"), "print('hi')\n");
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(python.state).toBe("stopped");
    expect(eventsFor("untouched.py")).toEqual([]);
  });
});

describe("the file tools", () => {
  test("tell a running server what an Edit left behind", async () => {
    const path = fileFor("edited.ts");
    const before = "const d = 1;\n";
    writeFileSync(path, before);

    // Open it the way the LSP tool would, so the edit is a change and not an
    // open — the case where a stale buffer actually bites.
    await manager.openFile(path, before);
    await waitFor(() => eventsFor("edited.ts").length >= 1);

    const after = "const d = 2;\n";
    await FileEditTool.call(
      { file_path: path, old_string: "const d = 1;", new_string: "const d = 2;" },
      context(),
    );
    await waitFor(() => eventsFor("edited.ts").length >= 2);

    // The last, not the second: taking the diagnostics baseline just before
    // the write can put a didChange of its own on the wire, and what matters
    // either way is where the server ends up.
    const seen = eventsFor("edited.ts");
    const last = seen[seen.length - 1]!;
    expect(last.event).toBe("didChange");
    expect(last.text).toBe(after);
  });

  test("tell a running server what a Write left behind", async () => {
    const path = fileFor("written.ts");
    const before = "const e = 1;\n";
    writeFileSync(path, before);

    await manager.openFile(path, before);
    await waitFor(() => eventsFor("written.ts").length >= 1);

    const after = "const e = 2;\nconst f = 3;\n";
    await FileWriteTool.call({ file_path: path, content: after }, context());
    await waitFor(() => eventsFor("written.ts").length >= 2);

    const seen = eventsFor("written.ts");
    const last = seen[seen.length - 1]!;
    expect(last.event).toBe("didChange");
    expect(last.text).toBe(after);
  });
});
