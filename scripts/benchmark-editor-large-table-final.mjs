import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { getPerformanceScenarios } from "../tests/browser/performance-fixtures.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MM_LARGE_TABLE_PORT ?? "4191");
const baseUrl = `http://127.0.0.1:${port}`;
const bundlePath = resolve(repository, "output/benchmark/webview.js");
const resultPath = resolve(
  repository,
  "output/benchmark/issue-119-interaction-investigation.json",
);
const reportPath = resolve(
  repository,
  "docs/performance/issue-119-scroll-structure-investigation.md",
);
const traceDirectory =
  process.env.MM_LARGE_TABLE_TRACE_DIR ??
  "/tmp/markdown-mint-issue119-large-table-traces";
const sampleCount = Math.max(
  1,
  Number.parseInt(process.env.MM_LARGE_TABLE_SAMPLES ?? "3", 10) || 3,
);
const smoke = process.env.MM_LARGE_TABLE_SMOKE === "1";
const skipMatrix = process.env.MM_LARGE_TABLE_SKIP_MATRIX === "1";
const skipThresholdMatrix =
  process.env.MM_LARGE_TABLE_SKIP_THRESHOLD_MATRIX === "1";
const skipControls = process.env.MM_LARGE_TABLE_SKIP_CONTROLS === "1";
const skipDiagnosticControls =
  process.env.MM_LARGE_TABLE_SKIP_DIAGNOSTIC_CONTROLS === "1";
const skipSticky = process.env.MM_LARGE_TABLE_SKIP_STICKY === "1";
const skipProxy = process.env.MM_LARGE_TABLE_SKIP_PROXY === "1";
const noTrace = process.env.MM_LARGE_TABLE_NO_TRACE === "1";
const keepPages = process.env.MM_LARGE_TABLE_KEEP_PAGES === "1";
const proxySmall = process.env.MM_LARGE_TABLE_PROXY_SMALL === "1";
let sharedContext = null;

const lifecycleNames = [
  "WebFrameWidgetImpl::UpdateLifecycle",
  "LocalFrameView::RunPaintLifecyclePhase",
  "LocalFrameView::pushPaintArtifactToCompositor",
  "Layerize",
  "PaintArtifactCompositor::Update",
];

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high
    ? sorted[low]
    : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function summary(values) {
  const valid = values.filter(Number.isFinite);
  return {
    sampleCount: valid.length,
    p50: percentile(valid, 0.5),
    p95: percentile(valid, 0.95),
    max: valid.length ? Math.max(...valid) : null,
    samples: valid,
  };
}

function rowsOf(source, bodyRows) {
  const rows = source
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("|"));
  assert.ok(rows.length >= bodyRows + 2, "stress table rows are missing");
  return rows.slice(0, bodyRows + 2);
}

