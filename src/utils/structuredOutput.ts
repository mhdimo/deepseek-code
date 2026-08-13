



















import type { z } from "zod";
import type { ZodTypeAny } from "zod";



export interface StructuredOutputOk<T> {
  ok: true;
  
  data: T;
  
  raw: string;
  errors: undefined;
  retryHint: undefined;
}

export interface StructuredOutputError {
  ok: false;
  data: undefined;
  
  raw: string;
  
  errors: string[];
  
  retryHint: string;
}

export type StructuredOutputResult<T> =
  | StructuredOutputOk<T>
  | StructuredOutputError;




function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/```(?:json|JSON)?[^\S\r\n]*\r?\n([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return text.trim();
}


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
      
      
      if (start !== -1) inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (start === -1) {
        start = i;
        openCh = ch;
        closeCh = ch === "{" ? "}" : "]";
      }
      
      
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


function extractJSON(
  raw: string,
): { value: unknown } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { error: "Model response was empty." };
  }

  
  const fenceStripped = stripCodeFence(raw);

  
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




function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0
      ? "." + issue.path.map(String).join(".")
      : "(root)";
    return `${path}: ${issue.message}`;
  });
}


function describeExpectedShape(schema: ZodTypeAny): string {
  
  
  const anySchema = schema as unknown as {
    description?: string;
    _def?: { description?: string | null };
    
    
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
      
    }
  }

  return "a JSON value conforming to the provided schema";
}




export function enforceSchema<T>(
  modelResponseText: string,
  schema: ZodTypeAny,
): StructuredOutputResult<T> {
  const raw = modelResponseText;

  
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
    
    suffix = result.retryHint;
  }

  
  const fallback = enforceSchema<T>("", schema);
  return fallback;
}
