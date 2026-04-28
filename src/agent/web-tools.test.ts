import { describe, it, expect, vi, beforeEach } from "vitest";
import { webSearch, webFetch, validateUrl, clearSearchCache, type WebToolOptions } from "./web-tools.js";

// ── Helpers ──

function mockResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

function mockFetch(responses: Array<{ url?: RegExp | string; response: Response; delay?: number }>) {
  return vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const urlStr = String(url);
    for (const r of responses) {
      const matches = typeof r.url === "string" ? urlStr === r.url : r.url?.test(urlStr);
      if (matches) {
        if (r.delay) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, r.delay);
            // Respect AbortSignal so fetchWithTimeout can actually abort
            options?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
        }
        return r.response;
      }
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  });
}

// ── validateUrl ──

describe("validateUrl", () => {
  it("accepts valid public URLs", async () => {
    const url = await validateUrl("https://example.com/path?q=1");
    expect(url).toBe("https://example.com/path?q=1");
  });

  it("rejects non-http protocols", async () => {
    await expect(validateUrl("ftp://example.com")).rejects.toThrow("Unsupported protocol");
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow("Unsupported protocol");
    await expect(validateUrl("javascript:alert(1)")).rejects.toThrow("Unsupported protocol");
  });

  it("rejects localhost", async () => {
    await expect(validateUrl("http://localhost:3000")).rejects.toThrow("Blocked internal hostname");
  });

  it("rejects 0.0.0.0", async () => {
    await expect(validateUrl("http://0.0.0.0")).rejects.toThrow("Blocked internal hostname");
  });

  it("rejects ::1", async () => {
    await expect(validateUrl("http://[::1]:8080")).rejects.toThrow("Blocked internal hostname");
  });

  it("rejects .local domains", async () => {
    await expect(validateUrl("http://myserver.local")).rejects.toThrow("Blocked internal hostname");
  });

  it("rejects private IPv4 ranges", async () => {
    await expect(validateUrl("http://127.0.0.1")).rejects.toThrow("Blocked private IP");
    await expect(validateUrl("http://10.0.0.1")).rejects.toThrow("Blocked private IP");
    await expect(validateUrl("http://192.168.1.1")).rejects.toThrow("Blocked private IP");
    await expect(validateUrl("http://169.254.1.1")).rejects.toThrow("Blocked private IP");
    await expect(validateUrl("http://172.16.0.1")).rejects.toThrow("Blocked private IP");
    await expect(validateUrl("http://172.31.255.255")).rejects.toThrow("Blocked private IP");
  });

  it("accepts public IPs", async () => {
    await expect(validateUrl("http://8.8.8.8")).resolves.toBe("http://8.8.8.8/");
    await expect(validateUrl("http://1.1.1.1")).resolves.toBe("http://1.1.1.1/");
  });

  it("rejects 172.15.x.x (not private)", async () => {
    // 172.15 is NOT in 172.16.0.0/12, should be allowed (but DNS lookup may fail in test)
    // We just verify it doesn't throw our private IP error
    try {
      await validateUrl("http://172.15.0.1");
    } catch (err) {
      expect((err as Error).message).not.toContain("Blocked private IP");
    }
  });
});

// ── webSearch ──

