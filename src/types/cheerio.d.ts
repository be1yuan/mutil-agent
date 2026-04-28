// Type stub for optional cheerio dependency.
// cheerio is an optional dependency — the web-tools module falls back
// to regex-based HTML extraction when it's not installed.

declare module "cheerio" {
  interface CheerioStatic {
    (selector: string): CheerioStatic;
    text(): string;
    remove(): CheerioStatic;
  }

  export function load(html: string): CheerioStatic;
}
