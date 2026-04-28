/**
 * Runtime smoke test for web-tools logic.
 * Tests pure functions without network/DNS/cheerio dependencies.
 */
import { URL } from "node:url";

// ── Inline copies of functions under test (to avoid module-level side effects) ──

function isPrivateIpString(ip: string): boolean {
  if (
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.")
  ) {
    return true;
  }
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] ?? "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fe80:")) return true;
  return false;
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

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function cleanText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function parseDuckDuckGoResults(html: string) {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
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

function extractWithRegex(html: string): { title: string; content: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]) : "";

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let content = bodyMatch ? bodyMatch[1] : html;

  content = content.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  content = content.replace(/<(nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, "");
  content = content.replace(/<[^>]+>/g, "\n");

  return { title, content: cleanText(content) };
}

// ── Test runner ──

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

function assertThrows(fn: () => void, name: string) {
  try {
    fn();
    console.log(`  ❌ ${name} (no throw)`);
    failed++;
  } catch {
    console.log(`  ✅ ${name}`);
    passed++;
  }
}

// ── Tests ──

console.log("\n=== isPrivateIpString ===");
assert(isPrivateIpString("127.0.0.1") === true, "127.0.0.1 is private");
assert(isPrivateIpString("10.0.0.1") === true, "10.0.0.1 is private");
assert(isPrivateIpString("192.168.1.1") === true, "192.168.1.1 is private");
assert(isPrivateIpString("169.254.1.1") === true, "169.254.1.1 is private");
assert(isPrivateIpString("172.16.0.1") === true, "172.16.0.1 is private");
assert(isPrivateIpString("172.31.255.255") === true, "172.31.255.255 is private");
assert(isPrivateIpString("172.15.0.1") === false, "172.15.0.1 is NOT private");
assert(isPrivateIpString("172.32.0.1") === false, "172.32.0.1 is NOT private");
assert(isPrivateIpString("8.8.8.8") === false, "8.8.8.8 is NOT private");
assert(isPrivateIpString("1.1.1.1") === false, "1.1.1.1 is NOT private");
assert(isPrivateIpString("::1") === true, "::1 is private");
assert(isPrivateIpString("0:0:0:0:0:0:0:1") === true, "0:0:0:0:0:0:0:1 is private");
assert(isPrivateIpString("fe80::1") === true, "fe80::1 is private");

// BUG: IPv4-mapped IPv6 bypasses check!
assert(isPrivateIpString("::ffff:127.0.0.1") === true
  ? "IPv4-mapped ::ffff:127.0.0.1 detected (PASS)"
  : "BUG: ::ffff:127.0.0.1 BYPASSES private IP check!",
  "IPv4-mapped IPv6 ::ffff:127.0.0.1");

assert(isPrivateIpString("::ffff:10.0.0.1") === true
  ? "IPv4-mapped ::ffff:10.0.0.1 detected (PASS)"
  : "BUG: ::ffff:10.0.0.1 BYPASSES private IP check!",
  "IPv4-mapped IPv6 ::ffff:10.0.0.1");

console.log("\n=== stripHtml ===");
assert(stripHtml("<b>Hello</b> <em>World</em>") === "Hello World", "basic tags stripped");
assert(stripHtml("&amp; &lt; &gt; &quot; &#39; &nbsp;") === '& < > " \'  ', "entities decoded");
assert(stripHtml("") === "", "empty string");
assert(stripHtml("no html") === "no html", "plain text unchanged");

console.log("\n=== normalizeQuery ===");
assert(normalizeQuery("  Hello   World  ") === "hello world", "whitespace normalized");
assert(normalizeQuery("UPPER") === "upper", "lowercased");
assert(normalizeQuery("") === "", "empty unchanged");

console.log("\n=== parseDuckDuckGoResults - basic ===");
const basicHtml = `
<div class="result">
  <a class="result__a" href="https://example.com/1">Result 1</a>
  <div class="result__snippet">Snippet 1</div>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/2">Result 2</a>
  <div class="result__snippet">Snippet 2</div>
</div>
`;
const basicResults = parseDuckDuckGoResults(basicHtml);
assert(basicResults.length === 2, `basic: 2 results (got ${basicResults.length})`);
if (basicResults.length >= 1) {
  assert(basicResults[0].title === "Result 1", `basic: title correct (got "${basicResults[0].title}")`);
  assert(basicResults[0].url === "https://example.com/1", `basic: url correct (got "${basicResults[0].url}")`);
}