describe("webSearch", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearSearchCache();
  });

  it("returns error for empty query", async () => {
    const result = await webSearch({ query: "" });
    expect(result).toContain("query is empty");
  });

  it("returns error for whitespace-only query", async () => {
    const result = await webSearch({ query: "   " });
    expect(result).toContain("query is empty");
  });

  it("parses DuckDuckGo results correctly", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com/page1">Example Page 1</a>
        <div class="result__snippet">This is snippet 1</div>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.com/page2">Example Page 2</a>
        <div class="result__snippet">This is snippet 2</div>
      </div>
    `;

    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse(html, { status: 200 }),
      },
    ]);

    const result = await webSearch({ query: "test" }, { fetch });
    expect(result).toContain("Example Page 1");
    expect(result).toContain("https://example.com/page1");
    expect(result).toContain("This is snippet 1");
    expect(result).toContain("Example Page 2");
  });

  it("handles DuckDuckGo 202 rate limit", async () => {
    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse("", { status: 202 }),
      },
    ]);

    const result = await webSearch({ query: "test" }, { fetch });
    expect(result).toContain("202");
    expect(result).toContain("rate limited");
  });

  it("handles HTTP errors", async () => {
    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
      },
    ]);

    const result = await webSearch({ query: "test" }, { fetch });
    expect(result).toContain("HTTP 500");
  });

  it("handles network timeout", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse("ok"),
        delay: 20_000, // longer than FETCH_TIMEOUT_MS (15000)
      },
    ]);

    const promise = webSearch({ query: "test" }, { fetch });
    // Advance past FETCH_TIMEOUT_MS to trigger the abort
    await vi.advanceTimersByTimeAsync(16_000);
    const result = await promise;
    expect(result).toContain("timeout");
    vi.useRealTimers();
  });

  it("handles no results found page", async () => {
    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse("<html>No results found for this query</html>"),
      },
    ]);

    const result = await webSearch({ query: "xyz12345nonsense" }, { fetch });
    expect(result).toContain("No results found");
  });

  it("handles parse failure (unexpected HTML)", async () => {
    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse("<html><body>Some unexpected content</body></html>"),
      },
    ]);

    const result = await webSearch({ query: "test" }, { fetch });
    expect(result).toContain("Failed to parse");
  });

  it("caches results and returns cached on second call", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com">Cached Result</a>
        <div class="result__snippet">Snippet</div>
      </div>
    `;

    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse(html),
      },
    ]);

    const result1 = await webSearch({ query: "cache-test" }, { fetch });
    expect(result1).toContain("Cached Result");
    expect(fetch).toHaveBeenCalledTimes(1);

    const result2 = await webSearch({ query: "cache-test" }, { fetch });
    expect(result2).toContain("[cached]");
    expect(result2).toContain("Cached Result");
    expect(fetch).toHaveBeenCalledTimes(1); // not called again
  });

  it("handles DuckDuckGo redirect URLs (r.duckduckgo.com)", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com">Title</a>
        <div class="result__snippet">Snippet</div>
      </div>
    `;

    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse(html),
      },
    ]);

    const result = await webSearch({ query: "test" }, { fetch });
    // The URL should be the resolved target, not the redirect path
    expect(result).toContain("https://example.com");
    expect(result).not.toContain("/l/?kh=");
    expect(result).not.toContain("uddg=");
  });

  it("limits to 10 results", async () => {
    let html = "";
    for (let i = 0; i < 20; i++) {
      html += `
        <div class="result">
          <a class="result__a" href="https://example.com/${i}">Title ${i}</a>
          <div class="result__snippet">Snippet ${i}</div>
        </div>
      `;
    }

    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse(html),
      },
    ]);

    const result = await webSearch({ query: "test" }, { fetch });
    const matches = result.match(/Title \d+/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(10);
  });
});

// ── webFetch ──

describe("webFetch", () => {
  it("returns error for empty URL", async () => {
    const result = await webFetch({ url: "" });
    expect(result).toContain("url is empty");
  });

  it("returns error for invalid URL", async () => {
    const result = await webFetch({ url: "not-a-url" });
    expect(result).toContain("URL validation failed");
  });

  it("returns error for blocked private URL", async () => {
    const result = await webFetch({ url: "http://localhost/admin" });
    expect(result).toContain("Blocked internal hostname");
  });

  it("fetches and extracts content", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Page</title></head>
        <body>
          <article>
            <h1>Hello World</h1>
            <p>This is the main content.</p>
          </article>
        </body>
      </html>
    `;

    const fetch = mockFetch([
      {
        url: "https://example.com/article",
        response: mockResponse(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      },
    ]);

    const result = await webFetch({ url: "https://example.com/article" }, { fetch });
    expect(result).toContain("Test Page");
    expect(result).toContain("Hello World");
    expect(result).toContain("This is the main content.");
  });

  it("handles non-UTF-8 charset", async () => {
    const buffer = new TextEncoder().encode("中文内容");
    // Simulate GBK encoded content by creating a response with gb2312 charset
    const response = new Response(buffer, {
      status: 200,
      headers: { "content-type": "text/html; charset=gb2312" },
    });

    const fetch = mockFetch([
      {
        url: "https://example.com/gbk",
        response,
      },
    ]);

    const result = await webFetch({ url: "https://example.com/gbk" }, { fetch });
    // Node.js TextDecoder supports gb2312, so it should decode successfully
    // The content may be garbled since we encoded UTF-8 bytes as GB2312,
    // but the function should not throw an error
    expect(result).toContain("[URL] https://example.com/gbk");
  });

  it("handles HTTP errors", async () => {
    const fetch = mockFetch([
      {
        url: "https://example.com/404",
        response: mockResponse("Not Found", { status: 404, statusText: "Not Found" }),
      },
    ]);

    const result = await webFetch({ url: "https://example.com/404" }, { fetch });
    expect(result).toContain("HTTP 404");
  });

  it("handles network timeout", async () => {
    // Simulate what fetchWithTimeout would throw after a timeout:
    // the fetch rejects with an AbortError, which fetchWithTimeout
    // converts to a "Request timeout" error.
    const fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const result = await webFetch({ url: "https://example.com/slow" }, { fetch });
    expect(result).toContain("timeout");
  });

  it("truncates long content to 8000 chars", async () => {
    const longContent = "A".repeat(20_000);
    const html = `<html><head><title>Long</title></head><body><article>${longContent}</article></body></html>`;

    const fetch = mockFetch([
      {
        url: "https://example.com/long",
        response: mockResponse(html),
      },
    ]);

    const result = await webFetch({ url: "https://example.com/long" }, { fetch });
    const contentMatch = result.match(/A+/);
    expect(contentMatch).toBeTruthy();
    expect(contentMatch![0].length).toBeLessThanOrEqual(8000);
    expect(result).toContain("more chars");
  });

  it("extracts content without article/main tags (fallback to body)", async () => {
    const html = `
      <html>
        <head><title>Fallback Test</title></head>
        <body>
          <div>Some content here</div>
          <p>More content</p>
        </body>
      </html>
    `;

    const fetch = mockFetch([
      {
        url: "https://example.com/fallback",
        response: mockResponse(html),
      },
    ]);

    const result = await webFetch({ url: "https://example.com/fallback" }, { fetch });
    expect(result).toContain("Fallback Test");
    expect(result).toContain("Some content here");
  });

  it("removes noise elements (script, style, nav, etc.)", async () => {
    const html = `
      <html>
        <head><title>Noise Test</title></head>
        <body>
          <nav>Navigation should be removed</nav>
          <article>Keep this content</article>
          <footer>Footer should be removed</footer>
          <script>alert('xss')</script>
        </body>
      </html>
    `;

    const fetch = mockFetch([
      {
        url: "https://example.com/noise",
        response: mockResponse(html),
      },
    ]);

    const result = await webFetch({ url: "https://example.com/noise" }, { fetch });
    expect(result).toContain("Keep this content");
    expect(result).not.toContain("Navigation should be removed");
    expect(result).not.toContain("Footer should be removed");
    expect(result).not.toContain("alert");
  });

  it("handles missing title gracefully", async () => {
    const html = `<html><body><article>Content without title</article></body></html>`;

    const fetch = mockFetch([
      {
        url: "https://example.com/no-title",
        response: mockResponse(html),
      },
    ]);

    const result = await webFetch({ url: "https://example.com/no-title" }, { fetch });
    expect(result).toContain("(no title)");
  });
});

