import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { getPerformanceScenarios } from "../tests/browser/performance-fixtures.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MM_SCROLL_STRUCTURE_PORT ?? "4188");
const baseUrl = `http://127.0.0.1:${port}`;
const bundlePath = resolve(repository, "output/benchmark/webview.js");
const reportPath = resolve(
  repository,
  "docs/performance/issue-119-scroll-structure-investigation.md",
);
const resultPath = resolve(
  repository,
  "output/benchmark/issue-119-interaction-investigation.json",
);
const rawTraceDirectory =
  process.env.MM_SCROLL_STRUCTURE_TRACE_DIR ??
  "/tmp/markdown-mint-issue119-scroll-structure-traces";
const sampleCount = Math.max(
  1,
  Number.parseInt(process.env.MM_SCROLL_STRUCTURE_SAMPLES ?? "3", 10) || 3,
);
const smoke = process.env.MM_SCROLL_STRUCTURE_SMOKE === "1";
const skipPerformance =
  process.env.MM_SCROLL_STRUCTURE_SKIP_PERFORMANCE === "1";
const selectedConditions = process.env.MM_SCROLL_STRUCTURE_CONDITIONS
  ? new Set(
      process.env.MM_SCROLL_STRUCTURE_CONDITIONS.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    )
  : null;
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

function rowsFor(markdown, bodyRows) {
  const rows = markdown
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("|"));
  assert.ok(rows.length >= bodyRows + 2, "Stress table rows are missing");
  return rows.slice(0, bodyRows + 2);
}

function tableMarkdown(rows) {
  return `${rows.join("\n")}\n`;
}

function tableScenario(
  baseScenario,
  bodyRows,
  { before = "", after = "" } = {},
) {
  const table = tableMarkdown(rowsFor(baseScenario.markdown, bodyRows));
  const parts = [];
  if (before) parts.push(before);
  parts.push(table.trimEnd());
  if (after) parts.push(after);
  return {
    ...baseScenario,
    markdown: `${parts.join("\n\n")}\n`,
    table: { ...baseScenario.table, bodyRows },
  };
}

function twoTableScenario(baseScenario, bodyRows) {
  const table = tableMarkdown(
    rowsFor(baseScenario.markdown, bodyRows),
  ).trimEnd();
  return {
    ...baseScenario,
    markdown: `Before table A.\n\n${table}\n\nBetween tables.\n\n${table}\n\nAfter table B.\n`,
    table: { ...baseScenario.table, bodyRows },
  };
}

function cssForCondition(condition) {
  if (condition.id === "stage")
    return ".mm-document-content table{overflow-x:visible!important;}";
  if (!condition.wrapper) return "";
  const overflowY =
    condition.id === "wrapper-proxy"
      ? "overflow-y:hidden!important;overflow-x:hidden!important;"
      : condition.id === "wrapper-hidden"
        ? "overflow-y:hidden!important;"
        : condition.id === "wrapper-clip"
          ? "overflow-y:clip!important;"
          : "";
  return [
    ".mm-document-content .mm-table-scroll{",
    "display:block!important;",
    "width:100%!important;",
    "max-width:100%!important;",
    "overflow-x:auto!important;",
    overflowY,
    "}",
    ".mm-document-content .mm-table-scroll>table{",
    "display:table!important;",
    "width:max-content!important;",
    "min-width:100%!important;",
    "max-width:none!important;",
    "overflow-x:visible!important;",
    "}",
  ].join("");
}

function styleMap(element, names) {
  if (!element) return null;
  const computed = getComputedStyle(element);
  return Object.fromEntries(names.map((name) => [name, computed[name]]));
}

function rectMap(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
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
      // The local test server is still binding its port.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Browser server failed to start: ${output}`);
}

async function waitFrames(page, count = 2) {
  await page.evaluate(
    (frames) =>
      new Promise((resolveReady) => {
        const tick = (remaining) => {
          if (remaining <= 0) {
            resolveReady();
            return;
          }
          requestAnimationFrame(() => tick(remaining - 1));
        };
        tick(frames);
      }),
    count,
  );
}

async function installCss(page, css) {
  if (css) {
    const url = `${baseUrl}/__mm_scroll_structure_${Math.random()
      .toString(36)
      .slice(2)}.css`;
    await page.route(url, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/css",
        body: css,
      }),
    );
    await page.addStyleTag({ url });
  }
  await waitFrames(page);
}

async function installScrollProxy(page) {
  await page.evaluate(() => {
    for (const wrapper of document.querySelectorAll(".mm-table-scroll")) {
      const table = wrapper.querySelector(":scope > table");
      if (!table || wrapper.querySelector(":scope > .mm-table-scrollbar-proxy"))
        continue;
      const proxy = document.createElement("div");
      proxy.className = "mm-table-scrollbar-proxy";
      proxy.setAttribute("data-mm-benchmark-only", "true");
      proxy.style.cssText =
        "display:block;width:100%;height:16px;overflow-x:auto;overflow-y:hidden;";
      const spacer = document.createElement("div");
      spacer.style.cssText = `width:${table.scrollWidth}px;height:1px;`;
      proxy.append(spacer);
      const sync = () => {
        table.style.transform = `translateX(${-proxy.scrollLeft}px)`;
      };
      proxy.addEventListener("scroll", sync, { passive: true });
      wrapper.append(proxy);
      sync();
    }
  });
  await waitFrames(page);
}

async function createPage(browser, scenario, condition) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(120_000);
  await page.addInitScript(
    ({ markdown, profile, tableScrollWrapper }) => {
      window.__markdownMintBenchmarkInitialMarkdown = markdown;
      window.__markdownMintPerformanceBenchmarkOptions = {
        tableScrollWrapper,
      };
      window.__markdownMintBenchmarkNavigationStartedAt = performance.now();
      window.__mmScrollTimeline = [];
      window.__mmScrollLongTasks = { supported: false, entries: [] };
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
        if (
          typeof PerformanceObserver !== "undefined" &&
          PerformanceObserver.supportedEntryTypes?.includes("longtask")
        ) {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__mmScrollLongTasks.entries.push({
                startTime: entry.startTime,
                duration: entry.duration,
              });
          });
          window.__mmScrollLongTaskObserver = observer;
          observer.observe({ type: "longtask", buffered: true });
          window.__mmScrollLongTasks.supported = true;
        }
      } catch {
        window.__mmScrollLongTasks.supported = false;
      }
    },
    {
      markdown: scenario.markdown,
      profile: scenario.profile,
      tableScrollWrapper: condition.wrapper === true,
    },
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
  const matches = await page.evaluate(
    (expected) =>
      window.markdownMint.sourceEl.value === expected &&
      window.__markdownMintHarness.document.markdown === expected,
    scenario.markdown,
  );
  assert.equal(matches, true, "Benchmark fixture changed while loading");
  await installCss(page, cssForCondition(condition));
  if (condition.id === "wrapper-proxy") await installScrollProxy(page);
  return page;
}

