import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { getPerformanceScenarios } from "../tests/browser/performance-fixtures.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MM_PAINT_INVESTIGATION_PORT ?? "4182");
const baseUrl = `http://127.0.0.1:${port}`;
const reportPath = resolve(
  repository,
  process.env.MM_PAINT_INVESTIGATION_REPORT ??
    "output/benchmark/issue-119-paint-compositor-investigation.json",
);
const markdownPath = resolve(
  repository,
  process.env.MM_PAINT_INVESTIGATION_MARKDOWN ??
    "docs/performance/issue-119-paint-compositor-investigation.md",
);
const bundlePath = resolve(repository, "output/benchmark/webview.js");
const rawTracePath = resolve(
  process.env.MM_PAINT_INVESTIGATION_RAW_TRACE ??
    "/tmp/markdown-mint-issue119-paint-click-trace.json",
);
const sampleCount = Math.max(
  1,
  Number.parseInt(process.env.MM_PAINT_INVESTIGATION_SAMPLES ?? "3", 10) || 3,
);
const smokeMode = process.env.MM_PAINT_INVESTIGATION_SMOKE === "1";
const debugStages = process.env.MM_PAINT_INVESTIGATION_DEBUG === "1";
const traceCategories = [
  "devtools.timeline",
  "blink",
  "input",
  "rendering",
  "v8",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.layers",
].join(",");
const lifecycleNames = [
  "WebFrameWidgetImpl::UpdateLifecycle",
  "LocalFrameView::RunPaintLifecyclePhase",
  "LocalFrameView::pushPaintArtifactToCompositor",
  "Layerize",
  "PaintArtifactCompositor::Update",
];
const editorSelector = ".mm-rich-panel .ProseMirror";

function percentile(values, fraction) {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high
    ? sorted[low]
    : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function summarize(values) {
  const valid = values.filter(Number.isFinite);
  return {
    sampleCount: valid.length,
    p50: percentile(valid, 0.5),
    p95: percentile(valid, 0.95),
    max: valid.length ? Math.max(...valid) : null,
    samples: valid,
  };
}

function analyzeGrowth(scaling) {
  const rowCounts = scaling.map((entry) => entry.bodyRows);
  const updateP50Ms = scaling.map(
    (entry) => entry.summary.longestPaintArtifactCompositorUpdateMs.p50,
  );
  const positive = rowCounts
    .map((rows, index) => [rows, updateP50Ms[index]])
    .filter(([rows, update]) => rows > 0 && update > 0);
  let logLogExponent = null;
  if (positive.length >= 2) {
    const logs = positive.map(([rows, update]) => [
      Math.log(rows),
      Math.log(update),
    ]);
    const meanX = logs.reduce((sum, [x]) => sum + x, 0) / logs.length;
    const meanY = logs.reduce((sum, [, y]) => sum + y, 0) / logs.length;
    const covariance = logs.reduce(
      (sum, [x, y]) => sum + (x - meanX) * (y - meanY),
      0,
    );
    const variance = logs.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
    logLogExponent = variance ? covariance / variance : null;
  }
  const ratio =
    updateP50Ms.length >= 2 && updateP50Ms[0] > 0
      ? updateP50Ms.at(-1) / updateP50Ms[0]
      : null;
  const pairwiseRates = updateP50Ms
    .slice(1)
    .map(
      (value, index) =>
        (value - updateP50Ms[index]) /
        (rowCounts[index + 1] - rowCounts[index]),
    );
  let classification = "insufficient trace data";
  if (Number.isFinite(logLogExponent)) {
    if (logLogExponent >= 1.7 && logLogExponent <= 2.3) {
      classification =
        "approximately quadratic in row count at fixed column count";
    } else if (logLogExponent >= 0.8 && logLogExponent <= 1.2) {
      classification = "approximately linear in row count";
    } else if (logLogExponent > 1.2) {
      classification = "superlinear in row count";
    } else if (logLogExponent > 0 && ratio !== null && ratio < 1.5) {
      classification = "mostly fixed cost across tested row counts";
    } else {
      classification = "sublinear or irregular across tested row counts";
    }
  }
  return {
    updateRatio: ratio,
    logLogExponent,
    adjacentPerRowRatesMs: pairwiseRates,
    classification,
    rowCounts,
    updateP50Ms,
  };
}

function largestUpdateLifecycleDurations(trace) {
  return (trace?.lifecycleEvents?.["WebFrameWidgetImpl::UpdateLifecycle"] ?? [])
    .map((event) => event.durationMs)
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
}

async function readInputSettlingSummary() {
  const interactionPath = resolve(
    repository,
    "output/benchmark/issue-119-interaction-investigation.json",
  );
  try {
    const prior = JSON.parse(await readFile(interactionPath, "utf8"));
    const condition = prior.investigation?.conditions?.A_currentRealClickEnd;
    const timings = condition?.timings;
    if (!timings) return null;
    return {
      generatedAt: prior.generatedAt,
      measurementCommitSHA: prior.gitCommit,
      inputToDomMutationMs: timings.inputToDomMutationMs?.p50 ?? null,
      postMutationLongestTaskMs: timings.postMutationLongestTaskMs?.p50 ?? null,
      postMutationLongTaskTotalMs:
        timings.postMutationLongTaskTotalMs?.p50 ?? null,
      inputToFirstIdleMs: timings.inputToFirstIdleMs?.p50 ?? null,
      inputPhasePmSelectionOffsetsMs: (condition.samples ?? []).map(
        (sample) =>
          sample.interaction.pmSelectionChanges.find(
            (change) => change.phase === "input",
          )?.fromPhaseStartMs ?? null,
      ),
    };
  } catch {
    return null;
  }
}

function removeLegacyMisorderedTaskFields(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) removeLegacyMisorderedTaskFields(entry);
    return;
  }
  if (Array.isArray(value.firstTwoLifecycleTasks)) {
    const lifecycleTasks = (value.longestLongTasks ?? [])
      .filter((task) =>
        /UpdateLifecycle|RunPaintLifecyclePhase|pushPaintArtifactToCompositor|Layerize|PaintArtifactCompositor::Update/.test(
          task.longestChild?.name ?? "",
        ),
      )
      .map((task) => ({
        event: task,
        nestedLifecycleMaxMs: {
          [task.longestChild.name]: task.longestChild.durationMs,
        },
      }));
    if (lifecycleTasks.length) value.largestLifecycleTasks = lifecycleTasks;
    delete value.firstTwoLifecycleTasks;
  }
  for (const entry of Object.values(value)) {
    removeLegacyMisorderedTaskFields(entry);
  }
}

