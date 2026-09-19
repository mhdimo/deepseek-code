/**
 * /compact used to be a string operation wearing a summary's name: it glued
 * together the first 200 characters of the last eight user prompts, called the
 * result "42 messages summarized", and replaced the whole conversation with it
 * — including the copy on disk, since the same list is what gets persisted.
 *
 * The transcript handed to the model is the thing compaction is *for*, so
 * these tests are mostly about what survives that trip: tool results (where a
 * coding session keeps its facts), the goal at the top, the current state at
 * the bottom, and a failure path that leaves everything alone.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as readSource } from "node:fs";
import {
  CompactionFailed,
  MAX_TRANSCRIPT_CHARS,
  compactionNotice,
  normalizeSummary,
  renderMessage,
  renderTranscript,
  summarizeConversation,
} from "./compaction.js";
import type { Message } from "../types/index.js";

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });

describe("renderMessage", () => {
  test("keeps the role, the text and the tool call", () => {
    const out = renderMessage({
      role: "assistant",
      content: "Reading the config",
      toolUse: [{ toolName: "Read", input: '{"file_path":"/a/b.ts"}', output: "export const x = 1;" }],
    });
    expect(out).toContain("assistant:");
    expect(out).toContain("Reading the config");
    expect(out).toContain("[tool Read");
    expect(out).toContain("/a/b.ts");
    expect(out).toContain("[result] export const x = 1;");
  });

  test("a failed tool call is a fact, not a blank", () => {
    const out = renderMessage({
      role: "assistant",
      content: "",
      toolUse: [{ toolName: "Bash", input: '{"command":"bun test"}', output: "2 fail", status: "error" }],
    });
    expect(out).toContain("[the tool call error]");
  });

  test("a message with nothing in it renders as nothing", () => {
    expect(renderMessage(assistant(""))).toBe("");
    expect(renderMessage({ role: "assistant", content: "   ", toolUse: [] })).toBe("");
  });
});

describe("renderTranscript", () => {
  test("keeps both sides and their order", () => {
    const text = renderTranscript([user("fix the parser"), assistant("which one?")]);
    expect(text.indexOf("fix the parser")).toBeLessThan(text.indexOf("which one?"));
    expect(text).toContain("user:");
    expect(text).toContain("assistant:");
  });

  test("empty messages do not become blank turns", () => {
    const text = renderTranscript([user("hello"), assistant(""), user("again")]);
    expect(text).not.toContain("assistant:");
    expect(text).toContain("hello");
    expect(text).toContain("again");
  });

  test("nothing to say renders as nothing", () => {
    expect(renderTranscript([])).toBe("");
    expect(renderTranscript([assistant("")])).toBe("");
  });

  test("a long conversation keeps its head and its tail, and says what it dropped", () => {
    // The goal is stated first and the current state last; those are the two
    // ends a successor actually needs. Cutting the middle is the trade.
    const messages: Message[] = [user("GOAL: make the whale sing")];
    for (let i = 0; i < 400; i++) {
      messages.push(assistant(`filler ${i} `.repeat(60)));
    }
    messages.push(assistant("STATE: the song is half written"));

    const text = renderTranscript(messages, 20_000);

    expect(text.length).toBeLessThan(20_000 + 1_000);
    expect(text).toContain("GOAL: make the whale sing");
    expect(text).toContain("STATE: the song is half written");
    expect(text).toMatch(/\[\S+ \d+ messages \(\d+ characters\) omitted/);
    // The middle really is gone, not merely claimed to be.
    expect(text).not.toContain("filler 200 ");
  });

  test("a transcript under the cap is passed through whole", () => {
    const messages = [user("a"), assistant("b"), user("c")];
    const text = renderTranscript(messages, MAX_TRANSCRIPT_CHARS);
    expect(text).not.toContain("omitted");
    expect(text).toContain("a");
    expect(text).toContain("c");
  });
});

describe("normalizeSummary", () => {
  test("trims and accepts a real summary", () => {
    const raw = "  ## Goal\nMake the whale sing without waking the neighbours.  ";
    expect(normalizeSummary(raw)).toBe(
      "## Goal\nMake the whale sing without waking the neighbours.",
    );
  });

  test("an empty or stub answer is a failure, not a summary", () => {
    expect(normalizeSummary("")).toBeNull();
    expect(normalizeSummary("   \n  ")).toBeNull();
    expect(normalizeSummary(undefined)).toBeNull();
    expect(normalizeSummary(null)).toBeNull();
    expect(normalizeSummary("OK")).toBeNull();
  });
});

describe("compactionNotice", () => {
  test("names the count and points at the archive", () => {
    const notice = compactionNotice({ summarized: 42, archivedTo: "/tmp/x.md" });
    expect(notice).toContain("42 messages");
    expect(notice).toContain("/tmp/x.md");
  });

  test("says nothing about an archive that does not exist", () => {
    expect(compactionNotice({ summarized: 3 })).not.toContain("archived at");
  });
});

/**
 * Against a real (local) provider, because the interesting half of compaction
 * happens at the engine boundary: the transcript goes out, a summary comes
 * back, and the numbers the cost report uses come from the response. The
 * provider takes a baseUrl override, so this is the actual addon talking to
 * an OpenAI-compatible endpoint — no mock of the thing under test.
 */
