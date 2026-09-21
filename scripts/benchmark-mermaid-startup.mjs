import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repository = resolve(
  process.env.MM_MERMAID_BENCHMARK_REPOSITORY ??
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const port = Number(process.env.MM_MERMAID_BENCHMARK_PORT ?? "4176");
const samples = Math.max(
  1,
  Number.parseInt(process.env.MM_MERMAID_BENCHMARK_SAMPLES ?? "5", 10) || 5,
);
const baseUrl = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ["tests/browser/server.mjs"], {
  cwd: repository,
  env: { ...process.env, MM_BROWSER_PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const ordinary = await measure(browser, "", "ordinary");
    const mermaid = await measure(browser, "?fixture=mermaid", "mermaid");
    const packageJson = JSON.parse(
      await readFile(resolve(repository, "package.json"), "utf8"),
    );
    const bundleNames = [
      "extension.js",
      "webview.js",
      "mermaid-loader.js",
      "mermaid.js",
    ];
    const bundleSizes = Object.fromEntries(
      await Promise.all(
        bundleNames.map(async (name) => [
          name,
          await fileSizeOrNull(resolve(repository, "dist", name)),
        ]),
      ),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          packageVersion: packageJson.version,
          samples,
          ordinary: summarize(ordinary),
          mermaid: summarize(mermaid),
          bundleBytes: bundleSizes,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGINT");
}

async function fileSizeOrNull(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {
      // The server may still be binding its local test port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Browser benchmark server did not start on ${baseUrl}`);
}

async function measure(browser, query, kind) {
  const measurements = [];
  for (let index = 0; index < samples; index += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/${query}`, { waitUntil: "domcontentloaded" });
      await page.locator(".ProseMirror").waitFor({ state: "attached" });
      if (kind === "mermaid")
        await page
          .locator('.mm-mermaid[data-mm-mermaid-state="rendered"]')
          .first()
          .waitFor({ state: "attached" });
      measurements.push(
        await page.evaluate(() => {
          const resourceEntries = performance
            .getEntriesByType("resource")
            .filter((entry) => {
              try {
                return new URL(entry.name).pathname.endsWith("/mermaid.js");
              } catch {
                return false;
              }
            });
          const firstUse = performance.getEntriesByName(
            "markdown-mint-mermaid-first-use",
          )[0];
          const firstRendered = performance.getEntriesByName(
            "markdown-mint-mermaid-first-rendered",
          )[0];
          const loadStart = performance.getEntriesByName(
            "markdown-mint-mermaid-load-start",
          )[0];
          const loadEnd = performance.getEntriesByName(
            "markdown-mint-mermaid-load-end",
          )[0];
          return {
            timeToEditableMs: performance.now(),
            mermaidRuntimeRequests: resourceEntries.length,
            mermaidRuntimeBytes: resourceEntries.reduce(
              (total, entry) => total + (entry.transferSize || 0),
              0,
            ),
            firstUseLatencyMs:
              firstUse && firstRendered
                ? firstRendered.startTime - firstUse.startTime
                : null,
            runtimeLoadMs:
              loadStart && loadEnd
                ? loadEnd.startTime - loadStart.startTime
                : null,
          };
        }),
      );
    } finally {
      await context.close();
    }
  }
  return measurements;
}

function summarize(values) {
  const fields = [
    "timeToEditableMs",
    "mermaidRuntimeRequests",
    "mermaidRuntimeBytes",
    "firstUseLatencyMs",
    "runtimeLoadMs",
  ];
  return Object.fromEntries(
    fields.map((field) => {
      const numbers = values
        .map((value) => value[field])
        .filter((value) => typeof value === "number")
        .sort((left, right) => left - right);
      return [
        field,
        numbers.length === 0
          ? null
          : {
              median: numbers[Math.floor(numbers.length / 2)],
              min: numbers[0],
              max: numbers.at(-1),
            },
      ];
    }),
  );
}