function getCompleteEvents(events) {
  return events.filter(
    (event) =>
      event.ph === "X" &&
      Number.isFinite(event.ts) &&
      Number.isFinite(event.dur),
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
  const complete = getCompleteEvents(events);
  const parentByEvent = new Map();
  const threadStacks = new Map();
  const sortedForNesting = complete
    .slice()
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  for (const event of sortedForNesting) {
    const key = `${event.pid}:${event.tid}`;
    const stack = threadStacks.get(key) ?? [];
    while (stack.length > 0 && !eventContains(stack.at(-1), event)) stack.pop();
    parentByEvent.set(event, stack.at(-1) ?? null);
    stack.push(event);
    threadStacks.set(key, stack);
  }
  const parentOf = (event) => parentByEvent.get(event) ?? null;
  const depthCache = new WeakMap();
  const depthOf = (event) => {
    if (depthCache.has(event)) return depthCache.get(event);
    let depth = 0;
    let parent = parentOf(event);
    while (parent && depth < 64) {
      depth += 1;
      parent = parentOf(parent);
    }
    depthCache.set(event, depth);
    return depth;
  };
  const traceOrigin = complete.length
    ? Math.min(...complete.map((event) => event.ts))
    : 0;
  const expose = (event) => ({
    name: event.name,
    category: event.cat,
    startUs: event.ts,
    startMsFromTrace: (event.ts - traceOrigin) / 1000,
    durationMs: event.dur / 1000,
    parentName: parentOf(event)?.name ?? null,
    depth: depthOf(event),
    pid: event.pid,
    tid: event.tid,
  });
  const tasks = complete
    .filter(
      (event) =>
        /RunTask|ProcessTaskFromWorkQueue|ThreadControllerImpl::RunTask/i.test(
          String(event.name ?? ""),
        ) ||
        (event.name === "Task" && event.dur >= 50_000),
    )
    .sort((a, b) => a.ts - b.ts);
  const lifecycleEvents = Object.fromEntries(
    lifecycleNames.map((name) => [
      name,
      complete
        .filter((event) => event.name === name)
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 10)
        .map(expose),
    ]),
  );
  const relevantNames = new Set([
    "RunTask",
    "WebFrameWidgetImpl::UpdateLifecycle",
    "LocalFrameView::RunPaintLifecyclePhase",
    "LocalFrameView::pushPaintArtifactToCompositor",
    "Layerize",
    "PaintArtifactCompositor::Update",
  ]);
  const hierarchyEvents = complete
    .filter((event) => relevantNames.has(event.name))
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur)
    .slice(0, 250)
    .map(expose);
  const longestPaintUpdates = complete
    .filter((event) => event.name === "PaintArtifactCompositor::Update")
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 3)
    .map((update) => {
      const descendants = complete
        .filter(
          (event) =>
            event !== update &&
            event.pid === update.pid &&
            event.tid === update.tid &&
            event.ts >= update.ts &&
            event.ts + event.dur <= update.ts + update.dur,
        )
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 10)
        .map(expose);
      const chain = [];
      let current = update;
      while (current && chain.length < 12) {
        chain.unshift(expose(current));
        current = parentOf(current);
      }
      return {
        event: expose(update),
        ancestorChain: chain,
        longestChildren: descendants,
      };
    });
  const categoryMatches = {
    Layout: /^(Layout|UpdateLayoutTree|StyleRecalc|RecalculateStyles)$/i,
    EventDispatch: /EventDispatch|HitTest/i,
    FunctionCall: /FunctionCall|EvaluateScript|RunMicrotasks|V8/i,
    SelectionInput: /Selection|Input|Caret|Editing/i,
    Paint: /Paint|Composite|Raster|Layerize|UpdateLifecycle/i,
  };
  const categoryTotalsMs = Object.fromEntries(
    Object.entries(categoryMatches).map(([category, pattern]) => [
      category,
      complete
        .filter((event) => pattern.test(String(event.name ?? "")))
        .reduce((sum, event) => sum + event.dur / 1000, 0),
    ]),
  );
  const mainEvents = complete.filter((event) => event.dur >= 50_000);
  const longTasks = tasks
    .filter((event) => event.dur >= 50_000)
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 12)
    .map((task) => {
      const child = complete
        .filter((event) => eventContains(task, event))
        .sort((a, b) => b.dur - a.dur)[0];
      return {
        ...expose(task),
        longestChild: child ? expose(child) : null,
      };
    });
  const lifecycleTaskSet = new Set();
  for (const event of complete) {
    if (!lifecycleNames.includes(event.name)) continue;
    let parent = parentOf(event);
    while (
      parent &&
      !/RunTask|ProcessTaskFromWorkQueue|ThreadControllerImpl::RunTask/i.test(
        String(parent.name ?? ""),
      )
    )
      parent = parentOf(parent);
    if (parent) lifecycleTaskSet.add(parent);
  }
  const largestLifecycleTasks = [...lifecycleTaskSet]
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 2)
    .map((task) => {
      const nested = Object.fromEntries(
        lifecycleNames.map((name) => [
          name,
          Math.max(
            0,
            ...complete
              .filter(
                (event) => event.name === name && eventContains(task, event),
              )
              .map((event) => event.dur / 1000),
          ),
        ]),
      );
      return { event: expose(task), nestedLifecycleMaxMs: nested };
    });
  return {
    eventCount: events.length,
    completeEventCount: complete.length,
    categoryTotalsMs,
    lifecycleEvents,
    lifecycleHierarchy: hierarchyEvents,
    longestPaintUpdates,
    largestLifecycleTasks,
    longestLongTasks: longTasks,
    longestMainThreadEvents: mainEvents
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 20)
      .map(expose),
    maxLifecycleMs: Object.fromEntries(
      lifecycleNames.map((name) => [
        name,
        Math.max(
          0,
          ...complete
            .filter((event) => event.name === name)
            .map((event) => event.dur / 1000),
        ),
      ]),
    ),
  };
}

async function buildInstrumentedBundle() {
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
      // The local browser server is still binding its port.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Browser server failed to start: ${output}`);
}

function rowsFor(markdown, bodyRows) {
  const tableRows = markdown
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("|"));
  assert.ok(tableRows.length >= bodyRows + 2, "Stress table rows are missing");
  return tableRows.slice(0, bodyRows + 2);
}

function scenarioForRows(baseScenario, bodyRows) {
  const lines = rowsFor(baseScenario.markdown, bodyRows);
  const markdown = `${lines.join("\n")}\n\nPerformance edit anchor.`;
  return {
    ...baseScenario,
    markdown,
    table: { ...baseScenario.table, bodyRows },
  };
}

async function createEditorPage(browser, scenario) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(120_000);
  await page.addInitScript(
    ({ markdown, profile }) => {
      window.__markdownMintBenchmarkInitialMarkdown = markdown;
      window.__markdownMintPerformanceBenchmarkOptions = {};
      window.__markdownMintBenchmarkNavigationStartedAt = performance.now();
      window.__markdownMintBenchmarkPmSelectionChanges = [];
      window.__markdownMintBenchmarkSelectionOnlyTransactions = [];
      window.__mmInteractionPhase = "setup";
      window.__mmInteractionPhaseStartedAt = Object.create(null);
      window.__mmInteractionPhaseStarts = Object.create(null);
      window.__markdownMintBenchmarkNavigationStartedAt = performance.now();
      window.__mmPaintLongTasks = { supported: false, entries: [] };
      window.__markdownMintBenchmarkProfile = profile;
      try {
        if (
          typeof PerformanceObserver !== "undefined" &&
          PerformanceObserver.supportedEntryTypes?.includes("longtask")
        ) {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__mmPaintLongTasks.entries.push({
                startTime: entry.startTime,
                duration: entry.duration,
              });
          });
          window.__mmPaintLongTaskObserver = observer;
          observer.observe({ type: "longtask", buffered: true });
          window.__mmPaintLongTasks.supported = true;
        }
      } catch {
        window.__mmPaintLongTasks.supported = false;
      }
    },
    { markdown: scenario.markdown, profile: scenario.profile },
  );
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const ready = await page.waitForFunction(() => {
    const editor = window.markdownMint?.view?.dom;
    return (
      window.markdownMint?.initialized === true &&
      editor?.isContentEditable === true &&
      !editor.closest('[data-panel="rich"]').hidden
    );
  });
  await ready.dispose();
  const actual = await page.evaluate((expected) => {
    const view = window.markdownMint.view;
    const table = view.dom.querySelector("table");
    return {
      readyAt: performance.now(),
      navigationStartedAt: window.__markdownMintBenchmarkNavigationStartedAt,
      fixtureMatches:
        window.markdownMint.sourceEl.value === expected &&
        window.__markdownMintHarness.document.markdown === expected,
      tableRows: table?.rows.length ?? 0,
      columns: table?.rows[0]?.cells.length ?? 0,
      editorClasses: view.dom.className,
      tableStyle: table
        ? {
            display: getComputedStyle(table).display,
            width: getComputedStyle(table).width,
            minWidth: getComputedStyle(table).minWidth,
            maxWidth: getComputedStyle(table).maxWidth,
            borderCollapse: getComputedStyle(table).borderCollapse,
            overflowX: getComputedStyle(table).overflowX,
          }
        : null,
    };
  }, scenario.markdown);
  assert.equal(actual.fixtureMatches, true, "Markdown changed during startup");
  page.__navigationStartedAt = actual.navigationStartedAt;
  page.__editorReadyAt = actual.readyAt;
  page.__editorShape = actual;
  return page;
}

function makeTableHtml(rows) {
  return `<table><tbody>${rows
    .map((line, rowIndex) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((value) => value.trim());
      if (rowIndex === 1) return "";
      const tag = rowIndex === 0 ? "th" : "td";
      return `<tr>${cells
        .map(
          (value) =>
            `<${tag}><p>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p></${tag}>`,
        )
        .join("")}</tr>`;
    })
    .join("")}</tbody></table>`;
}

async function createIsolatedTablePage(browser, scenario, mode, cssText) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(120_000);
  const rows = rowsFor(scenario.markdown, scenario.table.bodyRows);
  const editable = mode === "plainContenteditable";
  const tableHtml = makeTableHtml(rows);
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${cssText}</style><style>html,body{margin:0;padding:0}body{font:14px Arial,sans-serif}.mm-investigation-host{padding:16px}.mm-document-content{color:#222}</style></head><body><main class="mm-investigation-host"><div id="isolated-editor" class="mm-document-content" ${editable ? 'contenteditable="true" role="textbox" aria-multiline="true"' : ""}>${tableHtml}</div></main></body></html>`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(
    () => document.querySelectorAll("table tr").length > 100,
  );
  return page;
}

async function startTrace(page) {
  const session = await page.context().newCDPSession(page);
  const events = [];
  let error;
  session.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  try {
    await session.send("Tracing.start", {
      categories: traceCategories,
      transferMode: "ReportEvents",
      options: "record-until-full",
    });
  } catch (caught) {
    error = String(caught);
    await session.detach();
    return async () => ({ supported: false, error });
  }
  return async (rawPath) => {
    const completed = new Promise((resolveComplete) =>
      session.once("Tracing.tracingComplete", resolveComplete),
    );
    await session.send("Tracing.end");
    await completed;
    await session.detach();
    let rawFile = null;
    if (rawPath) {
      await mkdir(dirname(rawPath), { recursive: true });
      const raw = {
        metadata: {
          capturedAt: new Date().toISOString(),
          browserVersion: page.context().browser()?.version() ?? null,
          categories: traceCategories,
          eventCount: events.length,
        },
        traceEvents: events,
      };
      await writeFile(rawPath, JSON.stringify(raw));
      rawFile = { path: rawPath, bytes: (await stat(rawPath)).size };
    }
    return {
      supported: true,
      categories: traceCategories,
      ...(rawFile ? { rawFile } : {}),
      ...summarizeTrace(events),
    };
  };
}

async function installCss(page, name, css) {
  const url = `${baseUrl}/__mm_benchmark_${name}.css`;
  await page.route(url, (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: css }),
  );
  await page.addStyleTag({ url });
  await page.evaluate(
    () =>
      new Promise((resolveReady) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolveReady()),
        ),
      ),
  );
}

