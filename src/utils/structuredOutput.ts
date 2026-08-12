// Structured-output enforcement helper
//
// A pure-TS utility for callers that need a model response to conform to a Zod
// schema. Models are asked to emit JSON but frequently wrap it in prose,
// markdown fences, leading/trailing commentary, or partial fragments. This
// module:
//   1. Tolerantly extracts a JSON payload from raw model text.
//   2. Validates it against a caller-supplied Zod schema via safeParse.
//   3. Returns a discriminated result ({ ok, data, errors, retryHint }) that a
//      retry loop can feed back to the model so the next attempt fixes the
//      specific validation failure.
//
// This is intentionally framework-agnostic: it does not call the model, run a
// loop, or touch the C++ backend. Callers wire it into their own retry logic
// (e.g. an agent step or a slash command that needs JSON-conforming output).
//
// Adapted in spirit from Claude Code's structured-output handling, but uses
// DeepSeek's Zod-v4 patterns and returns a { retryHint } field the retry loop
// can paste into the next user/system turn.

import type { z } from "zod";
import type { ZodTypeAny } from "zod";

// ─── Public types ────────────────────────────────────────────────────────────

export interface StructuredOutputOk<T> {
  ok: true;
  /** The validated, schema-conforming data. */
  data: T;
  /** Raw model text the JSON was extracted from (for debugging/logging). */
  raw: string;
  errors: undefined;
  retryHint: undefined;
}

export interface StructuredOutputError {
  ok: false;
  data: undefined;
  /** Raw model text that failed to yield valid, schema-conforming JSON. */
  raw: string;
  /** Human-readable list of problems (parse failure and/or Zod issues). */
  errors: string[];
  /**
   * A ready-to-paste hint for the next model attempt. Describes what went wrong
   * and, when available, restates the expected shape so the model can self-correct.
   */
  retryHint: string;
}

export type StructuredOutputResult<T> =
  | StructuredOutputOk<T>
  | StructuredOutputError;

// ─── JSON extraction ─────────────────────────────────────────────────────────

/**
 * Strip a single level of markdown code fence if present. Models often emit:
 *   ```json
 *   { ... }
 *   ```
 * Returns the inner content with the fence removed.
 */
function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/```(?:json|JSON)?[^\S\r\n]*\r?\n([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return text.trim();
}

/**
 * Try to locate the outermost JSON value in `text` by scanning for the first
 * balanced {...} or [...] span. This recovers JSON embedded inside prose
 * ("Here is the result: { ... } as shown above.") which a naive JSON.parse of
 * the whole string would reject.
 *
 * Returns the substring of the first balanced object/array, or null if none is
 * found. Only handles the common cases — object/array/scalar-leading JSON. We
 * intentionally do not attempt to repair malformed JSON here; that is the
 * model's job on retry, and silent "best effort" rewriting tends to mask
 * schemas bugs.
 */
function extractBalancedJSON(text: string): string | null {
  let start = -1;
  let openCh = "";
  let closeCh = "";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) continue;

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      // Only enter a string once we've started a structure; stray quotes in
      // prose before any { or [ are ignored.
      if (start !== -1) inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (start === -1) {
        start = i;
        openCh = ch;
        closeCh = ch === "{" ? "}" : "]";
      }
      // Only count depth for the chosen opening char so nested arrays inside an
      // object (or vice versa) don't trip the bracket matcher.
      if (ch === openCh) depth++;
      continue;
    }

    if (ch === closeCh) {
      if (start === -1) continue;
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Tolerantly extract a parseable JSON string from raw model text.
 * Strategy (in order):
 *   1. Strip a markdown code fence if the whole text is one.
 *   2. Try parsing the trimmed text directly.
 *   3. Locate the first balanced {...}/[...] span and try that.
 *   4. As a last resort, try the fence-stripped balanced extraction.
 *
 * Returns { value } on success or { error } with a message describing why every
 * attempt failed.
 */
function extractJSON(
  raw: string,
): { value: unknown } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { error: "Model response was empty." };
  }

  // 1. Code-fence unwrap (handles the ```json ... ``` case).
  const fenceStripped = stripCodeFence(raw);

  // 2. Direct parse of the most promising candidates.
  const candidates: string[] = [
    trimmed,
    fenceStripped,
    fenceStripped !== trimmed ? fenceStripped : "",
  ];

  let firstParseError = "";
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { value: JSON.parse(candidate) };
    } catch (e) {
      if (!firstParseError) firstParseError = (e as Error).message;
    }
  }

  // 3. Balanced extraction from the raw text and the fence-stripped text.
  for (const source of [raw, fenceStripped]) {
    const span = extractBalancedJSON(source);
    if (span) {
      try {
        return { value: JSON.parse(span) };
      } catch (e) {
        if (!firstParseError) firstParseError = (e as Error).message;
      }
    }
  }

  return {
    error:
      `No valid JSON found in model response. ` +
      `First parse error: ${firstParseError || "unknown"}.`,
  };
}

// ─── Zod error formatting ────────────────────────────────────────────────────

/**
 * Flatten a ZodError into concise, model-actionable strings. Each entry names
 * the path and the message, e.g. ".items[0].name: expected string, received
 * number". Kept compact so the retryHint stays cheap to inject.
 */
function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0
      ? "." + issue.path.map(String).join(".")
      : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/**
 * Best-effort, human-readable description of the expected shape, derived from
 * the schema. Uses the schema's cached JSON Schema representation when the Zod
 * version exposes one; otherwise falls back to the schema's internal description
 * string. This is only a hint — validation authority always rests with safeParse.
 */
function describeExpectedShape(schema: ZodTypeAny): string {
  // Zod v4 exposes a description() accessor and optional _def.description.
  // We avoid leaning on private internals beyond what's stable across patches.
  const anySchema = schema as unknown as {
    description?: string;
    _def?: { description?: string | null };
    // zod/v4: schema can be converted to JSON schema via .toJSONSchema() on
    // ZodObject; guard with a runtime check.
    toJSONSchema?: unknown;
  };

  const desc =
    anySchema.description ?? anySchema._def?.description ?? undefined;
  if (desc) return desc;

  if (typeof anySchema.toJSONSchema === "function") {
    try {
      const jsonSchema = (anySchema.toJSONSchema as () => unknown)();
      return `JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;
    } catch {
      // Fall through to the generic message.
    }
  }

  return "a JSON value conforming to the provided schema";
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract JSON from a raw model response and validate it against a Zod schema.
 *
 * @param modelResponseText Raw text emitted by the model (may include prose,
 *   markdown fences, etc.).
 * @param schema A Zod schema to validate the extracted JSON against.
 * @returns A discriminated result. On success, `{ ok: true, data, raw }`. On
 *   failure, `{ ok: false, errors, retryHint, raw }` where `retryHint` is a
 *   ready-to-inject message describing the failure for the next model attempt.
 *
 * @example
 * const MySchema = z.object({ name: z.string(), count: z.number() });
 * const res = enforceSchema(modelText, MySchema);
 * if (!res.ok) {
 *   // feed res.retryHint back to the model and retry
 * } else {
 *   use(res.data.name, res.data.count);
 * }
 */
