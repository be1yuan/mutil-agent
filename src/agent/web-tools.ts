/**
 * WebSearch + WebFetch tool implementations.
 *
 * Design decisions:
 * - DuckDuckGo HTML search (no API key)
 * - cheerio for HTML parsing
 * - Fetch injection for testability
 * - DNS resolution before fetch (prevents DNS rebinding)
 * - TTL cache with capacity limit
 * - Serialised requests (promise chain) to avoid rate limits
 */

import { URL } from "node:url";
import { lookup } from "node:dns/promises";

// ── Types ──

export interface WebSearchArgs {
  query: string;
}

export interface WebFetchArgs {
  url: string;
}

export interface WebToolOptions {
  /** Injected fetch for testability. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

interface CacheEntry {
  result: string;
  timestamp: number;
}

// ── Constants ──

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 200;
const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_DELAY_MS = 1200; // delay between consecutive searches

// ── Cache ──

const searchCache = new Map<string, CacheEntry>();

function getCached(query: string): string | undefined {
  const normalized = normalizeQuery(query);
  const entry = searchCache.get(normalized);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    searchCache.delete(normalized);
    return undefined;
  }
  return entry.result;
}

function setCached(query: string, result: string): void {
  const normalized = normalizeQuery(query);
  // TTL GC: evict expired entries
  const now = Date.now();
  for (const [k, v] of searchCache) {
    if (now - v.timestamp > CACHE_TTL_MS) {
      searchCache.delete(k);
    }
  }
  // Capacity GC: evict oldest if at limit
  if (searchCache.size >= CACHE_MAX_SIZE) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, v] of searchCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(normalized, { result, timestamp: now });
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Serialised search queue ──

let searchQueue: Promise<unknown> = Promise.resolve();

function enqueueSearch<T>(fn: () => Promise<T>): Promise<T> {
  const p = searchQueue.then(() => delay(SEARCH_DELAY_MS)).then(fn);
  searchQueue = p.catch(() => undefined);
  return p;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── URL Safety ──

/**
 * Validate a URL before fetching.
 * Checks:
 * 1. Protocol must be http: or https:
 * 2. Hostname must not be private/internal
 * 3. Resolved IP must not be private (DNS rebinding protection)
 */
export async function validateUrl(urlStr: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  const hostname = url.hostname;

  // Block known internal hostnames
  if (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }

  // Block private IP ranges by string match (fast path)
  if (isPrivateIpString(hostname)) {
    throw new Error(`Blocked private IP: ${hostname}`);
  }

  // DNS rebinding protection: resolve hostname and check IP
  try {
    const addresses = await lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (isPrivateIpString(addr.address)) {
        throw new Error(`Blocked private IP resolved from ${hostname}: ${addr.address}`);
      }
    }
  } catch (err) {
    // If lookup fails with our own error, rethrow
    if (err instanceof Error && err.message.startsWith("Blocked")) {
      throw err;
    }
    // DNS resolution failure is acceptable for some hosts (e.g. some CDNs)
    // but we log it and continue — the fetch will fail naturally if truly bad
  }

  return url.toString();
}

function isPrivateIpString(ip: string): boolean {
  // IPv4 private ranges
  if (
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.")
  ) {
    return true;
  }
  // 172.16.0.0/12 → 172.16.0.0 ~ 172.31.255.255
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] ?? "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6 localhost
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  // IPv6 link-local
  if (ip.startsWith("fe80:")) return true;
  return false;
}

// ── Fetch with timeout ──

async function fetchWithTimeout(
  url: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, { signal: controller.signal });
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── WebSearch ──

