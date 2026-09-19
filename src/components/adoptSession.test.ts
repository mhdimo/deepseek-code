/**
 * Resuming a session has to move the engine, not just the screen.
 *
 * The engine owns the conversation from the moment a session is built — it
 * holds the history and appends to it. `/resume` and the session picker used
 * to load the saved transcript into the message list and stop there, so the
 * app showed the resumed conversation while the model kept answering from the
 * one it was already in. Nothing surfaced the disagreement: the reply was
 * fluent, on-topic for the *old* conversation, and wrong.
 *
 * These tests pin the invariant that makes the two agree — adopting a
 * transcript drops the native session, so the next send rebuilds it from the
 * messages now on screen.
 */
import { describe, expect, test } from "bun:test";
import { adoptSession, type AdoptSessionTarget } from "./adoptSession.js";
import type { SessionData } from "../state/storage.js";
import type { Message } from "../types/index.js";

const SAVED: SessionData = {
  hash: "a1b2c3",
  fileHistoryId: "fh-42",
  messages: [
    { role: "user", content: "what does the parser do?", timestamp: 1000 },
    { role: "assistant", content: "It tokenises the input.", timestamp: 2000 },
    { role: "system", content: "✓ Started a new session.", timestamp: 2500 },
  ],
  tokenUsage: 4321,
  model: "deepseek-chat",
  agent: "code",
  workingDirectory: "/tmp/project",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
};

interface Recorded {
  calls: string[];
  messages: Message[] | null;
  tokens: number | null;
  hash: string | null;
  scope: string | null;
}

function target(): { ui: AdoptSessionTarget; seen: Recorded } {
  const seen: Recorded = { calls: [], messages: null, tokens: null, hash: null, scope: null };
  return {
    seen,
    ui: {
      resetEngineSession: () => seen.calls.push("resetEngineSession"),
      setMessages: (messages) => {
        seen.calls.push("setMessages");
        seen.messages = messages;
      },
      setTokenCount: (tokens) => {
        seen.calls.push("setTokenCount");
        seen.tokens = tokens;
      },
      setActiveSessionHash: (hash) => {
        seen.calls.push("setActiveSessionHash");
        seen.hash = hash;
      },
      setFileHistoryScope: (scope) => {
        seen.calls.push("setFileHistoryScope");
        seen.scope = scope;
      },
    },
  };
}

describe("adopting a saved session", () => {
  test("drops the native session the engine was answering from", () => {
    const { ui, seen } = target();
    adoptSession(SAVED, ui);

    expect(seen.calls).toContain("resetEngineSession");
    // Before the transcript is on screen, so nothing can render the resumed
    // conversation while the old one is still what the model would answer from.
    expect(seen.calls[0]).toBe("resetEngineSession");
  });

  test("adopts the saved transcript, its token count and its hash", () => {
    const { ui, seen } = target();
    adoptSession(SAVED, ui);

    expect(seen.messages?.map((m) => m.content)).toEqual([
      "what does the parser do?",
      "It tokenises the input.",
      "✓ Started a new session.",
    ]);
    expect(seen.messages?.map((m) => m.role)).toEqual(["user", "assistant", "system"]);
    expect(seen.messages?.[0]?.timestamp).toBe(1000);
    expect(seen.tokens).toBe(4321);
    expect(seen.hash).toBe("a1b2c3");
  });

  test("drops tool blocks from the saved transcript", () => {
    const { ui, seen } = target();
    adoptSession(SAVED, ui);

    // Their results are gone with the engine session they belonged to, so
    // rendering them would show tool calls nothing can trace back to a message.
    expect(seen.messages?.every((m) => Array.isArray(m.toolUse) && m.toolUse.length === 0)).toBe(true);
  });

  test("scopes /rewind to the resumed conversation", () => {
    const { ui, seen } = target();
    adoptSession(SAVED, ui);

    expect(seen.scope).toBe("fh-42");
  });

  test("falls back to the session hash for pre-scoping snapshots", () => {
    const { ui, seen } = target();
    // Sessions saved before file history was scoped carry no id; their hash is
    // stable, where a fresh scope id would orphan the snapshots they do have.
    adoptSession({ ...SAVED, fileHistoryId: undefined }, ui);

    expect(seen.scope).toBe("a1b2c3");
  });
});
