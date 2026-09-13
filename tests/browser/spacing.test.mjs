import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.MM_BROWSER_TEST_PORT ?? "4174");
const baseUrl = `http://127.0.0.1:${port}`;
const tolerance = 0.75;

const fence = (language, source) =>
  [`\u0060\u0060\u0060${language}`, source, "```"].join("\n");
const table = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");
const alert = (kind = "NOTE", body = "Alert body.") =>
  `> [!${kind}]\n> ${body}`;
const details = (body) =>
  ["<details open>", "<summary>Details</summary>", body, "</details>"].join(
    "\n\n",
  );
const blocks = (...values) => values.join("\n\n");
const code = fence("ts", "const value = 1;");
const math = "$$\nx^2\n$$";
const visual = fence("geojson", '{"type":"Point","coordinates":[0,0]}');
const toc = (last) => blocks("# Heading", "[[_TOC_]]", last);
const description = blocks("Term\n: Definition", "After");

const spacingCases = [
  {
    name: "alert-code",
    source: blocks(alert(), code),
    profile: "github",
    types: ["alert", "code"],
  },
  {
    name: "code-alert",
    source: blocks(code, alert("TIP")),
    profile: "github",
    types: ["code", "alert"],
  },
  {
    name: "alert-paragraph",
    source: blocks(alert(), "Paragraph body."),
    profile: "github",
    types: ["alert", "paragraph"],
  },
  {
    name: "paragraph-alert",
    source: blocks("Paragraph body.", alert("TIP")),
    profile: "github",
    types: ["paragraph", "alert"],
  },
  {
    name: "alert-table",
    source: blocks(alert(), table),
    profile: "github",
    types: ["alert", "table"],
  },
  {
    name: "table-alert",
    source: blocks(table, alert("TIP")),
    profile: "github",
    types: ["table", "alert"],
  },
  {
    name: "alert-alert",
    source: blocks(alert(), alert("TIP")),
    profile: "github",
    types: ["alert", "alert"],
  },
  {
    name: "alert-comment-alert",
    source: blocks(alert(), "<!-- preserved comment -->", alert("TIP")),
    profile: "github",
    types: ["alert", "alert"],
  },
  {
    name: "toc-code",
    source: toc(code),
    profile: "gitlab",
    types: ["heading", "toc", "code"],
  },
  {
    name: "code-toc",
    source: blocks("# Heading", code, "[[_TOC_]]"),
    profile: "gitlab",
    types: ["heading", "code", "toc"],
  },
  {
    name: "toc-paragraph",
    source: toc("Paragraph body."),
    profile: "gitlab",
    types: ["heading", "toc", "paragraph"],
  },
  {
    name: "paragraph-toc",
    source: blocks("# Heading", "Paragraph body.", "[[_TOC_]]"),
    profile: "gitlab",
    types: ["heading", "paragraph", "toc"],
  },
  {
    name: "toc-table",
    source: toc(table),
    profile: "gitlab",
    types: ["heading", "toc", "table"],
  },
  {
    name: "table-toc",
    source: blocks("# Heading", table, "[[_TOC_]]"),
    profile: "gitlab",
    types: ["heading", "table", "toc"],
  },
  {
    name: "code-code",
    source: blocks(code, fence("js", "console.log(value);")),
    profile: "github",
    types: ["code", "code"],
  },
  {
    name: "details-code",
    source: blocks(details("Body paragraph."), code),
    profile: "github",
    types: ["details", "code"],
  },
  {
    name: "math-code",
    source: blocks(math, code),
    profile: "github",
    types: ["math", "code"],
  },
  {
    name: "visual-code",
    source: blocks(visual, code),
    profile: "github",
    types: ["visual", "code"],
  },
  {
    name: "table-code",
    source: blocks(table, code),
    profile: "github",
    types: ["table", "code"],
  },
  {
    name: "fallback-paragraph",
    source: blocks(":::custom\nbody\n:::", "After fallback."),
    profile: "github",
    types: ["fallback", "paragraph"],
  },
  {
    name: "image-code",
    source: blocks("![pixel](https://example.com/pixel.png)", code),
    profile: "github",
    types: ["paragraph", "code"],
  },
];

