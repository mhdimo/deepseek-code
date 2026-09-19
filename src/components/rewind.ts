/**
 * What a rewind does, decided in one place.
 *
 * `/rewind` moves three things — the visible conversation, the workspace files,
 * and the native session's history — and which of them move depends on the
 * mode. Only the first two were ever explicit; the third was simply missing, so
 * a rewind truncated the transcript while the model went on remembering the
 * turns that were rewound (and, in a "both" rewind, the edits whose files had
 * just been put back).
 *
 * Why it was missing is worth stating: the engine owns its own history, and
 * `getOrCreateMemorySession` only replays `history` when it *builds* a session
 * — a cache hit returns the existing one and ignores it. Truncating the React
 * list is therefore invisible to the model until something drops the cached
 * session, which is what `/clear` and `/compact` already do for the same
 * reason. Making the third decision a return value means a fourth mode cannot
 * forget it.
 */
import type { RewindMode } from "./RewindPicker.js";

export interface RewindPlan {
  /** Truncate the visible conversation back to the chosen message. */
  truncateConversation: boolean;
  /** Put the workspace's files back the way they were at that message. */
  restoreFiles: boolean;
  /** Drop the cached native session, so the next turn rebuilds from the
   *  truncated conversation instead of continuing the old one. */
  dropEngineSession: boolean;
}

export function rewindPlan(mode: RewindMode): RewindPlan {
  const truncateConversation = mode !== "code";
  return {
    truncateConversation,
    restoreFiles: mode !== "conversation",
    // Exactly when there is history to rebuild. A code-only rewind leaves the
    // conversation intact, so dropping the session there would rebuild it from
    // an unchanged list — pointless, and it would throw away the engine's own
    // record of a conversation that never changed.
    dropEngineSession: truncateConversation,
  };
}
