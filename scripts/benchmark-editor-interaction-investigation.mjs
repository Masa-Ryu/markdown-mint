import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
const reportPath = resolve(
  repository,
  process.env.MM_EDITOR_INTERACTION_REPORT ??
    "output/benchmark/issue-119-interaction-investigation.json",
);
const markdownPath = resolve(
  repository,
  process.env.MM_EDITOR_INTERACTION_MARKDOWN ??
    "docs/performance/issue-119-interaction-investigation.md",
);
const benchmarkBundle = resolve(repository, "output/benchmark/webview.js");
const editorSelector = ".mm-rich-panel .ProseMirror";
const traceCategories = [
  "devtools.timeline",
  "blink",
  "input",
  "rendering",
  "v8",
  "disabled-by-default-devtools.timeline",
].join(",");
const sampleCount = Math.max(
  1,
  Number.parseInt(process.env.MM_EDITOR_INTERACTION_SAMPLES ?? "3", 10) || 3,
);
const selectedConditions = process.env.MM_EDITOR_INTERACTION_CONDITIONS
  ? new Set(
      process.env.MM_EDITOR_INTERACTION_CONDITIONS.split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    )
  : null;
const captureChromeTrace = process.env.MM_EDITOR_INTERACTION_TRACE !== "0";

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
  server.stdout.on("data", (chunk) => (output += chunk.toString()));
  server.stderr.on("data", (chunk) => (output += chunk.toString()));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/`)).ok) return;
    } catch {
      // Wait for the local browser server to bind its port.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Browser server failed to start: ${output}`);
}

function percentile(values, fraction) {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function summarize(values) {
  const samples = values.filter(Number.isFinite);
  return {
    sampleCount: samples.length,
    samples: samples,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples.length ? Math.max(...samples) : null,
  };
}

function summarizeTrace(events, phase) {
  let scopedEvents = events;
  let traceWindow = null;
  if (phase === "input") {
    const insertText = events
      .filter(
        (event) =>
          event.ph === "X" && event.name === "TypingCommand::InsertText",
      )
      .sort((a, b) => b.ts - a.ts)[0];
    if (insertText) {
      const windowEnd = insertText.ts + insertText.dur;
      const keydown = events
        .filter(
          (event) =>
            event.name === "EventDispatch" &&
            event.ts <= insertText.ts &&
            JSON.stringify(event.args ?? {})
              .toLowerCase()
              .includes("keydown"),
        )
        .sort((a, b) => b.ts - a.ts)[0];
      const windowStart = keydown?.ts ?? insertText.ts;
      const rawCount = events.length;
      const eventsClippedAtBoundary = events.filter(
        (event) =>
          event.ph === "X" &&
          Number.isFinite(event.dur) &&
          event.ts < windowEnd &&
          event.ts + event.dur > windowEnd,
      ).length;
      const postReflectionLongestEvents = events
        .filter(
          (event) =>
            event.ph === "X" &&
            Number.isFinite(event.dur) &&
            event.ts >= windowEnd,
        )
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 5)
        .map((event) => ({
          name: event.name,
          category: event.cat,
          durationMs: event.dur / 1000,
        }));
      scopedEvents = events.flatMap((event) => {
        if (!Number.isFinite(event.ts)) return [];
        const eventStart = event.ts;
        const eventEnd = Number.isFinite(event.dur)
          ? event.ts + event.dur
          : event.ts;
        if (eventEnd <= windowStart || eventStart >= windowEnd) return [];
        if (event.ph !== "X" || !Number.isFinite(event.dur)) return [event];
        const clippedStart = Math.max(eventStart, windowStart);
        const clippedEnd = Math.min(eventEnd, windowEnd);
        return clippedEnd > clippedStart
          ? [{ ...event, ts: clippedStart, dur: clippedEnd - clippedStart }]
          : [];
      });
      traceWindow = {
        startMarker: keydown
          ? "keydown EventDispatch"
          : "TypingCommand fallback",
        endMarker: "TypingCommand::InsertText completion",
        durationMs: (windowEnd - windowStart) / 1000,
        eventsDiscardedOutsideInputWindow: rawCount - scopedEvents.length,
        eventsClippedAtInputWindowEnd: eventsClippedAtBoundary,
        insertTextEventDurationMs: insertText.dur / 1000,
        postReflectionLongestEvents,
      };
    } else {
      traceWindow = {
        startMarker: null,
        endMarker: null,
        error: "TypingCommand::InsertText trace marker was not found",
      };
    }
  }
  const complete = scopedEvents.filter(
    (event) => event.ph === "X" && Number.isFinite(event.dur),
  );
  const byDuration = [...complete].sort((a, b) => b.dur - a.dur);
  const categoryTotals = {
    Layout: 0,
    EventDispatch: 0,
    FunctionCall: 0,
    SelectionInput: 0,
    Paint: 0,
    Other: 0,
  };
  const categoryEvents = Object.fromEntries(
    Object.keys(categoryTotals).map((name) => [name, []]),
  );
  const categoryFor = (event) => {
    const name = String(event.name ?? "");
    if (/Selection|Input/i.test(name)) return "SelectionInput";
    if (/Layout|UpdateLayoutTree|StyleRecalc/i.test(name)) return "Layout";
    if (/EventDispatch|HitTest/i.test(name)) return "EventDispatch";
    if (/FunctionCall|EvaluateScript|RunMicrotasks|V8/i.test(name))
      return "FunctionCall";
    if (/Paint|Composite|Raster|Layerize|UpdateLifecycle/i.test(name))
      return "Paint";
    return "Other";
  };
  for (const event of complete) {
    const category = categoryFor(event);
    categoryTotals[category] += event.dur / 1000;
    categoryEvents[category].push(event);
  }
  const categoryMaxima = Object.fromEntries(
    Object.entries(categoryEvents).map(([category, categoryItems]) => {
      const largest = categoryItems.sort((a, b) => b.dur - a.dur)[0];
      return [
        category,
        largest
          ? {
              name: largest.name,
              category: largest.cat,
              durationMs: largest.dur / 1000,
            }
          : null,
      ];
    }),
  );

  const tasks = complete.filter(
    (event) =>
      /RunTask|ProcessTaskFromWorkQueue|ThreadControllerImpl::RunTask/i.test(
        String(event.name ?? ""),
      ) ||
      (event.name === "Task" && event.dur >= 50_000),
  );
  const eventParent = (event) =>
    complete
      .filter(
        (candidate) =>
          candidate !== event &&
          candidate.pid === event.pid &&
          candidate.tid === event.tid &&
          candidate.ts <= event.ts &&
          candidate.ts + candidate.dur >= event.ts + event.dur,
      )
      .sort((a, b) => a.dur - b.dur)[0];
  const longestTasks = [...tasks]
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 3)
    .map((task) => {
      const children = complete
        .filter(
          (event) =>
            event !== task &&
            event.pid === task.pid &&
            event.tid === task.tid &&
            event.ts >= task.ts &&
            event.ts + event.dur <= task.ts + task.dur,
        )
        .sort((a, b) => b.dur - a.dur);
      const longestChild = children[0];
      const parent = eventParent(task);
      return {
        name: task.name,
        category: task.cat,
        durationMs: task.dur / 1000,
        parentEvent: parent?.name ?? null,
        longestChild: longestChild
          ? {
              name: longestChild.name,
              category: longestChild.cat,
              durationMs: longestChild.dur / 1000,
              parentEvent: eventParent(longestChild)?.name ?? task.name,
            }
          : null,
      };
    });
  return {
    eventCount: scopedEvents.length,
    completeEventCount: complete.length,
    ...(traceWindow ? { traceWindow } : {}),
    categoryTotalsMs: categoryTotals,
    categoryMaxima,
    longestTasks,
    longestEvents: byDuration.slice(0, 12).map((event) => ({
      name: event.name,
      category: event.cat,
      durationMs: event.dur / 1000,
      phase: event.ph,
    })),
  };
}