const edgeCases = [
  {
    name: "details-paragraph",
    source: details("Body paragraph."),
    profile: "github",
    types: ["details"],
  },
  {
    name: "details-code-terminal",
    source: details(code),
    profile: "github",
    types: ["details"],
  },
  {
    name: "details-table-terminal",
    source: details(table),
    profile: "github",
    types: ["details"],
  },
  {
    name: "details-nested-terminal",
    source: details(details("Inner paragraph.")),
    profile: "github",
    types: ["details"],
  },
  {
    name: "description",
    source: description,
    profile: "gitlab",
    types: ["description", "paragraph"],
  },
  { name: "math", source: math, profile: "github", types: ["math"] },
  { name: "visual", source: visual, profile: "github", types: ["visual"] },
  {
    name: "fallback",
    source: ":::custom\nbody\n:::",
    profile: "github",
    types: ["fallback"],
  },
  { name: "list", source: "- one\n- two", profile: "github", types: ["list"] },
  {
    name: "ordered",
    source: "1. one\n2. two",
    profile: "github",
    types: ["list"],
  },
  {
    name: "task",
    source: "- [ ] one\n- [x] two",
    profile: "github",
    types: ["task"],
  },
  {
    name: "quote",
    source: "> quote paragraph",
    profile: "github",
    types: ["quote"],
  },
  {
    name: "inline-math",
    source: "Text $x^2$ remains inline.",
    profile: "github",
    types: ["paragraph"],
  },
  {
    name: "comment-first",
    source: blocks("<!-- leading comment -->", "Paragraph body."),
    profile: "github",
    types: ["paragraph"],
  },
  {
    name: "comment-last",
    source: blocks("Paragraph body.", "<!-- trailing comment -->"),
    profile: "github",
    types: ["paragraph"],
  },
  { name: "empty-toc", source: "[[_TOC_]]", profile: "gitlab", types: [] },
];

const specialMargins = {
  alert: { start: 14, end: 14 },
  details: { start: 14, end: 14 },
  toc: { start: 14, end: 14 },
  description: { start: 14, end: 14 },
  code: { start: 0, end: 14 },
  math: { start: 18.9, end: 18.9 },
  visual: { start: 16.8, end: 16.8 },
  fallback: { start: 0, end: 12.88 },
};