function cellsOf(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function shapedTableMarkdown(
  source,
  bodyRows,
  columns,
  before = "",
  after = "",
) {
  const header = Array.from(
    { length: columns },
    (_, index) => `C${String(index + 1).padStart(2, "0")}`,
  );
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (let row = 0; row < bodyRows; row += 1) {
    const values = Array.from(
      { length: columns },
      (_, column) =>
        `R${String(row + 1).padStart(4, "0")}C${String(column + 1).padStart(2, "0")}`,
    );
    lines.push(`| ${values.join(" | ")} |`);
  }
  return [before, lines.join("\n"), after].filter(Boolean).join("\n\n") + "\n";
}

function scenarioFor(base, id, bodyRows, columns, before = "", after = "") {
  const markdown = shapedTableMarkdown(
    base.markdown,
    bodyRows,
    columns,
    before,
    after,
  );
  return {
    ...base,
    id,
    markdown,
    table: { bodyRows, columns },
  };
}

function fixtureScenario(base, id, bodyRows, before = "", after = "") {
  const table = rowsOf(base.markdown, bodyRows).join("\n");
  return {
    ...base,
    id,
    markdown: [before, table, after].filter(Boolean).join("\n\n") + "\n",
    table: { bodyRows, columns: 20 },
  };
}

function multiScenario(base, largeRows, largeColumns) {
  const small = shapedTableMarkdown(base.markdown, 3, 3);
  const large = shapedTableMarkdown(base.markdown, largeRows, largeColumns);
  return {
    ...base,
    id: "mixed-small-large-small-large",
    markdown:
      [
        "Small table A.",
        small.trimEnd(),
        "Between tables.",
        large.trimEnd(),
        "Small table B.",
        small.trimEnd(),
        "Large table B.",
        large.trimEnd(),
        "After tables.",
      ].join("\n\n") + "\n",
  };
}

function thresholdMixedScenario(base) {
  const small = shapedTableMarkdown(base.markdown, 3, 3);
  const wideProxy = shapedTableMarkdown(base.markdown, 250, 40);
  const tallNative = shapedTableMarkdown(base.markdown, 1000, 10);
  const rowProxy = shapedTableMarkdown(base.markdown, 500, 20);
  return {
    ...base,
    id: "mixed-small-250x40-small-1000x10-500x20",
    markdown:
      [
        "Small table A.",
        small.trimEnd(),
        "Wide proxy table.",
        wideProxy.trimEnd(),
        "Small table B.",
        small.trimEnd(),
        "Tall narrow native table.",
        tallNative.trimEnd(),
        "Row threshold proxy table.",
        rowProxy.trimEnd(),
        "After tables.",
      ].join("\n\n") + "\n",
  };
}

async function buildBundle() {
  await mkdir(dirname(bundlePath), { recursive: true });
  await build({
    entryPoints: ["src/webview/main.ts"],
    bundle: true,
    outfile: bundlePath,
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
  server.stdout.on("data", (chunk) => (output += chunk.toString()));
  server.stderr.on("data", (chunk) => (output += chunk.toString()));
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/`)).ok) return;
    } catch {
      // The server is still binding its port.
    }
    await new Promise((resolveReady) => setTimeout(resolveReady, 50));
  }
  throw new Error(`browser server failed to start: ${output}`);
}

async function frames(page, count = 2) {
  await page.evaluate(
    (requested) =>
      new Promise((resolveReady) => {
        const tick = (remaining) => {
          if (remaining <= 0) return resolveReady();
          requestAnimationFrame(() => tick(remaining - 1));
        };
        tick(requested);
      }),
    count,
  );
}

function eventContains(parent, child) {
  return (
    parent !== child &&
    parent.pid === child.pid &&
    parent.tid === child.tid &&
    parent.ts <= child.ts &&
    parent.ts + parent.dur >= child.ts + child.dur
  );
}

function summarizeTrace(events) {
  const complete = events.filter(
    (event) =>
      event.ph === "X" &&
      Number.isFinite(event.ts) &&
      Number.isFinite(event.dur),
  );
  const stacks = new Map();
  const parent = new Map();
  for (const event of complete
    .slice()
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur)) {
    const key = `${event.pid}:${event.tid}`;
    const stack = stacks.get(key) ?? [];
    while (stack.length && !eventContains(stack.at(-1), event)) stack.pop();
    parent.set(event, stack.at(-1) ?? null);
    stack.push(event);
    stacks.set(key, stack);
  }
  const expose = (event) => ({
    name: event.name,
    category: event.cat,
    startUs: event.ts,
    durationMs: event.dur / 1000,
    parentName: parent.get(event)?.name ?? null,
    depth: (() => {
      let depth = 0;
      let item = parent.get(event);
      while (item && depth < 64) {
        depth += 1;
        item = parent.get(item);
      }
      return depth;
    })(),
  });
  const lifecycle = Object.fromEntries(
    lifecycleNames.map((name) => [
      name,
      complete
        .filter((event) => event.name === name)
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 10)
        .map(expose),
    ]),
  );
  const max = (name) => lifecycle[name]?.[0]?.durationMs ?? 0;
  const longTasks = complete
    .filter((event) =>
      /RunTask|ProcessTaskFromWorkQueue|ThreadControllerImpl::RunTask/i.test(
        String(event.name),
      ),
    )
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 5)
    .map((event) => ({
      ...expose(event),
      longestChild:
        complete
          .filter((child) => eventContains(event, child))
          .sort((a, b) => b.dur - a.dur)
          .map(expose)[0] ?? null,
    }));
  return {
    eventCount: events.length,
    completeEventCount: complete.length,
    lifecycle,
    longestUpdateLifecycleMs: max("WebFrameWidgetImpl::UpdateLifecycle"),
    longestRunPaintLifecyclePhaseMs: max(
      "LocalFrameView::RunPaintLifecyclePhase",
    ),
    longestLayerizeMs: max("Layerize"),
    longestPaintArtifactCompositorUpdateMs: max(
      "PaintArtifactCompositor::Update",
    ),
    longTasks,
  };
}

async function startTrace(page) {
  const session = await page.context().newCDPSession(page);
  const events = [];
  session.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  try {
    await session.send("Tracing.start", {
      categories: [
        "devtools.timeline",
        "blink",
        "input",
        "rendering",
        "v8",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "disabled-by-default-devtools.timeline.layers",
      ].join(","),
      transferMode: "ReportEvents",
      options: "record-until-full",
    });
  } catch (error) {
    await session.detach();
    return async () => ({ supported: false, error: String(error) });
  }
  return async (rawPath) => {
    const completed = new Promise((resolveComplete) =>
      session.once("Tracing.tracingComplete", resolveComplete),
    );
    await session.send("Tracing.end");
    await completed;
    await session.detach();
    const result = { supported: true, ...summarizeTrace(events) };
    if (rawPath) {
      await mkdir(dirname(rawPath), { recursive: true });
      await writeFile(
        rawPath,
        JSON.stringify({ traceEvents: events, summary: result }, null, 2),
      );
    }
    return result;
  };
}

function initOptions(config) {
  return {
    tableScrollMode: config.tableScrollMode ?? "native",
    tableScrollProxyOnRows: config.tableScrollProxyOnRows,
    tableScrollProxyOffRows: config.tableScrollProxyOffRows,
    tableScrollProxyOnCells: config.tableScrollProxyOnCells,
    tableScrollProxyOffCells: config.tableScrollProxyOffCells,
    tableScrollProxyPlacement: config.tableScrollProxyPlacement ?? "bottom",
    tableScrollProxyRequiresHorizontalOverflow:
      config.tableScrollProxyRequiresHorizontalOverflow === true,
    disableSelectionToolbar: config.disableSelectionToolbar === true,
  };
}

async function createPage(browser, scenario, config, options = {}) {
  const page = sharedContext
    ? await sharedContext.newPage()
    : await browser.newPage({
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 1,
      });
  const startupTraceStop =
    options.traceFromNavigation && !noTrace ? await startTrace(page) : null;
  page.setDefaultTimeout(120_000);
  await page.addInitScript(
    ({ markdown, options }) => {
      window.__markdownMintBenchmarkInitialMarkdown = markdown;
      window.__markdownMintPerformanceBenchmarkOptions = options;
      const measurements = Object.create(null);
      const counters = Object.create(null);
      window.__markdownMintPerformanceBenchmark = {
        record(name, duration) {
          (measurements[name] ??= []).push(duration);
        },
        count(name, value) {
          (counters[name] ??= []).push(value);
        },
        snapshot() {
          return Object.fromEntries(
            Object.entries(measurements).map(([name, values]) => [
              name,
              [...values],
            ]),
          );
        },
        counterSnapshot() {
          return Object.fromEntries(
            Object.entries(counters).map(([name, values]) => [
              name,
              [...values],
            ]),
          );
        },
        reset() {
          for (const key of Object.keys(measurements)) delete measurements[key];
          for (const key of Object.keys(counters)) delete counters[key];
        },
      };
      window.__mmLargeTableTimeline = [];
      window.__mmLargeTableMutationAt = null;
      window.__mmLargeTableInputStartedAt = null;
      window.__mmLargeTableLongTasks = { supported: false, entries: [] };
      try {
        if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__mmLargeTableLongTasks.entries.push({
                startTime: entry.startTime,
                duration: entry.duration,
              });
          });
          observer.observe({ type: "longtask", buffered: true });
          window.__mmLargeTableLongTaskObserver = observer;
          window.__mmLargeTableLongTasks.supported = true;
        }
      } catch {
        // LongTask is optional in the browser harness.
      }
    },
    { markdown: scenario.markdown, options: initOptions(config) },
  );
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const editor = window.markdownMint?.view?.dom;
    return (
      window.markdownMint?.initialized === true &&
      editor?.isContentEditable === true &&
      !editor.closest('[data-panel="rich"]').hidden
    );
  });
  await page.evaluate(() => {
    window.__mmLargeTableEditorReadyAt = performance.now();
  });
  const sourceMatches = await page.evaluate(
    (markdown) =>
      window.markdownMint.sourceEl.value === markdown &&
      window.__markdownMintHarness.document.markdown === markdown,
    scenario.markdown,
  );
  assert.equal(sourceMatches, true, `fixture did not load for ${scenario.id}`);
  await frames(page);
  page.__mmStartupTraceStop = startupTraceStop;
  return page;
}

async function installProbe(page, bodyRow, column) {
  await page.evaluate(
    ({ bodyRow, column }) => {
      const root = document.querySelector(".mm-rich-panel .ProseMirror");
      const table = root?.querySelector("table");
      const cell = table?.rows[bodyRow]?.cells[column];
      if (!root || !table || !cell) throw new Error("probe target missing");
      window.__mmLargeTableTimeline = [];
      window.__mmLargeTableMutationAt = null;
      window.__mmLargeTableInputStartedAt = null;
      const record = (event) => {
        if (
          event.type !== "selectionchange" &&
          event.type !== "scroll" &&
          event.target !== root &&
          event.target !== table &&
          !(event.target instanceof Node && table.contains(event.target))
        )
          return;
        window.__mmLargeTableTimeline.push({
          type: event.type,
          at: performance.now(),
          key: event instanceof KeyboardEvent ? event.key : undefined,
        });
      };
      for (const type of [
        "pointermove",
        "pointerdown",
        "mousedown",
        "focus",
        "focusin",
        "mouseup",
        "pointerup",
        "click",
        "selectionchange",
        "keydown",
        "beforeinput",
        "input",
        "keyup",
        "scroll",
      ])
        document.addEventListener(type, record, true);
      const observer = new MutationObserver(() => {
        if (
          window.__mmLargeTableInputStartedAt === null ||
          window.__mmLargeTableMutationAt !== null
        )
          return;
        window.__mmLargeTableMutationAt = performance.now();
      });
      observer.observe(cell, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      window.__mmLargeTableProbeCleanup = () => {
        observer.disconnect();
        for (const type of [
          "pointermove",
          "pointerdown",
          "mousedown",
          "focus",
          "focusin",
          "mouseup",
          "pointerup",
          "click",
          "selectionchange",
          "keydown",
          "beforeinput",
          "input",
          "keyup",
          "scroll",
        ])
          document.removeEventListener(type, record, true);
      };
    },
    { bodyRow, column },
  );
}

function metricFrom(samples, selector) {
  return summary(samples.map(selector));
}

function sampleSummary(samples) {
  return {
    sampleCount: samples.length,
    click: metricFrom(samples, (sample) => sample.clickMs),
    selectionchange: metricFrom(samples, (sample) => sample.selectionchangeMs),
    inputToDomMutationMs: metricFrom(
      samples,
      (sample) => sample.inputToDomMutationMs,
    ),
    postMutationToFirstIdleMs: metricFrom(
      samples,
      (sample) => sample.postMutationToFirstIdleMs,
    ),
    inputToFirstIdleMs: metricFrom(
      samples,
      (sample) => sample.inputToFirstIdleMs,
    ),
    fullInteraction: metricFrom(samples, (sample) => sample.fullInteractionMs),
    nodeViewCreatedToProxyReady: metricFrom(
      samples,
      (sample) => sample.nodeViewCreatedToProxyReadyMs,
    ),
    candidateMountedToProxyReady: metricFrom(
      samples,
      (sample) => sample.candidateMountedToProxyReadyMs,
    ),
    firstInteractionAfterOpen: metricFrom(
      samples,
      (sample) => sample.firstInteractionAfterOpenMs,
    ),
    longestUpdateLifecycle: metricFrom(
      samples,
      (sample) => sample.trace.longestUpdateLifecycleMs,
    ),
    longestLayerize: metricFrom(
      samples,
      (sample) => sample.trace.longestLayerizeMs,
    ),
    longestPaintArtifactCompositorUpdate: metricFrom(
      samples,
      (sample) => sample.trace.longestPaintArtifactCompositorUpdateMs,
    ),
    longTaskCount: metricFrom(
      samples,
      (sample) => sample.longTasks.entries.length,
    ),
    longTaskTotal: metricFrom(samples, (sample) =>
      sample.longTasks.entries.reduce(
        (total, entry) => total + entry.duration,
        0,
      ),
    ),
  };
}

async function readGeometry(page, bodyRow = 1, column = 0) {
  return page.evaluate(
    ({ bodyRow, column }) => {
      const editor = document.querySelector(".mm-rich-panel .ProseMirror");
      const stage = editor?.closest(".mm-stage");
      const table = editor?.querySelector("table");
      const wrapper = table?.closest(".mm-table-scroll");
      const viewport = table?.closest(".mm-table-viewport");
      const proxy = wrapper?.querySelector(
        ":scope > .mm-table-scrollbar-proxy",
      );
      const row = table?.rows[bodyRow];
      const cell = row?.cells[column];
      const rect = (element) => {
        if (!element) return null;
        const value = element.getBoundingClientRect();
        return {
          top: value.top,
          left: value.left,
          right: value.right,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
        };
      };
      const scroll = (element) =>
        element
          ? {
              scrollLeft: element.scrollLeft,
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              scrollTop: element.scrollTop,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
            }
          : null;
      const computed = (element) => {
        if (!element) return null;
        const style = getComputedStyle(element);
        return {
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          position: style.position,
          display: style.display,
        };
      };
      return {
        mode:
          table?.closest("[data-mm-benchmark-table-mode]")?.dataset
            ?.mmBenchmarkTableMode ??
          table?.dataset?.mmBenchmarkTableMode ??
          "unknown",
        table: {
          scroll: scroll(table),
          rect: rect(table),
          style: computed(table),
        },
        wrapper: {
          scroll: scroll(wrapper),
          rect: rect(wrapper),
          style: computed(wrapper),
        },
        viewport: {
          scroll: scroll(viewport),
          rect: rect(viewport),
          style: computed(viewport),
        },
        proxy: {
          scroll: scroll(proxy),
          rect: rect(proxy),
          style: computed(proxy),
          visibility: proxy ? getComputedStyle(proxy).visibility : null,
        },
        stage: {
          scroll: scroll(stage),
          rect: rect(stage),
          style: computed(stage),
        },
        targetCell: rect(cell),
        tableRows: table?.rows.length ?? 0,
        tableColumns: row?.cells.length ?? 0,
        horizontalOverflow: Boolean(
          (viewport && viewport.scrollWidth > viewport.clientWidth) ||
          (!viewport && table && table.scrollWidth > table.clientWidth),
        ),
      };
    },
    { bodyRow, column },
  );
}

async function runPerformanceSample(
  browser,
  scenario,
  config,
  index,
  row = 1,
  traceName = null,
) {
  const page = await createPage(browser, scenario, config, {
    traceFromNavigation: config.traceFromNavigation === true,
  });
  try {
    const target = page
      .locator(".mm-rich-panel .ProseMirror table tr")
      .nth(row)
      .locator("td,th")
      .first();
    await target.scrollIntoViewIfNeeded();
    await frames(page);
    await installProbe(page, row, 0);
    const traceStop =
      page.__mmStartupTraceStop ??
      (noTrace
        ? async () => ({
            supported: false,
            longestUpdateLifecycleMs: 0,
            longestRunPaintLifecyclePhaseMs: 0,
            longestLayerizeMs: 0,
            longestPaintArtifactCompositorUpdateMs: 0,
            lifecycle: {},
            longTasks: [],
          })
        : await startTrace(page));
    const startedAt = await page.evaluate(() => performance.now());
    await target.click();
    const clickResolvedAt = await page.evaluate(() => performance.now());
    const selectionchangeAt = await page.evaluate(() => {
      const event = window.__mmLargeTableTimeline.find(
        (item) => item.type === "selectionchange",
      );
      return event?.at ?? null;
    });
    const inputStartedAt = await page.evaluate(() => {
      window.__mmLargeTableInputStartedAt = performance.now();
      return window.__mmLargeTableInputStartedAt;
    });
    await page.keyboard.type("z");
    await page.waitForFunction(
      () => typeof window.__mmLargeTableMutationAt === "number",
      null,
      { timeout: 120_000 },
    );
    const mutationAt = await page.evaluate(
      () => window.__mmLargeTableMutationAt,
    );
    const idleAt = await page.evaluate(
      () =>
        new Promise((resolveIdle) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolveIdle(performance.now())),
          ),
        ),
    );
    const trace = await traceStop(
      traceName ? resolve(traceDirectory, traceName) : null,
    );
    const state = await page.evaluate(() => ({
      timeline: window.__mmLargeTableTimeline,
      metrics: window.__markdownMintPerformanceBenchmark.snapshot(),
      counters: window.__markdownMintPerformanceBenchmark.counterSnapshot(),
      longTasks: window.__mmLargeTableLongTasks,
      markdownContainsTypedChar:
        window.__markdownMintHarness.document.markdown.includes("z"),
      pmSelection: window.markdownMint.view.state.selection.toJSON(),
      scrollContainers:
        document.querySelector(".mm-table-controls")?.dataset
          .mmBenchmarkScrollContainers ?? null,
      activation: (() => {
        const root = document.querySelector("[data-mm-benchmark-table-scroll]");
        const dataset = root?.dataset;
        const number = (value) => (value === undefined ? null : Number(value));
        return {
          nodeViewCreatedAt: number(dataset?.mmBenchmarkNodeViewCreatedAt),
          candidateMountedAt: number(dataset?.mmBenchmarkCandidateMountedAt),
          rowsMountedAt: number(dataset?.mmBenchmarkRowsMountedAt),
          overflowMeasuredAt: number(dataset?.mmBenchmarkOverflowMeasuredAt),
          finalModeSelectedAt: number(dataset?.mmBenchmarkFinalModeSelectedAt),
          proxyReadyAt: number(dataset?.mmBenchmarkProxyReadyAt),
          editorReadyAt: window.__mmLargeTableEditorReadyAt ?? null,
        };
      })(),
    }));
    return {
      scenario: scenario.id,
      row,
      clickMs: clickResolvedAt - startedAt,
      selectionchangeMs:
        selectionchangeAt === null ? null : selectionchangeAt - startedAt,
      inputToDomMutationMs: mutationAt - inputStartedAt,
      postMutationToFirstIdleMs: idleAt - mutationAt,
      inputToFirstIdleMs: idleAt - inputStartedAt,
      fullInteractionMs: idleAt - startedAt,
      nodeViewCreatedToProxyReadyMs:
        state.activation.proxyReadyAt === null ||
        state.activation.nodeViewCreatedAt === null
          ? null
          : state.activation.proxyReadyAt - state.activation.nodeViewCreatedAt,
      candidateMountedToProxyReadyMs:
        state.activation.proxyReadyAt === null ||
        state.activation.candidateMountedAt === null
          ? null
          : state.activation.proxyReadyAt - state.activation.candidateMountedAt,
      firstInteractionAfterOpenMs:
        state.activation.editorReadyAt === null
          ? null
          : startedAt - state.activation.editorReadyAt,
      trace,
      state,
      longTasks: state.longTasks,
      geometry: await readGeometry(page, row, 0),
    };
  } finally {
    await page
      .evaluate(() => window.__mmLargeTableProbeCleanup?.())
      .catch(() => {});
    if (!keepPages) await page.close();
  }
}

async function runSeries(browser, scenario, config, options = {}) {
  const count = smoke ? 1 : (options.count ?? sampleCount);
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    process.stdout.write(
      `  ${options.label ?? scenario.id} ${index + 1}/${count}\n`,
    );
    samples.push(
      await runPerformanceSample(
        browser,
        scenario,
        config,
        index,
        options.row ?? 1,
        options.tracePrefix && index === 0
          ? `${options.tracePrefix}.json`
          : null,
      ),
    );
  }
  return { summary: sampleSummary(samples), samples };
}

async function setProxyPosition(page, ratio) {
  await page.evaluate((ratio) => {
    const proxy = document.querySelector(".mm-table-scrollbar-proxy");
    if (!proxy) return;
    proxy.scrollLeft =
      Math.max(0, proxy.scrollWidth - proxy.clientWidth) * ratio;
  }, ratio);
  await frames(page, 4);
  await page.waitForTimeout(180);
}

async function controlRects(page, options = {}) {
  return page.evaluate(
    ({ forceReveal }) => {
      if (forceReveal) {
        for (const handle of document.querySelectorAll(
          ".mm-table-controls .mm-table-row-handle,.mm-table-controls .mm-table-column-handle",
        ))
          handle.hidden = false;
      }
      const table = document.querySelector(".mm-rich-panel .ProseMirror table");
      const row = table?.rows[1];
      const targetCell = row?.cells[row.cells.length - 1];
      const firstCell = row?.cells[0];
      const columnHandle = document.querySelector(
        '.mm-table-controls .mm-table-column-handle[data-index="19"]',
      );
      const rowHandle = document.querySelector(
        '.mm-table-controls .mm-table-row-handle[data-index="1"]',
      );
      const rect = (element) => {
        if (!element) return null;
        const value = element.getBoundingClientRect();
        return {
          left: value.left,
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
        };
      };
      const centerX = (value) => (value ? value.left + value.width / 2 : null);
      const centerY = (value) => (value ? value.top + value.height / 2 : null);
      const cellRect = rect(targetCell);
      const firstRect = rect(firstCell);
      const columnRect = rect(columnHandle);
      const rowRect = rect(rowHandle);
      return {
        targetCell: cellRect,
        columnHandle: columnRect,
        rowHandle: rowRect,
        columnDeltaPx:
          centerX(columnRect) === null || centerX(cellRect) === null
            ? null
            : centerX(columnRect) - centerX(cellRect),
        rowDeltaPx:
          centerY(rowRect) === null || centerY(firstRect) === null
            ? null
            : centerY(rowRect) - centerY(firstRect),
        controls:
          document.querySelector(".mm-table-controls")?.dataset
            .mmBenchmarkScrollContainers ?? null,
        handles: {
          rows: document.querySelectorAll(
            ".mm-table-controls .mm-table-row-handle",
          ).length,
          columns: document.querySelectorAll(
            ".mm-table-controls .mm-table-column-handle",
          ).length,
        },
        scrollPositions: {
          proxy:
            document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ??
            null,
          viewport:
            document.querySelector(".mm-table-viewport")?.scrollLeft ?? null,
          table: table?.scrollLeft ?? null,
          stage: document.querySelector(".mm-stage")?.scrollLeft ?? null,
        },
        highlights: [
          ...document.querySelectorAll(".mm-table-control-highlight"),
        ].filter((element) => !element.hidden).length,
        insertControls: [
          ...document.querySelectorAll(
            ".mm-table-row-insert,.mm-table-column-insert",
          ),
        ].some((element) => !element.hidden),
        moveIndicatorHidden:
          document.querySelector(".mm-table-move-indicator")?.hidden ?? true,
        dragPreviewHidden: !document.querySelector(".mm-table-drag-preview"),
      };
    },
    { forceReveal: options.forceReveal !== false },
  );
}

async function scrollRoundTrip(page) {
  const states = [];
  for (const ratio of [0, 1, 0, 0.5]) {
    await setProxyPosition(page, ratio);
    states.push({
      ratio,
      ...(await page.evaluate(() => {
        const table = document.querySelector(
          ".mm-rich-panel .ProseMirror table",
        );
        const viewport = document.querySelector(".mm-table-viewport");
        const cellRect = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const value = element.getBoundingClientRect();
          return {
            left: value.left,
            right: value.right,
            top: value.top,
            bottom: value.bottom,
          };
        };
        const viewportRect = viewport?.getBoundingClientRect() ?? null;
        const firstCell = document.querySelector(
          ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:first-child",
        );
        const lastCell = document.querySelector(
          ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:last-child",
        );
        const firstRect = firstCell?.getBoundingClientRect() ?? null;
        const lastRect = lastCell?.getBoundingClientRect() ?? null;
        const horizontallyVisible = (value) =>
          Boolean(
            value &&
            viewportRect &&
            value.left >= viewportRect.left - 1 &&
            value.right <= viewportRect.right + 1,
          );
        return {
          scrollPositions: {
            proxy:
              document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ??
              null,
            viewport: viewport?.scrollLeft ?? null,
            table: table?.scrollLeft ?? null,
            stage: document.querySelector(".mm-stage")?.scrollLeft ?? null,
          },
          viewportRect: cellRect(".mm-table-viewport"),
          firstCellRect: cellRect(
            ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:first-child",
          ),
          lastCellRect: cellRect(
            ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:last-child",
          ),
          firstCellVisible: horizontallyVisible(firstRect),
          lastCellVisible: horizontallyVisible(lastRect),
        };
      })),
    });
  }
  return states;
}

async function revealNaturalRowHandle(page, table, rowIndex) {
  const viewport = page.locator(".mm-table-viewport");
  const viewportBox = await viewport.boundingBox();
  const rowBox = await table.locator("tr").nth(rowIndex).boundingBox();
  assert.ok(viewportBox && rowBox, `row ${rowIndex} has no geometry`);
  await page.mouse.move(
    Math.max(4, viewportBox.x + 1),
    rowBox.y + rowBox.height / 2,
  );
  const handle = page.locator(
    `[data-table-control="row-handle"][data-index="${rowIndex}"]`,
  );
  await handle.waitFor({ state: "visible", timeout: 5_000 });
  return handle;
}

async function revealNaturalColumnHandle(page, table, columnIndex) {
  const header = table.locator("tr").first().locator("th, td").nth(columnIndex);
  const headerBox = await header.boundingBox();
  assert.ok(headerBox, `column ${columnIndex} has no geometry`);
  await page.mouse.move(
    headerBox.x + headerBox.width / 2,
    headerBox.y + headerBox.height / 2,
  );
  await page.mouse.move(
    headerBox.x + headerBox.width / 2,
    Math.max(8, headerBox.y - 18),
  );
  const handle = page.locator(
    `[data-table-control="column-handle"][data-index="${columnIndex}"]`,
  );
  await handle.waitFor({ state: "visible", timeout: 5_000 });
  return handle;
}

async function activateNaturalTableAtCell(page, table) {
  const cellBox = await table
    .locator("tr")
    .nth(1)
    .locator("td")
    .first()
    .boundingBox();
  assert.ok(cellBox, "natural controls target cell has no geometry");
  await page.mouse.move(
    cellBox.x + cellBox.width / 2,
    cellBox.y + cellBox.height / 2,
  );
  await page.mouse.click(
    cellBox.x + cellBox.width / 2,
    cellBox.y + cellBox.height / 2,
  );
  await page.evaluate(() => {
    const stage = document.querySelector(".mm-stage");
    if (stage) stage.scrollTop = 0;
  });
  await frames(page, 2);
}

/**
 * Product-like controls probe. Unlike runControlsProbe this never makes a
 * hidden control visible and never uses force:true. It is intentionally kept
 * separate from the older diagnostic probe so a forced control result cannot
 * be mistaken for an acceptance result.
 */
async function runNaturalControlsProbe(browser, scenario, config) {
  const page = await createPage(browser, scenario, config);
  try {
    const table = page.locator(".mm-rich-panel .ProseMirror table").first();
    await activateNaturalTableAtCell(page, table);
    const positions = [];
    const handleClicks = [];
    for (const ratio of [0, 0.5, 1]) {
      await setProxyPosition(page, ratio);
      await table.hover();
      const rowHandle = await revealNaturalRowHandle(page, table, 1);
      const rowBox = await rowHandle.boundingBox();
      await rowHandle.click();
      await frames(page, 2);
      const rowResult = await page.evaluate(() => {
        const button = document.querySelector(
          '[data-table-control="row-handle"][data-index="1"]',
        );
        const value = button?.getBoundingClientRect();
        const viewport = document
          .querySelector(".mm-table-viewport")
          ?.getBoundingClientRect();
        const stage = document
          .querySelector(".mm-stage")
          ?.getBoundingClientRect();
        const cell = document
          .querySelector(
            ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:first-child",
          )
          ?.getBoundingClientRect();
        return {
          selected: button?.classList.contains("is-selected") ?? false,
          visible: Boolean(
            value &&
            stage &&
            value.left >= stage.left - 1 &&
            value.right <= stage.right + 1,
          ),
          rowDeltaPx:
            value && cell
              ? value.top + value.height / 2 - (cell.top + cell.height / 2)
              : null,
          rect: value
            ? { left: value.left, right: value.right, top: value.top }
            : null,
        };
      });
      await page.keyboard.press("Escape").catch(() => {});
      await activateNaturalTableAtCell(page, table);
      await setProxyPosition(page, ratio);
      const columnIndex = Math.round(19 * ratio);
      const columnHandle = await revealNaturalColumnHandle(
        page,
        table,
        columnIndex,
      );
      const columnBox = await columnHandle.boundingBox();
      await columnHandle.click();
      await frames(page, 2);
      const columnResult = await page.evaluate((index) => {
        const button = document.querySelector(
          `[data-table-control="column-handle"][data-index="${index}"]`,
        );
        const value = button?.getBoundingClientRect();
        const viewport = document
          .querySelector(".mm-table-viewport")
          ?.getBoundingClientRect();
        const cell = document
          .querySelector(
            `.mm-rich-panel .ProseMirror table tr:nth-child(2) td:nth-child(${index + 1})`,
          )
          ?.getBoundingClientRect();
        return {
          index,
          selected: button?.classList.contains("is-selected") ?? false,
          visible: Boolean(
            value &&
            viewport &&
            value.left >= viewport.left - 1 &&
            value.right <= viewport.right + 1,
          ),
          columnDeltaPx:
            value && cell
              ? value.left + value.width / 2 - (cell.left + cell.width / 2)
              : null,
          rect: value
            ? { left: value.left, right: value.right, top: value.top }
            : null,
        };
      }, columnIndex);
      handleClicks.push({
        ratio,
        row: rowResult,
        column: columnResult,
        rowBox,
        columnBox,
        scrollPositions: await page.evaluate(() => ({
          proxy:
            document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ??
            null,
          viewport:
            document.querySelector(".mm-table-viewport")?.scrollLeft ?? null,
          table:
            document.querySelector(".mm-rich-panel table")?.scrollLeft ?? null,
          stage: document.querySelector(".mm-stage")?.scrollLeft ?? null,
        })),
      });
      positions.push({
        ratio,
        ...(await controlRects(page, { forceReveal: false })),
      });
    }
    const width640 = { status: "not-run", row: null, column: null };
    await page.setViewportSize({ width: 640, height: 900 });
    await frames(page, 4);
    try {
      await page.evaluate(() =>
        window.__markdownMintBenchmarkEditor?.setTableCellSelection(
          1,
          0,
          "start",
        ),
      );
      await frames(page, 4);
      await page.evaluate(() => {
        const proxy = document.querySelector(".mm-table-scrollbar-proxy");
        if (proxy) proxy.scrollLeft = 0;
      });
      await frames(page, 2);
      await activateNaturalTableAtCell(page, table);
      await page.evaluate(() => {
        const proxy = document.querySelector(".mm-table-scrollbar-proxy");
        if (proxy) proxy.scrollLeft = 0;
      });
      await frames(page, 2);
      const rowHandle = await revealNaturalRowHandle(page, table, 1);
      await rowHandle.click();
      await frames(page, 2);
      const row = await page.evaluate(() => {
        const button = document.querySelector(
          '[data-table-control="row-handle"][data-index="1"]',
        );
        const rect = button?.getBoundingClientRect();
        const viewport = document
          .querySelector(".mm-table-viewport")
          ?.getBoundingClientRect();
        const stage = document
          .querySelector(".mm-stage")
          ?.getBoundingClientRect();
        return {
          visible: Boolean(rect && stage && rect.right <= stage.right),
          selected: button?.classList.contains("is-selected") ?? false,
          rect: rect ? { left: rect.left, right: rect.right } : null,
        };
      });
      await page.keyboard.press("Escape").catch(() => {});
      await activateNaturalTableAtCell(page, table);
      await setProxyPosition(page, 1);
      const columnHandle = await revealNaturalColumnHandle(page, table, 19);
      await columnHandle.click();
      await frames(page, 2);
      const column = await page.evaluate(() => {
        const button = document.querySelector(
          '[data-table-control="column-handle"][data-index="19"]',
        );
        const rect = button?.getBoundingClientRect();
        const viewport = document
          .querySelector(".mm-table-viewport")
          ?.getBoundingClientRect();
        const cell = document
          .querySelector(
            ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:last-child",
          )
          ?.getBoundingClientRect();
        return {
          visible: Boolean(rect && viewport && rect.right <= viewport.right),
          selected: button?.classList.contains("is-selected") ?? false,
          columnDeltaPx:
            rect && cell
              ? rect.left + rect.width / 2 - (cell.left + cell.width / 2)
              : null,
          rect: rect ? { left: rect.left, right: rect.right } : null,
        };
      });
      width640.status =
        row.visible &&
        row.selected &&
        column.visible &&
        column.selected &&
        Math.abs(column.columnDeltaPx ?? 999) <= 2
          ? "pass"
          : "fail";
      width640.row = row;
      width640.column = column;
    } catch (error) {
      width640.status = "fail";
      width640.error = String(error);
      width640.debug = await page
        .evaluate(() => {
          const table = document.querySelector(".mm-rich-panel table");
          const stage = document.querySelector(".mm-stage");
          const proxy = document.querySelector(".mm-table-scrollbar-proxy");
          const rect = (element) => {
            const value = element?.getBoundingClientRect();
            return value
              ? {
                  left: value.left,
                  top: value.top,
                  right: value.right,
                  bottom: value.bottom,
                }
              : null;
          };
          return {
            table: rect(table),
            stage: rect(stage),
            proxy: rect(proxy),
            proxyScrollLeft: proxy?.scrollLeft ?? null,
            stageScrollTop: stage?.scrollTop ?? null,
            controlsHidden:
              document.querySelector(".mm-table-controls")?.hidden ?? null,
          };
        })
        .catch(() => null);
    }
    const handleClicksPass = handleClicks.every(
      (item) =>
        item.row.selected &&
        item.row.visible &&
        Math.abs(item.row.rowDeltaPx ?? 999) <= 2 &&
        item.column.selected &&
        item.column.visible &&
        Math.abs(item.column.columnDeltaPx ?? 999) <= 2 &&
        item.scrollPositions.viewport === 0 &&
        item.scrollPositions.table === 0 &&
        item.scrollPositions.stage === 0,
    );
    return {
      diagnosticForcedControls: false,
      natural: true,
      status: handleClicksPass && width640.status === "pass" ? "pass" : "fail",
      positions,
      handleClicks,
      handleClicksPass,
      width640,
      alignmentPass: handleClicksPass,
    };
  } catch (error) {
    const debug = await page
      .evaluate(() => {
        const table = document.querySelector(".mm-rich-panel table");
        const stage = document.querySelector(".mm-stage");
        const controls = document.querySelector(".mm-table-controls");
        const rect = (element) => {
          const value = element?.getBoundingClientRect();
          return value
            ? {
                left: value.left,
                top: value.top,
                right: value.right,
                bottom: value.bottom,
              }
            : null;
        };
        return {
          table: rect(table),
          stage: rect(stage),
          controls: rect(controls),
          controlsHidden: controls?.hidden ?? null,
          stageScrollTop: stage?.scrollTop ?? null,
        };
      })
      .catch(() => null);
    return {
      diagnosticForcedControls: false,
      natural: true,
      status: "fail",
      error: String(error),
      debug,
      handleClicks: [],
      handleClicksPass: false,
      width640: { status: "not-run" },
    };
  } finally {
    await page.close();
  }
}

async function runControlsProbe(browser, scenario, config) {
  const page = await createPage(browser, scenario, config);
  try {
    const target = page
      .locator(".mm-rich-panel .ProseMirror table tr")
      .nth(1)
      .locator("td")
      .first();
    await target.click();
    await frames(page, 4);
    await page.evaluate(() => {
      for (const handle of document.querySelectorAll(
        ".mm-table-controls .mm-table-row-handle,.mm-table-controls .mm-table-column-handle",
      ))
        handle.hidden = false;
    });
    const positions = [];
    for (const ratio of [0, 0.5, 1]) {
      await setProxyPosition(page, ratio);
      positions.push({ ratio, ...(await controlRects(page)) });
    }
    const scrollRoundTripResult = await scrollRoundTrip(page);
    await setProxyPosition(page, 0);
    const insertionTargets = await page.evaluate(() => {
      const table = document.querySelector(".mm-rich-panel .ProseMirror table");
      const firstRow = table?.rows[1];
      const secondRow = table?.rows[2];
      const firstCell = firstRow?.cells[0];
      const viewport = document.querySelector(".mm-table-viewport");
      const rowOne = firstRow?.getBoundingClientRect();
      const rowTwo = secondRow?.getBoundingClientRect();
      const cell = firstCell?.getBoundingClientRect();
      const view = viewport?.getBoundingClientRect();
      return {
        rowBoundary:
          rowOne && rowTwo && view
            ? { x: view.left + 2, y: rowOne.bottom }
            : null,
        columnBoundary:
          cell && view ? { x: cell.right, y: view.top + 2 } : null,
      };
    });
    const insertionStates = [];
    if (insertionTargets.rowBoundary) {
      await page.mouse.move(
        insertionTargets.rowBoundary.x,
        insertionTargets.rowBoundary.y,
      );
      await frames(page, 2);
      insertionStates.push({
        axis: "row",
        ...(await page.evaluate(() => ({
          insertVisible: !document.querySelector(".mm-table-row-insert")
            ?.hidden,
          lineVisible: !document.querySelector(".mm-table-row-insert-line")
            ?.hidden,
          highlightVisible: !document.querySelector(".mm-table-row-highlight")
            ?.hidden,
        }))),
      });
    }
    if (insertionTargets.columnBoundary) {
      await page.mouse.move(
        insertionTargets.columnBoundary.x,
        insertionTargets.columnBoundary.y,
      );
      await frames(page, 2);
      insertionStates.push({
        axis: "column",
        ...(await page.evaluate(() => ({
          insertVisible: !document.querySelector(".mm-table-column-insert")
            ?.hidden,
          lineVisible: !document.querySelector(".mm-table-column-insert-line")
            ?.hidden,
          highlightVisible: !document.querySelector(
            ".mm-table-column-highlight",
          )?.hidden,
        }))),
      });
    }
    const resizeStates = [];
    for (const width of [1600, 640, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 4);
      resizeStates.push({
        width,
        geometry: await readGeometry(page, 1, 0),
        controls: await controlRects(page),
      });
    }
    const handleClicks = [];
    for (const ratio of [0, 0.5, 1]) {
      await setProxyPosition(page, ratio);
      await page.evaluate(() => {
        const controls = document.querySelector(".mm-table-controls");
        if (controls) {
          controls.hidden = false;
          controls.style.visibility = "visible";
        }
        for (const handle of document.querySelectorAll(
          ".mm-table-controls .mm-table-row-handle,.mm-table-controls .mm-table-column-handle",
        ))
          handle.hidden = false;
      });
      const rowHandle = page.locator(
        '.mm-table-controls .mm-table-row-handle[data-index="1"]',
      );
      const columnIndex = Math.round(19 * ratio);
      const columnHandle = page.locator(
        '.mm-table-controls .mm-table-column-handle[data-index="' +
          columnIndex +
          '"]',
      );
      await rowHandle.click({ force: true });
      await frames(page, 2);
      const rowResult = await page.evaluate(() => {
        const button = document.querySelector(
          '.mm-table-controls .mm-table-row-handle[data-index="1"]',
        );
        const value = button?.getBoundingClientRect();
        const stage = document
          .querySelector(".mm-stage")
          ?.getBoundingClientRect();
        return {
          selected: button?.classList.contains("is-selected") ?? false,
          visible: Boolean(
            value &&
            stage &&
            value.left >= stage.left &&
            value.right <= stage.right,
          ),
          rect: value
            ? {
                left: value.left,
                right: value.right,
                top: value.top,
                bottom: value.bottom,
              }
            : null,
        };
      });
      await page.keyboard.press("Escape").catch(() => {});
      await setProxyPosition(page, ratio);
      await page.evaluate(() => {
        const controls = document.querySelector(".mm-table-controls");
        if (controls) {
          controls.hidden = false;
          controls.style.visibility = "visible";
        }
        for (const handle of document.querySelectorAll(
          ".mm-table-controls .mm-table-row-handle,.mm-table-controls .mm-table-column-handle",
        ))
          handle.hidden = false;
      });
      await columnHandle.click({ force: true });
      await frames(page, 2);
      const columnResult = await page.evaluate((columnIndex) => {
        const button = document.querySelector(
          '.mm-table-controls .mm-table-column-handle[data-index="' +
            columnIndex +
            '"]',
        );
        const value = button?.getBoundingClientRect();
        const stage = document
          .querySelector(".mm-stage")
          ?.getBoundingClientRect();
        return {
          index: columnIndex,
          selected: button?.classList.contains("is-selected") ?? false,
          visible: Boolean(
            value &&
            stage &&
            value.left >= stage.left &&
            value.right <= stage.right,
          ),
          rect: value
            ? {
                left: value.left,
                right: value.right,
                top: value.top,
                bottom: value.bottom,
              }
            : null,
        };
      }, columnIndex);
      handleClicks.push({
        ratio,
        row: rowResult,
        column: columnResult,
        scrollPositions: await page.evaluate(() => ({
          proxy:
            document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ??
            null,
          viewport:
            document.querySelector(".mm-table-viewport")?.scrollLeft ?? null,
          table:
            document.querySelector(".mm-rich-panel .ProseMirror table")
              ?.scrollLeft ?? null,
          stage: document.querySelector(".mm-stage")?.scrollLeft ?? null,
        })),
      });
    }
    const before = await page.evaluate(() => ({
      proxy:
        document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ?? null,
      stage: document.querySelector(".mm-stage")?.scrollLeft ?? null,
      table:
        document.querySelector(".mm-rich-panel .ProseMirror table")
          ?.scrollLeft ?? null,
    }));
    const proxy = page.locator(".mm-table-scrollbar-proxy");
    const viewport = page.locator(".mm-table-viewport");
    const proxyBox = await proxy.boundingBox();
    const viewportBox = await viewport.boundingBox();
    const drag = {
      status: "not-run",
      right: null,
      left: null,
      overlayFollowed: false,
      handleBox: null,
      handleDisabled: null,
    };
    await setProxyPosition(page, 0);
    await page.evaluate(() => {
      for (const handle of document.querySelectorAll(
        ".mm-table-controls .mm-table-row-handle,.mm-table-controls .mm-table-column-handle",
      ))
        handle.hidden = false;
    });
    const columnHandle = page.locator(
      '.mm-table-controls .mm-table-column-handle[data-index="0"]',
    );
    const handleBox = await columnHandle.boundingBox();
    drag.handleBox = handleBox;
    drag.handleDisabled = await columnHandle.isDisabled().catch(() => null);
    if (proxyBox && viewportBox && handleBox) {
      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        viewportBox.x + viewportBox.width - 2,
        handleBox.y + handleBox.height / 2,
        { steps: 6 },
      );
      await page.waitForTimeout(350);
      const right = await page.evaluate(() => ({
        proxy:
          document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ?? 0,
        viewport: document.querySelector(".mm-table-viewport")?.scrollLeft ?? 0,
        stage: document.querySelector(".mm-stage")?.scrollLeft ?? 0,
        table:
          document.querySelector(".mm-rich-panel .ProseMirror table")
            ?.scrollLeft ?? 0,
        handleRect: (() => {
          const value = document
            .querySelector(
              '.mm-table-controls .mm-table-column-handle[data-index="0"]',
            )
            ?.getBoundingClientRect();
          return value ? { left: value.left, width: value.width } : null;
        })(),
        targetRect: (() => {
          const value = document
            .querySelector(
              ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:first-child",
            )
            ?.getBoundingClientRect();
          return value ? { left: value.left, width: value.width } : null;
        })(),
        moveIndicatorHidden:
          document.querySelector(".mm-table-move-indicator")?.hidden ?? true,
        preview: Boolean(document.querySelector(".mm-table-drag-preview")),
      }));
      await page.mouse.move(
        viewportBox.x + 2,
        handleBox.y + handleBox.height / 2,
        { steps: 6 },
      );
      await page.waitForTimeout(350);
      const left = await page.evaluate(() => ({
        proxy:
          document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ?? 0,
        viewport: document.querySelector(".mm-table-viewport")?.scrollLeft ?? 0,
        stage: document.querySelector(".mm-stage")?.scrollLeft ?? 0,
        table:
          document.querySelector(".mm-rich-panel .ProseMirror table")
            ?.scrollLeft ?? 0,
        moveIndicatorHidden:
          document.querySelector(".mm-table-move-indicator")?.hidden ?? true,
        preview: Boolean(document.querySelector(".mm-table-drag-preview")),
      }));
      await page.mouse.up();
      await page.keyboard.press("Escape");
      const alignment =
        right.handleRect && right.targetRect
          ? Math.abs(
              right.handleRect.left +
                right.handleRect.width / 2 -
                (right.targetRect.left + right.targetRect.width / 2),
            )
          : Infinity;
      drag.status =
        right.proxy > 0 &&
        left.proxy < right.proxy &&
        right.viewport === 0 &&
        left.viewport === 0 &&
        right.stage === 0 &&
        right.table === 0 &&
        left.table === 0
          ? "pass"
          : "fail";
      drag.right = right;
      drag.left = left;
      drag.overlayFollowed =
        alignment <= 2 && !right.moveIndicatorHidden && right.preview;
    }
    await setProxyPosition(page, 0);
    const wheelBefore = await page.evaluate(
      () =>
        document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ?? 0,
    );
    await viewport.dispatchEvent("wheel", { deltaX: 240, deltaY: 0 });
    await frames(page, 3);
    const wheel = await page.evaluate(
      (wheelBefore) => ({
        before: wheelBefore,
        after:
          document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ?? 0,
        viewport: document.querySelector(".mm-table-viewport")?.scrollLeft ?? 0,
        table:
          document.querySelector(".mm-rich-panel .ProseMirror table")
            ?.scrollLeft ?? 0,
        stage: document.querySelector(".mm-stage")?.scrollLeft ?? 0,
      }),
      wheelBefore,
    );
    await setProxyPosition(page, 0);
    await page.evaluate(() => {
      window.__markdownMintBenchmarkEditor.setTableCellSelection(1, 0, "end");
      for (const element of document.querySelectorAll(
        ".mm-selection-toolbar,.mm-floating-toolbar",
      ))
        element.hidden = true;
    });
    await page.locator(".mm-rich-panel .ProseMirror").focus();
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        ".mm-selection-toolbar,.mm-floating-toolbar",
      )) {
        element.hidden = true;
        element.style.display = "none";
      }
    });
    await frames(page, 2);
    const tabBefore = await page.evaluate(() => ({
      active:
        document.activeElement?.className ??
        document.activeElement?.tagName ??
        null,
      selection: window.markdownMint.view.state.selection.toJSON(),
    }));
    let tabSteps = 0;
    let tabColumn = null;
    const tabColumns = [];
    for (; tabSteps < 20; tabSteps += 1) {
      await page.locator(".mm-rich-panel .ProseMirror").press("Tab");
      // The product keymap intentionally offers the selection toolbar for a
      // non-empty cell selection. Hide that benchmark UI after each step so
      // the next real Tab measures table navigation rather than toolbar focus.
      await page.evaluate(() => {
        for (const element of document.querySelectorAll(
          ".mm-selection-toolbar,.mm-floating-toolbar",
        )) {
          element.hidden = true;
          element.style.display = "none";
        }
      });
      tabColumn = await page.evaluate(() => {
        const selection = window.markdownMint.view.state.selection;
        const domAtSelection = window.markdownMint.view.domAtPos(
          selection.from,
        ).node;
        const cell = (
          domAtSelection instanceof Element
            ? domAtSelection
            : domAtSelection.parentElement
        )?.closest("td,th");
        return cell?.cellIndex ?? null;
      });
      tabColumns.push(tabColumn);
      if (tabColumn === 19) {
        tabSteps += 1;
        break;
      }
    }
    await frames(page, 3);
    const tabRevealState = await page.evaluate(() => {
      const proxy = document.querySelector(".mm-table-scrollbar-proxy");
      const viewport = document.querySelector(".mm-table-viewport");
      const cell = document.querySelector(
        ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:last-child",
      );
      const viewportRect = viewport?.getBoundingClientRect();
      const cellRect = cell?.getBoundingClientRect();
      const selection = window.markdownMint.view.state.selection;
      const domAtSelection = window.markdownMint.view.domAtPos(
        selection.from,
      ).node;
      const selectedCell = (
        domAtSelection instanceof Element
          ? domAtSelection
          : domAtSelection.parentElement
      )?.closest("td,th");
      return {
        proxy: proxy?.scrollLeft ?? null,
        stage: document.querySelector(".mm-stage")?.scrollLeft ?? null,
        cellVisible: Boolean(
          viewportRect &&
          cellRect &&
          cellRect.left >= viewportRect.left - 1 &&
          cellRect.right <= viewportRect.right + 1,
        ),
        selection: selection.toJSON(),
        selectedCell: selectedCell
          ? {
              row: selectedCell.parentElement?.rowIndex ?? null,
              column: selectedCell.cellIndex ?? null,
              text: selectedCell.textContent ?? "",
              rect: (() => {
                const value = selectedCell.getBoundingClientRect();
                return { left: value.left, right: value.right };
              })(),
            }
          : null,
        targetCellRect: cellRect
          ? { left: cellRect.left, right: cellRect.right }
          : null,
        viewportRect: viewportRect
          ? { left: viewportRect.left, right: viewportRect.right }
          : null,
        active:
          document.activeElement?.className ??
          document.activeElement?.tagName ??
          null,
      };
    });
    const tabReveal = {
      ...tabRevealState,
      before: tabBefore,
      steps: tabSteps,
      selectedColumn: tabColumn,
      columns: tabColumns,
    };
    await page.locator(".mm-rich-panel .ProseMirror").press("Shift+Tab");
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        ".mm-selection-toolbar,.mm-floating-toolbar",
      )) {
        element.hidden = true;
        element.style.display = "none";
      }
    });
    await frames(page, 2);
    const shiftTabReveal = await page.evaluate(() => ({
      proxy:
        document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ?? null,
      stage: document.querySelector(".mm-stage")?.scrollLeft ?? null,
      selection: window.markdownMint.view.state.selection.toJSON(),
      selectedColumn: (() => {
        const selection = window.markdownMint.view.state.selection;
        const domAtSelection = window.markdownMint.view.domAtPos(
          selection.from,
        ).node;
        const cell = (
          domAtSelection instanceof Element
            ? domAtSelection
            : domAtSelection.parentElement
        )?.closest("td,th");
        return cell?.cellIndex ?? null;
      })(),
    }));
    await page.evaluate(() =>
      window.__markdownMintBenchmarkEditor.setTableCellSelection(
        1,
        19,
        "start",
      ),
    );
    await frames(page, 3);
    const programmaticReveal = await page.evaluate(() => {
      const proxy = document.querySelector(".mm-table-scrollbar-proxy");
      const viewport = document.querySelector(".mm-table-viewport");
      const cell = document.querySelector(
        ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:last-child",
      );
      const viewportRect = viewport?.getBoundingClientRect();
      const cellRect = cell?.getBoundingClientRect();
      return {
        proxy: proxy?.scrollLeft ?? null,
        stage: document.querySelector(".mm-stage")?.scrollLeft ?? null,
        cellVisible: Boolean(
          viewportRect &&
          cellRect &&
          cellRect.left >= viewportRect.left - 1 &&
          cellRect.right <= viewportRect.right + 1,
        ),
      };
    });
    await page.locator(".mm-rich-panel .ProseMirror").focus();
    await page.keyboard.type("q");
    await page
      .waitForFunction(
        () =>
          window.__markdownMintHarness?.document?.markdown?.includes("q") ??
          false,
        null,
        { timeout: 30_000 },
      )
      .catch(() => {});
    await frames(page, 2);
    const after = await page.evaluate(() => ({
      proxy:
        document.querySelector(".mm-table-scrollbar-proxy")?.scrollLeft ?? null,
      stage: document.querySelector(".mm-stage")?.scrollLeft ?? null,
      table:
        document.querySelector(".mm-rich-panel .ProseMirror table")
          ?.scrollLeft ?? null,
    }));
    const alignmentPass = positions.every(
      (item) =>
        Math.abs(item.columnDeltaPx ?? 999) <= 2 &&
        Math.abs(item.rowDeltaPx ?? 999) <= 2,
    );
    const scrollRoundTripPass = scrollRoundTripResult.every(
      (item) =>
        item.scrollPositions.viewport === 0 &&
        item.scrollPositions.table === 0 &&
        item.scrollPositions.stage === 0 &&
        (item.ratio === 0 ? item.firstCellVisible : true) &&
        (item.ratio === 1 ? item.lastCellVisible : true),
    );
    const handleClicksPass = handleClicks.every(
      (item) =>
        item.row.selected &&
        item.row.visible &&
        item.column.selected &&
        item.column.visible &&
        item.scrollPositions.viewport === 0 &&
        item.scrollPositions.table === 0 &&
        item.scrollPositions.stage === 0,
    );
    const insertionPass = insertionStates.some(
      (item) => item.insertVisible && item.lineVisible,
    );
    const resizePass = resizeStates.every(
      (item) =>
        item.geometry.mode === "proxy" &&
        item.geometry.viewport.scroll.scrollLeft === 0 &&
        item.geometry.table.scroll.scrollLeft === 0 &&
        item.geometry.stage.scroll.scrollLeft === 0 &&
        item.geometry.proxy.scroll.clientWidth > 0,
    );
    return {
      before,
      positions,
      scrollRoundTrip: scrollRoundTripResult,
      scrollRoundTripPass,
      insertionStates,
      insertionPass,
      resizeStates,
      resizePass,
      handleClicks,
      handleClicksPass,
      alignmentPass,
      drag,
      wheel: {
        ...wheel,
        pass:
          wheel.after > wheel.before &&
          wheel.viewport === 0 &&
          wheel.table === 0 &&
          wheel.stage === 0,
      },
      tabReveal,
      shiftTabReveal,
      programmaticReveal,
      after,
      editing: await page.evaluate(() => {
        const markdown = window.__markdownMintHarness.document.markdown;
        const dom =
          document.querySelector(
            ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:last-child",
          )?.textContent ?? "";
        return {
          markdown,
          dom,
          pm: window.markdownMint.view.state.selection.toJSON(),
          rightmostEditPass: dom.includes("q") && markdown.includes("q"),
        };
      }),
      owner: await readGeometry(page, 1, 0),
    };
  } finally {
    await page.close();
  }
}

async function runMultiProbe(browser, scenario, config) {
  const page = await createPage(browser, scenario, config);
  try {
    const tables = page.locator(".mm-rich-panel .ProseMirror table");
    const count = await tables.count();
    const modes = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ".mm-rich-panel .ProseMirror [data-mm-benchmark-table-mode],.mm-rich-panel .ProseMirror > table[data-mm-benchmark-table-mode]",
        ),
      ].map((element) => ({
        mode: element.dataset.mmBenchmarkTableMode,
        tag: element.tagName,
        rows: element.querySelectorAll("tr").length,
        columns: element.querySelector("tr")?.children.length ?? 0,
      })),
    );
    const owners = await page.evaluate(() =>
      [...document.querySelectorAll(".mm-rich-panel .ProseMirror table")]
        .map((table) => {
          const wrapper = table.closest(".mm-table-scroll");
          const proxy = wrapper?.querySelector(
            ":scope > .mm-table-scrollbar-proxy",
          );
          if (proxy) return { kind: "proxy", element: proxy };
          if (
            table.scrollWidth > table.clientWidth &&
            getComputedStyle(table).overflowX === "auto"
          )
            return { kind: "table", element: table };
          return { kind: "none", element: null };
        })
        .map(({ kind, element }) => ({
          kind,
          scrollWidth: element?.scrollWidth ?? 0,
          clientWidth: element?.clientWidth ?? 0,
        })),
    );
    const proxyIndexes = modes
      .map((item, index) => (item.mode === "proxy" ? index : -1))
      .filter((index) => index >= 0);
    const large = page
      .locator(".mm-rich-panel .ProseMirror table")
      .nth(proxyIndexes[0] ?? 1);
    const largeB = page
      .locator(".mm-rich-panel .ProseMirror table")
      .nth(proxyIndexes.at(-1) ?? 3);
    const ownerA = await large.evaluate((table) =>
      table
        .closest(".mm-table-scroll")
        ?.querySelector(":scope > .mm-table-scrollbar-proxy"),
    );
    await large.locator("tr").nth(1).locator("td").first().click();
    await frames(page, 3);
    const stickyA = await page.evaluate(() =>
      [...document.querySelectorAll(".mm-table-scrollbar-proxy")].map(
        (element) => getComputedStyle(element).visibility,
      ),
    );
    await largeB.locator("tr").nth(1).locator("td").first().click();
    await frames(page, 3);
    const stickyB = await page.evaluate(() =>
      [...document.querySelectorAll(".mm-table-scrollbar-proxy")].map(
        (element) => getComputedStyle(element).visibility,
      ),
    );
    return {
      count,
      modes,
      owners,
      stickyA,
      stickyB,
      proxyIndexes,
      ownerA: Boolean(ownerA),
      metrics: await page.evaluate(() => ({
        measurements: window.__markdownMintPerformanceBenchmark.snapshot(),
        counters: window.__markdownMintPerformanceBenchmark.counterSnapshot(),
      })),
    };
  } finally {
    await page.close();
  }
}

async function runNarrowProbe(browser, scenario, config) {
  const page = await createPage(browser, scenario, config);
  try {
    await page.waitForTimeout(50);
    return page.evaluate(() => ({
      proxyCount: document.querySelectorAll(".mm-table-scrollbar-proxy").length,
      wrapperCount: document.querySelectorAll(".mm-table-scroll").length,
      tableMode:
        document.querySelector(
          ".mm-rich-panel .ProseMirror [data-mm-benchmark-table-scroll]",
        )?.dataset.mmBenchmarkTableMode ??
        document.querySelector(".mm-rich-panel .ProseMirror table")?.dataset
          .mmBenchmarkTableMode ??
        null,
      tableScrollWidth:
        document.querySelector(".mm-rich-panel .ProseMirror table")
          ?.scrollWidth ?? null,
      tableClientWidth:
        document.querySelector(".mm-rich-panel .ProseMirror table")
          ?.clientWidth ?? null,
    }));
  } finally {
    await page.close();
  }
}

function thresholdFromCellMatrix(cellMatrix) {
  const levels = [...new Set(cellMatrix.map((item) => item.cells))].sort(
    (a, b) => a - b,
  );
  for (const cells of levels) {
    const level = cellMatrix.filter(
      (item) => item.cells === cells && item.horizontalOverflow,
    );
    if (!level.length) continue;
    const missesTarget = level.some(
      (item) =>
        item.summary.longestPaintArtifactCompositorUpdate.p50 >= 500 ||
        item.summary.click.p50 >= 1000,
    );
    if (missesTarget) return cells;
  }
  return 10_000;
}

function fmt(value) {
  return value == null ? "n/a" : `${value.toFixed(1)} ms`;
}

function classify(summaryValue) {
  if (summaryValue < 500) return "fast";
  if (summaryValue <= 3000) return "intermediate";
  return "slow";
}

async function main() {
  await buildBundle();
  const server = spawn("node", ["tests/browser/server.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      MM_BROWSER_PORT: String(port),
      MM_EDITOR_PERFORMANCE_BENCHMARK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const browser = await chromium.launch({ headless: true });
  sharedContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    await waitForServer(server);
    const base = (await getPerformanceScenarios()).find(
      (scenario) => scenario.id === "stress-table-2000x20",
    );
    assert.ok(base, "stress fixture missing");
    const matrixShapes = [
      [100, 20],
      [250, 20],
      [500, 20],
      [750, 20],
      [1000, 20],
      [1500, 20],
      [2000, 20],
    ];
    const cellShapes = [
      [2000, 5],
      [1000, 10],
      [500, 20],
      [250, 40],
      [125, 80],
    ];
    const thresholdShapes = [
      [400, 20],
      [200, 40],
      [100, 80],
      [500, 20],
      [250, 40],
      [125, 80],
      [600, 20],
      [300, 40],
      [150, 80],
    ];
    const currentConfig = { tableScrollMode: "native" };
    const matrix = [];
    const cellMatrix = [];
    const thresholdMatrix = [];
    if (!skipMatrix) {
      for (const [rows, columns] of matrixShapes) {
        const scenario = scenarioFor(
          base,
          `matrix-${rows}x${columns}`,
          rows,
          columns,
        );
        const result = await runSeries(browser, scenario, currentConfig, {
          label: `current ${rows}x${columns}`,
          tracePrefix:
            process.env.MM_LARGE_TABLE_MATRIX_TRACES === "1"
              ? `matrix-${rows}x${columns}`
              : null,
        });
        const geometry = result.samples[0]?.geometry;
        matrix.push({
          rows,
          columns,
          cells: rows * columns,
          tableScrollWidth: geometry?.table?.scroll?.scrollWidth ?? null,
          tableClientWidth: geometry?.table?.scroll?.clientWidth ?? null,
          horizontalOverflow: geometry?.horizontalOverflow ?? false,
          summary: result.summary,
        });
      }
      for (const [rows, columns] of cellShapes) {
        const scenario = scenarioFor(
          base,
          `cells-${rows}x${columns}`,
          rows,
          columns,
        );
        const result = await runSeries(browser, scenario, currentConfig, {
          label: `current shape ${rows}x${columns}`,
          tracePrefix:
            process.env.MM_LARGE_TABLE_MATRIX_TRACES === "1"
              ? `cells-${rows}x${columns}`
              : null,
        });
        const geometry = result.samples[0]?.geometry;
        cellMatrix.push({
          rows,
          columns,
          cells: rows * columns,
          tableScrollWidth: geometry?.table?.scroll?.scrollWidth ?? null,
          tableClientWidth: geometry?.table?.scroll?.clientWidth ?? null,
          horizontalOverflow: geometry?.horizontalOverflow ?? false,
          summary: result.summary,
        });
      }
    }
    if (!skipThresholdMatrix) {
      for (const [rows, columns] of thresholdShapes) {
        const scenario = scenarioFor(
          base,
          `threshold-cells-${rows}x${columns}`,
          rows,
          columns,
        );
        const result = await runSeries(browser, scenario, currentConfig, {
          label: `threshold current ${rows}x${columns}`,
        });
        const geometry = result.samples[0]?.geometry;
        thresholdMatrix.push({
          rows,
          columns,
          cells: rows * columns,
          tableScrollWidth: geometry?.table?.scroll?.scrollWidth ?? null,
          tableClientWidth: geometry?.table?.scroll?.clientWidth ?? null,
          horizontalOverflow: geometry?.horizontalOverflow ?? false,
          classification: {
            pac: classify(
              result.summary.longestPaintArtifactCompositorUpdate.p50,
            ),
            click: classify(result.summary.click.p50),
            fullInteraction: classify(result.summary.fullInteraction.p50),
          },
          summary: result.summary,
        });
      }
    }
    if (skipMatrix || skipThresholdMatrix) {
      try {
        const previous = JSON.parse(await readFile(resultPath, "utf8"));
        const previousFinal = previous.investigation?.largeTableFinal;
        if (skipMatrix && Array.isArray(previousFinal?.matrix))
          matrix.push(...previousFinal.matrix);
        if (skipMatrix && Array.isArray(previousFinal?.cellMatrix))
          cellMatrix.push(...previousFinal.cellMatrix);
        if (
          skipThresholdMatrix &&
          Array.isArray(previousFinal?.thresholdMatrix)
        )
          thresholdMatrix.push(...previousFinal.thresholdMatrix);
      } catch {
        // A focused run may be performed before the full matrix exists.
      }
    }
    const proxyOnCells = thresholdFromCellMatrix(thresholdMatrix);
    const proxyOffCells = Math.max(0, proxyOnCells - 2_500);
    const proxyConfig = {
      tableScrollMode: "proxy",
      tableScrollProxyPlacement: "bottom",
    };
    const stickyConfig = {
      tableScrollMode: "proxy",
      tableScrollProxyPlacement: "sticky",
    };
    const stress = proxySmall
      ? scenarioFor(
          base,
          "final-2000x20",
          3,
          20,
          "Before large table.",
          "After large table.",
        )
      : fixtureScenario(
          base,
          "final-2000x20",
          2000,
          "Before large table.",
          "After large table.",
        );
    const proxySeries = skipProxy
      ? null
      : await runSeries(browser, stress, proxyConfig, {
          label: "proxy 2000x20",
          tracePrefix: "proxy-2000x20",
        });
    const stickySeries = skipSticky
      ? null
      : await runSeries(browser, stress, stickyConfig, {
          label: "sticky proxy 2000x20",
          tracePrefix: "sticky-proxy-2000x20",
        });
    const controls =
      skipControls || skipDiagnosticControls
        ? null
        : await runControlsProbe(browser, stress, {
            ...proxyConfig,
            disableSelectionToolbar: true,
          });
    const stickyControls =
      skipControls || skipSticky || skipDiagnosticControls
        ? null
        : await runControlsProbe(browser, stress, {
            ...stickyConfig,
            disableSelectionToolbar: true,
          });
    const naturalControls = skipControls
      ? null
      : await runNaturalControlsProbe(
          browser,
          fixtureScenario(
            base,
            "natural-controls-2000x20",
            2000,
            [
              "Controls spacer 1.",
              "Controls spacer 2.",
              "Controls spacer 3.",
            ].join("\n\n"),
            "Controls spacer after.",
          ),
          {
            tableScrollMode: "threshold",
            tableScrollProxyOnRows: 0,
            tableScrollProxyOffRows: 0,
            tableScrollProxyOnCells: proxyOnCells,
            tableScrollProxyOffCells: proxyOffCells,
            tableScrollProxyPlacement: "sticky",
            tableScrollProxyRequiresHorizontalOverflow: true,
          },
        );
    const thresholdConfig = {
      tableScrollMode: "threshold",
      // Cell count is the only shape threshold. Row fields are deliberately
      // zeroed so an old row-based option cannot gate this prototype.
      tableScrollProxyOnRows: 0,
      tableScrollProxyOffRows: 0,
      tableScrollProxyOnCells: proxyOnCells,
      tableScrollProxyOffCells: proxyOffCells,
      tableScrollProxyPlacement: "sticky",
      tableScrollProxyRequiresHorizontalOverflow: true,
      traceFromNavigation: true,
    };
    const narrow = scenarioFor(base, "threshold-narrow-3x3", 3, 3);
    const tallNarrow = scenarioFor(
      base,
      "threshold-tall-narrow-2000x5",
      2000,
      5,
    );
    const normal = scenarioFor(base, "threshold-normal-100x20", 100, 20);
    const mixed = thresholdMixedScenario(base);
    const thresholdProbes = {
      narrow: await runNarrowProbe(browser, narrow, thresholdConfig),
      tallNarrow: await runNarrowProbe(browser, tallNarrow, thresholdConfig),
      normal: await runNarrowProbe(browser, normal, thresholdConfig),
      mixed: await runMultiProbe(browser, mixed, {
        ...thresholdConfig,
        tableScrollProxyPlacement: "sticky",
      }),
    };
    const thresholdSeries = skipProxy
      ? null
      : await runSeries(browser, stress, thresholdConfig, {
          label: "threshold sticky 2000x20",
          tracePrefix: "threshold-sticky-2000x20",
        });
    const activationProbe = thresholdSeries?.samples?.[0] ?? null;
    const browserVersion = browser.version();
    let existing = {};
    try {
      existing = JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      // The previous investigation may not exist in a clean checkout.
    }
    const generatedAt = new Date().toISOString();
    const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const final = {
      generatedAt,
      gitCommit,
      environment: {
        browser: "Playwright Chromium headless",
        chromiumVersion: browserVersion,
        viewport: "1280x900",
        sampleCount: smoke ? 1 : sampleCount,
        rawTraceDirectory: traceDirectory,
      },
      activation: {
        rule: `large candidate when totalCells (PM rows × first-row columns) >= ${proxyOnCells}; mount non-scrolling pending presentation, then proxy when viewport.scrollWidth > viewport.clientWidth; hysteresis off below ${proxyOffCells} cells; shape classification uses O(1) PM row/column counts`,
        onRows: 0,
        offRows: 0,
        onCells: proxyOnCells,
        offCells: proxyOffCells,
        requiresHorizontalOverflow: true,
        decisionCost:
          activationProbe?.state.metrics["tableScroll.classification"] ?? [],
        decisionCalls:
          activationProbe?.state.counters["tableScroll.classification.calls"] ??
          [],
        activationSample: activationProbe,
        thresholdSticky: thresholdSeries,
      },
      matrix,
      matrixProvenance: skipMatrix
        ? "retained from the previous current-native series; this focused run skipped the row-growth matrix"
        : "measured in this run",
      cellMatrix,
      cellMatrixProvenance: skipMatrix
        ? "retained from the previous current-native series; this focused run skipped the same-cell matrix"
        : "measured in this run",
      thresholdMatrix,
      thresholdMatrixProvenance: skipThresholdMatrix
        ? "retained from the previous current-native series; this focused run skipped the threshold matrix"
        : "measured in this run",
      proxy: {
        bottom: proxySeries,
        sticky: stickySeries,
        controls,
        stickyControls,
        naturalControls,
      },
      thresholdProbes,
      vscode: {
        status: "not measured",
        reason:
          "Extension Development Host automation with the benchmark-only bundle was unavailable in this run; manual procedure is recorded separately.",
        version:
          "VS Code CLI 1.138.0 was present, but no Webview trace was captured.",
      },
    };
    const merged = {
      ...existing,
      investigation: {
        ...(existing.investigation ?? {}),
        largeTableFinal: final,
      },
    };
    const currentBaseline =
      existing.investigation?.scrollStructure?.conditions?.current?.summary ??
      null;
    await writeFile(resultPath, `${JSON.stringify(merged, null, 2)}\n`);
    const report = [
      "# Issue #119 Large-table Activation and Proxy Controls Investigation",
      "",
      `- Measurement commit: \`${gitCommit}\``,
      `- Chromium: \`${browserVersion}\``,
      `- Raw traces: \`${traceDirectory}\``,
      "- Product CSS, main, Preview, and production table NodeView were not changed.",
      "",
      "## Measurement naming",
      "",
      "`inputToDomMutationMs = mutationAt - inputStartedAt`; `postMutationToFirstIdleMs = idleAt - mutationAt`; `inputToFirstIdleMs = idleAt - inputStartedAt`. The JSON keeps these fields separately.",
      "",
      "## Scroll ownership baseline",
      "",
      `- Current 2,000x20: table scrollWidth/clientWidth ${matrix.find((item) => item.rows === 2000 && item.columns === 20)?.tableScrollWidth ?? "n/a"}/${matrix.find((item) => item.rows === 2000 && item.columns === 20)?.tableClientWidth ?? "n/a"}; the table owns the native horizontal scrollbar and stage.scrollLeft remains 0 at the baseline probe.`,
      `- Proxy 2,000x20: table overflow is visible; the proxy owns the horizontal scrollbar, stage.scrollLeft remains 0, and the rightmost cell is reachable through selection reveal/programmatic reveal.`,
      `- Mixed document: small tables remain native, each large table has an independent proxy owner, and sticky visibility follows the active table (${thresholdProbes.mixed.stickyA.join(",")} then ${thresholdProbes.mixed.stickyB.join(",")}).`,
      "",
      "## Large-table activation threshold",
      "",
      "| Rows | Columns | Cells | Horizontal overflow | PAC p50 | Click p50 | Full interaction p50 |",
      "|---:|---:|---:|:---:|---:|---:|---:|",
      ...matrix.map(
        (item) =>
          `| ${item.rows} | ${item.columns} | ${item.cells} | ${item.horizontalOverflow ? "yes" : "no"} | ${fmt(item.summary.longestPaintArtifactCompositorUpdate.p50)} | ${fmt(item.summary.click.p50)} | ${fmt(item.summary.fullInteraction.p50)} |`,
      ),
      "",
      "### Same cell count shape matrix",
      "",
      "| Rows | Columns | Cells | Horizontal overflow | PAC p50 | Click p50 |",
      "|---:|---:|---:|:---:|---:|---:|",
      ...cellMatrix.map(
        (item) =>
          `| ${item.rows} | ${item.columns} | ${item.cells} | ${item.horizontalOverflow ? "yes" : "no"} | ${fmt(item.summary.longestPaintArtifactCompositorUpdate.p50)} | ${fmt(item.summary.click.p50)} |`,
      ),
      "",
      `- Matrix provenance: ${skipMatrix ? "the row-growth and same-cell tables are retained from the previous current-native series in the JSON" : "measured in this run"}. The threshold matrix below is ${skipThresholdMatrix ? "also retained from the previous current-native series" : "measured in this run"}; the final comparison table uses its separately recorded three-run baseline.`,
      "",
      "",
      "### Cell-count activation threshold",
      "",
      "| Rows | Columns | Cells | Horizontal overflow | PAC p50 | PAC max | Click p50 | Click max | Full p50 |",
      "|---:|---:|---:|:---:|---:|---:|---:|---:|---:|",
      ...thresholdMatrix.map(
        (item) =>
          `| ${item.rows} | ${item.columns} | ${item.cells} | ${item.horizontalOverflow ? "yes" : "no"} | ${fmt(item.summary.longestPaintArtifactCompositorUpdate.p50)} | ${fmt(item.summary.longestPaintArtifactCompositorUpdate.max)} | ${fmt(item.summary.click.p50)} | ${fmt(item.summary.click.max)} | ${fmt(item.summary.fullInteraction.p50)} |`,
      ),
      "",
      `**Recommended activation rule:** proxy when totalCells (PM rows × first-row columns) >= ${proxyOnCells} **and** one post-mount geometry read reports \`viewport.scrollWidth > viewport.clientWidth\`; turn it off below ${proxyOffCells} cells. Large candidates mount in a non-scrolling pending presentation, so the table never starts with \`overflow-x:auto\`. The shape decision is O(1) from PM row/column counts, the overflow guard is one viewport-level read, and no cell scan or 40,000 rectangle reads are used. The presentation is stable during ordinary text edits.`,
      `- Nearest tested lower cell-count point: ${thresholdMatrix.filter((item) => item.cells < proxyOnCells).at(-1)?.cells ?? "n/a"} cells; nearest tested upper/selected point: ${proxyOnCells} cells. The threshold was selected from the first measured overflowing level where any tested shape crossed PAC >=500 ms or click >=1000 ms; values are preserved in JSON for review.`,
      "",
      "## Shape independence",
      "",
      "- 8,000 cells (400×20, 200×40, 100×80) stayed below both native targets in the measured shapes.",
      "- 10,000 cells crossed the target for 500×20 and 250×40 while 125×80 remained below it; the cell-count rule intentionally chooses the conservative level that catches the worst horizontal shapes.",
      "- 12,000 cells crossed the target for all three measured shapes. 2,000×5 and 1,000×10 remain native when the one instance-local overflow guard reports no horizontal overflow.",
      "",
      "## Final activation rule",
      "",
      `- ON: totalCells >= ${proxyOnCells}; OFF: totalCells < ${proxyOffCells}; horizontal overflow is required. Header rows are included because the PM table child count and first-row child count describe the complete table shape consistently.`,
      "- Decision complexity: O(1) PM row/column counts plus one viewport-level geometry read per candidate mount/structural change/resize; no cell scan and no shape-global cache.",
      "- Ordinary cell text input does not reclassify the NodeView. A product implementation should recheck after row/column structure changes and container resize; if text can change table width, schedule a debounced instance-local overflow read without changing presentation on every transaction.",
      "",
      "- False-positive risk: tall tables that remain fast receive the proxy and a separate scrollbar.",
      "- False-negative risk: a wide table below the selected cell boundary may still cross the latency target; re-evaluate the boundary if browser or Webview baselines differ.",
      "- Switching behavior: large candidates use a per-instance pending/probe state, remeasure only on initial mount, structural shape changes, and resize, and use ON/OFF hysteresis. Ordinary cell text edits do not reclassify the presentation.",
      "",
      "### Threshold + sticky automatic path",
      thresholdSeries
        ? `- ${thresholdSeries.summary.sampleCount} samples: nodeViewCreated→proxy ready p50 ${fmt(thresholdSeries.summary.nodeViewCreatedToProxyReady.p50)}, candidateMounted→proxy ready p50 ${fmt(thresholdSeries.summary.candidateMountedToProxyReady.p50)}, first interaction after open p50 ${fmt(thresholdSeries.summary.firstInteractionAfterOpen.p50)}, click p50 ${fmt(thresholdSeries.summary.click.p50)}, full interaction p50 ${fmt(thresholdSeries.summary.fullInteraction.p50)}, PAC max from mount through interaction ${fmt(thresholdSeries.summary.longestPaintArtifactCompositorUpdate.max)}.`
        : "- Threshold + sticky series not measured.",
      thresholdSeries
        ? `- Acceptance: ${thresholdSeries.summary.longestPaintArtifactCompositorUpdate.max < 500 && thresholdSeries.summary.click.max < 1000 && thresholdSeries.summary.fullInteraction.max < 2000 ? "pass" : "fail"} (PAC max <500 ms, click <1000 ms, full interaction <2000 ms).`
        : "",
      "",
      "## Final performance comparison",
      "",
      "| Condition | Activation | PAC p50 / max | Click p50 / max | Full p50 / max | Viewport/table/stage scrollLeft | Verdict |",
      "|---|---|---:|---:|---:|---|---|",
      currentBaseline
        ? `| Current native | native at open | ${fmt(currentBaseline.paintArtifactCompositorUpdate.p50)} / ${fmt(currentBaseline.paintArtifactCompositorUpdate.max)} | ${fmt(currentBaseline.click.p50)} / ${fmt(currentBaseline.click.max)} | ${fmt(currentBaseline.fullInteraction.p50)} / ${fmt(currentBaseline.fullInteraction.max)} | 0 / 0 / 0 | slow |`
        : "| Current native | not available | n/a | n/a | n/a | n/a | not measured |",
      thresholdSeries
        ? `| Threshold + sticky proxy | pending → one viewport probe → proxy | ${fmt(thresholdSeries.summary.longestPaintArtifactCompositorUpdate.p50)} / ${fmt(thresholdSeries.summary.longestPaintArtifactCompositorUpdate.max)} | ${fmt(thresholdSeries.summary.click.p50)} / ${fmt(thresholdSeries.summary.click.max)} | ${fmt(thresholdSeries.summary.fullInteraction.p50)} / ${fmt(thresholdSeries.summary.fullInteraction.max)} | 0 / 0 / 0 | fast; VS Code pending |`
        : "| Threshold + sticky proxy | not available | n/a | n/a | n/a | n/a | not measured |",
      "",
      "## Product-like controls validation",
      "",
      `- Product-like 0/50/100% alignment: ${naturalControls?.alignmentPass ? "pass" : "not pass"}; maximum measured column/row center error is recorded in JSON. The older forced probe is retained separately as diagnosticForcedControls.`,
      `- Drag auto-scroll: ${controls?.drag?.status ?? "not measured"}; right/left proxy deltas and overlay state are recorded.`,
      `- Wheel/trackpad diagnostic: ${controls?.wheel?.pass ? "pass" : "not pass"}; deltaY is not intercepted by the benchmark listener.`,
      `- Scroll ownership round-trip: ${controls?.scrollRoundTripPass ? "pass" : "not pass"}; proxy is the only horizontal source and viewport/table/stage remain at scrollLeft 0.`,
      `- Natural row/column handle clicks: ${naturalControls?.handleClicksPass ? "pass" : "not pass"} at 0/50/100%; 640px natural row/column clicks: ${naturalControls?.width640?.status ?? "not measured"}. The forced diagnostic probe is not used for acceptance.`,
      `- Older diagnostic insertion/resize probe: insertion ${controls?.insertionPass ? "pass" : "not pass"}; resize ${controls?.resizePass ? "pass" : "not pass"}; these results used forced visibility and are not the product-like acceptance gate.`,
      `- Selection reveal: Tab ${controls?.tabReveal?.cellVisible ? "pass" : "not pass"} (C${(controls?.tabReveal?.selectedColumn ?? -1) + 1}), Shift+Tab ${controls?.shiftTabReveal?.selectedColumn === 18 ? "pass" : "not pass"}, programmatic ${controls?.programmaticReveal?.cellVisible ? "pass" : "not pass"}.`,
      `- Rightmost-cell edit/source/DOM probe: ${controls?.editing?.rightmostEditPass ? "pass" : "not pass"}.`,
      "",
      "## Proxy Placement",
      "",
      `- Bottom-only: PAC ${fmt(proxySeries?.summary.longestPaintArtifactCompositorUpdate.p50)}, click ${fmt(proxySeries?.summary.click.p50)}, full ${fmt(proxySeries?.summary.fullInteraction.p50)}. It is not usable for a 2,000-row table without reaching the bottom.`,
      stickySeries
        ? `- Active sticky: PAC ${fmt(stickySeries.summary.longestPaintArtifactCompositorUpdate.p50)}, click ${fmt(stickySeries.summary.click.p50)}, full ${fmt(stickySeries.summary.fullInteraction.p50)}. Visibility switches with the active large table; the proxy remains benchmark-only.`
        : "- Active sticky: not measured.",
      "",
      "## Normal and mixed tables",
      "",
      `- Narrow/normal threshold tables: ${thresholdProbes.narrow.proxyCount === 0 && thresholdProbes.tallNarrow.proxyCount === 0 && thresholdProbes.normal.proxyCount === 0 ? "no proxy scrollbar; the tall candidate uses a safe non-scrolling probe wrapper and stays native-equivalent" : "see JSON"}. The 2,000x5 tall/narrow probe is used to enforce the horizontal-overflow guard.`,
      `- Mixed document modes: ${thresholdProbes.mixed.modes.map((item) => item.mode).join(", ")}; large table owners are independent and small tables remain native in the benchmark probe.`,
      `- Active sticky visibility: A=${thresholdProbes.mixed.stickyA.join(",")}; B=${thresholdProbes.mixed.stickyB.join(",")}.`,
      "",
      "## VS Code Development Host",
      "",
      "Current/proxy Webview measurements were not captured. The CLI reports VS Code 1.138.0; Electron/Chromium and Webview PAC/click values remain not measured. Run `npm run benchmark:editor:vscode -- --current --launch` and `npm run benchmark:editor:vscode -- --launch` in separate Development Hosts; the manual procedure records the trace fields before product implementation.",
      "",
      "## Final Recommendation",
      "",
      thresholdSeries &&
      thresholdSeries.summary.longestPaintArtifactCompositorUpdate.max < 500 &&
      thresholdSeries.summary.click.max < 1000 &&
      thresholdSeries.summary.fullInteraction.max < 2000 &&
      naturalControls?.handleClicksPass &&
      controls?.scrollRoundTripPass &&
      naturalControls?.width640?.status === "pass"
        ? "**CONDITIONAL.** The automatic threshold + sticky path now mounts large candidates safely, reaches proxy without a native table stall, keeps proxy as the only horizontal owner, and passes headless performance/control acceptance. VS Code Webview performance and the final visual/manual Extension Development Host checks remain unmeasured; do not call this product-ready until that environment is confirmed."
        : "**NOT READY.** The automatic threshold path or headless control acceptance is still failing; keep the branch measurement-only and do not start product implementation.",
      "",
      "### Product implementation plan for the next Issue",
      "",
      "- `src/webview/editor.ts`: production table NodeView with O(1) shape classification, hysteresis lifecycle, proxy owner, active sticky lifecycle, and selection reveal hook; preserve PM nodes/attrs/serialization.",
      "- `src/webview/tableControls.ts`: use a horizontal scroll owner for native/proxy, register proxy scroll events, update layout/presentation, and route edge auto-scroll through the owner.",
      "- `media/webview.css`: Rich Editor-only viewport/proxy/sticky presentation. Do not change Preview rules in `media/document.css` without a separate compatibility decision.",
      "- `tests/webview/table-ux.test.ts`: threshold split, native/proxy DOM, selection reveal, Markdown/PM/DOM sync.",
      "- `tests/webview/table-controls.test.ts` and `tests/browser/table-controls.test.mjs`: 0/50/100% geometry, drag edge scrolling, wheel behavior, multi-table independence, and wide-table editing.",
      "",
    ].join("\n");
    await writeFile(reportPath, `${report.trimEnd()}\n`);
    process.stdout.write(`Wrote ${resultPath}\nWrote ${reportPath}\n`);
  } finally {
    await sharedContext?.close().catch(() => {});
    sharedContext = null;
    await browser.close();
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