describe("summarizeConversation against a provider", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let requests: Array<{ url: string; body: any }> = [];

  function serve(handler: (body: any) => Response): string {
    requests = [];
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        requests.push({ url: req.url, body });
        return handler(body);
      },
    });
    return `http://localhost:${server.port}`;
  }

  const completion = (content: string) =>
    new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "deepseek-chat",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      }),
      { headers: { "content-type": "application/json" } },
    );

  afterEach(() => {
    server?.stop(true);
    server = null;
    requests = [];
  });

  test("the transcript goes to the model and the summary comes back", async () => {
    const baseURL = serve(() =>
      completion("## Goal\nMake the whale sing.\n\n## Next\nTune the larynx."),
    );

    const result = await summarizeConversation({
      providerConfig: { type: "deepseek", apiKey: "test", baseURL, model: "deepseek-chat" },
      messages: [
        user("the whale must sing in B flat"),
        {
          role: "assistant",
          content: "Reading the larynx",
          toolUse: [{ toolName: "Read", input: '{"file_path":"/w/larynx.ts"}', output: "export const pitch = 'B♭';" }],
        },
      ],
    });

    expect(result.summary).toContain("## Goal");
    expect(result.attempts).toBe(1);
    expect(result.summarized).toBe(2);
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 40, totalTokens: 160 });

    // What the model was actually asked, and with what instructions.
    expect(requests.length).toBe(1);
    const sent = requests[0]!.body;
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toContain("You summarize an in-progress coding session");
    expect(sent.messages[1].content).toContain("the whale must sing in B flat");
    expect(sent.messages[1].content).toContain("[tool Read");
    expect(sent.messages[1].content).toContain("export const pitch = 'B♭';");
  });

  test("a summary of nothing is retried, then given up on", async () => {
    const baseURL = serve(() => completion("   "));

    const err = await summarizeConversation({
      providerConfig: { type: "deepseek", apiKey: "test", baseURL, model: "deepseek-chat" },
      messages: [user("summarize this properly, please")],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(CompactionFailed);
    expect((err as CompactionFailed).attempts).toBe(3);
    expect(requests.length).toBe(3);
    // The failure text is what the user is shown, so it has to say the
    // conversation survived.
    expect((err as CompactionFailed).message).toContain("unchanged");
  });

  test("a provider that refuses gives up without a summary", async () => {
    const baseURL = serve(() => new Response("nope", { status: 500 }));

    const err = await summarizeConversation({
      providerConfig: { type: "deepseek", apiKey: "test", baseURL, model: "deepseek-chat" },
      messages: [user("summarize this too")],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(CompactionFailed);
    expect(requests.length).toBe(3);
  });
});

describe("summarizeConversation", () => {
  test("refuses to call the model when there is nothing to summarize", async () => {
    // No network, no key, no model: this must fail before the API is reached.
    const err = await summarizeConversation({
      providerConfig: { type: "deepseek", apiKey: "unused", model: "deepseek-chat" },
      messages: [assistant("")],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CompactionFailed);
    expect((err as CompactionFailed).attempts).toBe(0);
  });

  test("an aborted signal stops before any attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await summarizeConversation({
      providerConfig: { type: "deepseek", apiKey: "unused", model: "deepseek-chat" },
      messages: [user("summarize me, but not really")],
      signal: controller.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CompactionFailed);
    expect((err as CompactionFailed).message).toContain("cancelled");
  });
});

describe("archiveTranscript", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("writes the transcript somewhere it can be read again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-archive-"));
    made.push(dir);
    const { archiveTranscript } = await import("./compaction.js");

    const path = await archiveTranscript({
      messages: [user("the goal"), assistant("the answer")],
      dir,
      now: 1_700_000_000_000,
    });

    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(dir)).toBe(true);
    const body = readFileSync(path, "utf-8");
    expect(body).toContain("the goal");
    expect(body).toContain("the answer");
  });

  test("an archive is dated, so two compactions do not overwrite each other", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-archive-"));
    made.push(dir);
    const { archiveTranscript } = await import("./compaction.js");
    const a = await archiveTranscript({ messages: [user("one")], dir, now: 1_700_000_000_000 });
    const b = await archiveTranscript({ messages: [user("two")], dir, now: 1_700_000_001_000 });
    expect(a).not.toBe(b);
  });
});

