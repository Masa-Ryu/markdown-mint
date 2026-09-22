import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { getPerformanceScenarios } from "../tests/browser/performance-fixtures.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MM_EDITOR_PERFORMANCE_PORT ?? "4178");
const baseUrl = `http://127.0.0.1:${port}`;
const editSamples = Math.max(
  5,
  Number.parseInt(process.env.MM_EDITOR_PERFORMANCE_SAMPLES ?? "20", 10) || 20,
);
const startupSamples = Math.max(
  3,
  Number.parseInt(
    process.env.MM_EDITOR_PERFORMANCE_STARTUP_SAMPLES ?? "5",
    10,
  ) || 5,
);
const previewSamples = Math.max(
  3,
  Number.parseInt(
    process.env.MM_EDITOR_PERFORMANCE_PREVIEW_SAMPLES ?? "5",
    10,
  ) || 5,
);
const burstEdits = Math.max(
  20,
  Number.parseInt(process.env.MM_EDITOR_PERFORMANCE_BURST_EDITS ?? "30", 10) ||
    30,
);
const reportPath = resolve(
  repository,
  process.env.MM_EDITOR_PERFORMANCE_REPORT ??
    "output/benchmark/editor-performance.json",
);
const benchmarkBundle = resolve(repository, "output/benchmark/webview.js");