async function captureRenderSnapshot(page, bodyRow = 1, column = 0) {
  return page.evaluate(
    ({ bodyRow: wantedRow, column: wantedColumn }) => {
      const editor = document.querySelector(".mm-rich-panel .ProseMirror");
      const stage = editor?.closest(".mm-stage");
      const panel = editor?.closest(".mm-rich-panel");
      const table = editor?.querySelector("table");
      const row = table?.rows[wantedRow];
      const cell = row?.cells[wantedColumn];
      const paragraph = cell?.querySelector(":scope > p") ?? null;
      const wrapper = table?.closest(".mm-table-scroll");
      const proxy = wrapper?.querySelector(
        ":scope > .mm-table-scrollbar-proxy",
      );
      const names = {
        stage: [
          "display",
          "position",
          "overflowX",
          "overflowY",
          "width",
          "height",
          "contain",
          "contentVisibility",
          "transform",
        ],
        editor: [
          "display",
          "position",
          "overflowX",
          "overflowY",
          "width",
          "height",
          "contain",
          "contentVisibility",
          "transform",
        ],
        table: [
          "display",
          "position",
          "width",
          "minWidth",
          "maxWidth",
          "margin",
          "borderSpacing",
          "borderCollapse",
          "overflowX",
          "overflowY",
          "boxSizing",
          "contain",
          "contentVisibility",
          "willChange",
          "transform",
          "isolation",
        ],
        row: [
          "display",
          "position",
          "minWidth",
          "width",
          "height",
          "padding",
          "border",
          "backgroundColor",
          "verticalAlign",
          "overflow",
          "contain",
          "contentVisibility",
          "transform",
          "willChange",
        ],
        paragraph: [
          "display",
          "fontFamily",
          "fontSize",
          "lineHeight",
          "whiteSpace",
          "overflowWrap",
          "wordBreak",
          "margin",
        ],
        wrapper: [
          "display",
          "position",
          "width",
          "minWidth",
          "maxWidth",
          "overflowX",
          "overflowY",
          "contain",
          "contentVisibility",
          "transform",
          "willChange",
        ],
        proxy: [
          "display",
          "position",
          "width",
          "height",
          "overflowX",
          "overflowY",
          "contain",
          "contentVisibility",
          "transform",
        ],
      };
      const styleOf = (element, propertyNames) => {
        if (!element) return null;
        const style = getComputedStyle(element);
        return Object.fromEntries(
          propertyNames.map((name) => [name, style[name]]),
        );
      };
      const rectOf = (element) => {
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
      const overflowAncestors = [];
      let ancestor = cell?.parentElement ?? null;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== "visible" || style.overflowY !== "visible")
          overflowAncestors.push({
            tagName: ancestor.tagName,
            className: String(ancestor.className ?? ""),
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            rect: rectOf(ancestor),
          });
        ancestor = ancestor.parentElement;
      }
      const readGeometry = (element) =>
        element
          ? {
              scrollTop: element.scrollTop,
              scrollLeft: element.scrollLeft,
              clientWidth: element.clientWidth,
              clientHeight: element.clientHeight,
              scrollWidth: element.scrollWidth,
              scrollHeight: element.scrollHeight,
              rect: rectOf(element),
            }
          : null;
      return {
        capturedAt: performance.now(),
        target: { bodyRow: wantedRow, column: wantedColumn },
        stage: styleOf(stage, names.stage),
        richPanel: styleOf(panel, names.editor),
        editor: styleOf(editor, names.editor),
        wrapper: styleOf(wrapper, names.wrapper),
        proxy: styleOf(proxy, names.proxy),
        table: styleOf(table, names.table),
        tbody: styleOf(table?.tBodies[0], names.row),
        row: styleOf(row, names.row),
        cell: styleOf(cell, names.row),
        paragraph: styleOf(paragraph, names.paragraph),
        overflowAncestors,
        geometry: {
          stage: readGeometry(stage),
          wrapper: readGeometry(wrapper),
          proxy: readGeometry(proxy),
          table: readGeometry(table),
          targetCell: rectOf(cell),
        },
      };
    },
    { bodyRow, column },
  );
}