// ── Edge cases ──

describe("edge cases", () => {
  it("webSearch handles query with special characters", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com">Test</a>
        <div class="result__snippet">Result for C++ programming</div>
      </div>
    `;

    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse(html),
      },
    ]);

    const result = await webSearch({ query: "C++ programming & more!" }, { fetch });
    expect(result).toContain("Result for C++ programming");
  });

  it("webSearch handles very long query", async () => {
    const longQuery = "a".repeat(500);
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com">Test</a>
        <div class="result__snippet">Result</div>
      </div>
    `;

    const fetch = mockFetch([
      {
        url: /duckduckgo\.com/,
        response: mockResponse(html),
      },
    ]);

    const result = await webSearch({ query: longQuery }, { fetch });
    expect(result).toContain("Result");
  });

  it("webFetch handles URL with query parameters and fragments", async () => {
    const html = `<html><head><title>Query Test</title></head><body><article>Content</article></body></html>`;

    const fetch = mockFetch([
      {
        url: "https://example.com/page?q=1&foo=bar#section",
        response: mockResponse(html),
      },
    ]);

    const result = await webFetch({ url: "https://example.com/page?q=1&foo=bar#section" }, { fetch });
    expect(result).toContain("Query Test");
  });

  it("webFetch handles redirect responses", async () => {
    const fetch = mockFetch([
      {
        url: "https://example.com/redirect",
        response: mockResponse("", { status: 301, statusText: "Moved Permanently" }),
      },
    ]);

    const result = await webFetch({ url: "https://example.com/redirect" }, { fetch });
    expect(result).toContain("HTTP 301");
  });
});