function npmBuildWebview() {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : "npm";
  const args = npmExecPath
    ? [npmExecPath, "run", "build:webview"]
    : ["run", "build:webview"];
  const result = spawnSync(command, args, {
    cwd: repository,
    stdio: "inherit",
    shell: process.platform === "win32" && !npmExecPath,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm run build:webview exited with ${result.status}`);
}

async function buildInstrumentedWebview() {
  await mkdir(dirname(benchmarkBundle), { recursive: true });
  await build({
    entryPoints: ["src/webview/main.ts"],
    bundle: true,
    outfile: benchmarkBundle,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    keepNames: true,
    legalComments: "none",
    loader: { ".svg": "text" },
    define: { __MM_EDITOR_PERFORMANCE_BENCHMARK__: "true" },
  });
}

async function waitForServer(server) {
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/`)).ok) return;
    } catch {
      // The local browser server may still be binding.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Browser server failed to start: ${output}`);
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function summarize(values) {
  if (values.length === 0)
    return { sampleCount: 0, p50: null, p95: null, max: null };
  return {
    sampleCount: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.reduce((maximum, value) => Math.max(maximum, value), -Infinity),
  };
}

function summarizeHookSamples(samples) {
  const names = new Set(samples.flatMap((sample) => Object.keys(sample)));
  return Object.fromEntries(
    [...names].sort().map((name) => {
      const values = samples.flatMap((sample) => sample[name] ?? []);
      return [
        name,
        {
          callCount: values.length,
          totalMilliseconds: values.reduce((total, value) => total + value, 0),
          perCallMilliseconds: summarize(values),
        },
      ];
    }),
  );
}

async function createPage(browser, scenario, mode = "rich") {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(
    scenario.category === "stress-only" ? 120_000 : 30_000,
  );
  await page.addInitScript(
    ({ initialMarkdown, profile }) => {
      window.__markdownMintBenchmarkInitialMarkdown = initialMarkdown;
      const phases = Object.create(null);
      let activePhase = "startup";
      window.__markdownMintPerformanceBenchmark = {
        record(name, durationMilliseconds) {
          const phase = (phases[activePhase] ??= Object.create(null));
          (phase[name] ??= []).push(durationMilliseconds);
        },
        setPhase(nextPhase) {
          activePhase = nextPhase;
          phases[activePhase] ??= Object.create(null);
        },
        clearPhase(phaseName) {
          phases[phaseName] = Object.create(null);
        },
        snapshot(phaseName) {
          const phase = phases[phaseName] ?? {};
          return Object.fromEntries(
            Object.entries(phase).map(([name, values]) => [
              name,
              values.slice(),
            ]),
          );
        },
      };
      window.__markdownMintBenchmarkNavigationStartedAt = performance.now();
      window.__markdownMintBenchmarkProfile = profile;
    },
    { initialMarkdown: scenario.markdown, profile: scenario.profile },
  );
  const params = new URLSearchParams();
  if (mode === "preview") params.set("mode", "preview");
  await page.goto(`${baseUrl}/${params.size ? `?${params}` : ""}`, {
    waitUntil: "domcontentloaded",
  });
  if (mode === "preview") {
    await page.waitForFunction(
      () =>
        window.markdownMint &&
        !document.querySelector('[data-panel="preview"]').hidden &&
        document.querySelector('[data-testid="preview-content"]')
          .childElementCount > 0,
    );
  } else {
    await page.waitForFunction(
      () =>
        window.markdownMint?.initialized === true &&
        window.markdownMint.view?.dom?.isContentEditable === true &&
        !window.markdownMint.view.dom.closest('[data-panel="rich"]').hidden,
    );
  }
  const initial = await page.evaluate(() => ({
    appMarkdown: window.markdownMint.sourceEl.value,
    hostMarkdown: window.__markdownMintHarness.document.markdown,
    appProfile: window.markdownMint.profile,
  }));
  assert.equal(
    initial.appMarkdown,
    scenario.markdown,
    "Source value changed at load",
  );
  assert.equal(
    initial.hostMarkdown,
    scenario.markdown,
    "Host value changed at load",
  );
  assert.equal(initial.appProfile, scenario.profile, "Profile changed at load");
  return page;
}

async function editTarget(page, scenario, target) {
  const locator =
    target === "table-cell" || (target === "startup" && scenario.table)
      ? page.locator(`${richEditor} table tbody td`).first()
      : page
          .locator(`${richEditor} p`)
          .filter({ hasText: "Performance edit anchor." })
          .last();
  await locator.waitFor({ state: "visible" });
  await locator.click();
  await page.keyboard.press("End");
  return locator;
}

const richEditor = ".mm-rich-panel .ProseMirror";

async function resetPhase(page, phase) {
  await page.evaluate((phaseName) => {
    const recorder = window.__markdownMintPerformanceBenchmark;
    recorder.clearPhase(phaseName);
    recorder.setPhase(phaseName);
    window.__markdownMintBenchmarkActionStartedAt = performance.now();
  }, phase);
}

async function waitForCompatibility(page, phase) {
  await page.waitForFunction(
    (phaseName) =>
      (window.__markdownMintPerformanceBenchmark.snapshot(phaseName)[
        "core.inspectCompatibility"
      ]?.length ?? 0) > 0,
    phase,
    { timeout: 120_000 },
  );
}

async function waitForHostSync(page) {
  await page.waitForFunction(
    () => window.markdownMint.sync.hasPending === false,
    {
      timeout: 120_000,
    },
  );
}

async function collectStartupSample(browser, scenario) {
  const page = await createPage(browser, scenario);
  try {
    const editorReadyMilliseconds = await page.evaluate(
      () =>
        performance.now() - window.__markdownMintBenchmarkNavigationStartedAt,
    );
    const target = await editTarget(page, scenario, "startup");
    const before = await target.textContent();
    const targetTag = await target.evaluate((element) =>
      element.tagName.toLowerCase(),
    );
    await page.evaluate(() => {
      window.__markdownMintBenchmarkActionStartedAt = performance.now();
    });
    await page.keyboard.type("z");
    await page.waitForFunction(
      ({ selector, previous }) =>
        Array.from(document.querySelectorAll(selector)).some(
          (element) => element.textContent === `${previous}z`,
        ),
      {
        selector: `${richEditor} ${targetTag}`,
        previous: before,
      },
    );
    const inputAcceptedMilliseconds = await page.evaluate(
      () =>
        performance.now() - window.__markdownMintBenchmarkNavigationStartedAt,
    );
    await waitForHostSync(page);
    await waitForCompatibility(page, "startup");
    const metrics = await page.evaluate(() =>
      window.__markdownMintPerformanceBenchmark.snapshot("startup"),
    );
    return {
      editorReadyMilliseconds,
      inputAcceptedMilliseconds,
      metrics,
    };
  } finally {
    await page.close();
  }
}

async function runInputSamples(browser, scenario, targetName) {
  const page = await createPage(browser, scenario);
  try {
    const target = await editTarget(page, scenario, targetName);
    const targetTag = await target.evaluate((element) =>
      element.tagName.toLowerCase(),
    );
    const latencies = [];
    const metrics = [];
    const sourceUpdated = [];
    for (let index = 0; index < editSamples; index += 1) {
      const beforeText = await target.textContent();
      const beforeSource = await page.evaluate(
        () => window.__markdownMintHarness.document.markdown,
      );
      const phase = `edit-${targetName}-${index + 1}`;
      await resetPhase(page, phase);
      await page.keyboard.type("x");
      await page.waitForFunction(
        ({ selector, previous }) =>
          Array.from(document.querySelectorAll(selector)).some(
            (element) => element.textContent === `${previous}x`,
          ),
        {
          selector: `${richEditor} ${targetTag}`,
          previous: beforeText,
        },
      );
      latencies.push(
        await page.evaluate(
          () =>
            performance.now() - window.__markdownMintBenchmarkActionStartedAt,
        ),
      );
      await waitForHostSync(page);
      await waitForCompatibility(page, phase);
      const [metricSnapshot, serialized] = await page.evaluate(
        (phaseName) => [
          window.__markdownMintPerformanceBenchmark.snapshot(phaseName),
          window.__markdownMintHarness.document.markdown,
        ],
        phase,
      );
      metrics.push(metricSnapshot);
      sourceUpdated.push(serialized !== beforeSource);
    }
    return {
      sampleCount: editSamples,
      latencyMilliseconds: summarize(latencies),
      latencySamplesMilliseconds: latencies,
      sourceUpdatedEverySample: sourceUpdated.every(Boolean),
      metrics: summarizeHookSamples(metrics),
    };
  } finally {
    await page.close();
  }
}

async function runTableStructuralSamples(browser, scenario) {
  const page = await createPage(browser, scenario);
  const latencies = [];
  const metrics = [];
  try {
    for (let index = 0; index < editSamples; index += 1) {
      const table = page.locator(`${richEditor} table`).first();
      const initialRows = await table.locator("tr").count();
      const tableBounds = await table.boundingBox();
      const firstBodyRowBounds = await table.locator("tr").nth(1).boundingBox();
      assert.ok(tableBounds && firstBodyRowBounds);
      await page.mouse.move(
        Math.max(8, tableBounds.x - 18),
        firstBodyRowBounds.y,
      );
      const rowInsert = page.locator('[data-table-control="row-insert"]');
      await rowInsert.waitFor({ state: "visible" });

      const phase = `table-structure-${index + 1}`;
      await resetPhase(page, phase);
      await rowInsert.click();
      await page.waitForFunction(
        (expectedRows) =>
          document.querySelectorAll(".mm-rich-panel .ProseMirror table tr")
            .length ===
          expectedRows + 1,
        initialRows,
      );
      latencies.push(
        await page.evaluate(
          () =>
            performance.now() - window.__markdownMintBenchmarkActionStartedAt,
        ),
      );
      await waitForHostSync(page);
      await waitForCompatibility(page, phase);
      metrics.push(
        await page.evaluate(
          (phaseName) =>
            window.__markdownMintPerformanceBenchmark.snapshot(phaseName),
          phase,
        ),
      );

      await page.evaluate((source) => {
        window.__markdownMintPerformanceBenchmark.setPhase("reset");
        window.__markdownMintHarness.deliverExternal(source, "github");
      }, scenario.markdown);
      await page.waitForFunction(
        ({ source, expectedRows }) =>
          window.__markdownMintHarness.document.markdown === source &&
          document.querySelectorAll(".mm-rich-panel .ProseMirror table tr")
            .length === expectedRows,
        {
          source: scenario.markdown,
          expectedRows: scenario.metadata.table.bodyRows + 1,
        },
      );
    }
    return {
      sampleCount: latencies.length,
      operation: "Insert row using the real Rich Editor row-insert control",
      latencyMilliseconds: summarize(latencies),
      latencySamplesMilliseconds: latencies,
      metrics: summarizeHookSamples(metrics),
    };
  } finally {
    await page.close();
  }
}

async function runTypingBurst(browser, scenario) {
  const page = await createPage(browser, scenario);
  try {
    const target = await editTarget(page, scenario, "normal-text");
    const editMessagesBefore = await page.evaluate(
      () =>
        window.__markdownMintHarness.messages.filter(
          (message) => message.type === "edit",
        ).length,
    );
    await resetPhase(page, "typing-burst");
    await page.keyboard.type("x".repeat(burstEdits), { delay: 15 });
    await page.waitForFunction(
      ({ selector, suffix }) =>
        Array.from(document.querySelectorAll(selector)).some((element) =>
          element.textContent?.endsWith(suffix),
        ),
      {
        selector: `${richEditor} p`,
        suffix: "x".repeat(burstEdits),
      },
    );
    await waitForHostSync(page);
    await waitForCompatibility(page, "typing-burst");
    const [metricSnapshot, editMessagesAfter, source] = await page.evaluate(
      (phase) => [
        window.__markdownMintPerformanceBenchmark.snapshot(phase),
        window.__markdownMintHarness.messages.filter(
          (message) => message.type === "edit",
        ).length,
        window.__markdownMintHarness.document.markdown,
      ],
      "typing-burst",
    );
    assert.ok(
      source.endsWith("x".repeat(burstEdits)),
      "typing burst was not serialized to the host document",
    );
    return {
      editCount: editMessagesAfter - editMessagesBefore,
      requestedKeystrokes: burstEdits,
      keyboardDelayMilliseconds: 15,
      metrics: summarizeHookSamples([metricSnapshot]),
    };
  } finally {
    await page.close();
  }
}

async function runPreviewSamples(browser, scenario) {
  const metrics = [];
  const readiness = [];
  const count = scenario.category === "stress-only" ? 3 : previewSamples;
  for (let index = 0; index < count; index += 1) {
    const page = await createPage(browser, scenario, "preview");
    try {
      readiness.push(
        await page.evaluate(
          () =>
            performance.now() -
            window.__markdownMintBenchmarkNavigationStartedAt,
        ),
      );
      metrics.push(
        await page.evaluate(() =>
          window.__markdownMintPerformanceBenchmark.snapshot("startup"),
        ),
      );
    } finally {
      await page.close();
    }
  }
  return {
    sampleCount: count,
    previewReadyMilliseconds: summarize(readiness),
    metrics: summarizeHookSamples(metrics),
  };
}

function mean(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

function ms(value) {
  return value === null ? "n/a" : value.toFixed(2);
}

function printSummary(report) {
  process.stdout.write("Editor performance benchmark (real Webview)\n");
  process.stdout.write(
    `Version ${report.packageVersion}; commit ${report.gitCommit}; Chromium ${report.environment.chromiumVersion}\n`,
  );
  process.stdout.write(`JSON: ${reportPath}\n`);
  for (const scenario of report.scenarios) {
    process.stdout.write(
      `\n${scenario.id} (${scenario.metadata.bytes} bytes, ${scenario.metadata.topLevelBlocks} blocks)\n`,
    );
    process.stdout.write(
      `  Startup editor-ready: p50/p95/max ${ms(scenario.startup.editorReadyMilliseconds.p50)} / ${ms(scenario.startup.editorReadyMilliseconds.p95)} / ${ms(scenario.startup.editorReadyMilliseconds.max)} ms\n`,
    );
    process.stdout.write(
      `  Startup to first accepted input: p50/p95/max ${ms(scenario.startup.inputAcceptedMilliseconds.p50)} / ${ms(scenario.startup.inputAcceptedMilliseconds.p95)} / ${ms(scenario.startup.inputAcceptedMilliseconds.max)} ms (${scenario.startup.sampleCount} samples)\n`,
    );
    if (scenario.edits?.normalText) {
      const edit = scenario.edits.normalText;
      process.stdout.write(
        `  Text edit to DOM: p50/p95/max ${ms(edit.latencyMilliseconds.p50)} / ${ms(edit.latencyMilliseconds.p95)} / ${ms(edit.latencyMilliseconds.max)} ms\n`,
      );
    }
    if (scenario.edits?.tableCell) {
      const edit = scenario.edits.tableCell;
      process.stdout.write(
        `  Table-cell edit to DOM: p50/p95/max ${ms(edit.latencyMilliseconds.p50)} / ${ms(edit.latencyMilliseconds.p95)} / ${ms(edit.latencyMilliseconds.max)} ms\n`,
      );
    }
    if (scenario.edits?.tableStructure) {
      const edit = scenario.edits.tableStructure;
      process.stdout.write(
        `  Table row append to DOM: p50/p95/max ${ms(edit.latencyMilliseconds.p50)} / ${ms(edit.latencyMilliseconds.p95)} / ${ms(edit.latencyMilliseconds.max)} ms\n`,
      );
    }
    if (scenario.typingBurst) {
      const burst = scenario.typingBurst;
      process.stdout.write(
        `  Typing burst: ${burst.editCount}/${burst.requestedKeystrokes} edits, parse ${burst.metrics["core.parseMarkdown"]?.callCount ?? 0}, compatibility ${burst.metrics["core.inspectCompatibility"]?.callCount ?? 0}, render ${burst.metrics["core.renderMarkdown"]?.callCount ?? 0}, serialize ${burst.metrics["core.serializeMarkdown"]?.callCount ?? 0}\n`,
      );
    }
    process.stdout.write(
      `  Preview render startup: p50/p95/max ${ms(scenario.preview.previewReadyMilliseconds.p50)} / ${ms(scenario.preview.previewReadyMilliseconds.p95)} / ${ms(scenario.preview.previewReadyMilliseconds.max)} ms; render calls ${scenario.preview.metrics["core.renderMarkdown"]?.callCount ?? 0}\n`,
    );
  }
}

async function main() {
  npmBuildWebview();
  await buildInstrumentedWebview();
  const scenarios = await getPerformanceScenarios();
  const server = spawn(process.execPath, ["tests/browser/server.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      MM_BROWSER_PORT: String(port),
      MM_EDITOR_PERFORMANCE_BENCHMARK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer(server);
    const executablePath =
      process.env.MM_EDITOR_PERFORMANCE_EXECUTABLE_PATH ??
      chromium.executablePath();
    browser = await chromium.launch({ headless: true, executablePath });
    const packageJson = JSON.parse(
      await readFile(resolve(repository, "package.json"), "utf8"),
    );
    const gitCommit =
      process.env.MM_EDITOR_PERFORMANCE_GIT_COMMIT?.trim() ||
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim();
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      packageVersion: packageJson.version,
      gitCommit,
      measurement: {
        webview: "The packaged src/webview/main.ts bundle built for Chromium",
        instrumentation:
          "Explicit benchmark-only hook; production build disables it",
        sampleCounts: {
          edit: editSamples,
          startup: startupSamples,
          preview: previewSamples,
          typingBurstEdits: burstEdits,
        },
        latencyDefinition:
          "Elapsed browser time from immediately before a real Playwright keyboard/pointer action until the Rich Editor DOM reflects the edit",
        percentiles: ["p50", "p95", "max"],
      },
      environment: {
        platform: `${process.platform}-${process.arch}`,
        operatingSystem: `${os.type()} ${os.release()}`,
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        nodeVersion: process.version,
        chromiumVersion: browser.version(),
        viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
      },
      scenarios: [],
    };

    for (const scenario of scenarios) {
      process.stdout.write(`Measuring ${scenario.id}...\n`);
      const samples = [];
      const count = scenario.category === "stress-only" ? 3 : startupSamples;
      for (let index = 0; index < count; index += 1)
        samples.push(await collectStartupSample(browser, scenario));
      const startup = {
        sampleCount: count,
        editorReadyMilliseconds: summarize(
          samples.map((sample) => sample.editorReadyMilliseconds),
        ),
        inputAcceptedMilliseconds: summarize(
          samples.map((sample) => sample.inputAcceptedMilliseconds),
        ),
        inputAcceptedSamplesMilliseconds: samples.map(
          (sample) => sample.inputAcceptedMilliseconds,
        ),
        metrics: summarizeHookSamples(samples.map((sample) => sample.metrics)),
      };
      const result = {
        id: scenario.id,
        category: scenario.category,
        profile: scenario.profile,
        metadata: scenario.metadata,
        startup,
        preview: await runPreviewSamples(browser, scenario),
      };
      if (scenario.category !== "stress-only") {
        result.edits = {
          normalText: await runInputSamples(browser, scenario, "normal-text"),
        };
        if (scenario.table) {
          result.edits.tableCell = await runInputSamples(
            browser,
            scenario,
            "table-cell",
          );
          if (scenario.id === "large-table-100x10")
            result.edits.tableStructure = await runTableStructuralSamples(
              browser,
              scenario,
            );
        }
      }
      report.scenarios.push(result);
    }

    const burstScenario = scenarios.find(
      (scenario) => scenario.id === "normal-100kb-many-blocks",
    );
    assert.ok(burstScenario);
    process.stdout.write("Measuring typing burst...\n");
    report.scenarios.find(
      (scenario) => scenario.id === burstScenario.id,
    ).typingBurst = await runTypingBurst(browser, burstScenario);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    printSummary(report);
  } finally {
    await browser?.close();
    server.kill("SIGINT");
  }
}

await main();