async function captureScrollUX(page, bodyRow = 1) {
  return page.evaluate(async (wantedRow) => {
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    const stage = editor?.closest(".mm-stage");
    const table = editor?.querySelector("table");
    const wrapper = table?.closest(".mm-table-scroll");
    const proxy = wrapper?.querySelector(":scope > .mm-table-scrollbar-proxy");
    const beforeParagraph = editor?.querySelector(":scope > p");
    const afterParagraph = [...(editor?.children ?? [])].find(
      (element) => element.tagName === "P" && !element.contains(table),
    );
    const row = table?.rows[wantedRow];
    const rightmostCell = row?.cells[row.cells.length - 1];
    if (!stage || !table || !row || !rightmostCell)
      throw new Error("Scroll UX fixture is missing its target table");
    const style = (element) => {
      const computed = getComputedStyle(element);
      return {
        overflowX: computed.overflowX,
        overflowY: computed.overflowY,
      };
    };
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
    const owner =
      proxy && proxy.scrollWidth > proxy.clientWidth
        ? proxy
        : wrapper && wrapper.scrollWidth > wrapper.clientWidth
          ? wrapper
          : table.scrollWidth > table.clientWidth &&
              ["auto", "scroll"].includes(style(table).overflowX)
            ? table
            : stage.scrollWidth > stage.clientWidth
              ? stage
              : null;
    const read = (label) => ({
      label,
      stage: {
        scrollLeft: stage.scrollLeft,
        scrollWidth: stage.scrollWidth,
        clientWidth: stage.clientWidth,
      },
      table: {
        scrollLeft: table.scrollLeft,
        scrollWidth: table.scrollWidth,
        clientWidth: table.clientWidth,
        rect: rect(table),
      },
      wrapper: wrapper
        ? {
            scrollLeft: wrapper.scrollLeft,
            scrollWidth: wrapper.scrollWidth,
            clientWidth: wrapper.clientWidth,
            rect: rect(wrapper),
          }
        : null,
      proxy: proxy
        ? {
            scrollLeft: proxy.scrollLeft,
            scrollWidth: proxy.scrollWidth,
            clientWidth: proxy.clientWidth,
            rect: rect(proxy),
          }
        : null,
      rightmostCell: rect(rightmostCell),
      beforeParagraph: rect(beforeParagraph),
      afterParagraph: rect(afterParagraph),
    });
    for (const element of [stage, proxy, wrapper, table])
      if (element) element.scrollLeft = 0;
    await new Promise((resolveReady) =>
      requestAnimationFrame(() => requestAnimationFrame(resolveReady)),
    );
    const initial = read("initial");
    if (owner) owner.scrollLeft = owner.scrollWidth - owner.clientWidth;
    await new Promise((resolveReady) =>
      requestAnimationFrame(() => requestAnimationFrame(resolveReady)),
    );
    const scrolled = read("max");
    const ownerRect = owner?.getBoundingClientRect() ?? null;
    return {
      scrollOwner:
        owner === null
          ? "none"
          : owner === proxy
            ? "scroll proxy"
            : owner === wrapper
              ? "table wrapper"
              : owner === table
                ? "table"
                : owner === stage
                  ? "stage"
                  : "none",
      horizontalScrollbarLocation: owner
        ? `${owner === proxy ? ".mm-table-scrollbar-proxy" : owner === wrapper ? ".mm-table-scroll" : owner === table ? "table" : ".mm-stage"} (${style(owner).overflowX})`
        : "none",
      ownerGeometry: owner
        ? {
            scrollWidth: owner.scrollWidth,
            clientWidth: owner.clientWidth,
            maxScrollLeft: Math.max(0, owner.scrollWidth - owner.clientWidth),
          }
        : null,
      rightmostReachable: Boolean(
        ownerRect &&
        scrolled.rightmostCell &&
        scrolled.rightmostCell.right <= ownerRect.right + 1 &&
        scrolled.rightmostCell.left >= ownerRect.left - 1,
      ),
      paragraphLeftShift: {
        before: initial.beforeParagraph?.left ?? null,
        after: scrolled.afterParagraph?.left ?? null,
        delta:
          initial.afterParagraph && scrolled.afterParagraph
            ? scrolled.afterParagraph.left - initial.afterParagraph.left
            : null,
      },
      initial,
      scrolled,
      stageScrollLeftAfter: stage.scrollLeft,
      tableScrollLeftAfter: table.scrollLeft,
      wrapperScrollLeftAfter: wrapper?.scrollLeft ?? null,
      proxyScrollLeftAfter: proxy?.scrollLeft ?? null,
      tableStyle: style(table),
      wrapperStyle: wrapper ? style(wrapper) : null,
    };
  }, bodyRow);
}

