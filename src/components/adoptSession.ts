import type { SessionData } from "../state/storage.js";
import type { Message } from "../types/index.js";

/** The React state a resumed session is adopted into, plus the one thing that
 *  is not React state: the engine's own copy of the conversation. Injected so
 *  the adoption can be tested without mounting the app. */
export interface AdoptSessionTarget {
  /** Drop the native session (see below). */
  resetEngineSession: () => void;
  setMessages: (messages: Message[]) => void;
  setTokenCount: (tokens: number) => void;
  setActiveSessionHash: (hash: string) => void;
  /** Scope /rewind's file snapshots to this conversation (fileHistory). */
  setFileHistoryScope: (scope: string) => void;
}

/**
 * Switch the app to a saved session — and the engine with it.
 *
 * The engine owns the conversation the moment a session is built: it holds the
 * history, appends to it, and compacts it, and nothing on the TS side can edit
 * it. Adopting a saved transcript into the message list alone therefore leaves
 * the two halves of the app disagreeing: the transcript on screen is the
 * resumed one, while the model — asked anything at all — answers from the
 * conversation it was already in, with no sign either way that it happened.
 *
 * Dropping the native session here is what re-syncs them: the next send
 * rebuilds it seeded with `history: messages`, which by then *is* the resumed
 * transcript. `/clear` already did this; resuming did not.
 *
 * Every path that puts a saved transcript on screen goes through here.
 */
export function adoptSession(session: SessionData, ui: AdoptSessionTarget): void {
  // First, so there is no window in which the new transcript is on screen and
  // the old conversation is still what the model would answer from.
  ui.resetEngineSession();
  // Tool blocks are dropped: they belong to a run whose results the engine no
  // longer holds, so re-rendering them would show calls nothing can trace back
  // to a message, and their output would be re-read as this session's.
  ui.setMessages(session.messages.map((m) => ({ ...m, toolUse: [] })));
  ui.setTokenCount(session.tokenUsage);
  ui.setActiveSessionHash(session.hash);
  // /rewind's snapshots are per-conversation too: without this, rewinding the
  // resumed transcript would offer the files as they were in the conversation
  // the user just left. Sessions saved before snapshots were scoped have no
  // id — their hash is stable, and a fresh scope id would orphan the snapshots
  // the session does have.
  ui.setFileHistoryScope(session.fileHistoryId ?? session.hash);
}