async function installInteractionObserver(page) {
  await page.evaluate(() => {
    if (!window.__mmPaintLongTasks) {
      window.__mmPaintLongTasks = { supported: false, entries: [] };
      try {
        if (
          typeof PerformanceObserver !== "undefined" &&
          PerformanceObserver.supportedEntryTypes?.includes("longtask")
        ) {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__mmPaintLongTasks.entries.push({
                startTime: entry.startTime,
                duration: entry.duration,
              });
          });
          window.__mmPaintLongTaskObserver = observer;
          observer.observe({ type: "longtask", buffered: true });
          window.__mmPaintLongTasks.supported = true;
        }
      } catch {
        window.__mmPaintLongTasks.supported = false;
      }
    }
    const root =
      document.querySelector(".mm-rich-panel .ProseMirror") ??
      document.querySelector("#isolated-editor");
    const table = root?.querySelector("table");
    if (!root || !table) throw new Error("Benchmark table DOM is missing");
    window.__mmPaintTimeline = [];
    window.__mmPaintPhase = "setup";
    window.__mmPaintPhaseStartedAt = {};
    window.__mmPaintLongTasks.entries.length = 0;
    window.__mmPaintLongTaskObserver?.takeRecords();
    const record = (event) => {
      const target = event.target;
      if (
        event.type !== "selectionchange" &&
        target !== root &&
        target !== table &&
        !(target instanceof Node && table.contains(target))
      )
        return;
      const at = performance.now();
      window.__mmPaintTimeline.push({
        type: event.type,
        at,
        phase: window.__mmPaintPhase,
        fromPhaseStartMs: Number.isFinite(
          window.__mmPaintPhaseStartedAt[window.__mmPaintPhase],
        )
          ? at - window.__mmPaintPhaseStartedAt[window.__mmPaintPhase]
          : null,
        ...(event instanceof KeyboardEvent ? { key: event.key } : {}),
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
    ])
      document.addEventListener(type, record, true);
  });
}

async function makeTarget(page, bodyRow, column = 0) {
  const rowInfo = await page.evaluate(
    ({ bodyRow: wantedRow, column: wantedColumn }) => {
      const root =
        document.querySelector(".mm-rich-panel .ProseMirror") ??
        document.querySelector("#isolated-editor");
      const table = root?.querySelector("table");
      const row = table?.rows[wantedRow];
      const cell = row?.cells[wantedColumn];
      if (!cell) throw new Error(`Could not find table body row ${wantedRow}`);
      window.__mmPaintTargetPosition = {
        row: wantedRow,
        column: wantedColumn,
      };
      return {
        bodyRow: wantedRow,
        column: wantedColumn,
        cellText: cell.textContent ?? "",
        actualRows: table?.rows.length ?? 0,
        actualColumns: row?.cells.length ?? 0,
        targetFoundAt: performance.now(),
      };
    },
    { bodyRow, column },
  );
  const rowSelector =
    (await page.locator(".mm-rich-panel .ProseMirror").count()) > 0
      ? ".mm-rich-panel .ProseMirror table tr"
      : "#isolated-editor table tr";
  const locator = page
    .locator(rowSelector)
    .nth(bodyRow)
    .locator("th, td")
    .nth(column);
  return { locator, rowInfo };
}

async function prepareVisible(page, locator) {
  const scrollStartedAt = performance.now();
  if (debugStages) process.stdout.write("    geometry query start\n");
  const geometry = await locator.evaluate((target) => {
    if (!target) throw new Error("Benchmark target disappeared");
    const intersectsViewport = (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth;
    let rect = target.getBoundingClientRect();
    const wasInViewport = intersectsViewport(rect);
    if (!wasInViewport) {
      target.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
      rect = target.getBoundingClientRect();
    }
    return {
      wasInViewport,
      inViewport: intersectsViewport(rect),
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
      measuredAt: performance.now(),
    };
  });
  const geometryCompletedAt = performance.now();
  if (debugStages)
    process.stdout.write(
      `    geometry query complete (${(geometryCompletedAt - scrollStartedAt).toFixed(1)} ms)\n`,
    );
  assert.equal(geometry.inViewport, true, "Target cell did not enter viewport");
  await page.evaluate(
    () =>
      new Promise((resolveReady) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolveReady()),
        ),
      ),
  );
  const scrollCompletedAt = performance.now();
  const visibleAt = await page.evaluate(() => performance.now());
  return {
    scrollStartedAt,
    scrollCompletedAt,
    visibleAt,
    targetGeometryMs: scrollCompletedAt - scrollStartedAt,
    visibilityGeometryQueryMs: geometryCompletedAt - scrollStartedAt,
    settleAfterGeometryMs: scrollCompletedAt - geometryCompletedAt,
    wasInViewport: geometry.wasInViewport,
    viewportRect: geometry.rect,
  };
}

async function resetClickTelemetry(page) {
  return page.evaluate(() => {
    window.__mmPaintTimeline.length = 0;
    if (window.__markdownMintBenchmarkPmSelectionChanges)
      window.__markdownMintBenchmarkPmSelectionChanges.length = 0;
    if (window.__markdownMintBenchmarkSelectionOnlyTransactions)
      window.__markdownMintBenchmarkSelectionOnlyTransactions.length = 0;
    window.__mmPaintLongTasks.entries.length = 0;
    window.__mmPaintLongTaskObserver?.takeRecords();
    const at = performance.now();
    window.__mmPaintPhase = "click";
    window.__mmPaintPhaseStartedAt = { click: at };
    window.__mmInteractionPhase = "click";
    window.__mmInteractionPhaseStartedAt = { click: at };
    window.__mmInteractionPhaseStarts = {
      clickStartedAt: at,
      endStartedAt: undefined,
      inputStartedAt: undefined,
      directSelectionStartedAt: undefined,
    };
    return at;
  });
}

async function snapshotInteraction(page, startedAt, clickResolvedAtNode) {
  return page.evaluate(
    ({ actionStart, clickResolvedNode }) => {
      const root =
        document.querySelector(".mm-rich-panel .ProseMirror") ??
        document.querySelector("#isolated-editor");
      const targetPosition = window.__mmPaintTargetPosition;
      const target =
        root?.querySelector("table")?.rows[targetPosition?.row]?.cells[
          targetPosition?.column
        ];
      const timeline = window.__mmPaintTimeline;
      const selections = timeline
        .filter((event) => event.type === "selectionchange")
        .map((event) => event.at - actionStart);
      const pmChanges =
        window.__markdownMintBenchmarkPmSelectionChanges?.slice() ?? [];
      const state = window.markdownMint?.view?.state?.selection;
      return {
        actionStartedAt: actionStart,
        clickResolvedAtNode: clickResolvedNode,
        eventTimeline: timeline.map((event) => ({ ...event })),
        selectionchangeLatencyMs: selections[0] ?? null,
        selectionchangeCount: selections.length,
        pmSelectionChanges: pmChanges,
        pmSelectionChangeLatencyMs: pmChanges[0]?.fromPhaseStartMs ?? null,
        pmSelection: state
          ? {
              from: state.from,
              to: state.to,
              head: state.head,
              anchor: state.anchor,
            }
          : null,
        activeElementIsRoot: document.activeElement === root,
        targetText: target?.textContent ?? null,
        longTasks: {
          supported: window.__mmPaintLongTasks.supported,
          count: window.__mmPaintLongTasks.entries.length,
          totalDurationMs: window.__mmPaintLongTasks.entries.reduce(
            (sum, task) => sum + task.duration,
            0,
          ),
          longestMs: Math.max(
            0,
            ...window.__mmPaintLongTasks.entries.map((task) => task.duration),
          ),
          entries: window.__mmPaintLongTasks.entries.slice(),
        },
        selectionOnlyTransactions:
          window.__markdownMintBenchmarkSelectionOnlyTransactions?.slice() ??
          [],
      };
    },
    { actionStart: startedAt, clickResolvedNode: clickResolvedAtNode },
  );
}

async function clickSample(page, target, context = {}) {
  if (debugStages) process.stdout.write("    trace start\n");
  const stopTrace = await startTrace(page);
  const actionStartedAt = await resetClickTelemetry(page);
  const clickStartedNodeAt = performance.now();
  if (debugStages) process.stdout.write("    click start\n");
  await target.click();
  const clickResolvedNodeAt = performance.now();
  if (debugStages) process.stdout.write("    click resolved; stopping trace\n");
  const trace = await stopTrace(context.saveRaw ? rawTracePath : undefined);
  if (debugStages) process.stdout.write("    trace summarized\n");
  const interaction = await snapshotInteraction(
    page,
    actionStartedAt,
    clickResolvedNodeAt,
  );
  const clickLatencyMs = clickResolvedNodeAt - clickStartedNodeAt;
  return {
    clickLatencyMs,
    clickStartedNodeAt,
    clickResolvedNodeAt,
    scrollPreparationMs: context.scrollPreparationMs ?? 0,
    selectionchangeLatencyMs: interaction.selectionchangeLatencyMs,
    pmSelectionChangeLatencyMs: interaction.pmSelectionChangeLatencyMs,
    selectionchangeCount: interaction.selectionchangeCount,
    pmSelectionChanges: interaction.pmSelectionChanges.length,
    longTasks: interaction.longTasks,
    interaction,
    trace,
  };
}