async function startTrace(page, phase) {
  const session = await page.context().newCDPSession(page);
  const events = [];
  let traceError;
  session.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  try {
    await session.send("Tracing.start", {
      categories: traceCategories,
      transferMode: "ReportEvents",
      options: "record-until-full",
    });
  } catch (error) {
    traceError = String(error);
    await session.detach();
    return async () => ({ supported: false, error: traceError });
  }
  return async () => {
    const completed = new Promise((resolveComplete) =>
      session.once("Tracing.tracingComplete", resolveComplete),
    );
    await session.send("Tracing.end");
    await completed;
    await session.detach();
    return {
      supported: true,
      categories: traceCategories,
      ...summarizeTrace(events, phase),
    };
  };
}

async function createPage(browser, scenario, options = {}) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(120_000);
  await page.addInitScript(
    ({ markdown, profile, benchmarkOptions }) => {
      window.__markdownMintBenchmarkInitialMarkdown = markdown;
      window.__markdownMintPerformanceBenchmarkOptions = benchmarkOptions;
      window.__markdownMintBenchmarkNavigationStartedAt = performance.now();
      window.__markdownMintBenchmarkPmSelectionChanges = [];
      window.__markdownMintBenchmarkSelectionOnlyTransactions = [];
      window.__mmInteractionEvents = [];
      window.__mmInteractionPhase = "setup";
      window.__mmPosAtCoords = { calls: 0, totalMs: 0, maxMs: 0 };
      window.__mmLongTasks = { supported: false, entries: [] };
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
          for (const name of Object.keys(measurements))
            delete measurements[name];
          for (const name of Object.keys(counters)) delete counters[name];
        },
      };
      window.__markdownMintBenchmarkProfile = profile;
      try {
        const supported =
          typeof PerformanceObserver !== "undefined" &&
          PerformanceObserver.supportedEntryTypes?.includes("longtask") ===
            true;
        if (supported) {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__mmLongTasks.entries.push({
                startTime: entry.startTime,
                duration: entry.duration,
              });
          });
          window.__mmLongTaskObserver = observer;
          observer.observe({ type: "longtask", buffered: true });
          window.__mmLongTasks.supported = true;
        }
      } catch {
        window.__mmLongTasks.supported = false;
      }
    },
    {
      markdown: scenario.markdown,
      profile: scenario.profile,
      benchmarkOptions: {
        disableTableEditing: options.disableTableEditing === true,
        disableSpellcheck: options.disableSpellcheck === true,
      },
    },
  );
  const navigationStartedNodeAt = performance.now();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const ready = await page.waitForFunction(() => {
    const editor = window.markdownMint?.view?.dom;
    return window.markdownMint?.initialized === true &&
      editor?.isContentEditable === true &&
      !editor.closest('[data-panel="rich"]').hidden
      ? performance.now()
      : false;
  });
  const editorReadyAt = await ready.jsonValue();
  await ready.dispose();
  const editorReadyNodeAt = performance.now();
  const fixtureMatches = await page.evaluate(
    (expected) =>
      window.markdownMint.sourceEl.value === expected &&
      window.__markdownMintHarness.document.markdown === expected,
    scenario.markdown,
  );
  assert.equal(fixtureMatches, true, "The stress Markdown changed at load");
  page.__navigationStartedNodeAt = navigationStartedNodeAt;
  page.__editorReadyAt = editorReadyAt;
  page.__editorReadyNodeAt = editorReadyNodeAt;
  return page;
}

