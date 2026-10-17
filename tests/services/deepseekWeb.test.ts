/**
 * The first-party Search and Fetch clients.
 *
 * Everything here runs against a fake fetch: the tests pin the wire format
 * (endpoint, auth header, payload field names) and the mapping back to the
 * shapes the tools render, not the network. Billing follows a successful 200,
 * so the failure paths are as important as the success path.
 */
import { describe, expect, test } from "bun:test";
import {
  DeepSeekWebError,
  fetchPage,
  formatSearchResults,
  isPrivateUrl,
  searchWeb,
  toolsEndpoint,
  type SearchResult,
} from "../../src/services/deepseekWeb.js";

const KEY = "sk-test-key";

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(response: () => Response): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("toolsEndpoint", () => {
  test("defaults to the DeepSeek host", () => {
    expect(toolsEndpoint(undefined, "/tools/search")).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
  });

  test("keeps one version segment and tolerates a trailing slash", () => {
    expect(toolsEndpoint("https://api.deepseek.com/v1", "/tools/fetch")).toBe(
      "https://api.deepseek.com/v1/tools/fetch",
    );
    expect(toolsEndpoint("https://api.deepseek.com/v1/", "/tools/fetch")).toBe(
      "https://api.deepseek.com/v1/tools/fetch",
    );
    expect(toolsEndpoint("https://proxy.example", "/tools/search")).toBe(
      "https://proxy.example/v1/tools/search",
    );
  });
});

describe("searchWeb", () => {
  test("posts the documented payload and maps every field", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        results: [
          {
            rerank_score: 2.4,
            title: "DeepSeek V4 released",
            url: "https://example.com/v4",
            snippet: "V4 is available.",
            summary: "DeepSeek has released V4 with tool calling.",
            content: "Full page text",
            site_name: "Example News",
            date: "2026-06-01T00:00:00+00:00",
            authority: 3,
          },
        ],
      }),
    );

    const results = await searchWeb("DeepSeek V4", {
      apiKey: KEY,
      count: 5,
      needContent: true,
      oriQuestion: "what is new in DeepSeek V4?",
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      query: "DeepSeek V4",
      count: 5,
      need_content: true,
      ori_question: "what is new in DeepSeek V4?",
    });

    expect(results).toEqual([
      {
        title: "DeepSeek V4 released",
        url: "https://example.com/v4",
        snippet: "V4 is available.",
        summary: "DeepSeek has released V4 with tool calling.",
        content: "Full page text",
        siteName: "Example News",
        date: "2026-06-01T00:00:00+00:00",
        authority: 3,
        rerankScore: 2.4,
      },
    ]);
  });

  test("clamps count to the API's 1–50 range", async () => {
    for (const [requested, sent] of [
      [undefined, 10],
      [0, 1],
      [999, 50],
    ] as const) {
      const { fetchImpl, calls } = fakeFetch(() => json({ results: [] }));
      await searchWeb("q", { apiKey: KEY, count: requested, fetchImpl });
      expect(JSON.parse(calls[0]!.init?.body as string).count).toBe(sent);
    }
  });

  test("an empty results array is a valid answer", async () => {
    const { fetchImpl } = fakeFetch(() => json({ results: [] }));
    expect(await searchWeb("nothing matches", { apiKey: KEY, fetchImpl })).toEqual([]);
  });

  test("rejects an empty or over-long query before spending a request", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ results: [] }));
    await expect(searchWeb("   ", { apiKey: KEY, fetchImpl })).rejects.toBeInstanceOf(
      DeepSeekWebError,
    );
    await expect(
      searchWeb("x".repeat(129), { apiKey: KEY, fetchImpl }),
    ).rejects.toBeInstanceOf(DeepSeekWebError);
    expect(calls).toHaveLength(0);
  });

  test("an OpenAI-shaped error carries its message, status and code", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(
        {
          error: {
            message: "'count' must be between 1 and 50",
            type: "invalid_request_error",
            param: null,
            code: "invalid_request_error",
          },
        },
        400,
      ),
    );

    try {
      await searchWeb("q", { apiKey: KEY, fetchImpl });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DeepSeekWebError);
      const webError = error as DeepSeekWebError;
      expect(webError.status).toBe(400);
      expect(webError.code).toBe("invalid_request_error");
      expect(webError.message).toContain("between 1 and 50");
    }
  });

  test("a non-JSON error body still reports the status", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("bad gateway", { status: 502 }));
    try {
      await searchWeb("q", { apiKey: KEY, fetchImpl });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DeepSeekWebError);
      expect((error as DeepSeekWebError).status).toBe(502);
      expect((error as DeepSeekWebError).message).toContain("502");
    }
  });

  test("a result without a URL is dropped, not rendered as a dead link", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ results: [{ title: "no url" }, { title: "ok", url: "https://a.example" }] }),
    );
    const results = await searchWeb("q", { apiKey: KEY, fetchImpl });
    expect(results.map((r) => r.url)).toEqual(["https://a.example"]);
  });
});

