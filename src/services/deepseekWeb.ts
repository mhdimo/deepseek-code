/**
 * DeepSeek's first-party Search and Fetch APIs.
 *
 * https://api-docs.deepseek.com/guides/search_and_fetch — two plain JSON
 * endpoints on the same host and bearer auth as the chat API:
 *
 *   POST /v1/tools/search  { query, count?, ori_question?, need_content? }
 *   POST /v1/tools/fetch   { url }
 *
 * The native engine (ai-sdk-cpp) has no server-side tool surface, so the
 * WebSearch and WebFetch tools call these directly. Billing is per successful
 * request ($0.75 per 1,000), so a failed or empty request costs nothing — but a
 * call that succeeds still spends the user's balance, which is why the tools
 * fall back to their keyless paths when no key is configured.
 */
import type { ProviderConfig } from "../types/index.js";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
export const MAX_SEARCH_COUNT = 50;
export const MAX_QUERY_CHARS = 128;

const SEARCH_PATH = "/tools/search";
const FETCH_PATH = "/tools/fetch";

/** An error response from the Search or Fetch API. */
export class DeepSeekWebError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DeepSeekWebError";
  }
}

/**
 * The absolute endpoint for a tool path.
 *
 * The configured base URL normally ends in `/v1` (the chat endpoint's shape).
 * A bare host and a trailing slash are both accepted so a proxy that strips or
 * adds the version segment still lands on `/v1/tools/...`.
 */
export function toolsEndpoint(baseURL: string | undefined, path: string): string {
  const base = (baseURL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const root = /\/v\d+$/.test(base) ? base : `${base}/v1`;
  return `${root}${path}`;
}

export interface WebRequestOptions {
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ApiErrorBody {
  error?: { message?: unknown; code?: unknown };
}

function errorFromResponse(status: number, body: unknown): DeepSeekWebError {
  const error = (body as ApiErrorBody | null)?.error;
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message
      : `HTTP ${status}`;
  const code = typeof error?.code === "string" ? error.code : undefined;
  return new DeepSeekWebError(message, status, code);
}

async function postJson(
  url: string,
  payload: Record<string, unknown>,
  options: WebRequestOptions,
): Promise<unknown> {
  const { apiKey, signal, timeoutMs = 20_000, fetchImpl = fetch } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : (signal ?? timeout);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal: combined,
  });

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // fall through: a non-JSON body is reported with its status below
  }

  if (!response.ok) throw errorFromResponse(response.status, body);
  return body;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  /** Short (100–200 chars) text meant for display. */
  snippet: string;
  /** Long (600–800 chars) text meant for the model. */
  summary: string;
  content: string;
  siteName: string | null;
  date: string | null;
  authority: number;
  rerankScore: number | null;
}

export interface SearchWebOptions extends WebRequestOptions {
  count?: number;
  /** The user's original question, to improve query understanding. */
  oriQuestion?: string;
  needContent?: boolean;
}

interface RawSearchResult {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  summary?: unknown;
  content?: unknown;
  site_name?: unknown;
  date?: unknown;
  authority?: unknown;
  rerank_score?: unknown;
}

const stringOr = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const nullableString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function clampCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return 10;
  return Math.min(MAX_SEARCH_COUNT, Math.max(1, Math.trunc(count)));
}

/**
 * Search the web. Returns [] for a successful search with no matches — an
 * empty array is a valid answer, not an error (and is not billed).
 */
export async function searchWeb(
  query: string,
  options: SearchWebOptions,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new DeepSeekWebError("The search query must not be empty", 400);
  if (trimmed.length > MAX_QUERY_CHARS) {
    throw new DeepSeekWebError(
      `The search query is ${trimmed.length} characters; the API accepts at most ${MAX_QUERY_CHARS}`,
      400,
    );
  }

  const payload: Record<string, unknown> = {
    query: trimmed,
    count: clampCount(options.count),
  };
  if (options.needContent) payload.need_content = true;
  if (options.oriQuestion) payload.ori_question = options.oriQuestion.slice(0, MAX_QUERY_CHARS);

  const body = (await postJson(
    toolsEndpoint(options.baseURL, SEARCH_PATH),
    payload,
    options,
  )) as { results?: unknown } | null;

  const results = Array.isArray(body?.results) ? body.results : [];
  return results.flatMap((entry): SearchResult[] => {
    const raw = entry as RawSearchResult;
    const url = stringOr(raw.url);
    if (!url) return [];
    return [
      {
        title: stringOr(raw.title, url),
        url,
        snippet: stringOr(raw.snippet),
        summary: stringOr(raw.summary),
        content: stringOr(raw.content),
        siteName: nullableString(raw.site_name),
        date: nullableString(raw.date),
        authority: typeof raw.authority === "number" ? raw.authority : -1,
        rerankScore: typeof raw.rerank_score === "number" ? raw.rerank_score : null,
      },
    ];
  });
}

/** The model-facing text for a set of results. */
export function formatSearchResults(results: readonly SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((result, index) => {
      const lines = [`[${index + 1}] ${result.title}`, `URL: ${result.url}`];
      const summary = result.summary || result.snippet;
      if (summary) lines.push(summary);
      const meta: string[] = [];
      if (result.siteName) meta.push(result.siteName);
      if (result.date) meta.push(result.date);
      if (result.authority >= 3) meta.push("high authority");
      if (meta.length > 0) lines.push(meta.join(" · "));
      if (result.content) lines.push("", result.content);
      return lines.join("\n");
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface FetchedPage {
  title: string;
  /** The page as Markdown. */
  content: string;
}

interface RawFetchedPage {
  title?: unknown;
  content?: unknown;
}

export async function fetchPage(url: string, options: WebRequestOptions): Promise<FetchedPage> {
  const body = (await postJson(
    toolsEndpoint(options.baseURL, FETCH_PATH),
    { url },
    { ...options, timeoutMs: options.timeoutMs ?? 30_000 },
  )) as RawFetchedPage | null;

  const content = stringOr(body?.content);
  if (!content) {
    throw new DeepSeekWebError("The Fetch API returned no page content", 404);
  }
  return { title: stringOr(body?.title), content };
}

/**
 * Whether a URL points at this machine or a private network. Sending one to a
 * remote Fetch API cannot work, and leaking an internal URL to a third party
 * is not what the tool was asked to do — those go through the direct download.
 */
export function isPrivateUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // not a URL the API could fetch either
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "[::1]" || hostname === "::1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** Whether the configured provider can reach the first-party tools at all. */
export function hasDeepSeekKey(provider: Pick<ProviderConfig, "apiKey">): boolean {
  return typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0;
}