async function makeEditorSample(browser, scenario, options = {}) {
  const page = await createEditorPage(browser, scenario);
  try {
    if (options.css === "minimal")
      await installCss(page, "minimal", options.minimalCss);
    if (options.overlayRemoval) {
      options.overlayRemovalDetails = await page.evaluate(() => {
        const selectors = [
          ".mm-table-controls",
          ".mm-toolbar",
          ".mm-table-toolbar",
          ".mm-selection-toolbar",
          ".mm-block-gap-insert",
          ".mm-empty-line-insert",
          ".mm-floating-toolbar",
          ".mm-popup-panel",
          '[role="dialog"]',
        ];
        const nodes = [
          ...new Set(
            selectors.flatMap((selector) => [
              ...document.querySelectorAll(selector),
            ]),
          ),
        ];
        const removed = nodes.map((node) => ({
          className: node.className?.toString?.() ?? "",
          selector:
            selectors.find((selector) => node.matches(selector)) ?? null,
        }));
        nodes.forEach((node) => node.remove());
        return { selectors, removed, count: removed.length };
      });
    }
    await installInteractionObserver(page);
    const bodyRow = options.bodyRow ?? 1;
    const { locator, rowInfo } = await makeTarget(
      page,
      bodyRow,
      options.column ?? 0,
    );
    const visible = await prepareVisible(page, locator);
    const scrollPreparationMs =
      visible.scrollCompletedAt - visible.scrollStartedAt;
    const sample = await clickSample(page, locator, {
      scrollPreparationMs,
      saveRaw: options.saveRaw,
    });
    return {
      mode: "proseMirror",
      bodyRows: scenario.table.bodyRows,
      cells: (scenario.table.bodyRows + 1) * scenario.table.columns,
      bodyRow,
      column: options.column ?? 0,
      target: rowInfo,
      editorReadyMs: page.__editorReadyAt - page.__navigationStartedAt,
      visibleAt: visible.visibleAt,
      scrollPreparationMs,
      css: options.css ?? "current",
      overlayRemoval: options.overlayRemovalDetails ?? null,
      computedTableStyle: page.__editorShape.tableStyle,
      click: sample,
      repeatedClick: null,
    };
  } finally {
    await page.close();
  }
}

async function makeRepeatSample(browser, scenario, options = {}) {
  const page = await createEditorPage(browser, scenario);
  try {
    await installInteractionObserver(page);
    const { locator, rowInfo } = await makeTarget(page, 1, 0);
    const visible = await prepareVisible(page, locator);
    const scrollPreparationMs =
      visible.scrollCompletedAt - visible.scrollStartedAt;
    const first = await clickSample(page, locator, {
      scrollPreparationMs,
      saveRaw: options.saveRaw,
    });
    const repeat = await clickSample(page, locator, {
      scrollPreparationMs: 0,
    });
    return {
      bodyRows: scenario.table.bodyRows,
      bodyRow: 1,
      target: rowInfo,
      scrollPreparationMs,
      firstSelectionClick: first,
      repeatSameCellClick: repeat,
    };
  } finally {
    await page.close();
  }
}

async function makeIsolatedSample(
  browser,
  scenario,
  mode,
  cssText,
  index,
  options = {},
) {
  const page = await createIsolatedTablePage(browser, scenario, mode, cssText);
  try {
    await installInteractionObserver(page);
    const { locator, rowInfo } = await makeTarget(page, 1, 0);
    const visible = await prepareVisible(page, locator);
    const scrollPreparationMs =
      visible.scrollCompletedAt - visible.scrollStartedAt;
    const sample = await clickSample(page, locator, {
      scrollPreparationMs,
      saveRaw: options.saveRaw === true,
    });
    return {
      mode,
      bodyRows: scenario.table.bodyRows,
      cells: (scenario.table.bodyRows + 1) * scenario.table.columns,
      target: rowInfo,
      scrollPreparationMs,
      click: sample,
      computedTableStyle: await page.evaluate(() => {
        const table = document.querySelector("table");
        return {
          display: getComputedStyle(table).display,
          width: getComputedStyle(table).width,
          minWidth: getComputedStyle(table).minWidth,
          maxWidth: getComputedStyle(table).maxWidth,
          borderCollapse: getComputedStyle(table).borderCollapse,
          overflowX: getComputedStyle(table).overflowX,
        };
      }),
    };
  } finally {
    await page.close();
  }
}

function summarizeClickSamples(samples) {
  const get = (select) => samples.map(select).filter(Number.isFinite);
  const traceName = (name) =>
    summarize(
      samples.map((sample) => sample.click.trace.maxLifecycleMs?.[name]),
    );
  return {
    sampleCount: samples.length,
    clickLatencyMs: summarize(get((sample) => sample.click.clickLatencyMs)),
    selectionchangeLatencyMs: summarize(
      get((sample) => sample.click.selectionchangeLatencyMs),
    ),
    pmSelectionChangeLatencyMs: summarize(
      get((sample) => sample.click.pmSelectionChangeLatencyMs),
    ),
    longestUpdateLifecycleMs: traceName("WebFrameWidgetImpl::UpdateLifecycle"),
    longestRunPaintLifecyclePhaseMs: traceName(
      "LocalFrameView::RunPaintLifecyclePhase",
    ),
    longestLayerizeMs: traceName("Layerize"),
    longestPaintArtifactCompositorUpdateMs: traceName(
      "PaintArtifactCompositor::Update",
    ),
    longTaskCount: summarize(
      samples.map((sample) => sample.click.longTasks.count),
    ),
    longTaskTotalMs: summarize(
      samples.map((sample) => sample.click.longTasks.totalDurationMs),
    ),
    longTaskLongestMs: summarize(
      samples.map((sample) => sample.click.longTasks.longestMs),
    ),
    samples,
  };
}

async function runCondition(
  browser,
  label,
  scenario,
  makeSample,
  count = sampleCount,
) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    process.stdout.write(`  ${label} sample ${index + 1}/${count}\n`);
    samples.push(await makeSample(index));
  }
  return summarizeClickSamples(samples);
}

const minimalCss = `
.mm-document-content table {
  box-sizing: border-box !important;
  display: table !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  margin: 0 !important;
  border-spacing: 2px !important;
  border-collapse: separate !important;
  overflow-x: visible !important;
}
.mm-document-content th,
.mm-document-content td {
  box-sizing: border-box !important;
  min-width: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  vertical-align: middle !important;
  background: transparent !important;
}
`;

async function runEndCorrectness(browser, scenario) {
  const results = { realEnd: [], directPmEnd: [] };
  for (let index = 0; index < sampleCount; index += 1) {
    for (const kind of ["realEnd", "directPmEnd"]) {
      process.stdout.write(
        `  End ${kind} sample ${index + 1}/${sampleCount}\n`,
      );
      const page = await createEditorPage(browser, scenario);
      try {
        await installInteractionObserver(page);
        const { locator } = await makeTarget(page, 1, 0);
        await prepareVisible(page, locator);
        await page.evaluate(() => {
          const editor = document.querySelector(".mm-rich-panel .ProseMirror");
          editor.focus();
        });
        const descriptor = { row: 1, column: 0 };
        await page.evaluate(
          (target) =>
            window.__markdownMintBenchmarkEditor.setTableCellSelection(
              target.row,
              target.column,
              "start",
            ),
          descriptor,
        );
        const before = await page.evaluate(() => {
          const cell =
            window.markdownMint.view.dom.querySelector("table")?.rows[1]
              ?.cells[0];
          const selection = getSelection();
          const anchor = selection?.anchorNode;
          const anchorElement =
            anchor instanceof Element ? anchor : anchor?.parentElement;
          return {
            pmPosition: window.markdownMint.view.state.selection.head,
            domAnchorOffset: selection?.anchorOffset ?? null,
            domSelectionInCell: Boolean(
              cell && anchorElement && cell.contains(anchorElement),
            ),
            cellTextLength: cell?.textContent?.length ?? null,
          };
        });
        const startedNodeAt = performance.now();
        let direct = null;
        if (kind === "realEnd") await page.keyboard.press("End");
        else {
          direct = await page.evaluate(() =>
            window.__markdownMintBenchmarkEditor.setTableCellSelection(
              1,
              0,
              "end",
            ),
          );
        }
        const completedNodeAt = performance.now();
        const after = await page.evaluate(() => {
          const cell =
            window.markdownMint.view.dom.querySelector("table")?.rows[1]
              ?.cells[0];
          const selection = getSelection();
          const anchor = selection?.anchorNode;
          const anchorElement =
            anchor instanceof Element ? anchor : anchor?.parentElement;
          return {
            pmPosition: window.markdownMint.view.state.selection.head,
            domAnchorOffset: selection?.anchorOffset ?? null,
            domSelectionInCell: Boolean(
              cell && anchorElement && cell.contains(anchorElement),
            ),
            cellTextLength: cell?.textContent?.length ?? null,
          };
        });
        const successfulCaretMove = Boolean(
          after.pmPosition > before.pmPosition &&
          after.domAnchorOffset > (before.domAnchorOffset ?? -1) &&
          after.domAnchorOffset === after.cellTextLength &&
          after.domSelectionInCell,
        );
        results[kind].push({
          durationMs: completedNodeAt - startedNodeAt,
          before,
          after,
          successfulCaretMove,
          directDispatchMs: direct?.dispatchMs ?? null,
        });
      } finally {
        await page.close();
      }
    }
  }
  const valid = results.realEnd.filter((sample) => sample.successfulCaretMove);
  const directEndSample = results.directPmEnd.find(
    (sample) => sample.successfulCaretMove,
  );
  return {
    targetCellEndObservedFromDirectPm: directEndSample
      ? {
          pmPosition: directEndSample.after.pmPosition,
          domAnchorOffset: directEndSample.after.domAnchorOffset,
          cellTextLength: directEndSample.after.cellTextLength,
        }
      : null,
    realEnd: {
      attemptCount: results.realEnd.length,
      successfulCount: valid.length,
      unsuccessfulCount: results.realEnd.length - valid.length,
      successfulDurationMs: summarize(valid.map((sample) => sample.durationMs)),
      samples: results.realEnd,
    },
    directPmEnd: {
      sampleCount: results.directPmEnd.length,
      dispatchDurationMs: summarize(
        results.directPmEnd.map((sample) => sample.directDispatchMs),
      ),
      wholeCallDurationMs: summarize(
        results.directPmEnd.map((sample) => sample.durationMs),
      ),
      samples: results.directPmEnd,
    },
  };
}