async function prepareTarget(page, initialPhase) {
  const target = page.locator(`${editorSelector} table tbody td`).first();
  const found = await target.evaluate((cell) => {
    const table = cell.closest("table");
    const row = cell.parentElement;
    const descriptor = {
      row: row?.rowIndex ?? -1,
      column: cell.cellIndex,
      before: cell.textContent ?? "",
      tableRows: table?.rows.length ?? 0,
      tableColumns: row?.cells.length ?? 0,
    };
    window.__mmTargetDescriptor = descriptor;
    return { ...descriptor, foundAt: performance.now() };
  });
  const foundNodeAt = performance.now();
  await page.evaluate(() => {
    const cell = document.querySelector(
      `${".mm-rich-panel .ProseMirror"} table tbody td`,
    );
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    if (!cell || !editor) throw new Error("Stress target cell was not found");
    const expectedCellText = `${cell.textContent ?? ""}z`;
    const observer = new MutationObserver(() => {
      if (cell.textContent !== expectedCellText) return;
      window.__mmDomReflectionAt = performance.now();
      observer.disconnect();
      if (typeof window.__mmBenchmarkNotifyReflection === "function")
        window.__mmBenchmarkNotifyReflection(window.__mmDomReflectionAt);
    });
    observer.observe(cell, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    const relevant = (event) => {
      if (event.type === "selectionchange") return true;
      const target = event.target;
      return target === editor || target === cell || cell.contains(target);
    };
    const eventTypes = [
      "scroll",
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
    ];
    for (const type of eventTypes) {
      document.addEventListener(
        type,
        (event) => {
          if (event.type === "scroll") {
            if (
              event.target !== document &&
              event.target !== document.documentElement &&
              event.target !== document.body &&
              event.target !== editor
            )
              return;
          } else if (!relevant(event)) return;
          const at = performance.now();
          if (event.type === "keydown" && event.key === "End")
            window.__mmInteractionPhase = "end";
          else if (event.type === "keydown") {
            window.__mmInteractionPhase = "input";
            window.__mmInputStartAt ??= at;
          }
          window.__mmInteractionEvents.push({
            type,
            at,
            phase: window.__mmInteractionPhase,
            ...(event instanceof KeyboardEvent ? { key: event.key } : {}),
            ...(event instanceof InputEvent
              ? { inputType: event.inputType, data: event.data }
              : {}),
          });
        },
        true,
      );
    }
    const view = window.markdownMint.view;
    const original = view.posAtCoords;
    view.posAtCoords = function (coords) {
      const startedAt = performance.now();
      window.__mmPosAtCoords.calls += 1;
      try {
        return original.call(this, coords);
      } finally {
        const elapsed = performance.now() - startedAt;
        window.__mmPosAtCoords.totalMs += elapsed;
        window.__mmPosAtCoords.maxMs = Math.max(
          window.__mmPosAtCoords.maxMs,
          elapsed,
        );
      }
    };
  });
  await target.waitFor({ state: "visible" });
  const visibleNodeAt = performance.now();
  const visibleAt = await page.evaluate(() => performance.now());
  const actionClock = initialPhase
    ? await resetEvents(page, initialPhase)
    : null;
  const actionReadyNodeAt = performance.now();
  return {
    target,
    descriptor: found,
    visibleAt,
    foundNodeAt,
    visibleNodeAt,
    actionReadyNodeAt,
    actionClock,
  };
}

async function resetEvents(page, phase) {
  const browserAt = await page.evaluate((nextPhase) => {
    window.__mmInteractionEvents.length = 0;
    window.__markdownMintBenchmarkPmSelectionChanges.length = 0;
    window.__markdownMintBenchmarkSelectionOnlyTransactions.length = 0;
    window.__mmPosAtCoords = { calls: 0, totalMs: 0, maxMs: 0 };
    window.__mmLongTasks.entries.length = 0;
    window.__mmLongTaskObserver?.takeRecords();
    window.__markdownMintPerformanceBenchmark?.reset?.();
    window.__mmInteractionPhase = nextPhase;
    window.__mmInputStartAt = undefined;
    window.__mmDomReflectionAt = undefined;
    window.__mmActionStartedAt = performance.now();
    return window.__mmActionStartedAt;
  }, phase);
  return { browserAt };
}

async function readInteractionState(page) {
  return page.evaluate(() => {
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    const cell = document.querySelector(
      ".mm-rich-panel .ProseMirror table tbody td",
    );
    const browserSelection = getSelection();
    const anchor = browserSelection?.anchorNode;
    const anchorElement =
      anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
    const state = window.markdownMint.view.state.selection;
    const timeline = window.__mmInteractionEvents;
    const eventTime = (type, phase) =>
      timeline.find((event) => event.type === type && event.phase === phase)
        ?.at ?? null;
    return {
      navigationStartedAt: window.__markdownMintBenchmarkNavigationStartedAt,
      activeElement: document.activeElement?.tagName.toLowerCase() ?? null,
      activeElementIsEditor: document.activeElement === editor,
      browserSelectionInTargetCell: Boolean(
        cell && anchorElement && cell.contains(anchorElement),
      ),
      browserSelectionAnchorOffset: browserSelection?.anchorOffset ?? null,
      pmSelection: {
        from: state.from,
        to: state.to,
        head: state.head,
        anchor: state.anchor,
        empty: state.empty,
      },
      eventTimeline: timeline.map((event) => ({
        ...event,
        fromActionStartMs:
          window.__mmActionStartedAt === undefined
            ? null
            : event.at - window.__mmActionStartedAt,
      })),
      pmSelectionChanges:
        window.__markdownMintBenchmarkPmSelectionChanges.slice(),
      selectionOnlyTransactions:
        window.__markdownMintBenchmarkSelectionOnlyTransactions.slice(),
      posAtCoords: { ...window.__mmPosAtCoords },
      inputStartedAt: window.__mmInputStartAt ?? null,
      domReflectionAt: window.__mmDomReflectionAt ?? null,
      selectionEventTimes: {
        mousedown: eventTime("mousedown", "click"),
        focus: eventTime("focus", "click") ?? eventTime("focusin", "click"),
        firstSelectionchange: eventTime("selectionchange", "click"),
        click: eventTime("click", "click"),
        keydown: eventTime("keydown", "end"),
        endSelectionchange: eventTime("selectionchange", "end"),
        keyup: eventTime("keyup", "end"),
      },
      longTasks: {
        supported: window.__mmLongTasks.supported,
        entries: window.__mmLongTasks.entries.slice(),
      },
      metrics: window.__markdownMintPerformanceBenchmark.snapshot(),
    };
  });
}

async function waitForCellDomSelection(page, selectionCompletedAt) {
  const initialProbe = await page.evaluate(() => {
    const cell = document.querySelector(
      ".mm-rich-panel .ProseMirror table tbody td",
    );
    const anchor = getSelection()?.anchorNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    return {
      checkedAt: performance.now(),
      synchronized: Boolean(cell && element && cell.contains(element)),
    };
  });
  if (initialProbe.synchronized)
    return {
      startedAt: selectionCompletedAt,
      completedAt: initialProbe.checkedAt,
      synchronized: true,
      firstProbe: true,
    };
  try {
    await page.waitForFunction(
      () => {
        const cell = document.querySelector(
          ".mm-rich-panel .ProseMirror table tbody td",
        );
        const anchor = getSelection()?.anchorNode;
        const element =
          anchor instanceof Element ? anchor : anchor?.parentElement;
        return Boolean(cell && element && cell.contains(element));
      },
      null,
      { timeout: 10_000 },
    );
  } catch {
    return {
      startedAt: selectionCompletedAt,
      completedAt: null,
      synchronized: false,
      firstProbe: false,
    };
  }
  return {
    startedAt: selectionCompletedAt,
    completedAt: await page.evaluate(() => performance.now()),
    synchronized: true,
    firstProbe: false,
  };
}

async function typeAndWaitForReflection(page) {
  await page.keyboard.type("z");
  await page.waitForFunction(
    () => typeof window.__mmDomReflectionAt === "number",
    null,
    { timeout: 120_000 },
  );
  return page.evaluate(() => ({
    startedAt: window.__mmInputStartAt,
    reflectedAt: window.__mmDomReflectionAt,
  }));
}

async function collectSample(browser, scenario, kind, options = {}) {
  const page = await createPage(browser, scenario, options.pageOptions);
  try {
    const initialPhase =
      kind === "realClickEndInput" ||
      kind === "forceClickEndInput" ||
      kind === "domClick"
        ? "click"
        : undefined;
    const {
      target,
      descriptor,
      visibleAt,
      foundNodeAt,
      visibleNodeAt,
      actionReadyNodeAt,
      actionClock: preparedActionClock,
    } = await prepareTarget(page, initialPhase);
    const timings = {
      navigationToEditorReadyMs:
        page.__editorReadyNodeAt - page.__navigationStartedNodeAt,
      editorReadyToTargetFoundMs: foundNodeAt - page.__editorReadyNodeAt,
      targetFoundToVisibleMs: visibleNodeAt - foundNodeAt,
      visibleToBenchmarkActionReadyMs: actionReadyNodeAt - visibleNodeAt,
    };
    let actionClock = preparedActionClock;
    let clickStartedNodeAt = null;
    let clickCompleteNodeAt = null;
    let endStartedNodeAt = null;
    let caretReadyNodeAt = null;
    let clickResolved = false;
    let endCompleted = false;
    let directSelection = null;
    let domSelectionSync = null;
    let focusPreparationMs = null;
    let inputStartedNodeAt = null;
    let domReflectionNodeAt = null;

    if (kind === "realClickEndInput" || kind === "forceClickEndInput") {
      clickStartedNodeAt = performance.now();
      if (kind === "forceClickEndInput") await target.click({ force: true });
      else await target.click();
      clickCompleteNodeAt = performance.now();
      clickResolved = true;
      timings.visibleToClickCompleteMs = clickCompleteNodeAt - visibleNodeAt;
      timings.clickActionMs = clickCompleteNodeAt - clickStartedNodeAt;

      // Keep the real input sequence uninterrupted by page.evaluate probes.
      endStartedNodeAt = performance.now();
      await page.keyboard.press("End");
      caretReadyNodeAt = performance.now();
      endCompleted = true;
      timings.clickToCaretReadyMs = caretReadyNodeAt - clickCompleteNodeAt;
      timings.endActionMs = caretReadyNodeAt - endStartedNodeAt;
      timings.postClickToEndStartMs = endStartedNodeAt - clickCompleteNodeAt;

      if (options.typeInput) {
        inputStartedNodeAt = performance.now();
        const reflection = await typeAndWaitForReflection(page);
        domReflectionNodeAt = performance.now();
        timings.inputStartToDomReflectionMs =
          reflection.reflectedAt - reflection.startedAt;
        timings.inputActionAndWaitMs = domReflectionNodeAt - inputStartedNodeAt;
      }
    } else if (kind === "domClick") {
      clickStartedNodeAt = performance.now();
      const result = await target.evaluate((cell) => {
        const startedAt = performance.now();
        cell.click();
        return { startedAt, completedAt: performance.now() };
      });
      clickCompleteNodeAt = performance.now();
      clickResolved = true;
      timings.visibleToClickCompleteMs = clickCompleteNodeAt - visibleNodeAt;
      timings.domClickCallMs = result.completedAt - result.startedAt;
    } else if (kind === "focusOnly") {
      actionClock = await resetEvents(page, "focus");
      const result = await page.evaluate(() => {
        const editor = document.querySelector(".mm-rich-panel .ProseMirror");
        const startedAt = performance.now();
        window.__mmActionStartedAt = startedAt;
        editor.focus();
        return { startedAt, completedAt: performance.now() };
      });
      timings.focusOnlyMs = result.completedAt - result.startedAt;
    } else if (kind === "directPmSelection" || kind === "directPmEnd") {
      const focusResult = await page.evaluate(() => {
        const editor = document.querySelector(".mm-rich-panel .ProseMirror");
        const startedAt = performance.now();
        editor.focus();
        return { startedAt, completedAt: performance.now() };
      });
      focusPreparationMs = focusResult.completedAt - focusResult.startedAt;
      if (kind === "directPmEnd") {
        await page.evaluate(
          ({ row, column }) =>
            window.__markdownMintBenchmarkEditor.setTableCellSelection(
              row,
              column,
              "start",
            ),
          descriptor,
        );
      }
      actionClock = await resetEvents(page, "direct-selection");
      const result = await page.evaluate(
        ({ row, column, edge }) =>
          window.__markdownMintBenchmarkEditor.setTableCellSelection(
            row,
            column,
            edge,
          ),
        {
          row: descriptor.row,
          column: descriptor.column,
          edge: kind === "directPmEnd" ? "end" : "start",
        },
      );
      directSelection = result;
      timings.directPmSelectionMs = result.completedAt - result.startedAt;
      timings.directPmSelectionPreparationMs = result.selectionPreparationMs;
      timings.directPmSelectionDispatchMs = result.dispatchMs;
      timings.editorReadyToDirectPmSelectionMs =
        result.completedAt - page.__editorReadyAt;
      timings.editorFocusPreparationMs = focusPreparationMs;
      domSelectionSync = await waitForCellDomSelection(
        page,
        result.completedAt,
      );
      timings.domSelectionSyncWaitMs =
        domSelectionSync.completedAt === null
          ? null
          : domSelectionSync.completedAt - result.completedAt;
    } else if (kind === "realEndOnly" || kind === "keyboardEventDispatch") {
      const focusResult = await page.evaluate(({ row, column }) => {
        window.__mmInteractionPhase = "setup";
        const editor = document.querySelector(".mm-rich-panel .ProseMirror");
        const focusStartedAt = performance.now();
        editor.focus();
        return { focusStartedAt, focusCompletedAt: performance.now() };
      }, descriptor);
      focusPreparationMs =
        focusResult.focusCompletedAt - focusResult.focusStartedAt;
      timings.editorFocusPreparationMs = focusPreparationMs;
      const initialSelection = await page.evaluate(
        ({ row, column }) =>
          window.__markdownMintBenchmarkEditor.setTableCellSelection(
            row,
            column,
            "start",
          ),
        descriptor,
      );
      timings.initialDirectSelectionMs =
        initialSelection.completedAt - initialSelection.startedAt;
      actionClock = await resetEvents(page, "end");
      endStartedNodeAt = performance.now();
      if (kind === "realEndOnly") await page.keyboard.press("End");
      else {
        const eventResult = await page.evaluate(() => {
          const editor = document.querySelector(".mm-rich-panel .ProseMirror");
          const startedAt = performance.now();
          editor.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "End",
              bubbles: true,
              cancelable: true,
            }),
          );
          return { startedAt, completedAt: performance.now() };
        });
        timings.syntheticKeyboardEventMs =
          eventResult.completedAt - eventResult.startedAt;
      }
      caretReadyNodeAt = performance.now();
      endCompleted = true;
      timings.realOrSyntheticEndMs = caretReadyNodeAt - endStartedNodeAt;
    }

    const interaction = await readInteractionState(page);
    if (
      interaction.navigationStartedAt !== null &&
      interaction.domReflectionAt !== null
    )
      timings.totalInputAcceptedMs =
        interaction.domReflectionAt - interaction.navigationStartedAt;
    const clickStartedAt =
      clickStartedNodeAt === null ? null : (actionClock?.browserAt ?? null);
    const endKeydownAt =
      interaction.eventTimeline.find(
        (event) => event.type === "keydown" && event.key === "End",
      )?.at ?? null;
    const endStartedAt =
      endStartedNodeAt === null
        ? null
        : (endKeydownAt ?? actionClock?.browserAt ?? null);
    const inputStartedAt = interaction.inputStartedAt;
    interaction.eventTimeline = interaction.eventTimeline.map((event) => {
      const phaseStart =
        event.phase === "end"
          ? (endKeydownAt ?? endStartedAt)
          : event.phase === "input"
            ? inputStartedAt
            : (clickStartedAt ?? actionClock?.browserAt ?? null);
      return {
        ...event,
        fromPhaseStartMs:
          phaseStart === null || phaseStart === undefined
            ? null
            : event.at - phaseStart,
      };
    });
    interaction.pmSelectionChanges = interaction.pmSelectionChanges.map(
      (change) => ({
        ...change,
        fromPhaseStartMs:
          actionClock?.browserAt === undefined
            ? null
            : change.at - actionClock.browserAt,
      }),
    );
    const input =
      interaction.inputStartedAt !== null &&
      interaction.domReflectionAt !== null
        ? {
            startedAt: interaction.inputStartedAt,
            reflectedAt: interaction.domReflectionAt,
          }
        : null;
    return {
      kind,
      condition: options.pageOptions ?? {},
      target: descriptor,
      milestones: {
        navigationStartedAt: interaction.navigationStartedAt,
        editorReadyAt: page.__editorReadyAt,
        targetFoundAt: descriptor.foundAt,
        visibleAt,
        clickStartedAt,
        clickCompleteNodeAt,
        endKeydownAt: endStartedAt,
        endCallStartedNodeAt: endStartedNodeAt,
        endCompletedNodeAt: caretReadyNodeAt,
        inputStartAt: input?.startedAt ?? null,
        domReflectionAt: input?.reflectedAt ?? null,
      },
      timings,
      flags: { clickResolved, endCompleted },
      directSelection,
      domSelectionSync,
      focusPreparationMs,
      interaction,
    };
  } finally {
    await page.close();
  }
}

