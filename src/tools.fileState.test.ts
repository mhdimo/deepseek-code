/**
 * Read before write, end to end through the real tool wrapper.
 *
 * The decisions live in `services/readState.ts` and are unit-tested there;
 * what these tests pin is that the wrapper *asks*, that the tools *record*,
 * and that the two agree about which file is which — the parts that fail
 * silently. The evidence for "the guard ran" is behavioural, not textual: the
 * prompt counts its calls, so a call that never reached the prompt was
 * refused ahead of it, and a call that landed was not refused at all.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getOrCreateMemorySession } from "./services/agent/agentSession.js";
import { toolsToBindingFormat } from "./tools.js";
import { FileReadTool } from "./tools/FileReadTool/FileReadTool.js";
import { FileWriteTool } from "./tools/FileWriteTool/FileWriteTool.js";
import { FileEditTool } from "./tools/FileEditTool/FileEditTool.js";
import { EDIT_MESSAGES } from "./services/readState.js";
import type { Tool, ToolUseContext } from "./Tool.js";
import type { AgentConfig } from "./types/index.js";

const CODE_AGENT: AgentConfig = {
  name: "code",
  displayName: "Code",
  description: "",
  systemPrompt: "",
  maxSteps: 5,
  permissions: { allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: false },
};

const sandbox = mkdtempSync(join(tmpdir(), "file-state-"));
let n = 0;

const providerConfig = {
  type: "deepseek",
  model: "deepseek-chat",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "test-key",
} as never;

/** How many times the user was asked. Zero is a claim these tests make: a
 *  refusal that came from the guard never reached the prompt. */
let prompts = 0;

beforeEach(() => {
  prompts = 0;
  // A settings dir of its own per test, so a rule on the machine running the
  // suite cannot reach these assertions.
  const dir = join(sandbox, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ schemaVersion: 2 }, null, 2));
  process.env.DEEPSEEK_CODE_DATA_DIR = dir;
});

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

/** A session of its own for every test: the read state is per session, which
 *  is half of what is being tested here. */
async function session(): Promise<ToolUseContext> {
  const { context } = await getOrCreateMemorySession({
    providerConfig,
    agentConfig: CODE_AGENT,
    workingDir: sandbox,
    memoryDir: join(sandbox, `m${n++}`),
    maxContextTokens: 100_000,
    requestPermission: async () => {
      prompts++;
      return { approved: true };
    },
  });
  return context;
}

/** Drive the real wrapper, which is the layer that consults the guard. */
async function run(
  context: ToolUseContext,
  tool: Tool,
  input: Record<string, unknown>,
): Promise<string> {
  const def = toolsToBindingFormat([tool], context).find((d) => d.name === tool.name)!;
  return String(await def.execute(input));
}

const file = (name: string) => join(sandbox, name);

/** Make the file look modified after it was read, whatever the filesystem's
 *  timestamp granularity happens to be. */
function touchLater(path: string, ms = 10_000): void {
  const later = new Date(Date.now() + ms);
  utimesSync(path, later, later);
}

describe("Edit", () => {
  test("a file nobody read is refused, before the user is asked anything", async () => {
    const context = await session();
    const target = file("unread.txt");
    writeFileSync(target, "original\n");

    const result = await run(context, FileEditTool, {
      file_path: target,
      old_string: "original",
      new_string: "changed",
    });

    expect(result).toBe(EDIT_MESSAGES.unread);
    expect(prompts).toBe(0);
    expect(readFileSync(target, "utf-8")).toBe("original\n");
  });

  test("a file the model read is editable", async () => {
    const context = await session();
    const target = file("read-then-edit.txt");
    writeFileSync(target, "original\n");

    await run(context, FileReadTool, { file_path: target });
    const result = await run(context, FileEditTool, {
      file_path: target,
      old_string: "original",
      new_string: "changed",
    });

    expect(result).toContain("Edited ");
    expect(readFileSync(target, "utf-8")).toBe("changed\n");
  });

  test("an edit counts as having seen the file — no re-read between edits", async () => {
    // Otherwise the model would have to re-read after every edit it makes,
    // which is both a wasted step and a step the reference does not require.
    const context = await session();
    const target = file("two-edits.txt");
    writeFileSync(target, "one\n");

    await run(context, FileReadTool, { file_path: target });
    await run(context, FileEditTool, { file_path: target, old_string: "one", new_string: "two" });
    const second = await run(context, FileEditTool, {
      file_path: target,
      old_string: "two",
      new_string: "three",
    });

    expect(second).toContain("Edited ");
    expect(readFileSync(target, "utf-8")).toBe("three\n");
  });

  test("a file that changed outside the session is refused until it is re-read", async () => {
    const context = await session();
    const target = file("stale.txt");
    writeFileSync(target, "original\n");

    await run(context, FileReadTool, { file_path: target });
    // Someone else — the user, a formatter, another process — rewrote it.
    writeFileSync(target, "rewritten\n");

    const refused = await run(context, FileEditTool, {
      file_path: target,
      old_string: "rewritten",
      new_string: "changed",
    });
    expect(refused).toBe(EDIT_MESSAGES.stale);
    expect(readFileSync(target, "utf-8")).toBe("rewritten\n");

    await run(context, FileReadTool, { file_path: target });
    const allowed = await run(context, FileEditTool, {
      file_path: target,
      old_string: "rewritten",
      new_string: "changed",
    });
    expect(allowed).toContain("Edited ");
  });

  test("a touched-but-unchanged file is not treated as modified", async () => {
    // The mtime moved and the bytes did not: a formatter, a sync client, a
    // `touch`. Sending the model back for a re-read it does not need is a
    // cost with nothing behind it, so the check is on the content.
    const context = await session();
    const target = file("touched.txt");
    writeFileSync(target, "original\n");

    await run(context, FileReadTool, { file_path: target });
    touchLater(target);

    const result = await run(context, FileEditTool, {
      file_path: target,
      old_string: "original",
      new_string: "changed",
    });
    expect(result).toContain("Edited ");
  });

  test("a ranged read is not a read", async () => {
    // The model saw a window of the file, so it cannot know what it is
    // rewriting around it.
    const context = await session();
    const target = file("ranged.txt");
    writeFileSync(target, "a\nb\nc\nd\ne\n");

    await run(context, FileReadTool, { file_path: target, offset: 2, limit: 2 });
    const result = await run(context, FileEditTool, {
      file_path: target,
      old_string: "b",
      new_string: "B",
    });

    expect(result).toBe(EDIT_MESSAGES.partial);
    expect(readFileSync(target, "utf-8")).toBe("a\nb\nc\nd\ne\n");
  });

  test("an edit with nothing to change is refused rather than reported as done", async () => {
    const context = await session();
    const target = file("unchanged.txt");
    writeFileSync(target, "original\n");

    await run(context, FileReadTool, { file_path: target });
    const result = await run(context, FileEditTool, {
      file_path: target,
      old_string: "original",
      new_string: "original",
    });

    // This used to rewrite the file byte-for-byte and answer "Edited", which
    // the model reads as work done — and then reasons on from.
    expect(result).toBe(EDIT_MESSAGES.unchanged);
    expect(prompts).toBe(0);
  });

  test("editing a file that is not there says so, rather than blaming the match", async () => {
    const context = await session();

    const result = await run(context, FileEditTool, {
      file_path: file("never-existed.txt"),
      old_string: "anything",
      new_string: "something",
    });

    expect(result).toBe(EDIT_MESSAGES.missing);
  });
});