/**
 * The wiring, because the defect was a decision about *what to do with the
 * transcript* — no unit test of the summarizer can see whether the result was
 * then thrown away.
 */
describe("wiring", () => {
  const app = readSource(join(import.meta.dir, "../components/App.tsx"), "utf8");

  test("/compact asks the model", () => {
    expect(app).toContain("await summarizeConversation({");
    // …and the fabricated banner is gone for good.
    expect(app).not.toContain("messages summarized]");
    expect(app).not.toContain("Topics discussed: ");
  });

  test("the summary is something the model will actually read", () => {
    // agentSession replays history as user/assistant turns only. A summary
    // stored as a `system` row is a summary nobody sees — which is exactly
    // what the old code did.
    const summaryBlock = app.slice(app.indexOf("const result = await summarizeConversation("));
    expect(summaryBlock).toContain('role: "user"');
    expect(summaryBlock).toContain("compaction: { summarized: result.summarized, archivedTo }");
    const agentSession = readSource(
      join(import.meta.dir, "./agent/agentSession.ts"),
      "utf8",
    );
    expect(agentSession).toContain('if (msg.role === "user")');
  });

  test("a failed compaction leaves the conversation alone", () => {
    // The throw has to be caught, and the catch must not touch `messages`.
    const start = app.indexOf("const compactController = new AbortController();");
    expect(start).toBeGreaterThan(-1);
    const compactCase = app.slice(start, start + 4000);
    const catchIdx = compactCase.indexOf("} catch (err) {");
    expect(catchIdx).toBeGreaterThan(-1);
    const failureBranch = compactCase.slice(catchIdx, compactCase.indexOf("} finally {"));
    expect(failureBranch).toContain("pushSystem(");
    expect(failureBranch).not.toContain("setMessages(");
  });

  test("the transcript is archived before it is replaced", () => {
    expect(app).toContain("const archivedTo = await archiveTranscript({ messages: toCompact });");
    expect(app.indexOf("await archiveTranscript(")).toBeLessThan(
      app.indexOf("await summarizeConversation("),
    );
  });

  test("the stale native session is dropped, so the next turn starts from the summary", () => {
    // Scoped to this case: resetMemorySession() also appears in /clear and
    // /sessions, and a slice that runs to the end of the file would pass on
    // those alone.
    const start = app.indexOf("const compactController = new AbortController();");
    const compactCase = app.slice(start, start + 4000);
    const summaryIdx = compactCase.indexOf("const result = await summarizeConversation(");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(compactCase.indexOf("resetMemorySession();", summaryIdx)).toBeGreaterThan(-1);
    // …and it happens after the model answered, not before: dropping the
    // session first would lose the conversation if the summary then failed.
    expect(summaryIdx).toBeLessThan(
      compactCase.indexOf("resetMemorySession();", summaryIdx),
    );
  });
});
