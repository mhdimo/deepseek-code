/**
 * Telling a retryable failure from a permanent one, using only a string.
 *
 * The strings below are not invented — they are what the engine actually puts
 * on the wire, which is why the assertions look like this:
 *
 *   - the class is gone. `map_exception` (ai-sdk-cpp bindings/c/ai_sdk.cpp)
 *     does distinguish a rate limit from an auth failure, but it reports that
 *     as an `ai_status_t`, and the node binding throws
 *     `Napi::Error::New(env, ai_last_error(ctx))` — the message alone.
 *   - the name in the message is not the class either. `AiError::what()` builds
 *     `name + ": " + message` in the *base* constructor (ai-sdk-cpp
 *     src/error/ai_error.cpp), so a RateLimitError stringifies as
 *     "AI_APICallError: …", exactly like a 400.
 *   - the message has two shapes, both from `extract_error_message`
 *     (ai-sdk-cpp include/ai/http/response.hpp): the default
 *     "API call failed with status N", or the body's own `error.message`.
 *
 * The second shape is the normal one against a real provider, so the old
 * classifyError — `/429|overload/i` — did not fire on a real 429. The fallback
 * model never ran and the user got the raw error instead of the advice.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyError,
  describeProviderError,
  emptyTurnMessage,
  isEmptyTurn,
  overloadMessage,
  promptTooLongMessage,
} from "./recovery.js";

describe("classifyError", () => {
  test("reads the status when the body carried no message", () => {
    expect(classifyError("AI_APICallError: API call failed with status 429")).toBe("overload");
    expect(classifyError("AI_APICallError: API call failed with status 503")).toBe("overload");
    expect(classifyError("AI_APICallError: API call failed with status 413")).toBe("prompt-too-long");
  });

  test("reads the wording when it did", () => {
    // DeepSeek's real 429 body. No digits anywhere — this is the case the old
    // classifier missed, and the reason the fallback never fired.
    expect(
      classifyError("AI_APICallError: Rate limit reached. Please try again later."),
    ).toBe("overload");
    expect(classifyError("AI_APICallError: Service is too busy.")).toBe("overload");
    expect(classifyError("AI_APICallError: The server is overloaded")).toBe("overload");
    expect(classifyError("AI_APICallError: Too many requests")).toBe("overload");
    expect(classifyError("AI_APICallError: upstream at capacity")).toBe("overload");
    expect(
      classifyError("AI_APICallError: This model's maximum context length is 65536 tokens."),
    ).toBe("prompt-too-long");
  });

  test("a mid-stream error reads the same as one that never started", () => {
    // `consume_stream_to_callback` wraps a streamed ErrorPart in a StreamError
    // carrying the provider's own text, so the class name differs and the
    // wording does not.
    expect(classifyError("AI_StreamError: rate limit exceeded")).toBe("overload");
  });

  test("a timeout is the same advice as an overload", () => {
    // A direct AiError, so this one keeps its name in the string.
    expect(classifyError("AI_TimeoutError: Request timed out after 60000ms")).toBe("overload");
  });

  test("statuses that mean 5xx", () => {
    for (const code of [500, 502, 504, 408]) {
      expect(classifyError(`AI_APICallError: API call failed with status ${code}`)).toBe("overload");
    }
  });

  test("a permanent failure is not a retryable one", () => {
    // The important half. These replace the provider's message with advice if
    // they are misread, so a 401 must never come back as "overloaded".
    expect(classifyError("AI_APICallError: API call failed with status 401")).toBeNull();
    expect(classifyError("AI_APICallError: API call failed with status 400")).toBeNull();
    expect(classifyError("AI_APICallError: API call failed with status 404")).toBeNull();
    // DeepSeek's real 401 body — no status code, no wording we claim.
    expect(
      classifyError("AI_APICallError: Authentication Fails, Your api key is invalid"),
    ).toBeNull();
    expect(classifyError("AI_APICallError: Model Not Exist")).toBeNull();
    expect(classifyError("AI_TypeValidationError: Expected string, got number")).toBeNull();
    expect(classifyError("AI_NoOutputGeneratedError: No output generated")).toBeNull();
    expect(classifyError("AI_InvalidResponseError: Failed to parse API response as JSON")).toBeNull();
  });

  test("an explicit status ends the search", () => {
    // `extract_error_message` writes either the status or the body's wording,
    // never both — so once a status is present there is nothing else to read,
    // and a 400 whose body happens to say "rate limit" is still a 400.
    expect(classifyError("AI_APICallError: API call failed with status 400; rate limit")).toBeNull();
  });

  test("a number in the message is not a status", () => {
    expect(classifyError("AI_APICallError: max_tokens 500 exceeds the model limit")).toBeNull();
    expect(classifyError("AI_APICallError: requested 4130 tokens")).toBeNull();
  });

  test("nothing in, nothing out", () => {
    expect(classifyError("")).toBeNull();
    expect(classifyError(undefined as unknown as string)).toBeNull();
  });
});

describe("describeProviderError", () => {
  test("drops the engine's prefix, which names nothing the user can act on", () => {
    expect(describeProviderError("AI_APICallError: Rate limit reached.")).toBe(
      "Rate limit reached.",
    );
    expect(describeProviderError("AI_TimeoutError: Request timed out")).toBe("Request timed out");
  });

  test("leaves a message that never had one alone", () => {
    expect(describeProviderError("Rate limit reached.")).toBe("Rate limit reached.");
  });

  test("caps a body that is not a message but a wall", () => {
    const long = describeProviderError(`AI_APICallError: ${"x".repeat(1000)}`);
    expect(long.length).toBeLessThanOrEqual(400);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("the advice keeps the provider's words", () => {
  test("a recognised error still shows what the provider said", () => {
    // The body often carries the one specific thing the user was told — how
    // long to wait, what the real limit is. Replacing it with advice throws
    // that away.
    const message = overloadMessage("deepseek-chat", "AI_APICallError: Rate limit reached. Retry in 20s.");
    expect(message).toContain("Rate limit reached. Retry in 20s.");
    expect(message).not.toContain("AI_APICallError");
    expect(message).toContain("deepseek-chat");
  });

  test("no detail, no dangling label", () => {
    const none = overloadMessage("deepseek-chat");
    expect(none).not.toContain("Provider said");
    // A message that was nothing but the engine's prefix carries no detail
    // either — better silent than "Provider said: ".
    expect(overloadMessage("deepseek-chat", "AI_APICallError:")).not.toContain("Provider said");
    expect(promptTooLongMessage("AI_APICallError:")).not.toContain("Provider said");
  });

  test("both messages still offer the way out", () => {
    expect(promptTooLongMessage()).toContain("/compact");
    expect(overloadMessage("deepseek-chat")).toContain("DEEPSEEK_FALLBACK_MODEL");
  });
});

describe("isEmptyTurn", () => {
  test("a turn with neither output nor usage did not happen", () => {
    expect(isEmptyTurn(0, 0)).toBe(true);
  });

  test("either one alone is a turn that happened", () => {
    // A provider that reports no usage still shows output events; a model that
    // answers with an empty string still reports the tokens it took to decide.
    expect(isEmptyTurn(0, 3)).toBe(false);
    expect(isEmptyTurn(150, 0)).toBe(false);
  });
});

describe("emptyTurnMessage", () => {
  test("says what happened and where to look", () => {
    const message = emptyTurnMessage("deepseek-chat");
    expect(message).toContain("returned nothing");
    expect(message).toContain("/doctor");
    expect(message).toContain("deepseek-chat");
  });

  test("a model name it does not have is not a hole in the sentence", () => {
    const message = emptyTurnMessage();
    expect(message).toContain("/doctor");
    expect(message).not.toContain("(current: )");
  });
});
