import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MM_TABLE_BENCHMARK_PORT ?? "4177");
const samples = Math.max(
  5,
  Number.parseInt(process.env.MM_TABLE_BENCHMARK_SAMPLES ?? "20", 10),
);
const bodyRows = Math.max(
  20,
  Number.parseInt(process.env.MM_TABLE_BENCHMARK_ROWS ?? "100", 10),
);
const columns = Math.max(
  3,
  Number.parseInt(process.env.MM_TABLE_BENCHMARK_COLUMNS ?? "10", 10),
);
const baseUrl = `http://127.0.0.1:${port}`;
const reportPath = resolve(repository, "output/benchmark/table-controls.json");

function numberedSource(rows, width) {
  const headers = ["#", "Name", "Value"];
  for (let column = 3; column < width; column += 1)
    headers.push(`Column ${column - 2}`);
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (let row = 1; row <= rows; row += 1) {
    const values = [String(row), `Row ${row}`, `Value ${row}`];
    for (let column = 3; column < width; column += 1)
      values.push(`Cell ${row}-${column}`);
    lines.push(`| ${values.join(" | ")} |`);
  }
  return lines.join("\n");
}

async function waitForServer(url, server) {
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The server is still binding.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Browser server failed to start: ${output}`);
}

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
}

async function load(page, source) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.markdownMint?.view);
  await page.evaluate((markdown) => {
    window.__markdownMintHarness.deliverExternal(markdown, "github");
  }, source);
  await page.waitForFunction(
    (markdown) =>
      window.__markdownMintHarness.document.markdown === markdown &&
      window.markdownMint.sourceEl.value === markdown,
    source,
  );
  await page.waitForSelector(".mm-rich-panel .ProseMirror table");
  await settle(page);
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = index - lower;
  return (
    (sorted[lower] ?? 0) +
    ((sorted[upper] ?? 0) - (sorted[lower] ?? 0)) * weight
  );
}

function summarize(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

async function benchmark(page) {
  const source = numberedSource(bodyRows, columns);
  await load(page, source);
  const table = page.locator(".mm-rich-panel .ProseMirror table");
  await table.hover();
  await page.waitForSelector(".mm-table-controls:not([hidden])");
  const cell = table.locator("tbody td").nth(1);
  await cell.click();
  await page.keyboard.press("End");
  await settle(page);

  const metadata = await page.evaluate(() => {
    const cells = document.querySelectorAll(
      ".mm-rich-panel .ProseMirror table th, .mm-rich-panel .ProseMirror table td",
    );
    const rowHandle = document.querySelector(
      '[data-table-control="row-handle"][data-index="1"]',
    );
    const columnHandle = document.querySelector(
      '[data-table-control="column-handle"][data-index="1"]',
    );
    const state = {
      cellRectQueries: 0,
      rowHandle,
      columnHandle,
      started: 0,
    };
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLTableCellElement) state.cellRectQueries += 1;
      return original.call(this);
    };
    window.__tableControlBenchmark = state;
    return {
      cellCount: cells.length,
      hasHandles: Boolean(rowHandle && columnHandle),
      initialMarkdown: window.__markdownMintHarness.document.markdown,
    };
  });
  assert.ok(metadata.hasHandles, "table control handles are missing");

  const timings = [];
  const cellRectQueries = [];
  const handleReplacements = [];
  const markdownOutputs = [];
  const cellTexts = [];
  const sourceSynchronized = [];
  for (let index = 0; index < samples; index += 1) {
    const token = "x";
    const beforeCellLength = await page.evaluate(
      () =>
        document.querySelector(
          ".mm-rich-panel .ProseMirror tbody tr td:nth-child(2)",
        )?.textContent?.length ?? 0,
    );
    await page.evaluate(() => {
      const state = window.__tableControlBenchmark;
      state.cellRectQueries = 0;
      state.started = performance.now();
    });
    await page.keyboard.type(token);
    await page.waitForFunction((length) => {
      const text = document.querySelector(
        ".mm-rich-panel .ProseMirror tbody tr td:nth-child(2)",
      )?.textContent;
      return Boolean(text && text.length > length);
    }, beforeCellLength);
    await settle(page);
    const result = await page.evaluate(() => {
      const state = window.__tableControlBenchmark;
      const cellText = document.querySelector(
        ".mm-rich-panel .ProseMirror tbody tr td:nth-child(2)",
      )?.textContent;
      return {
        elapsed: performance.now() - state.started,
        cellRectQueries: state.cellRectQueries,
        rowHandleStable:
          state.rowHandle ===
          document.querySelector(
            '[data-table-control="row-handle"][data-index="1"]',
          ),
        columnHandleStable:
          state.columnHandle ===
          document.querySelector(
            '[data-table-control="column-handle"][data-index="1"]',
          ),
        markdown: window.__markdownMintHarness.document.markdown,
        sourceSynchronized:
          window.markdownMint.sourceEl.value ===
          window.__markdownMintHarness.document.markdown,
        cellText,
      };
    });
    timings.push(result.elapsed);
    cellRectQueries.push(result.cellRectQueries);
    handleReplacements.push(
      !(result.rowHandleStable && result.columnHandleStable),
    );
    markdownOutputs.push(result.markdown);
    cellTexts.push(result.cellText);
    sourceSynchronized.push(result.sourceSynchronized);
  }

  return {
    scenario: {
      name: "large-table-repeated-cell-edit",
      bodyRows,
      columns,
      cellCount: metadata.cellCount,
    },
    samples,
    latencyMilliseconds: summarize(timings),
    cellRectQueries: {
      p50: percentile(cellRectQueries, 0.5),
      p95: percentile(cellRectQueries, 0.95),
      max: Math.max(...cellRectQueries),
      perCellP50: percentile(cellRectQueries, 0.5) / metadata.cellCount,
      perCellMax: Math.max(...cellRectQueries) / metadata.cellCount,
    },
    handleReplacements: handleReplacements.filter(Boolean).length,
    markdownChanged: markdownOutputs.every(
      (markdown) => markdown !== metadata.initialMarkdown,
    ),
    sourceSynchronized: sourceSynchronized.every(Boolean),
    finalCellText: cellTexts.at(-1),
  };
}

async function main() {
  const server = spawn(process.execPath, ["tests/browser/server.mjs"], {
    cwd: repository,
    env: { ...process.env, MM_BROWSER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await mkdir(dirname(reportPath), { recursive: true });
    await waitForServer(`${baseUrl}/`, server);
    const executablePath =
      process.env.MM_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      "Missing Chromium. Run npx playwright install chromium or set MM_BROWSER_EXECUTABLE_PATH.",
    );
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({
      viewport: { width: 960, height: 720 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(10000);
    const result = await benchmark(page);
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log("Table controls performance benchmark");
    console.log(`Report: ${reportPath}`);
    console.log(`Samples: ${samples}, table: ${bodyRows}x${columns}`);
    console.log(
      `Edit latency p50/p95/max: ${result.latencyMilliseconds.p50.toFixed(3)} / ${result.latencyMilliseconds.p95.toFixed(3)} / ${result.latencyMilliseconds.max.toFixed(3)} ms`,
    );
    console.log(
      `Cell rect queries p50/p95/max: ${result.cellRectQueries.p50} / ${result.cellRectQueries.p95} / ${result.cellRectQueries.max} (${result.cellRectQueries.perCellMax.toFixed(2)} per cell max)`,
    );
    console.log(`Handle replacements: ${result.handleReplacements}`);
    console.log(`Markdown changed: ${result.markdownChanged}`);
    console.log(`Source synchronized: ${result.sourceSynchronized}`);
  } finally {
    await browser?.close();
    server.kill("SIGINT");
  }
}

await main();