function px(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertClose(actual, expected, label, allowed = tolerance) {
  assert.ok(
    Math.abs(actual - expected) <= allowed,
    `${label}: expected ${expected.toFixed(2)}px, got ${actual.toFixed(2)}px`,
  );
}

async function waitForServer(url, child) {
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server may still be binding its test port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Browser harness did not start: ${output}`);
}

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolvePromise) =>
        requestAnimationFrame(() => requestAnimationFrame(resolvePromise)),
      ),
  );
}

async function readMetrics(page, rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const parsePx = (value) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const visible = (element) => {
      if (!element || element.hidden) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const typeOf = (element) => {
      if (element.matches(".markdown-alert")) return "alert";
      if (element.matches("details, .mm-details-node")) return "details";
      if (element.matches(".table-of-contents")) return "toc";
      if (element.matches("dl")) return "description";
      if (element.matches(".mm-code-block")) return "code";
      if (element.matches(".mm-math-block")) return "math";
      if (element.matches(".mm-diagram, .mm-static-asset")) return "visual";
      if (element.matches("pre[data-markdown-raw]")) return "fallback";
      if (element.matches("blockquote")) return "quote";
      if (element.matches("ul, ol"))
        return element.matches(".contains-task-list") ||
          Array.from(element.children).some((child) =>
            child.matches("li.task-list-item, li.mm-task-task"),
          )
          ? "task"
          : "list";
      if (element.matches("table")) return "table";
      if (element.matches("h1, h2, h3, h4, h5, h6")) return "heading";
      if (element.matches("p")) return "paragraph";
      if (element.matches("hr")) return "rule";
      return element.tagName.toLowerCase();
    };
    const displayFor = (host) => {
      if (host.matches(".mm-code-block-view"))
        return host.querySelector(":scope > .mm-code-block");
      if (host.matches(".mm-alert-node-view"))
        return host.querySelector(".markdown-alert");
      if (host.matches(".mm-rendered-node"))
        return host.querySelector(":scope > *") ?? host;
      return host;
    };
    const describe = (host, display) => {
      const hostStyle = getComputedStyle(host);
      const displayStyle = getComputedStyle(display);
      return {
        type: typeOf(display),
        separateDisplay: host !== display,
        host: {
          className: String(host.className),
          rect: host.getBoundingClientRect().toJSON(),
          marginStart: Number.parseFloat(hostStyle.marginBlockStart) || 0,
          marginEnd: Number.parseFloat(hostStyle.marginBlockEnd) || 0,
          first: host.dataset.mmDocumentFirst,
          last: host.dataset.mmDocumentLast,
          blockMargin: host.dataset.mmBlockMargin,
          empty: host.dataset.mmRenderedEmpty,
        },
        display: {
          className: String(display.className),
          rect: display.getBoundingClientRect().toJSON(),
          marginStart: Number.parseFloat(displayStyle.marginBlockStart) || 0,
          marginEnd: Number.parseFloat(displayStyle.marginBlockEnd) || 0,
        },
      };
    };
    const hosts = Array.from(root?.children ?? []);
    const blocks = hosts
      .map((host) => ({ host, display: displayFor(host) }))
      .filter(
        ({ host, display }) =>
          host.dataset.mmRenderedEmpty !== "true" && visible(display),
      )
      .map(({ host, display }) => describe(host, display));
    const containers = Array.from(
      root?.querySelectorAll(
        "details, .mm-details-node, .markdown-alert, blockquote",
      ) ?? [],
    ).map((container) => {
      const children = Array.from(container.children).filter(visible);
      const structuredDetails = container.matches(".mm-details-node");
      const isDetails = structuredDetails || container.matches("details");
      const summary = isDetails
        ? container.querySelector(
            ":scope > summary, :scope > .mm-details-header",
          )
        : null;
      const body = structuredDetails
        ? container.querySelector(":scope > .mm-details-body")
        : null;
      const bodyChildren = structuredDetails
        ? visible(body)
          ? Array.from(body.children).filter(visible)
          : []
        : children.filter((child) => child !== summary);
      const last = bodyChildren.at(-1);
      const style = getComputedStyle(container);
      return {
        kind: isDetails
          ? "details"
          : container.matches(".markdown-alert")
            ? "alert"
            : "quote",
        paddingBottom: parsePx(style.paddingBottom),
        borderBottom: parsePx(style.borderBottomWidth),
        bottomGap: last
          ? container.getBoundingClientRect().bottom -
            last.getBoundingClientRect().bottom
          : null,
        lastMarginBottom: last
          ? parsePx(getComputedStyle(last).marginBlockEnd)
          : null,
        summaryBodyGap:
          summary && bodyChildren[0]
            ? bodyChildren[0].getBoundingClientRect().top -
              summary.getBoundingClientRect().bottom
            : null,
        bodyCount: bodyChildren.length,
      };
    });
    return {
      root: root?.getBoundingClientRect().toJSON(),
      blocks,
      emptyHosts: hosts
        .filter((host) => host.dataset.mmRenderedEmpty === "true")
        .map((host) => ({
          className: String(host.className),
          hidden: host.hidden,
          rect: host.getBoundingClientRect().toJSON(),
          marginStart: parsePx(getComputedStyle(host).marginBlockStart),
          marginEnd: parsePx(getComputedStyle(host).marginBlockEnd),
          blockMargin: host.dataset.mmBlockMargin,
        })),
      containers,
      inlineMath: root?.querySelectorAll(".mm-math-inline").length ?? 0,
      overflow: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
    };
  }, rootSelector);
}

function assertBlockMargins(metrics, testCase, mode) {
  for (const [index, block] of metrics.blocks.entries()) {
    const expected =
      block.type === "alert" &&
      mode === "rich" &&
      testCase.name === "alert-alert" &&
      index > 0
        ? { ...specialMargins.alert, start: 10.5 }
        : specialMargins[block.type];
    if (!expected) continue;
    if (index > 0) {
      assertClose(
        block.host.marginStart,
        expected.start,
        `${testCase.name} ${mode} ${block.type} start margin`,
      );
    }
    if (index < metrics.blocks.length - 1) {
      assertClose(
        block.host.marginEnd,
        expected.end,
        `${testCase.name} ${mode} ${block.type} end margin`,
      );
    }
    if (mode === "rich" && block.separateDisplay) {
      assertClose(
        block.display.marginStart,
        0,
        `${testCase.name} rich ${block.type} inner start margin`,
      );
      assertClose(
        block.display.marginEnd,
        0,
        `${testCase.name} rich ${block.type} inner end margin`,
      );
    }
  }
}

function assertLayout(metrics, testCase, mode) {
  assert.deepEqual(
    metrics.blocks.map((block) => block.type),
    testCase.types,
    `${testCase.name} ${mode} block order`,
  );
  for (let index = 1; index < metrics.blocks.length; index += 1) {
    const previous = metrics.blocks[index - 1];
    const current = metrics.blocks[index];
    const actual = current.host.rect.top - previous.host.rect.bottom;
    const expected = Math.max(
      previous.host.marginEnd,
      current.host.marginStart,
    );
    assertClose(
      actual,
      expected,
      `${testCase.name} ${mode} ${previous.type}->${current.type} gap`,
    );
  }
  if (metrics.blocks.length > 0) {
    assertClose(
      metrics.blocks[0].host.marginStart,
      0,
      `${testCase.name} ${mode} first block margin`,
    );
    assertClose(
      metrics.blocks.at(-1).host.marginEnd,
      0,
      `${testCase.name} ${mode} last block margin`,
    );
  }
  assertBlockMargins(metrics, testCase, mode);
  for (const container of metrics.containers) {
    if (container.bodyCount === 0) continue;
    assertClose(
      container.lastMarginBottom,
      0,
      `${testCase.name} ${mode} ${container.kind} terminal child margin`,
    );
    assertClose(
      container.bottomGap,
      container.paddingBottom + container.borderBottom,
      `${testCase.name} ${mode} ${container.kind} terminal padding`,
      1.25,
    );
    if (container.kind === "details" && container.summaryBodyGap != null)
      assert.ok(
        container.summaryBodyGap > 0,
        `${testCase.name} ${mode} details summary/body gap disappeared`,
      );
  }
  if (testCase.name === "inline-math")
    assert.equal(metrics.inlineMath, 1, `${mode} inline math became a block`);
  if (testCase.name === "empty-toc") {
    assert.equal(
      metrics.blocks.length,
      0,
      `${mode} empty TOC rendered a block`,
    );
    for (const emptyHost of metrics.emptyHosts) {
      assert.equal(
        emptyHost.hidden,
        true,
        `${mode} empty TOC host was not hidden`,
      );
      assertClose(emptyHost.rect.width, 0, `${mode} empty TOC host width`);
      assertClose(emptyHost.rect.height, 0, `${mode} empty TOC host height`);
      assertClose(
        emptyHost.marginStart,
        0,
        `${mode} empty TOC host start margin`,
      );
      assertClose(emptyHost.marginEnd, 0, `${mode} empty TOC host end margin`);
      assert.equal(
        emptyHost.blockMargin,
        undefined,
        `${mode} empty TOC kept block margin metadata`,
      );
    }
  }
}

async function deliver(page, source, profile) {
  await page.evaluate(
    ([markdown, nextProfile]) =>
      window.__markdownMintHarness.deliverExternal(markdown, nextProfile),
    [source, profile],
  );
  await page.waitForFunction(
    (markdown) => window.__markdownMintHarness.document.markdown === markdown,
    source,
  );
  await settle(page);
}

async function loadRich(page) {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".mm-rich-panel .ProseMirror");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".mm-rich-panel .ProseMirror")
        .getBoundingClientRect().width > 0,
  );
}

async function loadPreview(page) {
  await page.goto(`${baseUrl}/?mode=preview`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(".mm-preview-panel .markdown-body");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".mm-preview-panel .markdown-body")
        .getBoundingClientRect().width > 0,
  );
}

async function readParagraphGeometry(page, rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    return Array.from(root?.children ?? [])
      .filter((child) => child.matches("p"))
      .map((paragraph) => ({
        text: paragraph.textContent ?? "",
        rect: paragraph.getBoundingClientRect().toJSON(),
        lineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
      }));
  }, rootSelector);
}

function assertMaterializedBlankGeometry(geometry, mode) {
  assert.equal(geometry.length, 3, `${mode} paragraph count`);
  assert.deepEqual(
    geometry.map((paragraph) => paragraph.text),
    ["one", "", "two"],
    `${mode} paragraph content`,
  );
  const contentHeight = geometry[0].rect.height;
  const blankHeight = geometry[1].rect.height;
  assert.ok(blankHeight > 0, `${mode} empty paragraph has no height`);
  assertClose(blankHeight, contentHeight, `${mode} empty paragraph height`);
  assertClose(
    blankHeight,
    geometry[1].lineHeight,
    `${mode} empty paragraph line height`,
  );
}

async function testMaterializedBlankGeometry(page) {
  const source = "one\n\n\ntwo";
  await loadRich(page);
  await deliver(page, source, "github");
  const rich = await readParagraphGeometry(page, ".mm-rich-panel .ProseMirror");
  assertMaterializedBlankGeometry(rich, "rich");

  await loadPreview(page);
  await deliver(page, source, "github");
  const preview = await readParagraphGeometry(
    page,
    ".mm-preview-panel .markdown-body",
  );
  assertMaterializedBlankGeometry(preview, "dedicated preview");

  await page.goto(
    `${baseUrl}/native.html?fixture=spacing&case=materialized-blank`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForSelector('[data-testid="native-content"]');
  await settle(page);
  const native = await readParagraphGeometry(
    page,
    '[data-testid="native-content"]',
  );
  assertMaterializedBlankGeometry(native, "native preview");

  for (const [mode, geometry] of [
    ["dedicated preview", preview],
    ["native preview", native],
  ]) {
    assertClose(
      geometry[1].rect.height,
      rich[1].rect.height,
      `${mode} and rich empty paragraph height`,
    );
  }
}

async function testSurface(page, mode, testCases) {
  const rootSelector =
    mode === "rich"
      ? ".mm-rich-panel .ProseMirror"
      : ".mm-preview-panel .markdown-body";
  for (const testCase of testCases) {
    await deliver(page, testCase.source, testCase.profile);
    const metrics = await readMetrics(page, rootSelector);
    assertLayout(metrics, testCase, mode);
  }
}

async function testStaleRenderedMetadata(page) {
  await deliver(page, toc("After"), "gitlab");
  let metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  const tocHost = metrics.blocks.find((block) => block.type === "toc");
  assert.equal(tocHost.host.blockMargin, "flow");
  await deliver(page, "[[_TOC_]]", "gitlab");
  metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  assert.equal(metrics.blocks.length, 0);
  assert.equal(metrics.emptyHosts.length, 1);
  assert.equal(metrics.emptyHosts[0].hidden, true);
  assert.equal(metrics.emptyHosts[0].blockMargin, undefined);
  await deliver(page, math, "github");
  metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  assert.equal(metrics.blocks[0].type, "math");
  assert.equal(metrics.blocks[0].host.blockMargin, "math");
  await deliver(page, ":::custom\nbody\n:::", "github");
  metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  assert.equal(metrics.blocks[0].type, "fallback");
  assert.equal(metrics.blocks[0].host.blockMargin, "fallback");
}

async function testCodeControls(page) {
  const source = blocks(code, "Paragraph after code.");
  await deliver(page, source, "github");
  const codeSelector =
    '.mm-rich-panel .mm-code-block [data-mm-code-action="expand"]';
  await page.locator(codeSelector).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".mm-rich-panel .mm-code-block")
      .classList.contains("mm-code-block-expanded"),
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      !document
        .querySelector(".mm-rich-panel .mm-code-block")
        .classList.contains("mm-code-block-expanded"),
  );
  const moreSelector =
    '.mm-rich-panel .mm-code-block [data-mm-code-action="more"]';
  await page.locator(moreSelector).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".mm-rich-panel .mm-code-menu:not([hidden])") !==
      null,
  );
  await page
    .locator('.mm-rich-panel [data-mm-code-menu-option="wrap"]')
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(
        '.mm-rich-panel [data-mm-code-menu-option="wrap"][aria-checked="true"]',
      ) !== null,
  );
  await page.locator(moreSelector).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".mm-rich-panel .mm-code-menu[hidden]") !== null,
  );
  const metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  assertLayout(
    metrics,
    { name: "code-controls", types: ["code", "paragraph"] },
    "rich",
  );
}

async function testMermaidAndTypography(page) {
  await deliver(
    page,
    blocks(fence("mermaid", "flowchart LR\n  A --> B"), code),
    "github",
  );
  await page.waitForFunction(
    () => {
      const diagram = document.querySelector(".mm-rich-panel .mm-mermaid");
      return diagram && diagram.dataset.mmMermaidState !== "pending";
    },
    undefined,
    { timeout: 10000 },
  );
  let metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  assert.deepEqual(
    metrics.blocks.map((block) => block.type),
    ["visual", "code"],
  );
  assertClose(metrics.blocks[0].host.marginEnd, 16.8, "Mermaid visual margin");

  await page.setViewportSize({ width: 360, height: 900 });
  await deliver(page, blocks(alert(), code, table), "github");
  metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  assertClose(
    metrics.blocks[1].host.rect.top - metrics.blocks[0].host.rect.bottom,
    14,
    "narrow alert/code gap",
  );
  assert.ok(
    metrics.overflow.scrollWidth <= metrics.overflow.clientWidth + 1,
    `narrow viewport overflow: ${metrics.overflow.scrollWidth}px > ${metrics.overflow.clientWidth}px`,
  );

  await page.setViewportSize({ width: 960, height: 900 });
  await page.evaluate(() => {
    for (const selector of [
      ".mm-rich-panel .ProseMirror",
      ".mm-preview-panel .markdown-body",
    ])
      document
        .querySelector(selector)
        ?.style.setProperty("--markdown-font-size", "28px");
  });
  await deliver(page, blocks(alert(), code), "github");
  metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  assertClose(
    metrics.blocks[1].host.rect.top - metrics.blocks[0].host.rect.bottom,
    28,
    "28px alert/code gap",
  );
  await page.evaluate(() => {
    for (const selector of [
      ".mm-rich-panel .ProseMirror",
      ".mm-preview-panel .markdown-body",
    ])
      document
        .querySelector(selector)
        ?.style.removeProperty("--markdown-font-size");
  });
}

async function testFallbackAndPreservedInlineContent(page) {
  const oversizedMath = `$$\n${"x".repeat(250001)}\n$$`;
  await deliver(page, blocks(oversizedMath, code), "github");
  await page.waitForSelector(".mm-rich-panel .mm-math-fallback");
  let metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  assert.deepEqual(
    metrics.blocks.map((block) => block.type),
    ["math", "code"],
    "math fallback block order",
  );
  assert.equal(
    await page.locator(".mm-rich-panel .mm-math-fallback").count(),
    1,
  );
  assertClose(metrics.blocks[0].host.marginEnd, 18.9, "math fallback margin");

  await deliver(
    page,
    blocks(fence("mermaid", "this is not a valid Mermaid diagram"), code),
    "github",
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".mm-rich-panel .mm-mermaid")?.dataset
        .mmMermaidState === "failed",
    undefined,
    { timeout: 10000 },
  );
  const mermaidSource = await page.locator(
    ".mm-rich-panel .mm-mermaid .mm-diagram-source",
  );
  assert.ok(
    (await mermaidSource.textContent()).includes("not a valid Mermaid"),
    "Mermaid fallback lost the original source",
  );
  metrics = await readMetrics(page, ".mm-rich-panel .ProseMirror");
  assert.deepEqual(
    metrics.blocks.map((block) => block.type),
    ["visual", "code"],
    "Mermaid fallback block order",
  );
  assertClose(
    metrics.blocks[0].host.marginEnd,
    16.8,
    "Mermaid fallback margin",
  );

  const source =
    "Inline $x^2$ with ![pixel](https://example.com/pixel.png)[^note].\n\n" +
    "[^note]: Footnote body.";
  await deliver(page, source, "github");
  await page.waitForSelector(".mm-rich-footnotes .footnotes");
  const inlineContent = await page.evaluate(() => ({
    inlineMath: document.querySelectorAll(".mm-rich-panel .mm-math-inline")
      .length,
    images: document.querySelectorAll(".mm-rich-panel .ProseMirror img").length,
    footnotes: document.querySelector(".mm-rich-footnotes")?.textContent ?? "",
  }));
  assert.equal(inlineContent.inlineMath, 1, "inline math became a block");
  assert.equal(inlineContent.images, 1, "inline image was not preserved");
  assert.ok(
    inlineContent.footnotes.includes("Footnote body"),
    "footnote rendering disappeared",
  );
}

async function setTheme(page, theme) {
  const themes = {
    light: {
      "--vscode-editor-background": "#ffffff",
      "--vscode-foreground": "#1f2328",
      "--vscode-editor-foreground": "#1f2328",
      "--vscode-textCodeBlock-background": "#f6f8fa",
      "--vscode-textLink-foreground": "#0969da",
      "--vscode-textSeparator-foreground": "rgba(31,35,40,.2)",
      "--vscode-descriptionForeground": "#59636e",
      "--vscode-widget-border": "rgba(31,35,40,.25)",
    },
    dark: {
      "--vscode-editor-background": "#1e1e1e",
      "--vscode-foreground": "#d4d4d4",
      "--vscode-editor-foreground": "#d4d4d4",
      "--vscode-textCodeBlock-background": "#181818",
      "--vscode-textLink-foreground": "#3794ff",
      "--vscode-descriptionForeground": "#9d9d9d",
      "--vscode-widget-border": "rgba(127,127,127,.45)",
    },
    contrast: {
      "--vscode-editor-background": "#000000",
      "--vscode-foreground": "#ffffff",
      "--vscode-editor-foreground": "#ffffff",
      "--vscode-textCodeBlock-background": "#000000",
      "--vscode-textLink-foreground": "#00ffff",
      "--vscode-textSeparator-foreground": "#ffffff",
      "--vscode-descriptionForeground": "#ffffff",
      "--vscode-widget-border": "#ffffff",
    },
  };
  await page.emulateMedia({
    colorScheme: theme === "light" ? "light" : "dark",
    forcedColors: theme === "contrast" ? "active" : "none",
  });
  await page.evaluate((variables) => {
    for (const [name, value] of Object.entries(variables))
      document.documentElement.style.setProperty(name, value);
    document.documentElement.classList.toggle(
      "vscode-high-contrast",
      variables["--vscode-editor-background"] === "#000000" &&
        variables["--vscode-foreground"] === "#ffffff",
    );
    document.body.style.backgroundColor =
      variables["--vscode-editor-background"];
    document.body.style.color = variables["--vscode-foreground"];
  }, themes[theme]);
  await settle(page);
}

async function testScreenshots(page) {
  await page.setViewportSize({ width: 960, height: 1000 });
  await deliver(
    page,
    blocks(
      "# Spacing fixture",
      alert(),
      code,
      details("Body paragraph."),
      math,
      visual,
      table,
    ),
    "github",
  );
  const output = resolve(repository, "output/playwright");
  await mkdir(output, { recursive: true });
  for (const theme of ["light", "dark", "contrast"]) {
    await setTheme(page, theme);
    await page.screenshot({
      path: resolve(output, `spacing-${theme}.png`),
      fullPage: true,
    });
  }
  await setTheme(page, "dark");
}

async function testNativeSurface(page, testCases) {
  for (const testCase of [...testCases, ...edgeCases]) {
    await page.goto(
      `${baseUrl}/native.html?fixture=spacing&case=${encodeURIComponent(testCase.name)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForSelector('[data-testid="native-content"]');
    await settle(page);
    const metrics = await readMetrics(page, '[data-testid="native-content"]');
    assertLayout(metrics, testCase, "native");
  }
}

async function main() {
  const server = spawn(process.execPath, ["tests/browser/server.mjs"], {
    cwd: repository,
    env: { ...process.env, MM_BROWSER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer(`${baseUrl}/`, server);
    const executablePath =
      process.env.MM_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
    if (!existsSync(executablePath))
      throw new Error(
        `Playwright browser executable is missing: ${executablePath}. Set MM_BROWSER_EXECUTABLE_PATH or run npx playwright install chromium.`,
      );
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({
      viewport: { width: 960, height: 900 },
      deviceScaleFactor: 1,
    });

    await testMaterializedBlankGeometry(page);
    await loadRich(page);
    await testSurface(page, "rich", [...spacingCases, ...edgeCases]);
    await testStaleRenderedMetadata(page);
    await testCodeControls(page);
    await testMermaidAndTypography(page);
    await testFallbackAndPreservedInlineContent(page);
    await loadRich(page);
    await testScreenshots(page);

    await loadPreview(page);
    await testSurface(page, "preview", [...spacingCases, ...edgeCases]);

    await page.setViewportSize({ width: 960, height: 900 });
    await testNativeSurface(page, spacingCases);
    console.log(
      `Browser spacing checks passed: ${spacingCases.length + edgeCases.length} rich/preview cases and ${spacingCases.length + edgeCases.length} native cases.`,
    );
    console.log(
      "Screenshots: output/playwright/spacing-{light,dark,contrast}.png",
    );
  } finally {
    await browser?.close();
    server.kill("SIGINT");
  }
}

await main();