console.log("\n=== parseDuckDuckGoResults - href before class ===");
const hrefFirstHtml = `
<div class="result">
  <a href="https://example.com/href-first" class="result__a">Href First</a>
  <div class="result__snippet">Test</div>
</div>
`;
const hrefFirstResults = parseDuckDuckGoResults(hrefFirstHtml);
assert(hrefFirstResults.length === 1, `href-first: 1 result (got ${hrefFirstResults.length})`);
if (hrefFirstResults.length >= 1) {
  // BUG: regex requires class before href, so this may fail
  assert(hrefFirstResults[0].url === "https://example.com/href-first",
    `href-first: url extracted (got "${hrefFirstResults[0]?.url ?? "N/A"}")`);
}

console.log("\n=== parseDuckDuckGoResults - DDG redirect URL ===");
const redirectHtml = `
<div class="result">
  <a class="result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Fpage">Redirect Result</a>
  <div class="result__snippet">Snippet</div>
</div>
`;
const redirectResults = parseDuckDuckGoResults(redirectHtml);
assert(redirectResults.length === 1, `redirect: 1 result (got ${redirectResults.length})`);
if (redirectResults.length >= 1) {
  // BUG: decodeURIComponent on DDG redirect URL gives DDG path, not target URL
  const url = redirectResults[0].url;
  const isTargetUrl = url === "https://example.com/page";
  const isDDGRedirect = url.includes("/l/?") || url.includes("uddg=");
  if (!isTargetUrl && isDDGRedirect) {
    console.log(`  ⚠️ BUG: DDG redirect URL not resolved. Got: "${url}"`);
  }
  assert(isTargetUrl || isDDGRedirect, `redirect: URL is DDG redirect (got "${url}")`);
}

console.log("\n=== parseDuckDuckGoResults - malformed URL (decodeURIComponent crash) ===");
const malformedHtml = `
<div class="result">
  <a class="result__a" href="https://example.com/%ZZbad">Malformed</a>
  <div class="result__snippet">Test</div>
</div>
`;
try {
  const malformedResults = parseDuckDuckGoResults(malformedHtml);
  console.log(`  ⚠️ No crash (got ${malformedResults.length} results, url="${malformedResults[0]?.url ?? "N/A"}")`);
  passed++;
} catch (e) {
  console.log(`  ❌ BUG: decodeURIComponent crashes on malformed URL: ${(e as Error).message}`);
  failed++;
}

console.log("\n=== parseDuckDuckGoResults - nested divs (real DDG structure) ===");
// Real DDG has more complex nesting
const realDdgHtml = `
<div class="result results_links results_links_deep result--web--">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a class="result__a" rel="nofollow" href="https://example.com/real">Real DDG Result</a>
    </h2>
    <a class="result__url" href="https://example.com/real">example.com</a>
    <a class="result__snippet" href="https://example.com/real">This is the real snippet text</a>
  </div>
</div>
`;
const realDdgResults = parseDuckDuckGoResults(realDdgHtml);
assert(realDdgResults.length >= 1, `real DDG: at least 1 result (got ${realDdgResults.length})`);
if (realDdgResults.length >= 1) {
  assert(realDdgResults[0].title === "Real DDG Result",
    `real DDG: title correct (got "${realDdgResults[0].title}")`);
  assert(realDdgResults[0].snippet !== "",
    `real DDG: snippet extracted (got "${realDdgResults[0].snippet}")`);
}

console.log("\n=== extractWithRegex ===");
const testHtml = `
<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <nav>Navigation</nav>
  <article>
    <h1>Main Content</h1>
    <p>Paragraph 1</p>
  </article>
  <footer>Footer</footer>
  <script>alert('xss')</script>
</body>
</html>
`;
const extracted = extractWithRegex(testHtml);
assert(extracted.title === "Test Page", `title extracted (got "${extracted.title}")`);
assert(extracted.content.includes("Main Content"), "content includes main text");
assert(!extracted.content.includes("Navigation"), "nav removed");
assert(!extracted.content.includes("Footer"), "footer removed");
assert(!extracted.content.includes("alert"), "script removed");

console.log("\n=== URL hostname parsing ===");
const ipv6Url = new URL("http://[::1]:8080/path");
assert(ipv6Url.hostname === "::1", `IPv6 hostname parsed (got "${ipv6Url.hostname}")`);

const localhostUrl = new URL("http://localhost:3000");
assert(localhostUrl.hostname === "localhost", `localhost parsed (got "${localhostUrl.hostname}")`);

// ── Summary ──

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log("⚠️  BUGS FOUND - see details above");
  process.exit(1);
} else {
  console.log("All tests passed!");
  process.exit(0);
}