describe("Write", () => {
  test("a new file needs no read", async () => {
    const context = await session();
    const target = file("created.txt");

    const result = await run(context, FileWriteTool, { file_path: target, content: "hello\n" });

    expect(result).toContain("Wrote ");
    expect(readFileSync(target, "utf-8")).toBe("hello\n");
  });

  test("overwriting a file nobody read is refused", async () => {
    const context = await session();
    const target = file("overwrite-unread.txt");
    writeFileSync(target, "the only copy\n");

    const result = await run(context, FileWriteTool, { file_path: target, content: "gone\n" });

    expect(result).toBe(EDIT_MESSAGES.unread);
    expect(readFileSync(target, "utf-8")).toBe("the only copy\n");
  });

  test("overwriting a file the model read is allowed", async () => {
    const context = await session();
    const target = file("overwrite-read.txt");
    writeFileSync(target, "before\n");

    await run(context, FileReadTool, { file_path: target });
    const result = await run(context, FileWriteTool, { file_path: target, content: "after\n" });

    expect(result).toContain("Wrote ");
    expect(readFileSync(target, "utf-8")).toBe("after\n");
  });

  test("a file that changed since the read is refused even for a Write", async () => {
    // Write has no content to fall back on — what it is about to install has
    // nothing to do with what was read — so the mtime is all there is, and it
    // is why this one is still compared against the clock.
    const context = await session();
    const target = file("overwrite-stale.txt");
    writeFileSync(target, "as read\n");

    await run(context, FileReadTool, { file_path: target });
    touchLater(target);

    const result = await run(context, FileWriteTool, { file_path: target, content: "mine\n" });

    expect(result).toBe(EDIT_MESSAGES.stale);
    expect(readFileSync(target, "utf-8")).toBe("as read\n");
  });

  test("a file written this turn can be written again", async () => {
    // Which is what makes the recorded timestamp matter: Write has no content
    // to compare, so a record that kept the *old* mtime would refuse the very
    // next Write the model makes.
    const context = await session();
    const target = file("written-twice.txt");

    await run(context, FileWriteTool, { file_path: target, content: "one\n" });
    const second = await run(context, FileWriteTool, { file_path: target, content: "two\n" });

    expect(second).toContain("Wrote ");
    expect(readFileSync(target, "utf-8")).toBe("two\n");
  });

  test("a file written this turn can be edited without a re-read", async () => {
    // The registry has to move with the file: a Write the model just made is
    // not a file it has never seen.
    const context = await session();
    const target = file("written-then-edited.txt");

    await run(context, FileWriteTool, { file_path: target, content: "first\n" });
    const result = await run(context, FileEditTool, {
      file_path: target,
      old_string: "first",
      new_string: "second",
    });

    expect(result).toContain("Edited ");
    expect(readFileSync(target, "utf-8")).toBe("second\n");
  });
});

describe("the read state belongs to the session", () => {
  test("a new session does not inherit the last one's reads", async () => {
    // A read from a previous conversation is not evidence about this one, and
    // the guard is the only thing that would notice.
    const target = file("across-sessions.txt");
    writeFileSync(target, "original\n");

    const first = await session();
    await run(first, FileReadTool, { file_path: target });

    const second = await session();
    const result = await run(second, FileEditTool, {
      file_path: target,
      old_string: "original",
      new_string: "changed",
    });

    expect(result).toBe(EDIT_MESSAGES.unread);
  });
});