function summarizeCondition(samples, name) {
  const keys = new Set(
    samples.flatMap((sample) => Object.keys(sample.timings)),
  );
  const timingSummaries = Object.fromEntries(
    [...keys].map((key) => [
      key,
      summarize(samples.map((sample) => sample.timings[key])),
    ]),
  );
  const eventSamples = samples.map((sample) => sample.interaction);
  const normalizedPmSelectionChanges = samples.flatMap((sample) =>
    sample.interaction.pmSelectionChanges.map((change, index) => {
      let phase = change.phase;
      if (!phase) {
        if (
          sample.kind === "directPmSelection" ||
          sample.kind === "directPmEnd"
        )
          phase = "direct-selection";
        else if (
          sample.kind === "realClickEndInput" ||
          sample.kind === "forceClickEndInput"
        )
          phase = index === 0 ? "click" : "end";
        else phase = sample.kind;
      }
      const phaseStart =
        phase === "click"
          ? sample.milestones.clickStartedAt
          : phase === "end"
            ? sample.milestones.endKeydownAt
            : null;
      const fromPhaseStartMs = Number.isFinite(phaseStart)
        ? change.at - phaseStart
        : change.fromPhaseStartMs;
      return { ...change, phase, fromPhaseStartMs };
    }),
  );
  const selectionOnly = eventSamples.flatMap((sample) =>
    sample.selectionOnlyTransactions?.length
      ? sample.selectionOnlyTransactions
      : (sample.metrics["editor.selectionOnlyTransaction"] ?? []).map(
          (durationMs) => ({ phase: "legacy-unattributed", durationMs }),
        ),
  );
  const selectionOnlyDurations = selectionOnly.map(
    (sample) => sample.durationMs,
  );
  const selectionOnlyByPhase = Object.fromEntries(
    [...new Set(selectionOnly.map((sample) => sample.phase))].map((phase) => {
      const durations = selectionOnly
        .filter((sample) => sample.phase === phase)
        .map((sample) => sample.durationMs);
      return [
        phase,
        {
          calls: durations.length,
          totalMs: durations.reduce((total, value) => total + value, 0),
          maxMs: Math.max(0, ...durations),
          samplesMs: durations,
        },
      ];
    }),
  );
  const posAtCoords = eventSamples.map((sample) => sample.posAtCoords);
  const eventNames = [
    "scroll",
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
  ];
  const observedPhases = ["click", "end", "input", "focus", "direct-selection"];
  const eventTimelineMs = Object.fromEntries(
    observedPhases.map((phase) => [
      phase,
      Object.fromEntries(
        eventNames.map((eventName) => [
          eventName,
          summarize(
            eventSamples.flatMap((sample) =>
              sample.eventTimeline
                .filter(
                  (event) => event.phase === phase && event.type === eventName,
                )
                .map((event) =>
                  phase === "end" &&
                  (sample.kind === "realEndOnly" ||
                    sample.kind === "keyboardEventDispatch")
                    ? event.fromActionStartMs
                    : event.fromPhaseStartMs,
                ),
            ),
          ),
        ]),
      ),
    ]),
  );
  const pmSelectionChanged = normalizedPmSelectionChanges
    .filter((change) => change.phase === "click")
    .map((change) => change.fromPhaseStartMs)
    .filter(Number.isFinite);
  const pmEndSelectionChanged = normalizedPmSelectionChanges
    .filter((change) => change.phase === "end")
    .map((change) => change.fromPhaseStartMs)
    .filter(Number.isFinite);
  const longTaskWindow = (startKey, endKey) => {
    const overlaps = [];
    for (const sample of samples) {
      const start = sample.milestones[startKey];
      const end = sample.milestones[endKey];
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        continue;
      for (const task of sample.interaction.longTasks.entries) {
        const overlap = Math.max(
          0,
          Math.min(task.startTime + task.duration, end) -
            Math.max(task.startTime, start),
        );
        if (overlap > 0) overlaps.push(overlap);
      }
    }
    return {
      count: overlaps.length,
      totalDurationMs: overlaps.reduce((sum, value) => sum + value, 0),
      longestMs: overlaps.length ? Math.max(...overlaps) : 0,
    };
  };
  return {
    condition: name,
    sampleCount: samples.length,
    timings: timingSummaries,
    eventTimelineMs,
    pmSelectionChangedMs: summarize(pmSelectionChanged),
    pmEndSelectionChangedMs: summarize(pmEndSelectionChanged),
    pmSelectionChanges: normalizedPmSelectionChanges,
    posAtCoords: {
      calls: posAtCoords.reduce((total, sample) => total + sample.calls, 0),
      totalMs: posAtCoords.reduce((total, sample) => total + sample.totalMs, 0),
      maxMs: Math.max(0, ...posAtCoords.map((sample) => sample.maxMs)),
      samples: posAtCoords,
    },
    selectionOnlyTransaction: {
      calls: selectionOnly.length,
      totalMs: selectionOnlyDurations.reduce(
        (total, value) => total + value,
        0,
      ),
      maxMs: Math.max(0, ...selectionOnlyDurations),
      byPhase: selectionOnlyByPhase,
      samplesMs: selectionOnly,
    },
    longTasks: {
      observerSupportedSamples: eventSamples.filter(
        (sample) => sample.longTasks.supported,
      ).length,
      count: eventSamples.reduce(
        (total, sample) => total + sample.longTasks.entries.length,
        0,
      ),
      longestMs: Math.max(
        0,
        ...eventSamples.flatMap((sample) =>
          sample.longTasks.entries.map((entry) => entry.duration),
        ),
      ),
      totalDurationMs: eventSamples.reduce(
        (total, sample) =>
          total +
          sample.longTasks.entries.reduce(
            (sum, entry) => sum + entry.duration,
            0,
          ),
        0,
      ),
      inputStartToDomReflection: longTaskWindow(
        "inputStartAt",
        "domReflectionAt",
      ),
    },
    samples,
  };
}