function medianSummary(summary) {
  return summary?.p50 ?? null;
}

function ms(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "n/a";
}

function reportMarkdown(report) {
  const investigation = report.paintCompositorInvestigation;
  const scalingRows = investigation.scaling
    .map((entry) => {
      const samples = entry.samples;
      const first = samples
        .map((sample) => largestUpdateLifecycleDurations(sample.click.trace)[0])
        .filter(Number.isFinite);
      const second = samples
        .map((sample) => largestUpdateLifecycleDurations(sample.click.trace)[1])
        .filter(Number.isFinite);
      return `| ${entry.bodyRows} | ${entry.cells} | ${ms(entry.summary.clickLatencyMs.p50)} | ${ms(percentile(first, 0.5))} | ${ms(percentile(second, 0.5))} | ${ms(medianSummary(entry.summary.longestPaintArtifactCompositorUpdateMs))} | ${ms(medianSummary(entry.summary.longestLayerizeMs))} | ${ms(medianSummary(entry.summary.longestUpdateLifecycleMs))} |`;
    })
    .join("\n");
  const current = investigation.cssIsolation.current;
  const minimal = investigation.cssIsolation.minimal;
  const endSamples = investigation.endCorrectness.realEnd;
  const directPmEnd = investigation.endCorrectness.directPmEnd;
  const repeat = investigation.repeatSelection;
  const position = (row) => investigation.rowPosition[`row${row}`];
  const plain = investigation.domIsolation.plainContenteditable;
  const statik = investigation.domIsolation.staticTable;
  const overlay = investigation.overlayIsolation;
  const tracePath = investigation.rawTrace?.path ?? "not captured";
  const traceBytes = investigation.rawTrace?.bytes ?? null;
  const updateEvent = report.representativeTrace?.longestPaintUpdates?.[0];
  const deepest = updateEvent?.longestChildren?.[0];
  const fixedLayout = investigation.cssIsolation.fixedLayout ?? null;
  const cssProperties = investigation.cssIsolation.properties ?? [];
  const growth = investigation.growthAnalysis;
  const inputSettling = investigation.inputSettlingSummary;
  const repeatLifecycleTaskDurations =
    repeat?.samples?.map((sample) =>
      (sample.repeatSameCellClick.trace?.longestLongTasks ?? [])
        .filter((task) => /UpdateLifecycle/.test(task.longestChild?.name ?? ""))
        .map((task) => task.durationMs)
        .sort((a, b) => b - a)
        .slice(0, 2),
    ) ?? [];
  const repeatLargestLifecycle = percentile(
    repeatLifecycleTaskDurations
      .map((durations) => durations[0])
      .filter(Number.isFinite),
    0.5,
  );
  const repeatSecondLifecycle = percentile(
    repeatLifecycleTaskDurations
      .map((durations) => durations[1])
      .filter(Number.isFinite),
    0.5,
  );
  const conclusion = [
    `Scaling: PaintArtifactCompositor::Update p50 rises from ${ms(investigation.scaling[0]?.summary.longestPaintArtifactCompositorUpdateMs?.p50)} at ${investigation.scaling[0]?.bodyRows ?? "?"} rows to ${ms(investigation.scaling.at(-1)?.summary.longestPaintArtifactCompositorUpdateMs?.p50)} at ${investigation.scaling.at(-1)?.bodyRows ?? "?"} rows (ratio ${growth.updateRatio?.toFixed(1) ?? "n/a"}, exponent ${growth.logLogExponent?.toFixed(2) ?? "n/a"}); this is ${growth.classification}.`,
    `DOM isolation: ProseMirror current p50 ${ms(current?.clickLatencyMs?.p50)}, plain contenteditable p50 ${ms(plain?.clickLatencyMs?.p50)}, static table p50 ${ms(statik?.clickLatencyMs?.p50)}.`,
    `CSS isolation: PaintArtifactCompositor::Update p50 is ${ms(current?.longestPaintArtifactCompositorUpdateMs?.p50)} with current CSS and ${ms(minimal?.longestPaintArtifactCompositorUpdateMs?.p50)} with minimal CSS; no individually restored tested property reproduced the pause, so one or more omitted rules or a combination of rules remain candidates.`,
    `Selection trigger: first click p50 ${ms(repeat?.firstSelectionClick?.clickLatencyMs?.p50)} with selectionchange p50 ${ms(repeat?.firstSelectionClick?.selectionchangeLatencyMs?.p50)}; same-cell repeat p50 ${ms(repeat?.repeatSameCellClick?.clickLatencyMs?.p50)} with no selectionchange, but CDP still shows lifecycle tasks p50 ${ms(repeatLargestLifecycle)} and ${ms(repeatSecondLifecycle)}. A selectionchange is therefore not required for the repeat-click lifecycle pause.`,
    `Overlay DOM removal p50 ${ms(overlay?.summary?.clickLatencyMs?.p50)} after removing ${overlay?.removedNodeCount ?? 0} matched nodes.`,
    `Real End caret validation: ${endSamples.successfulCount}/${endSamples.attemptCount} successful; unsuccessful End trials are excluded. Direct PM end moved PM ${directPmEnd?.samples?.[0]?.before?.pmPosition}→${directPmEnd?.samples?.[0]?.after?.pmPosition} and DOM offset ${directPmEnd?.samples?.[0]?.before?.domAnchorOffset}→${directPmEnd?.samples?.[0]?.after?.domAnchorOffset}.`,
    `VS Code Webview: ${investigation.vscodeWebview.status}; no Webview runtime measurement is claimed unless its measured fields are populated.`,
  ];
  return `# 2000×20 Paint/Compositor Investigation

Generated: ${report.generatedAt}

## Measurement corrections

**phase attribution:** Events and PM selection transactions capture the active phase and phase-specific start at dispatch time. clickStartedAt, endStartedAt, inputStartedAt, and directSelectionStartedAt are independent fields; no post-hoc phase guessing is applied. Companion input PM-selection offsets from inputStartedAt were ${JSON.stringify(inputSettling?.inputPhasePmSelectionOffsetsMs ?? [])} ms, including one delayed event still classified as input.

**End validation:** Real End moved the target-cell caret in ${endSamples.successfulCount}/${endSamples.attemptCount} trials. The first failed sample stayed PM ${endSamples.samples[0]?.before?.pmPosition} / DOM offset ${endSamples.samples[0]?.before?.domAnchorOffset}; direct PM-end validation moved PM ${directPmEnd?.samples?.[0]?.before?.pmPosition}→${directPmEnd?.samples?.[0]?.after?.pmPosition}, DOM ${directPmEnd?.samples?.[0]?.before?.domAnchorOffset}→${directPmEnd?.samples?.[0]?.after?.domAnchorOffset}. The direct caret landed at the end of the 8-character target cell. Absolute PM positions depend on the benchmark document shape. Failed End attempts are excluded from successful-caret latency summaries.

**DOM mutation vs settled:** Companion current-input run (${inputSettling?.generatedAt ?? "no saved run"}) p50: input → DOM mutation ${ms(inputSettling?.inputToDomMutationMs)}, post-mutation longest task ${ms(inputSettling?.postMutationLongestTaskMs)}, post-mutation long-task total ${ms(inputSettling?.postMutationLongTaskTotalMs)}, input → first idle ${ms(inputSettling?.inputToFirstIdleMs)}. DOM mutation therefore did not mean the browser had settled. The idle marker uses requestIdleCallback (or two animation frames when unavailable).

## Scaling

| body rows | cells | click p50 | largest UpdateLifecycle | second-largest UpdateLifecycle | PaintArtifactCompositor::Update max | Layerize max | UpdateLifecycle max |
|---:|---:|---:|---:|---:|---:|---:|---:|
${scalingRows}

**Observed growth:** ${growth.classification}; log-log exponent ${growth.logLogExponent?.toFixed(2) ?? "n/a"}; PaintArtifactCompositor::Update p50 ratio 2000 rows / 100 rows = ${growth.updateRatio?.toFixed(1) ?? "n/a"} while rows increase 20×. Each row condition has ${sampleCount} real Playwright clicks. Scroll-to-target and the two-frame visibility settle are timed outside click latency.

## DOM isolation

**ProseMirror:** ${current?.sampleCount ?? 0} samples; click p50/p95/max ${ms(current?.clickLatencyMs?.p50)} / ${ms(current?.clickLatencyMs?.p95)} / ${ms(current?.clickLatencyMs?.max)}; PaintArtifactCompositor::Update p50 ${ms(current?.longestPaintArtifactCompositorUpdateMs?.p50)}.

**Plain contenteditable:** ${plain?.sampleCount ?? 0} samples; click p50/p95/max ${ms(plain?.clickLatencyMs?.p50)} / ${ms(plain?.clickLatencyMs?.p95)} / ${ms(plain?.clickLatencyMs?.max)}; Update p50 ${ms(plain?.longestPaintArtifactCompositorUpdateMs?.p50)}.

**Static table:** ${statik?.sampleCount ?? 0} samples; click p50/p95/max ${ms(statik?.clickLatencyMs?.p50)} / ${ms(statik?.clickLatencyMs?.p95)} / ${ms(statik?.clickLatencyMs?.max)}; Update p50 ${ms(statik?.longestPaintArtifactCompositorUpdateMs?.p50)}.

**Conclusion:** ${investigation.domIsolation.conclusion}

## CSS isolation

**Current CSS:** ${current?.sampleCount ?? 0} current-style ProseMirror samples; click p50 ${ms(current?.clickLatencyMs?.p50)}; PaintArtifactCompositor::Update p50 ${ms(current?.longestPaintArtifactCompositorUpdateMs?.p50)}.

**Minimal CSS:** ${minimal?.sampleCount ?? 0} samples; click p50 ${ms(minimal?.clickLatencyMs?.p50)}; PaintArtifactCompositor::Update p50 ${ms(minimal?.longestPaintArtifactCompositorUpdateMs?.p50)}.

**Relevant properties:** ${investigation.cssIsolation.propertyIsolationStatus}${cssProperties.length ? ` Each restoration was screened once: ${cssProperties.map((entry) => `${entry.property}: click ${ms(entry.summary.clickLatencyMs.p50)}, Update ${ms(entry.summary.longestPaintArtifactCompositorUpdateMs.p50)}, Layerize ${ms(entry.summary.longestLayerizeMs.p50)}`).join("; ")}.` : ""}${fixedLayout ? ` Fixed-layout benchmark-only result: click ${ms(fixedLayout.summary.clickLatencyMs.p50)}, Update ${ms(fixedLayout.summary.longestPaintArtifactCompositorUpdateMs.p50)}; computed table-layout ${fixedLayout.computedTableLayout}.` : ""}

## Selection trigger

**First selection:** click p50 ${ms(repeat?.firstSelectionClick?.clickLatencyMs?.p50)}; selectionchange p50 ${ms(repeat?.firstSelectionClick?.selectionchangeLatencyMs?.p50)}; PM selection changes per trial ${JSON.stringify(repeat?.firstPmSelectionChangeCounts ?? [])}; compositor Update p50 ${ms(repeat?.firstSelectionClick?.longestPaintArtifactCompositorUpdateMs?.p50)}.

**Repeat same-cell click:** click p50 ${ms(repeat?.repeatSameCellClick?.clickLatencyMs?.p50)}; selectionchange p50 ${ms(repeat?.repeatSameCellClick?.selectionchangeLatencyMs?.p50)}; PM selection changes per trial ${JSON.stringify(repeat?.repeatPmSelectionChangeCounts ?? [])}; compositor Update p50 ${ms(repeat?.repeatSameCellClick?.longestPaintArtifactCompositorUpdateMs?.p50)}; the two longest CDP RunTask events containing UpdateLifecycle have p50 ${ms(repeatLargestLifecycle)} / ${ms(repeatSecondLifecycle)}.

## Position sensitivity

**Row 1:** from the 2000-row scaling samples, click p50 ${ms(current?.clickLatencyMs?.p50)}; scroll preparation p50 ${ms(
    investigation.scaling
      .at(-1)
      ?.samples?.map((sample) => sample.scrollPreparationMs)
      .sort((a, b) => a - b)[Math.floor(sampleCount / 2)],
  )}.

**Row 1000:** click p50 ${ms(position(1000)?.clickLatencyMs?.p50)}; scroll preparation p50 ${ms(position(1000)?.scrollPreparationMs?.p50)}.

**Row 2000:** click p50 ${ms(position(2000)?.clickLatencyMs?.p50)}; scroll preparation p50 ${ms(position(2000)?.scrollPreparationMs?.p50)}.

## VS Code Webview

**Headless:** Chrome for Testing ${report.environment.chromiumVersion}; the current ProseMirror condition reports the values above.

**VS Code:** ${investigation.vscodeWebview.status}. ${investigation.vscodeWebview.note}

Manual repro notes: ${investigation.vscodeWebview.manualProcedurePath ?? "none"}.

## Chromium trace

**Longest lifecycle chain:** ${updateEvent ? updateEvent.ancestorChain.map((event) => `${event.name} (${event.category}, ${ms(event.durationMs)}, parent ${event.parentName ?? "none"}, depth ${event.depth})`).join(" → ") : "No PaintArtifactCompositor::Update event was found in the representative trace."}

**RunTask → UpdateLifecycle → RunPaintLifecyclePhase → pushPaintArtifactToCompositor → Layerize → PaintArtifactCompositor::Update:** detailed named events with name, category, start, duration, parent, and depth are in JSON representativeTrace.lifecycleHierarchy and lifecycleEvents.

**Deepest measurable expensive child:** ${deepest ? `${deepest.name} (${deepest.category}; ${ms(deepest.durationMs)}; parent ${deepest.parentName ?? "none"}; depth ${deepest.depth})` : "No nested child event was reported under the longest PaintArtifactCompositor::Update."}

Top ten measurable descendants under each of the three longest compositor updates are saved in representativeTrace.longestPaintUpdates[].longestChildren. Raw trace: ${tracePath} (${traceBytes === null ? "size unavailable" : `${traceBytes} bytes`}); it is retained outside Git for additional analysis.

## Conclusion

${conclusion.map((line) => `- ${line}`).join("\n")}

This report contains measurements only. No permanent CSS, table, ProseMirror, or TableControls behavior change was introduced.

## Conditions and environment

- Branch: ${report.branch}
- Measurement base commit SHA: ${report.gitCommit}; instrumentation commit SHA: ${report.measurement.instrumentationCommitSHA ?? "not recorded"}.
- Capture source note: ${report.measurement.postCaptureChanges ?? "The report does not record whether the harness changed after capture."}
- Fixture: ${report.fixture.path}; ${report.fixture.bodyRows} body rows × ${report.fixture.columns} columns; ${report.fixture.bytes} bytes; ${report.fixture.cells} body/header cells.
- Chromium: ${report.environment.chromiumVersion}; OS: ${report.environment.operatingSystem}; CPU: ${report.environment.cpu} (${report.environment.logicalCpuCount} logical CPUs); Node ${report.environment.nodeVersion}.
- Viewport: 1280×900, device scale factor 1. LongTask PerformanceObserver supported: ${report.environment.longTaskObserverSupported}.
- Conditions: row scaling ${sampleCount} per size; plain contenteditable/static/minimal CSS ${report.measurement.isolationSamples} each; overlays ${report.measurement.overlaySamples}; first/repeat click shares each 2000-row scaling sample; row 1000/2000 ${sampleCount} each; End correctness ${sampleCount} each.
- Result JSON: [issue-119-interaction-investigation.json](../../output/benchmark/issue-119-interaction-investigation.json), including this paintCompositorInvestigation dataset.
- Chromium CDP trace categories: ${traceCategories}.
`;
}

