/**
 * Oversized output is paged, not fatal.
 *
 * The defect: stdout crossing 50KB SIGTERM'd (then SIGKILLed) the process
 * group, and the result said only "(output truncated at 50KB)" — a killed
 * command read as a completed one. So the assertions here are mostly about the
 * command *finishing*: it writes a marker after its verbose output, and the
 * marker has to exist. Reading back the full output from the spilled file is
 * the other half — truncating to 50KB is fine, losing the rest is not.
 *
 * `DEEPSEEK_CODE_DATA_DIR` sends the spill files to a scratch directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BashTool } from "./BashTool.js";

const sandbox = mkdtempSync(join(tmpdir(), "bashtool-output-"));
process.env.DEEPSEEK_CODE_DATA_DIR = sandbox;
const work = join(sandbox, "work");

/** 200KB of numbered lines, then a marker proving the script ran to the end. */
const VERBOSE = [
  "i=0; while [ $i -lt 4000 ]; do echo \"line $i of a long but valid command\"; i=$((i+1)); done",
  "echo FINISHED > marker.txt",
].join("; ");

async function bash(command: string, timeout = 30_000): Promise<string> {
  const context = {
    workingDir: work,
    abortController: new AbortController(),
    permissions: { allowExecute: true },
    requestPermission: async () => ({ approved: true }),
  };
  const result = await (BashTool as never as {
    call: (i: unknown, c: unknown) => Promise<{ data: unknown }>;
  }).call({ command, timeout }, context);
  return String(result.data);
}

beforeAll(() => {
  mkdirSync(work, { recursive: true });
});

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("a command whose output exceeds the inline cap", () => {
  test("runs to completion instead of being killed", async () => {
    const result = await bash(VERBOSE);

    // The whole point: the script reached its last statement.
    expect(existsSync(join(work, "marker.txt"))).toBe(true);
    expect(readFileSync(join(work, "marker.txt"), "utf-8").trim()).toBe("FINISHED");
    expect(result).toContain("line 0 of a long but valid command");
    expect(result).not.toContain("Exit code");
  });

  test("keeps the head inline and says where the rest is", async () => {
    const result = await bash(VERBOSE);
    const marker = /\[stdout truncated at 50KB; full output in ([^\]]+)\]/.exec(result);

    expect(marker).not.toBeNull();
    const spill = marker![1]!;
    expect(existsSync(spill)).toBe(true);
    // The pointer leads the result: the tool runner caps results by cutting
    // the tail, which is where a trailing note would have been lost.
    expect(result.indexOf(marker![0]!)).toBeLessThan(result.indexOf("line 0 of"));

    const full = readFileSync(spill, "utf-8");
    // Every line is in the file, including the ones past the inline cap.
    expect(full).toContain("line 0 of a long but valid command");
    expect(full).toContain("line 3999 of a long but valid command");
    expect(full.split("\n").filter(Boolean)).toHaveLength(4000);
    // And the result's own text is bounded.
    expect(result.length).toBeLessThan(60_000);
  });

  test("spills stderr to its own file", async () => {
    const command =
      "i=0; while [ $i -lt 4000 ]; do echo \"err $i of a chatty stderr stream\" >&2; i=$((i+1)); done; echo done";
    const result = await bash(command);
    const marker = /\[stderr truncated at 50KB; full output in ([^\]]+)\]/.exec(result);

    expect(marker).not.toBeNull();
    expect(result).toContain("STDERR:");
    expect(readFileSync(marker![1]!, "utf-8")).toContain("err 3999 of a chatty stderr stream");
    expect(result).toContain("done"); // stdout after the stderr flood still lands
  });
});

describe("ordinary commands are untouched", () => {
  test("small output returns verbatim, unsullied by truncation notes", async () => {
    expect(await bash("echo hello")).toBe("hello\n");
    expect(await bash("printf 'a\\nb\\n'")).toBe("a\nb\n");
  });

  test("a failing command still reports its exit code", async () => {
    const result = await bash("echo oops >&2; exit 3");
    expect(result).toContain("Exit code 3");
    expect(result).toContain("oops");
  });

  test("a timeout still kills the group", async () => {
    const result = await bash("echo started; sleep 30", 700);
    expect(result).toContain("Command timed out after 700ms");
    expect(result).toContain("started");
  });
});