function ms(value) {
  return value === null || value === undefined
    ? "n/a"
    : `${value.toFixed(1)} ms`;
}

function reportMarkdown(report) {
  const investigation = report.investigation;
  const condition = (name) => investigation.conditions[name];
  const p50 = (name, timing) => condition(name)?.timings[timing]?.p50;
  const eventP50 = (name, phase, event) =>
    condition(name)?.eventTimelineMs[phase]?.[event]?.p50;
  const currentClick = p50("A_currentRealClickEnd", "visibleToClickCompleteMs");
  const currentClickAction = p50("A_currentRealClickEnd", "clickActionMs");
  const forceClick = p50("B_forceClickEnd", "visibleToClickCompleteMs");
  const clickPlusEndP50 = (name) => {
    const samples = condition(name)?.samples ?? [];
    return summarize(
      samples.map(
        (sample) =>
          sample.timings.clickActionMs + sample.timings.clickToCaretReadyMs,
      ),
    ).p50;
  };
  const forceEndKeydownAfterClickP50 = summarize(
    (condition("B_forceClickEnd")?.samples ?? []).map((sample) => {
      const endKeydown = sample.interaction.eventTimeline.find(
        (event) => event.type === "keydown" && event.key === "End",
      );
      return endKeydown?.fromActionStartMs - sample.timings.clickActionMs;
    }),
  ).p50;
  const directSelect = p50("E_directPmSelection", "directPmSelectionMs");
  const currentEnd = p50("F_realEndOnly", "realOrSyntheticEndMs");
  const directEnd = p50("H_directPmEnd", "directPmSelectionMs");
  const currentClickSelectionOnly = condition(
    "A_currentRealClickEnd",
  )?.selectionOnlyTransaction;
  const endOnlySelectionOnly =
    condition("F_realEndOnly")?.selectionOnlyTransaction;
  const tableDisabledClick = p50(
    "I_tableEditingDisabled",
    "visibleToClickCompleteMs",
  );
  const spellcheckClick = p50(
    "J_spellcheckDisabled",
    "visibleToClickCompleteMs",
  );
  const pos = condition("A_currentRealClickEnd")?.posAtCoords;
  const traces = investigation.chromeTraces;
  const inputTraceScope = traces.scope;
  const firstPostReflectionTask = inputTraceScope?.postReflectionLongTasks
    ?.slice()
    .sort((a, b) => b.duration - a.duration)[0];
  const traceLines = Object.entries(traces)
    .filter(([phase]) => phase !== "scope")
    .map(([phase, trace]) => {
      if (!trace?.supported)
        return `- ${phase}: unavailable (${trace?.error ?? "unsupported"})`;
      const longest = trace.longestTasks ?? [];
      const descriptions = longest.map((task, index) => {
        const child = task.longestChild;
        return `${index + 1}. ${task.name} (${task.category}, ${ms(task.durationMs)}, parent ${task.parentEvent ?? "none"})${child ? `; longest nested event ${child.name} (${child.category}, ${ms(child.durationMs)}, parent ${child.parentEvent ?? task.name})` : ""}`;
      });
      const window = trace.traceWindow;
      const scopeDescription = window
        ? `; input window ${window.startMarker} → ${window.endMarker} (${ms(window.durationMs)}; ${window.eventsDiscardedOutsideInputWindow} outside events clipped)`
        : "";
      const postDescription =
        phase === "input" && firstPostReflectionTask
          ? `; PerformanceObserver post-reflection Long Task ${ms(firstPostReflectionTask.duration)} (outside the clipped input window)`
          : "";
      return `- ${phase}: ${descriptions.length ? descriptions.join("; ") : "no task event found"}; ${trace.eventCount} trace events${scopeDescription}${postDescription}`;
    });
  const categoryMaxima = {};
  for (const category of [
    "Layout",
    "EventDispatch",
    "FunctionCall",
    "SelectionInput",
    "Paint",
    "Other",
  ]) {
    const maxima = Object.entries(traces)
      .filter(([phase, trace]) => phase !== "scope" && trace?.supported)
      .map(([phase, trace]) => ({
        phase,
        event: trace.categoryMaxima?.[category],
      }))
      .filter((entry) => entry.event)
      .sort((a, b) => b.event.durationMs - a.event.durationMs);
    categoryMaxima[category] = maxima[0] ?? null;
  }
  const categoryLines = Object.entries(categoryMaxima).map(
    ([category, result]) =>
      `- ${category}: ${result ? `${result.event.name} (${ms(result.event.durationMs)}, ${result.phase})` : "no event captured"}`,
  );
  const conclusion = [];
  if (currentClick !== null && forceClick !== null)
    conclusion.push(
      `Force click reduces the click call by ${ms(currentClick - forceClick)}, but the uninterrupted click+End p50 is ${ms(clickPlusEndP50("A_currentRealClickEnd"))} current vs ${ms(clickPlusEndP50("B_forceClickEnd"))} forced. The End keydown in the forced case arrives ${ms(forceEndKeydownAfterClickP50)} after the click promise completes, so force moves the wait into the next call rather than removing it.`,
    );
  if (currentClick !== null && directSelect !== null)
    conclusion.push(
      `Direct PM selection p50 ${ms(directSelect)} vs real click ${ms(currentClick)}.`,
    );
  if (condition("A_currentRealClickEnd")?.pmSelectionChangedMs?.p50 != null)
    conclusion.push(
      `Click trace stages: click event at ${ms(eventP50("A_currentRealClickEnd", "click", "click"))}, first selectionchange at ${ms(eventP50("A_currentRealClickEnd", "click", "selectionchange"))}, PM selection update at ${ms(condition("A_currentRealClickEnd")?.pmSelectionChangedMs?.p50)}, Playwright resolution at ${ms(currentClick)}.`,
    );
  if (currentEnd !== null && directEnd !== null)
    conclusion.push(
      `Real End itself is ${ms(p50("A_currentRealClickEnd", "clickToCaretReadyMs"))} after a normal click and ${ms(currentEnd)} standalone; direct PM end dispatch is ${ms(directEnd)}. The previously reported 7.6-second End interval does not reproduce as native End key handling in the corrected continuous sequence.`,
    );
  if (tableDisabledClick !== null && currentClick !== null)
    conclusion.push(
      `tableEditing disabled click p50 ${ms(tableDisabledClick)} vs current ${ms(currentClick)}.`,
    );
  if (spellcheckClick !== null && currentClick !== null)
    conclusion.push(
      `spellcheck disabled click p50 ${ms(spellcheckClick)} vs current ${ms(currentClick)}.`,
    );
  if (pos)
    conclusion.push(
      `posAtCoords: ${pos.calls} calls, ${ms(pos.totalMs)} total, ${ms(pos.maxMs)} max across current-click samples.`,
    );
  if (currentClickSelectionOnly)
    conclusion.push(
      `Selection-only transactions during the click sequence: ${currentClickSelectionOnly.calls} calls, ${ms(currentClickSelectionOnly.totalMs)} total, ${ms(currentClickSelectionOnly.maxMs)} max; End-only after setup reset: ${endOnlySelectionOnly?.calls ?? 0} calls.`,
    );
  if (traces.click?.longestTasks?.[0])
    conclusion.push(
      `Chromium's click trace contains two ${ms(traces.click.longestTasks[0].durationMs)} / ${ms(traces.click.longestTasks[1]?.durationMs)} RunTask long tasks; their dominant nested events are ${traces.click.longestTasks[0].longestChild?.name ?? "not identified"} and ${traces.click.longestTasks[1]?.longestChild?.name ?? "not identified"}. Both span lifecycle paint/compositing.`,
    );
  if (traces.click?.categoryMaxima?.Paint)
    conclusion.push(
      `Chromium lifecycle paint/compositing is the dominant measured stage: its largest click event is ${traces.click.categoryMaxima.Paint.name} at ${ms(traces.click.categoryMaxima.Paint.durationMs)}, while the largest Layout event across traces is ${ms(categoryMaxima.Layout?.event.durationMs)}.`,
    );
  const currentLongTasks = condition("A_currentRealClickEnd")?.longTasks;
  if (currentLongTasks)
    conclusion.push(
      `PerformanceObserver recorded ${currentLongTasks.count} long tasks (${ms(currentLongTasks.totalDurationMs)} total, ${ms(currentLongTasks.longestMs)} longest) across current click/End/input runs.`,
    );
  if (
    inputTraceScope?.inputStartedAt != null &&
    inputTraceScope?.domReflectionAt != null
  )
    conclusion.push(
      `In the traced typing sample, the DOM mutation occurred ${ms(inputTraceScope.domReflectionAt - inputTraceScope.inputStartedAt)} after keydown. A separate PerformanceObserver Long Task began after that mutation and lasted ${ms(firstPostReflectionTask?.duration)}; it is outside the clipped input trace window and accounts for the longer Playwright typing roundtrip (${ms(p50("A_currentRealClickEnd", "inputActionAndWaitMs"))}).`,
    );
  return `# Issue #119 interaction investigation

Generated: ${report.generatedAt}
Trace summary updated: ${report.traceUpdatedAt ?? report.generatedAt}

## Click investigation

Current real click (visible → Playwright resolved): p50/p95/max ${ms(p50("A_currentRealClickEnd", "visibleToClickCompleteMs"))} / ${ms(condition("A_currentRealClickEnd")?.timings.visibleToClickCompleteMs?.p95)} / ${ms(condition("A_currentRealClickEnd")?.timings.visibleToClickCompleteMs?.max)} (${condition("A_currentRealClickEnd")?.sampleCount ?? 0} samples)

Playwright click call only: p50 ${ms(currentClickAction)}. Current click → immediate End: ${ms(p50("A_currentRealClickEnd", "clickToCaretReadyMs"))}; combined click+End: ${ms(clickPlusEndP50("A_currentRealClickEnd"))}. Visible → benchmark action start: ${ms(p50("A_currentRealClickEnd", "visibleToBenchmarkActionReadyMs"))}; target found → visible: ${ms(p50("A_currentRealClickEnd", "targetFoundToVisibleMs"))}.

Force click: p50/p95/max ${ms(p50("B_forceClickEnd", "visibleToClickCompleteMs"))} / ${ms(condition("B_forceClickEnd")?.timings.visibleToClickCompleteMs?.p95)} / ${ms(condition("B_forceClickEnd")?.timings.visibleToClickCompleteMs?.max)}; immediate End ${ms(p50("B_forceClickEnd", "clickToCaretReadyMs"))}; combined click+End ${ms(clickPlusEndP50("B_forceClickEnd"))}. End keydown reached the page ${ms(forceEndKeydownAfterClickP50)} after the click call resolved.

DOM click: call p50 ${ms(p50("C_domClick", "domClickCallMs"))}. Diagnostic only; it does not reproduce physical pointer/focus behavior.

Focus only: p50 ${ms(p50("D_focusOnly", "focusOnlyMs"))} (editor.focus()).

Direct PM selection: p50 ${ms(directSelect)} (preparation ${ms(p50("E_directPmSelection", "directPmSelectionPreparationMs"))}; dispatch ${ms(p50("E_directPmSelection", "directPmSelectionDispatchMs"))}). First follow-up DOM-selection probe confirmed the target after ${ms(p50("E_directPmSelection", "domSelectionSyncWaitMs"))}; this is probe availability after dispatch, not proof the browser selection took that long to synchronize.

Event timeline (current click, p50 from action call start):

- scroll: ${ms(eventP50("A_currentRealClickEnd", "click", "scroll"))}
- pointermove: ${ms(eventP50("A_currentRealClickEnd", "click", "pointermove"))}
- pointerdown: ${ms(eventP50("A_currentRealClickEnd", "click", "pointerdown"))}
- mousedown: ${ms(eventP50("A_currentRealClickEnd", "click", "mousedown"))}
- focus/focusin: ${ms(eventP50("A_currentRealClickEnd", "click", "focus") ?? eventP50("A_currentRealClickEnd", "click", "focusin"))}
- mouseup: ${ms(eventP50("A_currentRealClickEnd", "click", "mouseup"))}
- pointerup: ${ms(eventP50("A_currentRealClickEnd", "click", "pointerup"))}
- selectionchange: ${ms(eventP50("A_currentRealClickEnd", "click", "selectionchange"))}
- click: ${ms(eventP50("A_currentRealClickEnd", "click", "click"))}
- PM selection changed: p50 ${ms(condition("A_currentRealClickEnd")?.pmSelectionChangedMs?.p50)} after click start; in the forced condition End keydown waited ${ms(forceEndKeydownAfterClickP50)} after click completion.

posAtCoords: ${pos?.calls ?? 0} calls; ${ms(pos?.totalMs)} total; ${ms(pos?.maxMs)} max.

Selection-only transaction during current click sequence: ${currentClickSelectionOnly?.calls ?? 0} calls; ${ms(currentClickSelectionOnly?.totalMs)} total; ${ms(currentClickSelectionOnly?.maxMs)} max. Phase breakdown is in JSON and this is separate from all dispatchTransaction time.

## End investigation

Real End: p50/p95/max ${ms(currentEnd)} / ${ms(condition("F_realEndOnly")?.timings.realOrSyntheticEndMs?.p95)} / ${ms(condition("F_realEndOnly")?.timings.realOrSyntheticEndMs?.max)} after setting the start caret directly in the target cell. In the uninterrupted current click sequence, click → End complete is ${ms(p50("A_currentRealClickEnd", "clickToCaretReadyMs"))}.

KeyboardEvent dispatch only: ${ms(p50("G_keyboardEventDispatch", "syntheticKeyboardEventMs"))} in-page synchronous dispatch (${ms(p50("G_keyboardEventDispatch", "realOrSyntheticEndMs"))} Playwright evaluate roundtrip); diagnostic only and does not reproduce native editing behavior.

Direct PM end: p50 ${ms(directEnd)}; first follow-up DOM-selection probe confirmed the target after ${ms(p50("H_directPmEnd", "domSelectionSyncWaitMs"))} (same probe-availability caveat as above).

tableEditing disabled: click ${ms(tableDisabledClick)}, End ${ms(p50("I_tableEditingDisabled", "clickToCaretReadyMs"))}.

spellcheck disabled: click ${ms(spellcheckClick)}, End ${ms(p50("J_spellcheckDisabled", "clickToCaretReadyMs"))}, input-to-DOM ${ms(p50("J_spellcheckDisabled", "inputStartToDomReflectionMs"))}.

Current input start → DOM reflection: ${ms(p50("A_currentRealClickEnd", "inputStartToDomReflectionMs"))}; complete navigation → reflected input: ${ms(p50("A_currentRealClickEnd", "totalInputAcceptedMs"))}.

End event timeline (real End-only, p50 from key action call start): keydown ${ms(eventP50("F_realEndOnly", "end", "keydown"))}; selectionchange ${ms(eventP50("F_realEndOnly", "end", "selectionchange"))}; keyup ${ms(eventP50("F_realEndOnly", "end", "keyup"))}. beforeinput: ${ms(eventP50("F_realEndOnly", "end", "beforeinput"))}; input: ${ms(eventP50("F_realEndOnly", "end", "input"))}. Full event sequences are in JSON; End normally should omit beforeinput/input.

Selection-only transaction: End-only samples recorded ${endOnlySelectionOnly?.calls ?? 0} calls, ${ms(endOnlySelectionOnly?.totalMs)} total, ${ms(endOnlySelectionOnly?.maxMs)} max after setup was excluded by per-phase reset. Per-condition counts are in JSON.

## Chromium trace

Trace scope: one separate traced run for each of click, End, and input; trace overhead is excluded from the three-sample condition summaries. Input trace events are clipped at the TypingCommand::InsertText completion marker aligned with the DOM mutation observer. PerformanceObserver tasks after that boundary are reported separately. Raw trace files were not committed; summaries are in the JSON.

Longest tasks:

${traceLines.join("\n")}

Largest event per category in each measured window (selection/input category combines trace event names containing those terms; the input window is keydown → DOM mutation):

${categoryLines.join("\n")}

## Conclusion

${conclusion.map((line) => `- ${line}`).join("\n")}

These conclusions describe the measured Chromium build, fixture, and environment below. They do not establish causes outside these measured paths.

## Conditions and environment

- Branch: \`${report.branch}\`
- Commit SHA: \`${report.gitCommit}\`
- Condition measurement commit SHAs: \`${(report.measurement.conditionCommitSHAs ?? [report.gitCommit]).join("`, `")}\`
- Trace capture commit SHA: \`${report.traceCommitSHA ?? report.gitCommit}\`
- Fixture: \`${report.fixture.path}\` (${report.fixture.bytes} bytes, ${report.fixture.bodyRows} body rows, ${report.fixture.columns} columns, ${report.fixture.totalRowsIncludingHeader} table rows, ${report.fixture.cellsIncludingHeader} cells)
- Chromium: ${report.environment.chromiumVersion}
- OS: ${report.environment.operatingSystem}; CPU: ${report.environment.cpu} (${report.environment.logicalCpuCount} logical CPUs)
- Node: ${report.environment.nodeVersion}; viewport: 1280×900, DPR 1
- tableEditing plugin disabled and spellcheck=false were applied only via benchmark options in this benchmark bundle; no product behavior optimization was made.
- PerformanceObserver longtask support: ${Object.values(investigation.conditions).some((entry) => entry.samples.some((sample) => sample.interaction.longTasks.supported)) ? "available" : "unavailable"}.
`;
}