async function installInteractionProbe(page, bodyRow, column) {
  await page.evaluate(
    ({ bodyRow: wantedRow, column: wantedColumn }) => {
      const root = document.querySelector(".mm-rich-panel .ProseMirror");
      const table = root?.querySelector("table");
      const cell = table?.rows[wantedRow]?.cells[wantedColumn];
      if (!root || !table || !cell) throw new Error("Target cell missing");
      window.__mmScrollTimeline = [];
      window.__mmScrollMutationAt = null;
      window.__mmScrollInputStartedAt = null;
      window.__mmScrollInputIdleAt = null;
      const record = (event) => {
        if (
          event.type !== "selectionchange" &&
          event.type !== "scroll" &&
          event.target !== root &&
          event.target !== table &&
          !(event.target instanceof Node && table.contains(event.target))
        )
          return;
        window.__mmScrollTimeline.push({
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
        if (!(cell.textContent ?? "").includes("z")) return;
        window.__mmScrollMutationAt = performance.now();
        observer.disconnect();
      });
      observer.observe(cell, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      window.__mmScrollWaitForMutation = () =>
        new Promise((resolveMutation) => {
          if (window.__mmScrollMutationAt !== null) {
            resolveMutation(window.__mmScrollMutationAt);
            return;
          }
          const check = () => {
            if (window.__mmScrollMutationAt !== null)
              resolveMutation(window.__mmScrollMutationAt);
            else requestAnimationFrame(check);
          };
          check();
        });
    },
    { bodyRow, column },
  );
}

async function startTrace(page) {
  const session = await page.context().newCDPSession(page);
  const events = [];
  session.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  try {
    await session.send("Tracing.start", {
      categories: traceCategories,
      transferMode: "ReportEvents",
      options: "record-until-full",
    });
  } catch (error) {
    await session.detach();
    return async () => ({ supported: false, error: String(error) });
  }
  return async (rawPath) => {
    const complete = new Promise((resolveComplete) =>
      session.once("Tracing.tracingComplete", resolveComplete),
    );
    await session.send("Tracing.end");
    await complete;
    await session.detach();
    if (rawPath) {
      await mkdir(dirname(rawPath), { recursive: true });
      await writeFile(
        rawPath,
        JSON.stringify({ traceEvents: events, metadata: { traceCategories } }),
      );
    }
    return { supported: true, ...summarizeTrace(events) };
  };
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
  const parent = new Map();
  const stacks = new Map();
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
      let value = 0;
      let item = parent.get(event);
      while (item && value < 64) {
        value += 1;
        item = parent.get(item);
      }
      return value;
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
  const pac = complete
    .filter((event) => event.name === "PaintArtifactCompositor::Update")
    .sort((a, b) => b.dur - a.dur)[0];
  const longestChildren = pac
    ? complete
        .filter(
          (event) =>
            event !== pac &&
            event.pid === pac.pid &&
            event.tid === pac.tid &&
            event.ts >= pac.ts &&
            event.ts + event.dur <= pac.ts + pac.dur,
        )
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 10)
        .map(expose)
    : [];
  const categoryTotalsMs = {
    Layout: 0,
    EventDispatch: 0,
    FunctionCall: 0,
    SelectionInput: 0,
    Paint: 0,
    Other: 0,
  };
  for (const event of complete) {
    const name = String(event.name ?? "");
    const category = /Layout|UpdateLayoutTree|StyleRecalc/i.test(name)
      ? "Layout"
      : /EventDispatch|HitTest/i.test(name)
        ? "EventDispatch"
        : /FunctionCall|EvaluateScript|RunMicrotasks|V8/i.test(name)
          ? "FunctionCall"
          : /Selection|Input|Caret|Editing/i.test(name)
            ? "SelectionInput"
            : /Paint|Composite|Raster|Layerize|UpdateLifecycle/i.test(name)
              ? "Paint"
              : "Other";
    categoryTotalsMs[category] += event.dur / 1000;
  }
  const longTasks = complete
    .filter(
      (event) =>
        /RunTask|ProcessTaskFromWorkQueue|ThreadControllerImpl::RunTask/i.test(
          String(event.name ?? ""),
        ) ||
        (event.name === "Task" && event.dur >= 50_000),
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
    categoryTotalsMs,
    lifecycle,
    longestPaintArtifactCompositorUpdateMs: Math.max(
      0,
      ...lifecycle["PaintArtifactCompositor::Update"].map(
        (event) => event.durationMs,
      ),
    ),
    longestLayerizeMs: Math.max(
      0,
      ...lifecycle.Layerize.map((event) => event.durationMs),
    ),
    longestUpdateLifecycleMs: Math.max(
      0,
      ...lifecycle["WebFrameWidgetImpl::UpdateLifecycle"].map(
        (event) => event.durationMs,
      ),
    ),
    longestRunPaintLifecyclePhaseMs: Math.max(
      0,
      ...lifecycle["LocalFrameView::RunPaintLifecyclePhase"].map(
        (event) => event.durationMs,
      ),
    ),
    longestPaintChildren: longestChildren,
    longTasks,
  };
}

function metricValues(samples, path) {
  return summarize(
    samples.map((sample) => path.reduce((value, key) => value?.[key], sample)),
  );
}

async function runInteractionSample(
  browser,
  scenario,
  condition,
  index,
  row = 1,
) {
  const page = await createPage(browser, scenario, condition);
  const target = page
    .locator(".mm-rich-panel .ProseMirror table tr")
    .nth(row)
    .locator("th,td")
    .first();
  await target.scrollIntoViewIfNeeded();
  await waitFrames(page);
  const style = await captureRenderSnapshot(page, row, 0);
  await installInteractionProbe(page, row, 0);
  await page.evaluate(() => {
    window.__markdownMintPerformanceBenchmark?.reset?.();
    window.__mmScrollLongTasks.entries.length = 0;
    window.__mmScrollLongTaskObserver?.takeRecords();
    window.__mmScrollActionStartedAt = performance.now();
  });
  const traceStop = await startTrace(page);
  const clickStartedAt = await page.evaluate(() => performance.now());
  await target.click();
  const clickResolvedAt = await page.evaluate(() => performance.now());
  await page.evaluate(() => {
    window.__mmScrollInputStartedAt = performance.now();
  });
  await page.keyboard.type("z");
  await page.waitForFunction(
    () => typeof window.__mmScrollMutationAt === "number",
    null,
    { timeout: 120_000 },
  );
  const mutationAt = await page.evaluate(() => window.__mmScrollMutationAt);
  const idleAt = await page.evaluate(
    () =>
      new Promise((resolveIdle) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__mmScrollInputIdleAt = performance.now();
            resolveIdle(window.__mmScrollInputIdleAt);
          }),
        ),
      ),
  );
  const rawPath =
    index === 0
      ? resolve(rawTraceDirectory, `${condition.id}-row${row}.json`)
      : null;
  const trace = await traceStop(rawPath);
  const state = await page.evaluate(() => {
    const timeline = window.__mmScrollTimeline;
    const first = (type) =>
      timeline.find((event) => event.type === type)?.at ?? null;
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    const table = editor?.querySelector("table");
    const cell = table?.rows[1]?.cells[0];
    const selection = getSelection();
    const anchor = selection?.anchorNode;
    const anchorElement =
      anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
    return {
      timeline,
      eventTimes: {
        pointermove: first("pointermove"),
        pointerdown: first("pointerdown"),
        mousedown: first("mousedown"),
        focus: first("focus") ?? first("focusin"),
        mouseup: first("mouseup"),
        pointerup: first("pointerup"),
        click: first("click"),
        selectionchange: first("selectionchange"),
      },
      selectionInCell: Boolean(
        cell && anchorElement && cell.contains(anchorElement),
      ),
      pmSelection: window.markdownMint.view.state.selection.toJSON(),
      metrics: window.__markdownMintPerformanceBenchmark.snapshot(),
      counters: window.__markdownMintPerformanceBenchmark.counterSnapshot(),
      longTasks: {
        supported: window.__mmScrollLongTasks.supported,
        entries: window.__mmScrollLongTasks.entries.slice(),
      },
      markdownContainsTypedChar:
        window.__mmMarkdownMintHarness?.document?.markdown?.includes("z") ??
        window.__markdownMintHarness.document.markdown.includes("z"),
      scrollContainers:
        document.querySelector(".mm-table-controls")?.dataset
          .mmBenchmarkScrollContainers ?? null,
    };
  });
  await page.close();
  const actionStartedAt = await Promise.resolve(clickStartedAt);
  return {
    condition: condition.id,
    row,
    style,
    trace,
    state,
    clickLatencyMs: clickResolvedAt - actionStartedAt,
    inputToDomMutationMs: mutationAt - (state.inputStartedAt ?? mutationAt),
    inputToFirstIdleMs: idleAt - mutationAt,
    fullInteractionMs: idleAt - actionStartedAt,
    inputStartedAt: await Promise.resolve(state.inputStartedAt ?? null),
    clickResolvedAt,
  };
}