describe("fetchPage", () => {
  test("posts the URL and returns the Markdown page", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ title: "Example article", content: "# Example article\n\nBody." }),
    );

    const page = await fetchPage("https://example.com/article", { apiKey: KEY, fetchImpl });

    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      url: "https://example.com/article",
    });
    expect(page).toEqual({ title: "Example article", content: "# Example article\n\nBody." });
  });

  test("empty content is a 404, not an empty success", async () => {
    const { fetchImpl } = fakeFetch(() => json({ title: "No content", content: "" }));
    try {
      await fetchPage("https://example.com", { apiKey: KEY, fetchImpl });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DeepSeekWebError);
      expect((error as DeepSeekWebError).status).toBe(404);
    }
  });
});

describe("isPrivateUrl", () => {
  test("loopback, RFC 1918 and link-local addresses stay local", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://foo.localhost/",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.1.1/",
      "http://172.16.0.9/",
      "http://172.31.255.1/",
      "http://169.254.169.254/",
      "not a url",
    ]) {
      expect(isPrivateUrl(url)).toBe(true);
    }
  });

  test("public hosts are fetchable", () => {
    expect(isPrivateUrl("https://example.com/a")).toBe(false);
    expect(isPrivateUrl("http://172.32.0.1/")).toBe(false);
    expect(isPrivateUrl("https://api.deepseek.com")).toBe(false);
  });
});

describe("formatSearchResults", () => {
  const result = (overrides: Partial<SearchResult> = {}): SearchResult => ({
    title: "A result",
    url: "https://example.com",
    snippet: "short",
    summary: "long summary",
    content: "",
    siteName: null,
    date: null,
    authority: -1,
    rerankScore: null,
    ...overrides,
  });

  test("numbers results and prefers the summary", () => {
    const text = formatSearchResults([result()]);
    expect(text).toContain("[1] A result");
    expect(text).toContain("URL: https://example.com");
    expect(text).toContain("long summary");
    expect(text).not.toContain("short");
  });

  test("falls back to the snippet when the summary is empty", () => {
    expect(formatSearchResults([result({ summary: "" })])).toContain("short");
  });

  test("names the source, date and authority when present", () => {
    const text = formatSearchResults([
      result({ siteName: "Example", date: "2026-06-01T00:00:00+00:00", authority: 3 }),
    ]);
    expect(text).toContain("Example · 2026-06-01T00:00:00+00:00 · high authority");
  });

  test("includes content only when the API returned it", () => {
    expect(formatSearchResults([result({ content: "Full text" })])).toContain("Full text");
    expect(formatSearchResults([result()])).not.toContain("Full text");
  });

  test("no results is stated plainly", () => {
    expect(formatSearchResults([])).toBe("No results found.");
  });
});