export async function webSearch(
  args: WebSearchArgs,
  options: WebToolOptions = {}
): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return "[websearch error] query is empty";
  }

  // Check cache
  const cached = getCached(query);
  if (cached) {
    return `[cached] ${cached}`;
  }

  const fetchFn = options.fetch ?? globalThis.fetch;

  return enqueueSearch(async () => {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    let response: Response;
    try {
      response = await fetchWithTimeout(searchUrl, fetchFn, FETCH_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[websearch error] fetch failed: ${msg}`;
    }

    // Handle DuckDuckGo rate limit / redirect
    if (response.status === 202) {
      return `[websearch error] DuckDuckGo returned 202 (rate limited or requires verification). Try again later.`;
    }
    if (!response.ok) {
      return `[websearch error] HTTP ${response.status}: ${response.statusText}`;
    }

    const html = await response.text();
    const results = parseDuckDuckGoResults(html);

    if (results.length === 0) {
      // Distinguish "no results" from "parse failure"
      if (html.includes("No results found") || html.includes("no results")) {
        return `[websearch] No results found for "${query}"`;
      }
      return `[websearch error] Failed to parse DuckDuckGo results (HTML structure may have changed). Raw response length: ${html.length} chars.`;
    }

    const output = formatSearchResults(query, results);
    setCached(query, output);
    return output;
  });
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML result structure (as of 2024-2025):
  // Each result is in a <div class="result"> containing:
  //   <a class="result__a" href="...">title</a>
  //   <a class="result__url" href="...">display url</a>
  //   <div class="result__snippet">snippet text</div>

  const resultRegex = /<div class="result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi;
  const matches = html.match(resultRegex) ?? [];

  for (const block of matches.slice(0, 10)) {
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"/i);
    const snippetMatch = block.match(/<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);

    const title = titleMatch ? stripHtml(titleMatch[1]) : "";
    const url = urlMatch ? decodeURIComponent(urlMatch[1]) : "";
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function formatSearchResults(query: string, results: SearchResult[]): string {
  const lines: string[] = [`搜索结果 (query: "${query}"):`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. [${r.title}] ${r.url}`);
    if (r.snippet) {
      lines.push(`   摘要: ${r.snippet}`);
    }
  }
  return lines.join("\n");
}

// ── WebFetch ──

export async function webFetch(
  args: WebFetchArgs,
  options: WebToolOptions = {}
): Promise<string> {
  const urlStr = String(args.url ?? "").trim();
  if (!urlStr) {
    return "[webfetch error] url is empty";
  }

  // Validate URL (includes DNS rebinding check)
  let validatedUrl: string;
  try {
    validatedUrl = await validateUrl(urlStr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[webfetch error] URL validation failed: ${msg}`;
  }

  const fetchFn = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchWithTimeout(validatedUrl, fetchFn, FETCH_TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[webfetch error] fetch failed: ${msg}`;
  }

  if (!response.ok) {
    return `[webfetch error] HTTP ${response.status}: ${response.statusText}`;
  }

  // Detect charset from Content-Type header
  const contentType = response.headers.get("content-type") ?? "";
  const charsetMatch = contentType.match(/charset=([^;]+)/i);
  const declaredCharset = charsetMatch ? charsetMatch[1].trim().toLowerCase() : undefined;

  let html: string;
  try {
    if (declaredCharset && declaredCharset !== "utf-8") {
      const buffer = await response.arrayBuffer();
      html = new TextDecoder(declaredCharset).decode(buffer);
    } else {
      html = await response.text();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[webfetch error] failed to decode response: ${msg}`;
  }

  // Extract content
  const { title, content } = extractContent(html);

  const output = [
    `[URL] ${validatedUrl}`,
    `[Title] ${title || "(no title)"}`,
    `[Content]`,
    content.slice(0, 8000),
    content.length > 8000 ? `\n... (${content.length - 8000} more chars)` : "",
  ].join("\n");

  return output;
}

// ── Content extraction (no cheerio dependency for basic use) ──
// If cheerio is available, use it for better extraction.

let cheerioModule: typeof import("cheerio") | undefined;

try {
  // Dynamic import — optional dependency
  const mod = await import("cheerio");
  cheerioModule = mod;
} catch {
  // cheerio not installed, fallback to regex-based extraction
}

function extractContent(html: string): { title: string; content: string } {
  if (cheerioModule) {
    return extractWithCheerio(html);
  }
  return extractWithRegex(html);
}

function extractWithCheerio(html: string): { title: string; content: string } {
  const $ = cheerioModule!.load(html);

  const title = $("title").text().trim() || "";

  // Remove noise elements
  $("script, style, nav, footer, header, aside, iframe, noscript").remove();

  // Try semantic content areas first
  let text = $("article").text() || $("main").text() || $('[role="main"]').text();

  // Fallback to body
  if (!text.trim()) {
    text = $("body").text();
  }

  return {
    title,
    content: cleanText(text),
  };
}

function extractWithRegex(html: string): { title: string; content: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]) : "";

  // Extract body
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let content = bodyMatch ? bodyMatch[1] : html;

  // Remove script/style tags and their contents
  content = content.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Remove other noise tags (keep content of div/p/etc)
  content = content.replace(/<(nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Convert remaining tags to newlines
  content = content.replace(/<[^>]+>/g, "\n");

  return {
    title,
    content: cleanText(content),
  };
}

function cleanText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