async function runInteractionSampleFixed(
  browser,
  scenario,
  condition,
  index,
  row = 1,
) {
  // The first implementation above deliberately records browser timestamps
  // after the page closes only for the final aggregation. Keep the actual
  // input timestamp in a small wrapper so mutation attribution is explicit.
  const page = await createPage(browser, scenario, condition);
  const target = page
    .locator(".mm-rich-panel .ProseMirror table tr")
    .nth(row)
    .locator("th,td")
    .first();
  await target.scrollIntoViewIfNeeded();
  await waitFrames(page);
  const style = await captureRenderSnapshot(page, row, 0);
  await installInteractionProbe(page, row, 0);
  await page.evaluate(() => {
    window.__markdownMintPerformanceBenchmark?.reset?.();
    window.__mmScrollLongTasks.entries.length = 0;
    window.__mmScrollLongTaskObserver?.takeRecords();
    window.__mmScrollActionStartedAt = performance.now();
  });
  const traceStop = await startTrace(page);
  const clickStartedAt = await page.evaluate(() => performance.now());
  await target.click();
  const clickResolvedAt = await page.evaluate(() => performance.now());
  const inputStartedAt = await page.evaluate(() => {
    window.__mmScrollInputStartedAt = performance.now();
    return window.__mmScrollInputStartedAt;
  });
  await page.keyboard.type("z");
  await page.waitForFunction(
    () => typeof window.__mmScrollMutationAt === "number",
    null,
    { timeout: 120_000 },
  );
  const mutationAt = await page.evaluate(() => window.__mmScrollMutationAt);
  const idleAt = await page.evaluate(
    () =>
      new Promise((resolveIdle) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__mmScrollInputIdleAt = performance.now();
            resolveIdle(window.__mmScrollInputIdleAt);
          }),
        ),
      ),
  );
  const trace = await traceStop(
    index === 0
      ? resolve(rawTraceDirectory, `${condition.id}-row${row}.json`)
      : null,
  );
  const state = await page.evaluate(() => {
    const timeline = window.__mmScrollTimeline;
    const first = (type) =>
      timeline.find((event) => event.type === type)?.at ?? null;
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    const table = editor?.querySelector("table");
    const cell = table?.rows[1]?.cells[0];
    const selection = getSelection();
    const anchor = selection?.anchorNode;
    const anchorElement =
      anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
    return {
      timeline,
      eventTimes: {
        pointermove: first("pointermove"),
        pointerdown: first("pointerdown"),
        mousedown: first("mousedown"),
        focus: first("focus") ?? first("focusin"),
        mouseup: first("mouseup"),
        pointerup: first("pointerup"),
        click: first("click"),
        selectionchange: first("selectionchange"),
      },
      selectionInCell: Boolean(
        cell && anchorElement && cell.contains(anchorElement),
      ),
      pmSelection: window.markdownMint.view.state.selection.toJSON(),
      metrics: window.__markdownMintPerformanceBenchmark.snapshot(),
      counters: window.__markdownMintPerformanceBenchmark.counterSnapshot(),
      longTasks: {
        supported: window.__mmScrollLongTasks.supported,
        entries: window.__mmScrollLongTasks.entries.slice(),
      },
      markdownContainsTypedChar:
        window.__markdownMintHarness.document.markdown.includes("z"),
      scrollContainers:
        document.querySelector(".mm-table-controls")?.dataset
          .mmBenchmarkScrollContainers ?? null,
    };
  });
  await page.close();
  return {
    condition: condition.id,
    row,
    style,
    trace,
    state,
    clickLatencyMs: clickResolvedAt - clickStartedAt,
    selectionLatencyMs:
      (state.eventTimes.selectionchange ?? clickResolvedAt) - clickStartedAt,
    inputToDomMutationMs: mutationAt - inputStartedAt,
    inputToFirstIdleMs: idleAt - mutationAt,
    fullInteractionMs: idleAt - clickStartedAt,
    clickStartedAt,
    clickResolvedAt,
    inputStartedAt,
    mutationAt,
    idleAt,
  };
}

async function captureUxPage(browser, scenario, condition) {
  const page = await createPage(browser, scenario, condition);
  const style = await captureRenderSnapshot(page, 1, 0);
  const ux = await captureScrollUX(page, 1);
  await page.close();
  return { style, ux };
}

async function captureMultipleUxPage(browser, scenario, condition) {
  const page = await createPage(browser, scenario, condition);
  const ux = await page.evaluate(async () => {
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    const stage = editor?.closest(".mm-stage");
    const tables = [...(editor?.querySelectorAll("table") ?? [])];
    const describeOwner = (table) => {
      const wrapper = table.closest(".mm-table-scroll");
      const proxy = wrapper?.querySelector(
        ":scope > .mm-table-scrollbar-proxy",
      );
      if (proxy && proxy.scrollWidth > proxy.clientWidth)
        return { element: proxy, kind: "scroll proxy" };
      if (wrapper && wrapper.scrollWidth > wrapper.clientWidth)
        return { element: wrapper, kind: "table wrapper" };
      if (
        table.scrollWidth > table.clientWidth &&
        ["auto", "scroll"].includes(getComputedStyle(table).overflowX)
      )
        return { element: table, kind: "table" };
      if (stage && stage.scrollWidth > stage.clientWidth)
        return { element: stage, kind: "stage" };
      return { element: null, kind: "none" };
    };
    const owners = tables.map(describeOwner);
    const before = owners.map(({ element, kind }) => ({
      kind,
      scrollLeft: element?.scrollLeft ?? 0,
      scrollWidth: element?.scrollWidth ?? 0,
      clientWidth: element?.clientWidth ?? 0,
    }));
    const first = owners[0]?.element;
    if (first) {
      first.scrollLeft = first.scrollWidth - first.clientWidth;
      const wrapper = tables[0]?.closest(".mm-table-scroll");
      const proxy = wrapper?.querySelector(
        ":scope > .mm-table-scrollbar-proxy",
      );
      if (proxy === first && tables[0])
        tables[0].style.transform = `translateX(${-proxy.scrollLeft}px)`;
    }
    await new Promise((resolveReady) =>
      requestAnimationFrame(() => requestAnimationFrame(resolveReady)),
    );
    const after = owners.map(({ element, kind }) => ({
      kind,
      scrollLeft: element?.scrollLeft ?? 0,
    }));
    return {
      tableCount: tables.length,
      owners: before,
      after,
      firstTableScrolled: (after[0]?.scrollLeft ?? 0) > 0,
      secondTableUnchanged:
        (before[1]?.scrollLeft ?? 0) === (after[1]?.scrollLeft ?? 0),
      stageScrollLeft: stage?.scrollLeft ?? 0,
    };
  });
  await page.close();
  return { ux };
}