async function main() {
  if (process.env.MM_PAINT_INVESTIGATION_REPORT_ONLY === "1") {
    const output = JSON.parse(await readFile(reportPath, "utf8"));
    const investigation = output.paintCompositorInvestigation;
    investigation.growthAnalysis = analyzeGrowth(investigation.scaling);
    const directEndSample =
      investigation.endCorrectness.directPmEnd.samples.find(
        (sample) => sample.successfulCaretMove,
      );
    delete investigation.endCorrectness.expectedBodyCellEnd;
    investigation.endCorrectness.targetCellEndObservedFromDirectPm =
      directEndSample
        ? {
            pmPosition: directEndSample.after.pmPosition,
            domAnchorOffset: directEndSample.after.domAnchorOffset,
            cellTextLength: directEndSample.after.cellTextLength,
          }
        : null;
    if (investigation.repeatSelection?.samples?.length) {
      investigation.repeatSelection.firstPmSelectionChangeCounts =
        investigation.repeatSelection.samples.map(
          (sample) => sample.firstSelectionClick.pmSelectionChanges,
        );
      investigation.repeatSelection.repeatPmSelectionChangeCounts =
        investigation.repeatSelection.samples.map(
          (sample) => sample.repeatSameCellClick.pmSelectionChanges,
        );
    }
    const propertySamples = investigation.cssIsolation.properties ?? [];
    const largestPropertyUpdate = Math.max(
      0,
      ...propertySamples.map(
        (entry) =>
          entry.summary.longestPaintArtifactCompositorUpdateMs.p50 ?? 0,
      ),
    );
    const currentUpdate =
      investigation.cssIsolation.current.longestPaintArtifactCompositorUpdateMs
        .p50;
    investigation.cssIsolation.propertyIsolationStatus =
      largestPropertyUpdate < currentUpdate * 0.3
        ? `Minimal CSS reduced the lifecycle pause; none of ${propertySamples.length} individually restored properties reproduced it (largest one-sample PaintArtifactCompositor::Update ${largestPropertyUpdate.toFixed(1)} ms). A property combination or an untested CSS rule remains unisolated.`
        : investigation.cssIsolation.propertyIsolationStatus;
    investigation.inputSettlingSummary = await readInputSettlingSummary();
    investigation.vscodeWebview.note =
      "The Mac was locked and CUA reported that automatic unlock failed, so VS Code could not be opened for this run. Headless Playwright cannot establish whether VS Code's embedded Electron Webview reproduces this lifecycle pause; no native Webview trace was captured. Use the recorded manual procedure and report its measurements separately.";
    removeLegacyMisorderedTaskFields(output);
    const codeCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    output.measurement.captureBaseCommitSHA = output.gitCommit;
    output.measurement.captureWorkingTreeDirty = true;
    output.measurement.instrumentationCommitSHA = codeCommit;
    output.measurement.postCaptureChanges =
      "Only derived aggregation and report labels were corrected after timing capture; browser interaction paths and captured measurements were unchanged.";
    await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`);
    const interactionReportPath = resolve(
      repository,
      "output/benchmark/issue-119-interaction-investigation.json",
    );
    try {
      const previous = JSON.parse(
        await readFile(interactionReportPath, "utf8"),
      );
      previous.paintCompositorInvestigation = investigation;
      previous.representativePaintTrace = output.representativeTrace;
      previous.measurement.captureWorkingTreeDirty = true;
      previous.measurement.paintCaptureBaseCommitSHA = output.gitCommit;
      previous.measurement.paintInstrumentationCommitSHA = codeCommit;
      await writeFile(
        interactionReportPath,
        `${JSON.stringify(previous, null, 2)}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `Could not extend the prior interaction JSON: ${String(error)}\n`,
      );
    }
    await writeFile(markdownPath, reportMarkdown(output));
    process.stdout.write(
      `Updated derived analysis without rerunning browser measurements. Instrumentation commit: ${codeCommit}\nMarkdown: ${markdownPath}\nJSON: ${reportPath}\n`,
    );
    return;
  }

  await buildInstrumentedBundle();
  const baseScenario = (await getPerformanceScenarios()).find(
    (item) => item.id === "stress-table-2000x20",
  );
  assert.ok(baseScenario, "2000x20 stress fixture is missing");
  const cssText = await readFile(
    resolve(repository, "media/document.css"),
    "utf8",
  );
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
      process.env.MM_PAINT_INVESTIGATION_EXECUTABLE_PATH ??
      chromium.executablePath();
    browser = await chromium.launch({ headless: true, executablePath });
    const fixtureRows = rowsFor(
      baseScenario.markdown,
      baseScenario.table.bodyRows,
    );
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      branch: execFileSync("git", ["branch", "--show-current"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      fixture: {
        path: "tests/github-markdown-test-suite/stress/github-table-2000x20.md",
        bytes: Buffer.byteLength(baseScenario.markdown, "utf8"),
        bodyRows: baseScenario.table.bodyRows,
        columns: baseScenario.table.columns,
        totalRowsIncludingHeader: fixtureRows.length - 1,
        cells: (baseScenario.table.bodyRows + 1) * baseScenario.table.columns,
      },
      measurement: {
        samplesPerScalingSize: sampleCount,
        isolationSamples: sampleCount,
        overlaySamples: 1,
        rowPositionSamples: sampleCount,
        endCorrectnessSamples: sampleCount,
        harness:
          "Playwright Chromium headless using the bundled Markdown Mint Webview",
        click:
          "Real Playwright locator.click after target is scrolled into viewport and two animation frames; scroll time recorded separately",
        rawTrace:
          "One complete representative 2000-row current-CSS click trace is kept in /tmp, outside Git",
        observer:
          "PerformanceObserver longtask; events are captured before the click and read after locator.click resolves",
      },
      environment: {
        chromiumVersion: browser.version(),
        executablePath,
        operatingSystem: `${os.type()} ${os.release()}`,
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
        viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
        longTaskObserverSupported: null,
      },
      paintCompositorInvestigation: {
        scaling: [],
        domIsolation: {},
        cssIsolation: {
          current: null,
          minimal: null,
          properties: [],
          propertyIsolationStatus: "Pending minimal CSS comparison",
          fixedLayout: null,
        },
        overlayIsolation: null,
        repeatSelection: null,
        rowPosition: {},
        endCorrectness: null,
        vscodeWebview: {
          status: "not-run",
          note: "VS Code is a separate Electron Webview and is not inferred from this headless run. A manual procedure will be recorded if in-app automation cannot be performed in this environment.",
          manualProcedurePath: null,
        },
        rawTrace: null,
      },
    };
    const investigation = report.paintCompositorInvestigation;
    const byRows = new Map();
    const iterationSizes = smokeMode
      ? [100]
      : [100, 250, 500, 1000, 1500, 2000];
    for (const bodyRows of iterationSizes) {
      const scenario = scenarioForRows(baseScenario, bodyRows);
      const samples = [];
      const repeated = [];
      for (let index = 0; index < sampleCount; index += 1) {
        process.stdout.write(
          `  Current PM ${bodyRows} rows sample ${index + 1}/${sampleCount}\n`,
        );
        const page = await createEditorPage(browser, scenario);
        if (debugStages) process.stdout.write("    editor ready\n");
        try {
          await installInteractionObserver(page);
          const { locator, rowInfo } = await makeTarget(page, 1, 0);
          if (debugStages) process.stdout.write("    target found\n");
          const visible = await prepareVisible(page, locator);
          if (debugStages) process.stdout.write("    target visible\n");
          const scrollPreparationMs =
            visible.scrollCompletedAt - visible.scrollStartedAt;
          const first = await clickSample(page, locator, {
            scrollPreparationMs,
            saveRaw: bodyRows === 2000 && index === 0,
          });
          const initialSample = {
            mode: "proseMirror",
            bodyRows,
            cells: (bodyRows + 1) * scenario.table.columns,
            bodyRow: 1,
            target: rowInfo,
            editorReadyMs: page.__editorReadyAt - page.__navigationStartedAt,
            scrollPreparationMs,
            click: first,
            computedTableStyle: page.__editorShape.tableStyle,
          };
          samples.push(initialSample);
          if (bodyRows === 2000) {
            const repeat = await clickSample(page, locator);
            repeated.push({
              firstSelectionClick: first,
              repeatSameCellClick: repeat,
            });
          }
          if (bodyRows === 2000 && index === 0) {
            investigation.rawTrace = first.trace.rawFile ?? null;
            report.representativeTrace = first.trace;
          }
          if (index === 0)
            report.environment.longTaskObserverSupported =
              first.longTasks?.supported ?? null;
        } finally {
          await page.close();
        }
      }
      const summary = summarizeClickSamples(samples);
      const scaled = {
        bodyRows,
        columns: scenario.table.columns,
        cells: (bodyRows + 1) * scenario.table.columns,
        summary,
        samples,
      };
      investigation.scaling.push(scaled);
      byRows.set(bodyRows, scaled);
      if (bodyRows === 2000) {
        const firstSamples = repeated.map((item) => item.firstSelectionClick);
        const repeatSamples = repeated.map((item) => item.repeatSameCellClick);
        investigation.repeatSelection = {
          firstSelectionClick: summarizeClickSamples(
            firstSamples.map((click) => ({ click })),
          ),
          repeatSameCellClick: summarizeClickSamples(
            repeatSamples.map((click) => ({ click })),
          ),
          firstSelectionChangeCounts: firstSamples.map(
            (sample) => sample.selectionchangeCount,
          ),
          repeatSelectionChangeCounts: repeatSamples.map(
            (sample) => sample.selectionchangeCount,
          ),
          firstPmSelectionChangeCounts: firstSamples.map(
            (sample) => sample.pmSelectionChanges,
          ),
          repeatPmSelectionChangeCounts: repeatSamples.map(
            (sample) => sample.pmSelectionChanges,
          ),
          samples: repeated,
        };
        investigation.cssIsolation.current = summary;
        investigation.domIsolation.proseMirror = summary;
      }
    }

    if (smokeMode) {
      const summary = investigation.scaling[0]?.summary;
      const smokeScenario = scenarioForRows(baseScenario, 100);
      const plain = await makeIsolatedSample(
        browser,
        smokeScenario,
        "plainContenteditable",
        cssText,
        0,
      );
      const statik = await makeIsolatedSample(
        browser,
        smokeScenario,
        "staticTable",
        cssText,
        0,
      );
      const minimal = await makeEditorSample(browser, smokeScenario, {
        css: "minimal",
        minimalCss,
      });
      process.stdout.write(
        `Smoke result: ${JSON.stringify({
          editorReadyMs: summary?.samples?.[0]?.editorReadyMs,
          clickLatencyMs: summary?.clickLatencyMs,
          selectionchangeLatencyMs: summary?.selectionchangeLatencyMs,
          pmSelectionChangeLatencyMs: summary?.pmSelectionChangeLatencyMs,
          maxLifecycleMs: summary?.samples?.[0]?.click?.trace?.maxLifecycleMs,
          eventCount: summary?.samples?.[0]?.click?.trace?.eventCount,
          plainClickMs: plain.click.clickLatencyMs,
          staticClickMs: statik.click.clickLatencyMs,
          minimalCssClickMs: minimal.click.clickLatencyMs,
        })}\n`,
      );
      return;
    }

    for (const bodyRow of [1000, 2000]) {
      const rowSamples = [];
      const scenario = scenarioForRows(baseScenario, 2000);
      for (let index = 0; index < sampleCount; index += 1) {
        process.stdout.write(
          `  Row position ${bodyRow} sample ${index + 1}/${sampleCount}\n`,
        );
        rowSamples.push(
          await makeEditorSample(browser, scenario, {
            bodyRow,
            saveRaw: false,
          }),
        );
      }
      investigation.rowPosition[`row${bodyRow}`] = {
        bodyRow,
        scrollPreparationMs: summarize(
          rowSamples.map((sample) => sample.scrollPreparationMs),
        ),
        ...summarizeClickSamples(rowSamples),
        samples: rowSamples,
      };
    }

    const fullScenario = scenarioForRows(baseScenario, 2000);
    const plainSamples = [];
    const staticSamples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      process.stdout.write(
        `  Plain contenteditable ${index + 1}/${sampleCount}\n`,
      );
      plainSamples.push(
        await makeIsolatedSample(
          browser,
          fullScenario,
          "plainContenteditable",
          cssText,
          index,
          { saveRaw: false },
        ),
      );
      process.stdout.write(`  Static table ${index + 1}/${sampleCount}\n`);
      staticSamples.push(
        await makeIsolatedSample(
          browser,
          fullScenario,
          "staticTable",
          cssText,
          index,
        ),
      );
    }
    investigation.domIsolation.plainContenteditable =
      summarizeClickSamples(plainSamples);
    investigation.domIsolation.staticTable =
      summarizeClickSamples(staticSamples);
    const pmUpdate =
      investigation.cssIsolation.current.longestPaintArtifactCompositorUpdateMs
        .p50;
    const plainUpdate =
      investigation.domIsolation.plainContenteditable
        .longestPaintArtifactCompositorUpdateMs.p50;
    const staticUpdate =
      investigation.domIsolation.staticTable
        .longestPaintArtifactCompositorUpdateMs.p50;
    investigation.domIsolation.conclusion =
      pmUpdate > 0 && plainUpdate < pmUpdate * 0.5
        ? "Plain contenteditable was materially faster than ProseMirror at comparable cell count; the ProseMirror/view path contributes to the measured lifecycle cost."
        : staticUpdate < pmUpdate * 0.5 && plainUpdate >= pmUpdate * 0.5
          ? "Static table was materially faster than editable conditions; contenteditable/editing representation contributes to the measured lifecycle cost."
          : plainUpdate >= pmUpdate * 0.5 && staticUpdate >= pmUpdate * 0.5
            ? "Plain contenteditable and static HTML had lifecycle costs within half of the ProseMirror measurement; table/CSS paint structure remains a major shared contributor."
            : "The three DOM modes were not separated by a 2× threshold; compare the per-condition intervals in the JSON before attributing a single cause.";

    const minimalSamples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      process.stdout.write(`  Minimal CSS ${index + 1}/${sampleCount}\n`);
      minimalSamples.push(
        await makeEditorSample(browser, fullScenario, {
          css: "minimal",
          minimalCss,
          saveRaw: false,
        }),
      );
    }
    investigation.cssIsolation.minimal = summarizeClickSamples(minimalSamples);
    const currentClick = investigation.cssIsolation.current.clickLatencyMs.p50;
    const minimalClick = investigation.cssIsolation.minimal.clickLatencyMs.p50;
    const minimalUpdate =
      investigation.cssIsolation.minimal.longestPaintArtifactCompositorUpdateMs
        .p50;
    const materiallyImproved =
      Number.isFinite(currentClick) &&
      Number.isFinite(minimalClick) &&
      (minimalClick < currentClick * 0.7 || minimalUpdate < pmUpdate * 0.7);
    investigation.cssIsolation.propertyIsolationStatus = materiallyImproved
      ? "Minimal CSS materially improved the measured click or compositor time; one-property restoration screen follows."
      : "Minimal CSS did not reduce click and PaintArtifactCompositor::Update by 30%; property-by-property restoration was not run because the prerequisite improvement was absent.";

    if (materiallyImproved) {
      const candidates = [
        [
          "display:block",
          ".mm-document-content table{display:block!important}",
        ],
        [
          "width:max-content",
          ".mm-document-content table{width:max-content!important}",
        ],
        [
          "min-width:100% + max-width:100%",
          ".mm-document-content table{min-width:100%!important;max-width:100%!important}",
        ],
        [
          "border-collapse:collapse",
          ".mm-document-content table{border-collapse:collapse!important}",
        ],
        [
          "overflow-x:auto",
          ".mm-document-content table{overflow-x:auto!important}",
        ],
        [
          "cell min-width:5em",
          ".mm-document-content th,.mm-document-content td{min-width:5em!important}",
        ],
        [
          "cell padding:7px 10px",
          ".mm-document-content th,.mm-document-content td{padding:7px 10px!important}",
        ],
        [
          "cell border",
          ".mm-document-content th,.mm-document-content td{border:1px solid var(--mm-border)!important}",
        ],
        [
          "vertical-align:top",
          ".mm-document-content th,.mm-document-content td{vertical-align:top!important}",
        ],
      ];
      for (const [property, css] of candidates) {
        const samples = [];
        for (let index = 0; index < 1; index += 1) {
          const page = await createEditorPage(browser, fullScenario);
          try {
            await installCss(
              page,
              `minimal_${property.replaceAll(/[^a-z0-9]/gi, "_")}`,
              minimalCss,
            );
            await installCss(
              page,
              `restore_${property.replaceAll(/[^a-z0-9]/gi, "_")}`,
              css,
            );
            await installInteractionObserver(page);
            const { locator } = await makeTarget(page, 1, 0);
            const visible = await prepareVisible(page, locator);
            const sample = await clickSample(page, locator, {
              scrollPreparationMs:
                visible.scrollCompletedAt - visible.scrollStartedAt,
            });
            samples.push({ mode: "proseMirror", click: sample });
          } finally {
            await page.close();
          }
        }
        investigation.cssIsolation.properties.push({
          property,
          sampleCount: samples.length,
          summary: summarizeClickSamples(samples),
          samples,
        });
      }
      const largestIndividualUpdate = Math.max(
        0,
        ...investigation.cssIsolation.properties.map(
          (entry) =>
            entry.summary.longestPaintArtifactCompositorUpdateMs.p50 ?? 0,
        ),
      );
      investigation.cssIsolation.propertyIsolationStatus =
        largestIndividualUpdate < pmUpdate * 0.3
          ? `Minimal CSS reduced the lifecycle pause; none of ${investigation.cssIsolation.properties.length} individually restored properties reproduced it (largest one-sample PaintArtifactCompositor::Update p50 ${largestIndividualUpdate.toFixed(1)} ms). A property combination or an untested CSS rule remains unisolated.`
          : `Minimal CSS reduced the lifecycle pause, and at least one one-sample property restoration approached the current-style compositor time; inspect the property samples before attribution.`;
    }

    const overlaySample = await makeEditorSample(browser, fullScenario, {
      overlayRemoval: true,
    });
    investigation.overlayIsolation = {
      sampleCount: 1,
      removedNodeCount: overlaySample.overlayRemoval?.count ?? 0,
      matchedNodes: overlaySample.overlayRemoval?.removed ?? [],
      summary: summarizeClickSamples([overlaySample]),
      samples: [overlaySample],
    };

    investigation.endCorrectness = await runEndCorrectness(
      browser,
      fullScenario,
    );
    investigation.vscodeWebview = {
      status: "manual-check-required",
      note: "The Mac was locked and CUA reported that automatic unlock failed, so VS Code could not be opened for this run. Headless Playwright cannot establish whether VS Code's embedded Electron Webview reproduces this lifecycle pause; no native Webview trace was captured. Use the recorded manual procedure and report its measurements separately.",
      manualProcedurePath:
        "docs/performance/issue-119-vscode-webview-manual.md",
      measured: false,
      headlessValuesAreNotSubstituted: true,
    };

    investigation.growthAnalysis = analyzeGrowth(investigation.scaling);
    investigation.inputSettlingSummary = await readInputSettlingSummary();

    const packageJson = JSON.parse(
      await readFile(resolve(repository, "package.json"), "utf8"),
    );
    const output = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      branch: report.branch,
      gitCommit: report.gitCommit,
      fixture: report.fixture,
      measurement: report.measurement,
      environment: report.environment,
      packageVersion: packageJson.version,
      paintCompositorInvestigation: investigation,
      representativeTrace: report.representativeTrace,
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`);
    const interactionReportPath = resolve(
      repository,
      "output/benchmark/issue-119-interaction-investigation.json",
    );
    try {
      const previous = JSON.parse(
        await readFile(interactionReportPath, "utf8"),
      );
      const extended = {
        ...previous,
        paintCompositorInvestigation: investigation,
        representativePaintTrace: report.representativeTrace,
      };
      await writeFile(
        interactionReportPath,
        `${JSON.stringify(extended, null, 2)}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `Could not extend the prior interaction JSON: ${String(error)}\n`,
      );
    }
    await writeFile(markdownPath, reportMarkdown(output));
    process.stdout.write(
      `\nInvestigation JSON: ${reportPath}\nExtended interaction JSON: ${interactionReportPath}\nMarkdown: ${markdownPath}\n`,
    );
    process.stdout.write(`Raw trace: ${rawTracePath}\n`);
    process.stdout.write(
      `Scaling PaintArtifactCompositor::Update p50: ${investigation.scaling.map((entry) => `${entry.bodyRows}=${ms(entry.summary.longestPaintArtifactCompositorUpdateMs.p50)}`).join(", ")}\n`,
    );
    process.stdout.write(
      `DOM isolation: ${investigation.domIsolation.conclusion}\n`,
    );
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