async function runCondition(browser, scenario, name, kind, options = {}) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    process.stdout.write(`  ${name} sample ${index + 1}/${sampleCount}\n`);
    samples.push(await collectSample(browser, scenario, kind, options));
  }
  return summarizeCondition(samples, name);
}

async function main() {
  await buildInstrumentedWebview();
  const scenario = (await getPerformanceScenarios()).find(
    (item) => item.id === "stress-table-2000x20",
  );
  assert.ok(scenario, "Stress table fixture is missing");
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
    const fixtureRows = scenario.markdown
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith("|"));
    const current = {};
    const traceSummaries = {};
    const experiments = [
      ["A_currentRealClickEnd", "realClickEndInput", { typeInput: true }],
      ["B_forceClickEnd", "forceClickEndInput", { typeInput: true }],
      ["C_domClick", "domClick", {}],
      ["D_focusOnly", "focusOnly", {}],
      ["E_directPmSelection", "directPmSelection", {}],
      ["F_realEndOnly", "realEndOnly", {}],
      ["G_keyboardEventDispatch", "keyboardEventDispatch", {}],
      ["H_directPmEnd", "directPmEnd", {}],
      [
        "I_tableEditingDisabled",
        "realClickEndInput",
        { pageOptions: { disableTableEditing: true }, typeInput: true },
      ],
      [
        "J_spellcheckDisabled",
        "realClickEndInput",
        { pageOptions: { disableSpellcheck: true }, typeInput: true },
      ],
    ];
    const traceOnly = process.env.MM_EDITOR_INTERACTION_TRACE_ONLY === "1";
    if (!traceOnly) {
      for (const [name, kind, options] of experiments) {
        if (selectedConditions && !selectedConditions.has(name)) continue;
        current[name] = await runCondition(
          browser,
          scenario,
          name,
          kind,
          options,
        );
      }
    }

    if (captureChromeTrace) {
      process.stdout.write(
        "  Capturing separate click/End/input Chrome traces\n",
      );
      const tracedPage = await createPage(browser, scenario);
      try {
        let notifyDomReflection;
        const domReflectionObserved = new Promise((resolveReflection) => {
          notifyDomReflection = resolveReflection;
        });
        await tracedPage.exposeFunction("__mmBenchmarkNotifyReflection", (at) =>
          notifyDomReflection(at),
        );
        const { target, visibleAt } = await prepareTarget(tracedPage, "click");
        const traceClick = await startTrace(tracedPage, "click");
        await target.click();
        const clickAt = await tracedPage.evaluate(() => performance.now());
        traceSummaries.click = await traceClick();
        await resetEvents(tracedPage, "end");
        const traceEnd = await startTrace(tracedPage, "end");
        await tracedPage.keyboard.press("End");
        await tracedPage.evaluate(() => performance.now());
        traceSummaries.end = await traceEnd();
        const traceInput = await startTrace(tracedPage, "input");
        const typePromise = tracedPage.keyboard.type("z");
        const domReflectionAt = await domReflectionObserved;
        traceSummaries.input = await traceInput();
        await typePromise;
        const inputMarks = await tracedPage.evaluate(() => ({
          inputStartedAt: window.__mmInputStartAt ?? null,
          domReflectionAt: window.__mmDomReflectionAt ?? null,
          longTasks: window.__mmLongTasks.entries.slice(),
        }));
        const postReflectionLongTasks = inputMarks.longTasks.filter(
          (task) => task.startTime >= domReflectionAt,
        );
        traceSummaries.scope = {
          targetVisibleAt: visibleAt,
          clickCompleteAt: clickAt,
          inputStartedAt: inputMarks.inputStartedAt,
          domReflectionAt,
          traceEndRequestedAtDomReflection: true,
          longTasksOverlappingInputStartToDomReflection:
            inputMarks.longTasks.filter(
              (task) =>
                task.startTime < domReflectionAt &&
                task.startTime + task.duration > inputMarks.inputStartedAt,
            ),
          postReflectionLongTasks,
          standaloneTraceSamples: 1,
        };
      } finally {
        await tracedPage.close();
      }
    } else {
      traceSummaries.unavailable = {
        supported: false,
        error: "Tracing disabled by MM_EDITOR_INTERACTION_TRACE=0",
      };
    }

    const packageJson = JSON.parse(
      await readFile(resolve(repository, "package.json"), "utf8"),
    );
    const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const mergeExisting =
      traceOnly || process.env.MM_EDITOR_INTERACTION_MERGE === "1";
    const previousReport = mergeExisting
      ? JSON.parse(await readFile(reportPath, "utf8"))
      : null;
    const savedConditions = {
      ...(previousReport?.investigation?.conditions ?? {}),
      ...current,
    };
    const finalConditions = Object.fromEntries(
      Object.entries(savedConditions).map(([name, entry]) => {
        const summary = summarizeCondition(entry.samples, name);
        summary.measurementCommitSHA = current[name]
          ? gitCommit
          : (entry.measurementCommitSHA ??
            previousReport?.gitCommit ??
            gitCommit);
        return [name, summary];
      }),
    );
    const report = {
      ...(previousReport ?? {}),
      schemaVersion: 1,
      generatedAt: previousReport?.generatedAt ?? new Date().toISOString(),
      traceUpdatedAt: new Date().toISOString(),
      packageVersion: previousReport?.packageVersion ?? packageJson.version,
      branch: execFileSync("git", ["branch", "--show-current"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      gitCommit: previousReport?.gitCommit ?? gitCommit,
      traceCommitSHA: gitCommit,
      fixture: {
        path: "tests/github-markdown-test-suite/stress/github-table-2000x20.md",
        bytes: Buffer.byteLength(scenario.markdown, "utf8"),
        bodyRows: scenario.table.bodyRows,
        columns: scenario.table.columns,
        totalRowsIncludingHeader: fixtureRows.length - 1,
        cellsIncludingHeader: (fixtureRows.length - 1) * scenario.table.columns,
      },
      measurement: {
        ...(previousReport?.measurement ?? {}),
        samplesPerCondition: sampleCount,
        conditionCommitSHAs: [
          ...new Set(
            Object.values(finalConditions).map(
              (entry) => entry.measurementCommitSHA,
            ),
          ),
        ],
        interactionHarness:
          "Playwright Chromium headless, benchmark-only webview bundle",
        directSelection:
          "In-bundle TableMap position plus TextSelection.near dispatched through the app transaction path",
        domClick:
          "HTMLElement.click() diagnostic; no physical pointer or native activation simulation",
        keyboardEventDispatch:
          "Synthetic keydown KeyboardEvent only; does not reproduce native caret movement",
        traceCapture:
          "CDP Tracing ReportEvents around one separate real click, real End, and input-start-to-DOM-mutation interaction; raw trace is summarized then discarded",
        traceCategories,
        tableEditingDisabled:
          "Benchmark option omits tableEditing() plugin before EditorState creation; default build is unchanged",
        spellcheckDisabled:
          "Benchmark option sets only the editor contenteditable spellcheck attribute to false",
        percentile: "linear interpolation; p50/p95/max",
      },
      environment: {
        ...(previousReport?.environment ?? {}),
        platform: `${process.platform}-${process.arch}`,
        operatingSystem: `${os.type()} ${os.release()}`,
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        nodeVersion: process.version,
        chromiumVersion: browser.version(),
        executablePath,
        viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
      },
      investigation: {
        conditions: finalConditions,
        chromeTraces: traceSummaries,
      },
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(markdownPath, reportMarkdown(report));
    process.stdout.write(`JSON: ${reportPath}\nMarkdown: ${markdownPath}\n`);
    for (const [name, entry] of Object.entries(current)) {
      const click = entry.timings.visibleToClickCompleteMs?.p50;
      const end =
        entry.timings.clickToCaretReadyMs?.p50 ??
        entry.timings.realOrSyntheticEndMs?.p50;
      const direct = entry.timings.directPmSelectionMs?.p50;
      process.stdout.write(
        `  ${name}: click ${ms(click)}, End ${ms(end)}, direct ${ms(direct)}\n`,
      );
    }
  } finally {
    await browser?.close();
    server.kill("SIGINT");
  }
}

await main();
