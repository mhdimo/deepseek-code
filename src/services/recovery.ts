import type { DeepSeekCodeConfig, ProviderConfig } from "../types/index.js";

export type ErrorClass = "overload" | "prompt-too-long" | null;

/**
 * How a failed turn reaches the UI — three shapes, and the first two are read
 * off a string because a string is all that crosses the C ABI.
 *
 * The engine raises *typed* errors (`RateLimitError`, `AuthenticationError`,
 * `TimeoutError`) and `map_exception` distinguishes them into an `ai_status_t`
 * (ai-sdk-cpp `bindings/c/ai_sdk.cpp`). None of that survives the trip: the
 * node binding throws `Napi::Error::New(env, ai_last_error(ctx))`, and
 * `ai_last_error` holds `e.what()` alone. So the class is gone before this
 * module sees anything, and the derived `error_type()` never appears at all —
 * `name_` is set by the *base* constructor (ai-sdk-cpp `src/error/ai_error.cpp`),
 * which is why a 429 and a 400 both arrive prefixed `AI_APICallError:`.
 *
 * What is left is the message, and it has exactly two shapes, both from
 * `extract_error_message()` (ai-sdk-cpp `include/ai/http/response.hpp`):
 *
 *   "API call failed with status 429"      the body carried no message
 *   "Rate limit reached. Try again."       the body's own `error.message`
 *
 * The second is the normal case against a real provider — DeepSeek's 429 body
 * carries a message — and matching on the digits alone misses exactly the error
 * this module exists to catch. That was the bug: `resolveFallbackProvider` never
 * ran, because the string never said "429"; the user got the raw error and no
 * retry. Classify on the status when it is there and on the wording when it is
 * not.
 *
 * The third shape is silence, at the bottom of this file: a failure that
 * produces no *response* at all — connection refused, DNS failure, timeout —
 * reaches the UI as an empty, successful turn. Note the narrowness. An HTTP
 * status is a response and surfaces as a normal error event; it is the
 * no-response failures that were swallowed, and only for an agent with no tool
 * set (with tools, the same failure routes through the stream consumer).
 * `ai_session_send_stream` returned its status without emitting a terminal
 * event where its sibling `ai_stream_text` always emitted one; fixed on
 * ai-sdk-cpp `release/1.0.0` (commit 2664390). The guard below stays anyway —
 * a turn with no output and no usage is worth naming whoever produced it.
 */

/** `AI_APICallError:`, `AI_TimeoutError:` — the engine's own prefix, jargon the
 *  user cannot act on, so it is kept out of anything we render. */
const SDK_ERROR_PREFIX = /^AI_[A-Za-z]*Error:\s*/;

/** `extract_error_message`'s default text, and the only place a status code is
 *  spelled out. Anchored on the word so a message that happens to mention
 *  "500 tokens" is not read as a 500. */
const STATUS_RE = /\bstatus\s+(\d{3})\b/i;

/** What a provider says when it is briefly unable to serve the request.
 *  Deliberately narrow: the cost of guessing wrong is high, because this class
 *  replaces the provider's own error text with advice, so a 400 misread as an
 *  overload would hide the one message that says what to fix. */
const OVERLOAD_WORDING =
  /\b(?:rate ?limit(?:ed|s|ing)?|too many requests|overload(?:ed)?|service (?:is )?(?:unavailable|too busy)|temporarily unavailable|at capacity|high (?:demand|load))\b/i;

/** What a provider says when the prompt does not fit the context window. Note
 *  that DeepSeek answers this with a 400 and this wording, not a 413 — which is
 *  why the status check alone is not enough here either. */
const PROMPT_TOO_LONG_WORDING =
  /\b(?:prompt is too long|maximum context length|context (?:length|window)|too many tokens|input is too long|reduce the (?:length|size))\b/i;

/** The engine's timeout class, which — being a direct `AiError` — is the one
 *  that does keep its name in the string. */
const TIMEOUT_PREFIX = /^AI_TimeoutError\b/i;