async function captureControlsAndEditing(browser, scenario, condition) {
  const page = await createPage(browser, scenario, condition);
  const target = page
    .locator(".mm-rich-panel .ProseMirror table tr")
    .nth(1)
    .locator("td")
    .last();
  await target.scrollIntoViewIfNeeded();
  await waitFrames(page);
  await target.click();
  await waitFrames(page);
  const controlAt = async (label, fraction) => {
    await page.evaluate((ratio) => {
      const table = document.querySelector(".mm-rich-panel .ProseMirror table");
      const wrapper = table?.closest(".mm-table-scroll");
      const stage = document.querySelector(".mm-stage");
      const proxy = wrapper?.querySelector(
        ":scope > .mm-table-scrollbar-proxy",
      );
      const owner = proxy ?? wrapper ?? table ?? stage;
      if (owner) {
        owner.scrollLeft =
          Math.max(0, owner.scrollWidth - owner.clientWidth) * ratio;
        if (proxy) table.style.transform = `translateX(${-proxy.scrollLeft}px)`;
      }
    }, fraction);
    await waitFrames(page);
    await page.evaluate(() => {
      for (const handle of document.querySelectorAll(
        ".mm-table-controls .mm-table-row-handle, .mm-table-controls .mm-table-column-handle",
      ))
        handle.hidden = false;
    });
    return page.evaluate((name) => {
      const controls = document.querySelector(".mm-table-controls");
      const targetCell = document.querySelector(
        ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:last-child",
      );
      const targetRowCell = document.querySelector(
        ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:first-child",
      );
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
      return {
        label: name,
        controlsHidden: controls?.hidden ?? true,
        rowHandles: document.querySelectorAll(
          ".mm-table-controls .mm-table-row-handle",
        ).length,
        columnHandles: document.querySelectorAll(
          ".mm-table-controls .mm-table-column-handle",
        ).length,
        targetCell: rect(targetCell),
        rowHandle: rect(
          document.querySelector(
            '.mm-table-controls .mm-table-row-handle[data-index="1"]',
          ),
        ),
        columnHandle: rect(
          document.querySelector(
            '.mm-table-controls .mm-table-column-handle[data-index="19"]',
          ),
        ),
        rowAlignmentDeltaTop:
          rect(targetRowCell) &&
          rect(
            document.querySelector(
              '.mm-table-controls .mm-table-row-handle[data-index="1"]',
            ),
          )
            ? rect(
                document.querySelector(
                  '.mm-table-controls .mm-table-row-handle[data-index="1"]',
                ),
              ).top - rect(targetRowCell).top
            : null,
        columnAlignmentDeltaLeft:
          rect(targetCell) &&
          rect(
            document.querySelector(
              '.mm-table-controls .mm-table-column-handle[data-index="19"]',
            ),
          )
            ? rect(
                document.querySelector(
                  '.mm-table-controls .mm-table-column-handle[data-index="19"]',
                ),
              ).left - rect(targetCell).left
            : null,
        highlighted: document.querySelectorAll(
          ".mm-table-controls .mm-table-control-highlight:not([hidden])",
        ).length,
        moveIndicatorHidden:
          document.querySelector(".mm-table-move-indicator")?.hidden ?? true,
        scrollContainers: controls?.dataset.mmBenchmarkScrollContainers ?? null,
      };
    }, label);
  };
  const tableMetrics = await page.evaluate(() => {
    const table = document.querySelector(".mm-rich-panel .ProseMirror table");
    const wrapper = table?.closest(".mm-table-scroll");
    return {
      table: table
        ? { scrollWidth: table.scrollWidth, clientWidth: table.clientWidth }
        : null,
      wrapper: wrapper
        ? { scrollWidth: wrapper.scrollWidth, clientWidth: wrapper.clientWidth }
        : null,
      stage: (() => {
        const stage = document.querySelector(".mm-stage");
        return stage
          ? { scrollWidth: stage.scrollWidth, clientWidth: stage.clientWidth }
          : null;
      })(),
      controls:
        document.querySelector(".mm-table-controls")?.dataset
          .mmBenchmarkScrollContainers ?? null,
    };
  });
  const controls = [
    await controlAt("0%", 0),
    await controlAt("50%", 0.5),
    await controlAt("100%", 1),
  ];
  const editing = await page.evaluate(() => {
    const table = document.querySelector(".mm-rich-panel .ProseMirror table");
    const cells = table?.rows[1]?.cells;
    const cell = cells ? cells[cells.length - 1] : null;
    const before = cell?.textContent ?? "";
    return { before, cellExists: Boolean(cell) };
  });
  await page.keyboard.type("q");
  await waitFrames(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const finalState = await page.evaluate(() => ({
    domText:
      document.querySelector(
        ".mm-rich-panel .ProseMirror table tr:nth-child(2) td:last-child",
      )?.textContent ?? null,
    markdown: window.__markdownMintHarness.document.markdown,
    pmSelection: window.markdownMint.view.state.selection.toJSON(),
    stageScrollLeft: document.querySelector(".mm-stage")?.scrollLeft ?? null,
    wrapperScrollLeft:
      document.querySelector(".mm-table-scroll")?.scrollLeft ?? null,
    editMessageCount: window.__markdownMintHarness.messages.filter(
      (message) => message.type === "edit",
    ).length,
  }));
  await page.close();
  return {
    tableMetrics,
    controls,
    editing: {
      ...editing,
      ...finalState,
      markdownContainsTypedChar: finalState.markdown.includes("q"),
      domContainsTypedChar: finalState.domText?.includes("q") ?? false,
    },
    dragAutoScroll: {
      status: "not-run",
      reason:
        "The benchmark NodeView keeps the existing production TableControls DOM contract unchanged; a drag is only meaningful after target resolution succeeds.",
    },
  };
}

function conditionSummary(samples) {
  return {
    sampleCount: samples.length,
    click: summarize(samples.map((sample) => sample.clickLatencyMs)),
    selectionchange: summarize(
      samples.map((sample) => sample.selectionLatencyMs),
    ),
    paintArtifactCompositorUpdate: summarize(
      samples.map(
        (sample) => sample.trace.longestPaintArtifactCompositorUpdateMs,
      ),
    ),
    layerize: summarize(
      samples.map((sample) => sample.trace.longestLayerizeMs),
    ),
    updateLifecycle: summarize(
      samples.map((sample) => sample.trace.longestUpdateLifecycleMs),
    ),
    runPaintLifecyclePhase: summarize(
      samples.map((sample) => sample.trace.longestRunPaintLifecyclePhaseMs),
    ),
    inputToDomMutation: summarize(
      samples.map((sample) => sample.inputToDomMutationMs),
    ),
    inputToFirstIdle: summarize(
      samples.map((sample) => sample.inputToFirstIdleMs),
    ),
    fullInteraction: summarize(
      samples.map((sample) => sample.fullInteractionMs),
    ),
    longTaskCount: summarize(
      samples.map((sample) => sample.state.longTasks.entries.length),
    ),
    longTaskTotal: summarize(
      samples.map((sample) =>
        sample.state.longTasks.entries.reduce(
          (total, entry) => total + entry.duration,
          0,
        ),
      ),
    ),
  };
}

function classify(summary) {
  const pac = summary.paintArtifactCompositorUpdate.p50;
  return pac < 500 ? "fast" : pac <= 3000 ? "intermediate" : "slow";
}

function formatMs(summary) {
  return summary?.p50 == null ? "n/a" : `${summary.p50.toFixed(1)} ms`;
}

async function main() {
  await buildInstrumentedBundle();
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
  try {
    await waitForServer(server);
    const scenarios = await getPerformanceScenarios();
    const base = scenarios.find(
      (scenario) => scenario.id === "stress-table-2000x20",
    );
    assert.ok(base, "Stress scenario is missing");
    const stress = tableScenario(base, 2000, {
      after: "Performance edit anchor.",
    });
    const wideSmall = tableScenario(base, 100, {
      before: "Before wide table.",
      after: "After wide table.",
    });
    const narrow = {
      ...tableScenario(base, 3, {
        before: "Before narrow.",
        after: "After narrow.",
      }),
      markdown:
        "Before narrow.\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\nAfter narrow.\n",
    };
    const twoWide = twoTableScenario(base, 100);
    const allConditions = [
      { id: "current", label: "Current table overflow:auto", wrapper: false },
      {
        id: "stage",
        label: "Stage scroll (table overflow:visible)",
        wrapper: false,
      },
      {
        id: "wrapper-auto",
        label: "Table wrapper overflow-x:auto",
        wrapper: true,
      },
      {
        id: "wrapper-hidden",
        label: "Table wrapper auto + overflow-y:hidden",
        wrapper: true,
      },
      {
        id: "wrapper-clip",
        label: "Table wrapper auto + overflow-y:clip",
        wrapper: true,
      },
      {
        id: "wrapper-proxy",
        label: "Non-scroll viewport + small scrollbar proxy",
        wrapper: true,
      },
    ];
    const conditions = selectedConditions
      ? allConditions.filter((condition) =>
          selectedConditions.has(condition.id),
        )
      : allConditions;
    let existingResults = {};
    try {
      existingResults = JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      // The prior investigation JSON may not exist in a clean checkout.
    }
    const measurements = {};
    for (const condition of conditions) {
      const count = skipPerformance ? 0 : smoke ? 1 : sampleCount;
      const samples = [];
      for (let index = 0; index < count; index += 1) {
        process.stdout.write(
          `  ${condition.id} sample ${index + 1}/${count}\n`,
        );
        samples.push(
          await runInteractionSampleFixed(browser, stress, condition, index, 1),
        );
      }
      const ux = await captureUxPage(browser, wideSmall, condition);
      const narrowUx = await captureUxPage(browser, narrow, condition);
      const multipleUx = await captureMultipleUxPage(
        browser,
        twoWide,
        condition,
      );
      const controls = await captureControlsAndEditing(
        browser,
        wideSmall,
        condition,
      );
      const previousCondition =
        existingResults.investigation?.scrollStructure?.conditions?.[
          condition.id
        ];
      measurements[condition.id] = skipPerformance
        ? {
            ...previousCondition,
            label: condition.label,
            css: cssForCondition(condition),
            style: previousCondition?.style ?? null,
            ux,
            narrowUx,
            multipleUx,
            controls,
          }
        : {
            label: condition.label,
            css: cssForCondition(condition),
            summary: conditionSummary(samples),
            classification: classify(conditionSummary(samples)),
            samples,
            style: samples[0]?.style ?? null,
            ux,
            narrowUx,
            multipleUx,
            controls,
          };
    }

    const position = skipPerformance
      ? (existingResults.investigation?.scrollStructure?.position ?? {})
      : {};
    const fastCondition = allConditions.find(
      (condition) => condition.id === "wrapper-proxy",
    );
    if (fastCondition && !skipPerformance) {
      for (const row of [1, 1000, 2000]) {
        const samples = [];
        for (let index = 0; index < (smoke ? 1 : 3); index += 1)
          samples.push(
            await runInteractionSampleFixed(
              browser,
              stress,
              fastCondition,
              index + 10,
              row,
            ),
          );
        position[`row${row}`] = {
          summary: conditionSummary(samples),
          samples,
        };
      }
    }

    const browserVersion = browser.version();
    const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const result = {
      investigation: {
        scrollStructure: {
          generatedAt: new Date().toISOString(),
          branch: execFileSync("git", ["branch", "--show-current"], {
            cwd: repository,
            encoding: "utf8",
          }).trim(),
          gitCommit,
          environment: {
            browser: "Playwright Chromium headless",
            chromiumVersion: browserVersion,
            viewport: "1280x900",
            sampleCount: smoke ? 1 : sampleCount,
            rawTraceDirectory,
          },
          conditions: measurements,
          position,
          domContractFindings: {
            nodeDOMTableAssumption: true,
            locations: [
              "src/webview/editor.ts:tableTargetAtElement() requires view.nodeDOM(tablePos) === tableElement and tableElement instanceof HTMLTableElement",
              "src/webview/editor.ts:tableTargetForSelection()/tableTargetForStructureSelection() require nodeDOM(tablePos) to be an HTMLTableElement",
              "src/webview/editor.ts:isCurrentTableControlTarget() repeats the nodeDOM equality check",
              "src/webview/editor.ts:updateTableDeletePreviewGeometry()/showTableDeletePreview() treat nodeDOM(tablePos) as the table element",
            ],
            benchmarkNodeViewShape:
              "div.mm-table-scroll > table > tbody (contentDOM)",
          },
          vscodeWebview: {
            status: "not measured",
            reason:
              "This investigation used the Playwright Chromium harness; the wrapper NodeView is benchmark-only and was not installed in the Extension Development Host.",
          },
        },
      },
    };
    const existing = existingResults;
    const previousScrollStructure = existing.investigation?.scrollStructure;
    const mergedScrollStructure = {
      ...previousScrollStructure,
      ...result.investigation.scrollStructure,
      conditions: {
        ...(previousScrollStructure?.conditions ?? {}),
        ...measurements,
      },
      position: {
        ...(previousScrollStructure?.position ?? {}),
        ...position,
      },
    };
    const mergedResult = {
      ...existing,
      ...result,
      investigation: {
        ...(existing.investigation ?? {}),
        scrollStructure: mergedScrollStructure,
      },
    };
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(mergedResult, null, 2)}\n`);
    const lines = [
      "# Issue #119 Scroll Ownership Investigation",
      "",
      `- Commit: \`${gitCommit}\``,
      `- Chromium: \`${browserVersion}\``,
      `- Raw traces: \`${rawTraceDirectory}\` (representative traces are retained there)`,
      "- Product CSS and main were not changed; the wrapper NodeView is benchmark-only.",
      "",
      "## Current baseline and scroll ownership",
      "",
      "The Current condition records the existing table-owned horizontal scroll container. The stage condition is the fast performance baseline and intentionally moves horizontal scrolling to `.mm-stage`.",
      "",
      "| Structure | Local table scroll | Stage scroll | PAC p50 | Click p50 | Full interaction p50 | Controls / UX | Verdict |",
      "|---|---:|---:|---:|---:|---:|---|---|",
    ];
    for (const condition of allConditions) {
      const entry = mergedScrollStructure.conditions[condition.id];
      const ux = entry.ux.ux;
      const localScroll = ["table", "table wrapper", "scroll proxy"].includes(
        ux.scrollOwner,
      );
      const multiple = entry.multipleUx?.ux;
      const controlsVerdict =
        ux.scrollOwner === "scroll proxy"
          ? "proxy not in existing listener set"
          : multiple?.secondTableUnchanged === true
            ? "controls measured; independent scroll pass"
            : "stage/table ownership changes UX";
      lines.push(
        `| ${condition.label} | ${localScroll ? "yes" : "no"} | ${ux.scrollOwner === "stage" ? "yes" : "no"} | ${formatMs(entry.summary.paintArtifactCompositorUpdate)} | ${formatMs(entry.summary.click)} | ${formatMs(entry.summary.fullInteraction)} | ${controlsVerdict} | ${entry.classification} |`,
      );
    }
    lines.push(
      "",
      "## Effective style and geometry verification",
      "",
      "The JSON stores computed style and geometry snapshots for `.mm-stage`, `.mm-rich-panel`, `.ProseMirror`, `.mm-table-scroll`, `table`, `tbody`, target row/cell, and paragraph. It also records all non-visible overflow ancestors and scroll dimensions. Wrapper C1-C3 differ only in wrapper overflow-y; cell padding, border, minimum width, border model, and header styling remain inherited from Current.",
      "",
      "## TableControls and editing",
      "",
      "The benchmark NodeView changes `view.nodeDOM(tablePos)` to the wrapper. The normal TableControls resolver therefore needs a descendant-table adapter; this branch uses a compile-time benchmark-only adapter solely to measure geometry. The existing scroll-container scan detects `.mm-table-scroll`, but it does not detect the proxy because the proxy is a child outside the table's ancestor chain.",
      "",
      "The control geometry, right-edge edit, Tab/Shift+Tab, Markdown/DOM/PM state, and independent-scroll probes are stored under each condition. Wrapper C1-C3 keep a table-local scrollbar but remain intermediate. The proxy is fast and keeps stage.scrollLeft at 0, but its horizontal scroll is not currently in refreshScrollContainers() and the measured column-handle delta grows with proxy scroll; drag auto-scroll is therefore not claimed as passing. A product implementation must explicitly register and sync the proxy before adoption.",
      "",
      "## Position verification",
      "",
    );
    for (const [row, entry] of Object.entries(mergedScrollStructure.position))
      lines.push(
        `- ${row}: click ${formatMs(entry.summary.click)}, PAC ${formatMs(entry.summary.paintArtifactCompositorUpdate)}, full interaction ${formatMs(entry.summary.fullInteraction)}.`,
      );
    lines.push(
      "",
      "## Preview and VS Code",
      "",
      "The preview was not modified by this benchmark-only NodeView/CSS path. VS Code Webview was not measured; do not treat the headless result as a Webview confirmation.",
      "",
      "## Recommended product architecture",
      "",
      "The simple wrapper (`overflow-x:auto` on `.mm-table-scroll`) is not the final architecture: it reduces PAC from about 7316ms to about 1842ms but remains above the 500ms target and keeps row-position sensitivity. The only fast diagnostic structure is a Rich Editor-only non-scroll table viewport plus a small horizontal proxy that translates the table. It preserves stage.scrollLeft=0, right-edge reachability, paragraph stability, independent table owners, and editing in this headless run, but it is not ready for product implementation until proxy-aware Controls and a usable scrollbar placement are designed. Keep Preview DOM/CSS unchanged. The stage-scroll condition remains the simplest fast baseline but changes the current table-local UX.",
      "",
      "## Required product changes",
      "",
      "1. Add a real table NodeView in `src/webview/editor.ts` while preserving PM table nodes, attrs, serialization, and `contentDOM` semantics.",
      "2. Update the table target resolver and delete-preview paths that assume `view.nodeDOM(tablePos)` is an `HTMLTableElement`; resolve the descendant table while retaining the wrapper as the scroll ancestor.",
      "3. Verify `TableControls.refreshScrollContainers()`, `updateLayout()`, and `scheduleAutoScroll()` observe and scroll the wrapper, then add browser/webview tests for 0/50/100% scroll and drag edge scrolling.",
      "4. Add Rich Editor-only CSS and leave `media/document.css` Preview behavior unchanged.",
      "",
      "## Known risks",
      "",
      "- The benchmark NodeView and descendant-table adapter are compile-time benchmark paths only; they are not a product implementation.",
      "- Headless Chromium results are not VS Code Webview measurements.",
      "- C2/C3 computed overflow values must be reviewed from the saved snapshots because CSS overflow coupling can normalize `visible` or `clip`.",
      "- The diagnostic proxy is appended inside the wrapper and currently sits after the table; its scrollbar placement and keyboard/drag affordance require a product UX design.",
      "- The raw traces are temporary files outside git; the JSON retains summary data and paths.",
      "",
    );
    await writeFile(reportPath, `${lines.join("\n")}\n`);
    process.stdout.write(`Wrote ${resultPath}\nWrote ${reportPath}\n`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
