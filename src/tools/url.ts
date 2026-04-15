import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { z } from "zod";
import { chromium, type Browser, type Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DEFAULT_USER_AGENT =
  process.env.URL_TOOL_USER_AGENT ??
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_CAP_MS = 5_000;
const AUTO_SCROLL_STEP_DELAY_MS = 250;
const AUTO_SCROLL_BUDGET_MS = 5_000;
const POST_SCROLL_IDLE_CAP_MS = 2_000;

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  const current = browserPromise;
  if (!current) return;
  browserPromise = null;
  try {
    const browser = await current;
    await browser.close();
  } catch {
    // Ignore close errors during shutdown.
  }
}

interface FetchOptions {
  userAgent?: string;
  timeoutMs?: number;
  raw?: boolean;
}

export interface ArticleResult {
  url: string;
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  site_name: string | null;
  lang: string | null;
  published_time: string | null;
  length: number | null;
  fallback: boolean;
  markdown: string;
}

function buildTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    bulletListMarker: "-",
  });
  td.use(gfm);
  return td;
}

// Scroll the page by one viewport at a time to trigger lazy-load and
// infinite-scroll handlers, walking every element through the viewport so
// IntersectionObserver callbacks actually fire. Exits early when we're at the
// bottom and scrollBy has nothing left to advance for two consecutive steps
// (robust against brief network jitter that briefly stalls growth), or when
// the wall-clock budget is exhausted.
async function autoScroll(page: Page): Promise<void> {
  const deadline = Date.now() + AUTO_SCROLL_BUDGET_MS;
  let stuckSteps = 0;
  while (Date.now() < deadline) {
    const { scrolled, atBottom } = await page.evaluate(() => {
      const before = window.scrollY;
      window.scrollBy(0, window.innerHeight);
      return {
        scrolled: window.scrollY - before,
        atBottom:
          window.scrollY + window.innerHeight >=
          document.documentElement.scrollHeight - 1,
      };
    });
    if (atBottom && scrolled === 0) {
      stuckSteps += 1;
      if (stuckSteps >= 2) return;
    } else {
      stuckSteps = 0;
    }
    await page.waitForTimeout(AUTO_SCROLL_STEP_DELAY_MS);
  }
}

async function fetchHtml(
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<{ html: string; finalUrl: string }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (response && !response.ok()) {
      throw new Error(
        `HTTP ${response.status()} ${response.statusText()} fetching ${url}`,
      );
    }
    // Best-effort secondary wait so SPAs get a chance to hydrate and fetch data.
    // Capped because many sites long-poll and never truly go idle.
    try {
      await page.waitForLoadState("networkidle", {
        timeout: NETWORK_IDLE_CAP_MS,
      });
    } catch {
      // networkidle timed out — proceed with whatever the page has rendered.
    }
    await autoScroll(page);
    // Give any scroll-triggered requests a brief window to settle.
    try {
      await page.waitForLoadState("networkidle", {
        timeout: POST_SCROLL_IDLE_CAP_MS,
      });
    } catch {
      // Same rationale as above — proceed regardless.
    }
    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Timeout after ${timeoutMs}ms fetching ${url}`);
    }
    throw err;
  } finally {
    await page.close();
    await context.close();
  }
}

export async function fetchAsMarkdown(
  url: string,
  opts: FetchOptions = {},
): Promise<ArticleResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported protocol: ${parsed.protocol} (only http/https allowed)`,
    );
  }

  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { html, finalUrl } = await fetchHtml(
    parsed.toString(),
    userAgent,
    timeoutMs,
  );

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(html, { url: finalUrl, virtualConsole });
  const document = dom.window.document;
  const td = buildTurndown();

  try {
    const pageTitle = document.title || null;
    const pageLang = document.documentElement.lang || null;

    if (opts.raw) {
      const bodyHtml = document.body?.innerHTML ?? "";
      return {
        url: finalUrl,
        title: pageTitle,
        byline: null,
        excerpt: null,
        site_name: null,
        lang: pageLang,
        published_time: null,
        length: bodyHtml.length,
        fallback: true,
        markdown: td.turndown(bodyHtml),
      };
    }

    // Snapshot body HTML before Readability mutates the DOM, so we can fall
    // back to converting the full body if Readability returns null.
    const originalBodyHtml = document.body?.innerHTML ?? "";
    const article = new Readability(document).parse();

    if (!article || !article.content) {
      return {
        url: finalUrl,
        title: pageTitle,
        byline: null,
        excerpt: null,
        site_name: null,
        lang: pageLang,
        published_time: null,
        length: originalBodyHtml.length,
        fallback: true,
        markdown: td.turndown(originalBodyHtml),
      };
    }

    return {
      url: finalUrl,
      title: article.title ?? pageTitle,
      byline: article.byline ?? null,
      excerpt: article.excerpt ?? null,
      site_name: article.siteName ?? null,
      lang: article.lang ?? pageLang,
      published_time: article.publishedTime ?? null,
      length: article.length ?? null,
      fallback: false,
      markdown: td.turndown(article.content),
    };
  } finally {
    dom.window.close();
  }
}

function mapError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "read_url failed: unknown error";
}

function errorResult(err: unknown) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: mapError(err) }],
  };
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function registerUrlTools(server: McpServer): void {
  server.registerTool(
    "read_url",
    {
      title: "Read URL as Markdown",
      description:
        "Fetch a URL and return the article body as clean markdown. " +
        "Uses Mozilla Readability to strip navigation/ads/footers, then Turndown " +
        "(with GFM extensions) for HTML → markdown conversion. Sends a custom " +
        "User-Agent that may succeed where stricter sites block generic bot UAs. " +
        "Set `raw: true` to skip Readability and convert the full <body>. " +
        "Output includes title, byline, excerpt, language, and publish time when available. " +
        "Sets `fallback: true` when Readability couldn't parse and the full body was used.",
      inputSchema: {
        url: z.url().describe("Absolute http(s) URL to fetch"),
        user_agent: z
          .string()
          .optional()
          .describe("Override the User-Agent header for this request"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Fetch timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`,
          ),
        raw: z
          .boolean()
          .optional()
          .describe("Skip Readability and convert the full <body> instead"),
      },
    },
    async ({ url, user_agent, timeout_ms, raw }) => {
      try {
        const result = await fetchAsMarkdown(url, {
          userAgent: user_agent,
          timeoutMs: timeout_ms,
          raw,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