export function enforceSchema<T>(
  modelResponseText: string,
  schema: ZodTypeAny,
): StructuredOutputResult<T> {
  const raw = modelResponseText;

  // 1. Extract & parse JSON.
  const extracted = extractJSON(raw);
  if ("error" in extracted) {
    const errors = [extracted.error];
    return {
      ok: false,
      data: undefined,
      raw,
      errors,
      retryHint: buildRetryHint(errors, schema),
    };
  }

  // 2. Validate against the schema (non-throwing).
  const parsed = schema.safeParse(extracted.value);
  if (parsed.success) {
    return {
      ok: true,
      data: parsed.data as T,
      raw,
      errors: undefined,
      retryHint: undefined,
    };
  }

  const errors = formatZodIssues(parsed.error);
  return {
    ok: false,
    data: undefined,
    raw,
    errors,
    retryHint: buildRetryHint(errors, schema),
  };
}

/**
 * Compose a retry hint from a list of error messages plus the expected shape.
 * The hint is phrased as corrective instruction so a caller can append it
 * verbatim to the next model turn.
 */
function buildRetryHint(errors: string[], schema: ZodTypeAny): string {
  const shape = describeExpectedShape(schema);
  const bullets = errors.map((e) => `- ${e}`).join("\n");
  return (
    `Your previous response did not match the required structure.\n` +
    `Problems:\n${bullets}\n\n` +
    `Respond with ONLY valid JSON (no prose, no markdown fences) that is ` +
    `${shape}.`
  );
}

// ─── Optional retry-loop helper ───────────────────────────────────────────────

/**
 * Drive a caller-supplied model-call function through up to `maxAttempts`
 * retries until it returns schema-conforming JSON, or until attempts are
 * exhausted.
 *
 * The caller provides `generate(textOverride?)` — typically a closure over a
 * query/agent call — which returns the raw model text for one attempt. On each
 * failure, the retry hint is appended to the prompt for the next attempt.
 *
 * This keeps the helper decoupled from the agent loop / provider while still
 * offering the common retry shape. Callers that need custom backoff, abort
 * handling, or streaming should call `enforceSchema` directly in their own loop.
 */
export async function enforceSchemaWithRetry<T>(
  generate: (promptSuffix?: string) => Promise<string>,
  schema: ZodTypeAny,
  opts: { maxAttempts?: number } = {},
): Promise<StructuredOutputResult<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  let suffix: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await generate(suffix);
    const result = enforceSchema<T>(text, schema);
    if (result.ok || attempt === maxAttempts) {
      return result;
    }
    // Feed the hint into the next attempt.
    suffix = result.retryHint;
  }

  // Unreachable: loop always returns on the final attempt.
  const fallback = enforceSchema<T>("", schema);
  return fallback;
}
