import { fetchAsMarkdown, closeBrowser } from "../tools/url.js";

const url = process.argv[2] ?? "https://example.com";
const raw = process.argv.includes("--raw");

async function main(): Promise<void> {
  try {
    const result = await fetchAsMarkdown(url, { raw });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}

void main();