/** Statuses that mean "ask again", matching the engine's own `is_retryable()`. */
function statusMeansOverload(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function classifyError(errorText: string): ErrorClass {
  const text = String(errorText ?? "");
  if (!text) return null;

  const status = STATUS_RE.exec(text);
  if (status) {
    const code = Number.parseInt(status[1] ?? "", 10);
    if (code === 413) return "prompt-too-long";
    if (statusMeansOverload(code)) return "overload";
    // An explicit, non-transient status is the answer: `extract_error_message`
    // uses either the status or the body's wording, never both, so there is
    // nothing further to read and a 401 must not be retried against another
    // provider on the strength of a word in its body.
    return null;
  }

  if (PROMPT_TOO_LONG_WORDING.test(text)) return "prompt-too-long";
  if (OVERLOAD_WORDING.test(text)) return "overload";
  // A timeout ends in the same advice as an overload — resend, or let the
  // one-shot fallback take it.
  if (TIMEOUT_PREFIX.test(text)) return "overload";

  return null;
}

/** How much of a provider's own message to repeat before it stops being a
 *  message and starts being a wall. */
const DETAIL_LIMIT = 400;

/**
 * The provider's own words, with the engine's prefix stripped.
 *
 * Worth showing even when the class is recognised: a rate-limit body often
 * carries the wait, and a context-length body carries the actual limit. Advice
 * that replaces the provider's message rather than accompanying it throws away
 * the only specific thing the user was told.
 */
export function describeProviderError(errorText: string): string {
  const text = String(errorText ?? "").replace(SDK_ERROR_PREFIX, "").trim();
  if (text.length <= DETAIL_LIMIT) return text;
  return `${text.slice(0, DETAIL_LIMIT - 1)}…`;
}

function providerSaid(detail: string | undefined): string {
  const described = describeProviderError(detail ?? "");
  return described ? `\n  Provider said: ${described}\n` : "";
}

export function promptTooLongMessage(detail?: string): string {
  return (
    "Warning: prompt is too long for the model's context window." +
    providerSaid(detail) +
    "\n  /compact   — summarize the conversation to free context\n" +
    "  /clear     — start a fresh conversation\n\n" +
    "(Compaction is handled by the session engine; use the commands above.)"
  );
}

export function overloadMessage(model: string, detail?: string): string {
  return (
    "Warning: the provider is temporarily unable to serve this request (rate " +
    "limit, overload, or no capacity) and no fallback model is configured." +
    providerSaid(detail) +
    "\n  - Wait a moment and resend the prompt\n" +
    "  - Configure a fallback: set the DEEPSEEK_FALLBACK_MODEL env var or add " +
    "a second profile to .deepseek-code.json\n" +
    `  - Switch models with /model${model ? ` (current: ${model})` : ""}`
  );
}

/**
 * The finish reason a turn gets when it produced nothing at all.
 *
 * Not an engine reason — the engine does not report this — but derived, the
 * same way `max_turns` in stepLimit.ts is. A failure with no response behind it
 * emits no terminal event, and the binding synthesizes a `finish` to unblock
 * the consumer (ai-sdk-cpp `bindings/node/src/addon.cpp`, `RunStreamAsync`), so
 * it arrives looking exactly like a completed turn that had nothing to say.
 * The empty `finishReason` is the tell — a real finish always names one.
 *
 * The engine-side cause is fixed (commit 2664390), but a released build still
 * has it, and the derived reason costs nothing: nothing else in the pipeline
 * can distinguish "the model said nothing" from "the call never happened", and
 * only one of those wants the user's attention.
 */
export const EMPTY_FINISH_REASON = "empty_response";

/**
 * Whether a turn that ended on its own produced nothing.
 *
 * Both halves are required, and each guards against the other's false
 * positive: a provider that reports no usage still shows output events, and a
 * model that answers with an empty string still reports the tokens it took to
 * decide to. Only a turn with neither did not happen.
 */
export function isEmptyTurn(totalTokens: number, outputEvents: number): boolean {
  return totalTokens === 0 && outputEvents === 0;
}

export function emptyTurnMessage(model?: string): string {
  return (
    "The model returned nothing — no text, no tool calls, and no token usage. " +
    "A request rejected before it produces any output arrives this way, so check " +
    "the API key and endpoint with /doctor, then retry" +
    `${model ? `, or switch models with /model (current: ${model})` : ""}.`
  );
}

export function resolveFallbackProvider(
  config: DeepSeekCodeConfig,
  current: ProviderConfig,
): ProviderConfig | null {
  const envModel = process.env.DEEPSEEK_FALLBACK_MODEL;
  if (envModel && envModel.trim()) {
    return {
      type: current.type,
      model: envModel.trim(),
      apiKey: current.apiKey,
      baseURL: current.baseURL,
    };
  }

  const profiles = config.profiles ?? {};
  for (const [, profile] of Object.entries(profiles)) {
    if (
      profile.provider === current.type &&
      profile.model === current.model &&
      (profile.baseURL || undefined) === (current.baseURL || undefined)
    ) {
      continue; // the profile we are already using
    }
    return {
      type: profile.provider,
      model: profile.model,
      apiKey: profile.apiKey || current.apiKey,
      baseURL: profile.baseURL || current.baseURL,
    };
  }

  return null;
}
