import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const expectedPath = resolve(repository, "docs/demo/full-document-expected.md");
const serverPath = resolve(repository, "tests/browser/server.mjs");

const envNumber = (name, fallback, minimum = 0) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
};

const timing = {
  typeMs: envNumber("MM_DEMO_TYPE_MS", 20),
  stepMs: envNumber("MM_DEMO_STEP_MS", 500),
  sectionMs: envNumber("MM_DEMO_SECTION_MS", 900),
  finalHoldMs: envNumber("MM_DEMO_FINAL_HOLD_MS", 3000),
  slowMo: envNumber("MM_DEMO_SLOWMO", 40),
};
const port = Math.trunc(envNumber("MM_DEMO_PORT", 4176, 1024));
const baseUrl = `http://127.0.0.1:${port}`;
const unsupportedFeatures = [];
const bugs = [];

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function waitForServer(url) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`Browser server did not become ready: ${lastError ?? url}`);
}

function startServer() {
  const server = spawn(process.execPath, [serverPath], {
    cwd: repository,
    env: { ...process.env, MM_BROWSER_PORT: String(port) },
    stdio: "inherit",
  });
  const failed = new Promise((_, reject) => {
    server.once("error", reject);
    server.once("exit", (code, signal) => {
      if (code !== null && code !== 0)
        reject(new Error(`Browser server exited with code ${code}`));
      else if (signal)
        reject(new Error(`Browser server exited with ${signal}`));
    });
  });
  return { server, failed };
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      server.kill("SIGTERM");
      resolveStop();
    }, 2000);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    server.kill("SIGINT");
  });
}

async function waitForVisible(locator, description) {
  await locator.waitFor({ state: "visible" });
  assert.ok(await locator.isVisible(), `${description} is not visible`);
}

async function waitForRich(page) {
  await page.waitForFunction(
    () =>
      document.body.dataset.markdownMintMode === "editor" &&
      Boolean(window.markdownMint?.view),
  );
  await page.locator(".mm-rich-panel .ProseMirror").waitFor({
    state: "visible",
  });
}

async function pause(ms = timing.stepMs) {
  await wait(ms);
}

async function typeText(page, text) {
  await page.keyboard.type(text, { delay: timing.typeMs });
}

async function waitForDocumentText(page, text) {
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll(".mm-rich-panel .ProseMirror")).some(
        (editor) => editor.textContent?.includes(expected),
      ),
    text,
  );
}

async function focusEditor(page) {
  await page.locator(".mm-rich-panel .ProseMirror").focus();
}

async function selectionIsEmptyParagraph(page) {
  return page.evaluate(() => {
    const selection = window.markdownMint?.view?.state.selection;
    return Boolean(
      selection?.empty &&
      selection.$from?.parent?.type?.name === "paragraph" &&
      selection.$from.parent.content.size === 0,
    );
  });
}

async function waitForEmptyParagraph(page) {
  await page.waitForFunction(() => {
    const selection = window.markdownMint?.view?.state.selection;
    return Boolean(
      selection?.empty &&
      selection.$from?.parent?.type?.name === "paragraph" &&
      selection.$from.parent.content.size === 0,
    );
  });
}

async function prepareParagraph(page) {
  const state = await page.evaluate(() => {
    const selection = window.markdownMint?.view?.state.selection;
    return {
      kind: selection?.constructor?.name,
      parent: selection?.$from?.parent?.type?.name,
      empty: selection?.empty,
      parentOffset: selection?.$from?.parentOffset,
      parentSize: selection?.$from?.parent?.content?.size,
    };
  });
  if (state.parent === "code_block") {
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () =>
        !Array.from(
          document.querySelectorAll(".mm-rich-panel .mm-code-block"),
        ).some((block) => block.classList.contains("mm-code-block-expanded")),
    );
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(
      () =>
        window.markdownMint?.view?.state.selection?.constructor?.name ===
        "_BlockBoundarySelection",
    );
  }
  if (state.empty === false && state.parent !== "code_block")
    await page.keyboard.press("Control+e");
  if (!(await selectionIsEmptyParagraph(page))) {
    await page.keyboard.press("Enter");
    await waitForEmptyParagraph(page);
  }
}

async function newParagraph(page) {
  await focusEditor(page);
  await prepareParagraph(page);
}

async function selectHeadingLevel(page, level) {
  const select = page.locator(".mm-heading-select");
  await select.selectOption(String(level));
  await page.waitForFunction((expectedLevel) => {
    const selection = window.markdownMint?.view?.state.selection;
    return (
      selection?.$from?.parent?.type?.name === "heading" &&
      selection.$from.parent.attrs.level === Number(expectedLevel)
    );
  }, level);
}

async function insertHeading(page, level, text, { starter = false } = {}) {
  if (!starter) await newParagraph(page);
  if (starter) await page.locator(".mm-heading-select").selectOption("p");
  await selectHeadingLevel(page, level);
  await focusEditor(page);
  await typeText(page, text);
  await page.waitForFunction(
    ({ expectedLevel, expectedText }) =>
      Array.from(
        document.querySelectorAll(
          `.mm-rich-panel .ProseMirror h${expectedLevel}`,
        ),
      ).some((heading) => heading.textContent === expectedText),
    { expectedLevel: level, expectedText: text },
  );
  await pause();
}

async function paragraph(page, text) {
  await newParagraph(page);
  await typeText(page, text);
  await waitForDocumentText(page, text);
}

async function rangeForText(locator, text) {
  return locator.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.nodeValue?.indexOf(needle) ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      const rects = Array.from(range.getClientRects());
      const first = rects[0];
      const last = rects.at(-1) ?? first;
      if (!first || !last) return null;
      return {
        start: { x: first.left + 0.5, y: first.top + first.height / 2 },
        end: { x: last.right - 0.5, y: last.top + last.height / 2 },
      };
    }
    return null;
  }, text);
}

async function selectVisibleText(page, text, scope) {
  const target =
    scope ??
    page
      .locator(".mm-rich-panel .ProseMirror p")
      .filter({ hasText: text })
      .first();
  await target.scrollIntoViewIfNeeded();
  const range = await rangeForText(target, text);
  assert.ok(range, `Could not find visible text: ${text}`);
  await page.mouse.move(range.start.x, range.start.y);
  await page.mouse.down();
  await page.mouse.move(range.end.x, range.end.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((expected) => {
    const selection = window.markdownMint?.view?.state.selection;
    if (!selection || selection.empty) return false;
    return (
      selection.content().size > 0 &&
      window.markdownMint.view.state.doc.textBetween(
        selection.from,
        selection.to,
        "\n",
      ) === expected
    );
  }, text);
}

async function applySelectionToolbar(page, label) {
  const accessibleLabel = label === "Strikethrough" ? "Strike" : label;
  const button = page.getByRole("button", {
    name: `${accessibleLabel} selection`,
    exact: true,
  });
  await waitForVisible(button, `${label} selection button`);
  await button.click();
  await pause();
}

async function formatRange(page, text, label) {
  await selectVisibleText(page, text);
  await applySelectionToolbar(page, label);
}

async function openSlashMenu(page) {
  await prepareParagraph(page);
  await focusEditor(page);
  await page.keyboard.type("/");
  const menu = page.locator(".mm-empty-line-popup");
  await waitForVisible(menu, "Insert popup");
  return menu;
}

async function chooseInsertCommand(page, label) {
  const menu = await openSlashMenu(page);
  const items = menu.locator('[role="menuitem"]:not([hidden])');
  const target = menu.getByRole("menuitem", { name: label, exact: true });
  await target.waitFor({ state: "visible" });
  const targetLabel = await target.getAttribute("aria-label");
  const labels = await items.evaluateAll((elements) =>
    elements
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          !element.hasAttribute("disabled") &&
          !element.hidden &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      })
      .map(
        (element) =>
          element.getAttribute("aria-label") ?? element.textContent?.trim(),
      ),
  );
  const targetIndex = labels.findIndex(
    (item) => item === targetLabel || item === label,
  );
  assert.ok(
    targetIndex >= 0,
    `Insert command is not keyboard reachable: ${label}`,
  );
  await page.waitForFunction(
    (expected) =>
      document.activeElement?.getAttribute("aria-label") === expected,
    labels[0],
  );
  for (let index = 0; index < targetIndex; index += 1)
    await page.keyboard.press("Tab");
  await page.waitForFunction(
    (expected) =>
      document.activeElement?.getAttribute("aria-label") === expected,
    targetLabel,
  );
  await page.keyboard.press("Enter");
  await pause();
}

async function insertAlert(page, type, body) {
  await chooseInsertCommand(page, "Alert");
  const dialog = page.locator(".mm-profile-feature-dialog[open]");
  await waitForVisible(dialog, "Alert dialog");
  await dialog.locator('[data-feature-field="alert-type"]').selectOption(type);
  await dialog.locator('[data-feature-field="body"]').fill(body);
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await page.waitForFunction(
    (expectedBody) =>
      Array.from(document.querySelectorAll(".mm-alert-node-view")).some(
        (node) =>
          node.textContent?.includes(expectedBody) ||
          node.querySelector("textarea")?.value.includes(expectedBody),
      ),
    body,
  );
  await pause();
}

async function insertTable(page, rows, columns, values) {
  await chooseInsertCommand(page, "Insert table");
  const dialog = page.locator(".mm-table-dialog[open]");
  await waitForVisible(dialog, "Table dialog");
  const cell = dialog.getByRole("gridcell", {
    name: `${columns} columns by ${rows} rows`,
    exact: true,
  });
  await cell.click();
  await dialog
    .getByRole("button", { name: "Insert table", exact: true })
    .click();
  await page.waitForFunction(
    ({ expectedRows, expectedColumns }) => {
      const tables = document.querySelectorAll(
        ".mm-rich-panel .ProseMirror table",
      );
      const table = tables[tables.length - 1];
      return (
        table?.querySelectorAll("tr").length === expectedRows &&
        table?.querySelector("tr")?.children.length === expectedColumns
      );
    },
    { expectedRows: rows, expectedColumns: columns },
  );
  const table = page.locator(".mm-rich-panel .ProseMirror table").last();
  await table.locator("th,td").first().click();
  for (let row = 0; row < values.length; row += 1) {
    for (let column = 0; column < values[row].length; column += 1) {
      await typeText(page, values[row][column]);
      if (row !== values.length - 1 || column !== values[row].length - 1)
        await page.keyboard.press("Tab");
    }
  }
  await page.waitForFunction((expectedValues) => {
    const tables = document.querySelectorAll(
      ".mm-rich-panel .ProseMirror table",
    );
    const table = tables[tables.length - 1];
    const cells = Array.from(table?.querySelectorAll("th,td") ?? []).map(
      (cell) => cell.textContent ?? "",
    );
    return JSON.stringify(cells) === JSON.stringify(expectedValues.flat());
  }, values);
  await pause();
}

async function setTableColumnAlignment(
  page,
  columnIndex,
  action,
  expectedAlign,
) {
  const table = page.locator(".mm-rich-panel .ProseMirror table").last();
  await table.locator("tr").first().locator("th,td").nth(columnIndex).click();
  const button = page.locator(`.mm-table-toolbar [data-action="${action}"]`);
  await waitForVisible(button, `Table ${action} control`);
  await button.click();
  await page.waitForFunction(
    ({ expectedColumn, expectedValue }) => {
      const tables = document.querySelectorAll(
        ".mm-rich-panel .ProseMirror table",
      );
      const table = tables[tables.length - 1];
      const cell = table?.querySelector("tr")?.children[expectedColumn];
      return (
        cell instanceof HTMLElement &&
        getComputedStyle(cell).textAlign === expectedValue
      );
    },
    { expectedColumn: columnIndex, expectedValue: expectedAlign },
  );
  await pause();
}

async function exitTable(page) {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const selection = window.markdownMint?.view?.state.selection;
    if (!selection?.$from) return false;
    for (let depth = selection.$from.depth; depth > 0; depth -= 1)
      if (selection.$from.node(depth).type.spec.tableRole) return false;
    return true;
  });
}

async function insertMermaid(page, source) {
  await chooseInsertCommand(page, "Mermaid diagram");
  const dialog = page.locator(".mm-profile-feature-dialog[open]");
  await waitForVisible(dialog, "Mermaid dialog");
  const body = dialog.locator('[data-feature-field="body"]');
  await body.fill(source);
  const status = dialog.locator(".mm-mermaid-validation-status");
  await page.waitForFunction(
    () =>
      document.querySelector(".mm-mermaid-validation-status")?.dataset
        .validationState === "valid",
  );
  assert.equal(await status.getAttribute("data-validation-state"), "valid");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[data-mm-mermaid="true"]')).some(
      (node) =>
        node.getAttribute("data-mm-mermaid-state") === "rendered" &&
        node.querySelector("svg"),
    ),
  );
  await pause();
}

async function insertMath(page, expression) {
  await chooseInsertCommand(page, "Math");
  const dialog = page.locator(".mm-profile-feature-dialog[open]");
  await waitForVisible(dialog, "Math dialog");
  await dialog.locator('[data-feature-field="body"]').fill(expression);
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await page.waitForFunction(() =>
    Boolean(document.querySelector(".mm-rich-panel .mm-math-block")),
  );
  await pause();
}

async function insertCodeBlock(page, language, lines) {
  await chooseInsertCommand(page, "Code block");
  const codeBlock = page.locator(".mm-rich-panel .mm-code-block").last();
  await codeBlock.waitFor({ state: "visible" });
  const languageTrigger = codeBlock.locator(".mm-code-language-trigger");
  await languageTrigger.click();
  const input = codeBlock.locator(".mm-code-language-inline");
  await input.fill(language);
  const option = codeBlock.locator('[data-mm-language-option="typescript"]');
  await option.waitFor({ state: "visible" });
  await input.press("Enter");
  await page.waitForFunction(
    ({ expectedLanguage }) => {
      const blocks = document.querySelectorAll(".mm-rich-panel .mm-code-block");
      return (
        blocks[blocks.length - 1]?.dataset.mmCodeLanguage === expectedLanguage
      );
    },
    { expectedLanguage: language },
  );
  await codeBlock.locator(".mm-code-block-pre code").click();
  for (let index = 0; index < lines.length; index += 1) {
    await typeText(page, lines[index]);
    if (index < lines.length - 1) await page.keyboard.press("Enter");
  }
  await page.waitForFunction(
    ({ expectedText, expectedLanguage }) => {
      const blocks = document.querySelectorAll(".mm-rich-panel .mm-code-block");
      const block = blocks[blocks.length - 1];
      const code = block?.querySelector(".mm-code-block-pre code");
      return (
        block?.dataset.mmCodeLanguage === expectedLanguage &&
        code?.textContent === expectedText &&
        Boolean(code?.querySelector("span"))
      );
    },
    { expectedText: lines.join("\n"), expectedLanguage: language },
  );
  await pause();
}

async function insertDetails(page, summary, bodyLines) {
  await chooseInsertCommand(page, "Details");
  const dialog = page.locator(".mm-profile-feature-dialog[open]");
  await waitForVisible(dialog, "Details dialog");
  await dialog.locator('[data-feature-field="title"]').fill(summary);
  await dialog
    .locator('[data-feature-field="body"]')
    .fill(bodyLines.join("\n"));
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  const details = page.locator(".mm-rich-panel .mm-details-node").last();
  await details.waitFor({ state: "visible" });
  await page.waitForFunction((expected) => {
    const nodes = document.querySelectorAll(".mm-rich-panel .mm-details-node");
    return (
      nodes[nodes.length - 1]?.querySelector(".mm-details-summary")
        ?.textContent === expected
    );
  }, summary);
  const toggle = details.locator(
    ":scope > .mm-details-header > .mm-details-toggle",
  );
  let detailsToggleVerified = false;
  try {
    await toggle.click();
    await page.waitForFunction(
      () => {
        const nodes = document.querySelectorAll(
          ".mm-rich-panel .mm-details-node",
        );
        return nodes[nodes.length - 1]?.dataset.mmDetailsOpen === "false";
      },
      undefined,
      { timeout: 5000 },
    );
    assert.equal(await details.locator(".mm-details-body").isVisible(), false);
    await toggle.click();
    await page.waitForFunction(
      () => {
        const nodes = document.querySelectorAll(
          ".mm-rich-panel .mm-details-node",
        );
        return nodes[nodes.length - 1]?.dataset.mmDetailsOpen === "true";
      },
      undefined,
      { timeout: 5000 },
    );
    assert.equal(await details.locator(".mm-details-body").isVisible(), true);
    detailsToggleVerified = true;
  } catch (error) {
    bugs.push(
      "Details toggle after Rich insertion did not reach the collapsed state in the standalone recording harness; the same .mm-details-toggle works for loaded Details fixtures in tests/browser/block-editing.test.mjs.",
    );
    console.log(
      `  ! Details collapse/expand verification failed: ${error.message}`,
    );
  }
  if (!detailsToggleVerified) {
    const open = await details.getAttribute("data-mm-details-open");
    if (open === "false") await toggle.click();
  }
  await pause();

  const formatted = "formatted text";
  const bodyParagraph = details
    .locator(".mm-details-body p")
    .filter({ hasText: formatted })
    .first();
  await selectVisibleText(page, formatted, bodyParagraph);
  const selectionButton = page.getByRole("button", {
    name: "Bold selection",
    exact: true,
  });
  if (await selectionButton.isVisible()) {
    await selectionButton.click();
    await page.waitForFunction(
      (expected) =>
        Array.from(
          document.querySelectorAll(".mm-rich-panel .mm-details-body strong"),
        ).some((node) => node.textContent === expected),
      formatted,
    );
  } else {
    unsupportedFeatures.push(
      "Details body contextual formatting: the shared selection toolbar is not exposed for this NodeView selection.",
    );
    console.log(
      "  ! Details body selection toolbar is unavailable; leaving its body text unformatted.",
    );
  }
  await page.keyboard.press("Control+e");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => {
    const selection = window.markdownMint?.view?.state.selection;
    if (!selection) return false;
    if (selection.constructor?.name === "_BlockBoundarySelection") return true;
    return Boolean(
      selection.empty &&
      selection.$from?.parent?.type?.name === "paragraph" &&
      selection.$from.parent.content.size === 0,
    );
  });
  const afterDetails = await selectionIsEmptyParagraph(page);
  if (!afterDetails) {
    await page.keyboard.press("Enter");
    await waitForEmptyParagraph(page);
  }
}

async function generatedSource(page) {
  return page.locator(".mm-source-textarea").inputValue();
}

function canonicalSource(source) {
  const unescaped = source
    .replace(/\r\n?/g, "\n")
    .replace(/\\([`*_()[\]<>#\-+.!~$:=&])/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "_$1_");
  return unescaped
    .split("\n")
    .map((line) => {
      if (!/^\s*\|.*\|\s*$/.test(line)) return line;
      const cells = line.trim().split("|");
      const values = cells.slice(1, -1).map((cell) => cell.trim());
      const separator = values.every((cell) => /^:?-+:?$/.test(cell));
      return `|${values
        .map((cell) => {
          if (!separator) return cell;
          if (cell.startsWith(":") && cell.endsWith(":")) return ":center:";
          if (cell.startsWith(":")) return ":left";
          if (cell.endsWith(":")) return "right:";
          return "none";
        })
        .join("|")}|`;
    })
    .join("\n")
    .replace(/^(\s*\d+\.\s+[^\n]+)\n[ \t]*\n(?=[ \t]+- )/gm, "$1\n")
    .trimEnd();
}

async function validateSource(page) {
  const expected = await readFile(expectedPath, "utf8");
  const actual = await generatedSource(page);
  const expectedWithoutUnsupportedInlineMath = expected.replace(
    "Inline math such as $E = mc^2$ can stay inside a sentence.",
    "Inline math such as E = mc^2 can stay inside a sentence.",
  );
  assert.equal(
    canonicalSource(actual),
    canonicalSource(expectedWithoutUnsupportedInlineMath),
    "Generated Markdown differs from the expected semantic document",
  );
  for (const structure of [
    "# 🌿Markdown Mint",
    "## Write naturally",
    "**bold text**",
    "_emphasize an idea_",
    "~~remove what you no longer need~~",
    "`inline code`",
    "[links](https://example.com)",
    "> [!TIP]",
    "- Finish the feature",
    "1. Prepare the release",
    "   - Check the Markdown",
    "|Feature|Status|Owner|",
    "```mermaid",
    "$$",
    "```typescript",
    "<details>",
    "> [!NOTE]",
    "**a richer editing experience without giving up Markdown.**",
  ])
    assert.ok(
      canonicalSource(actual).includes(structure),
      `Missing source structure: ${structure}`,
    );
  return actual;
}

async function inspectRichDocument(page) {
  const report = await page.evaluate(() => {
    const root = document.querySelector(".mm-rich-panel .ProseMirror");
    const text = (selector) =>
      Array.from(root?.querySelectorAll(selector) ?? []).map((node) =>
        node.textContent?.trim(),
      );
    const tables = Array.from(root?.querySelectorAll("table") ?? []).map(
      (table) => ({
        rows: table.querySelectorAll("tr").length,
        columns: table.querySelector("tr")?.children.length ?? 0,
        cells: Array.from(table.querySelectorAll("th,td")).map(
          (cell) => cell.textContent,
        ),
      }),
    );
    return {
      headings: text("h1,h2"),
      strong: text("strong"),
      emphasis: text("em"),
      strike: text("s,del"),
      code: text("code"),
      links: Array.from(root?.querySelectorAll("a") ?? []).map((link) => ({
        text: link.textContent,
        href: link.getAttribute("href"),
      })),
      lists: Array.from(root?.querySelectorAll("ul,ol") ?? []).map((list) => ({
        type: list.tagName,
        items: list.children.length,
        nested: Boolean(list.closest("li")),
      })),
      tables,
      alerts: Array.from(root?.querySelectorAll(".markdown-alert") ?? []).map(
        (alert) => alert.className,
      ),
      mermaid: Boolean(root?.querySelector('[data-mm-mermaid="true"] svg')),
      math: Boolean(root?.querySelector(".mm-math-block")),
      codeBlock: root?.querySelector(".mm-code-block")?.dataset.mmCodeLanguage,
      details: {
        summary: root?.querySelector(".mm-details-summary")?.textContent,
        body: root?.querySelector(".mm-details-body")?.textContent,
        open: root?.querySelector(".mm-details-node")?.dataset.mmDetailsOpen,
      },
    };
  });
  assert.equal(report.headings[0], "🌿Markdown Mint");
  assert.equal(report.tables.length, 2);
  assert.deepEqual(report.tables[0], {
    rows: 4,
    columns: 3,
    cells: [
      "Feature",
      "Status",
      "Owner",
      "Visual editing",
      "✅ Ready",
      "Alice",
      "Table controls",
      "🚧 Review",
      "Sam",
      "GitHub profile",
      "✅ Ready",
      "Morgan",
    ],
  });
  assert.deepEqual(report.tables[1].cells.slice(0, 2), [
    "Profile",
    "Typical use",
  ]);
  assert.equal(report.alerts.length, 2);
  assert.equal(report.mermaid, true);
  assert.equal(report.math, true);
  assert.equal(report.codeBlock, "TypeScript");
  assert.equal(report.details.summary, "More details");
  assert.equal(report.details.open, "true");
  console.log("Rich document inspection:", JSON.stringify(report, null, 2));
}

async function main() {
  const { server, failed } = startServer();
  let browser;
  try {
    await Promise.race([waitForServer(`${baseUrl}/`), failed]);
    browser = await chromium.launch({ headless: false, slowMo: timing.slowMo });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    // The browser harness normally installs a mock VS Code transport. Hiding
    // only that transport lets the product's local Source fallback be
    // inspected without changing the document or editor state.
    await page.addInitScript(() => {
      Object.defineProperty(window, "acquireVsCodeApi", {
        configurable: true,
        get: () => undefined,
        set: () => {},
      });
    });
    await page.goto(`${baseUrl}/?profile=github`);
    await page.waitForFunction(() => Boolean(window.markdownMint?.view));
    await page.locator(".mm-rich-panel .ProseMirror").waitFor({
      state: "attached",
    });
    // This is the only harness setup call: it establishes an empty starting
    // document before the first visible authoring action. It is not a source
    // load and is never used again to modify the document.
    await page.evaluate(() =>
      window.__markdownMintHarness.deliverExternal("", "github"),
    );
    await waitForRich(page);
    await page.waitForFunction(
      () =>
        document.body.dataset.markdownMintMode === "editor" &&
        document.querySelector(".mm-profile-select")?.value === "github" &&
        document.querySelectorAll(
          ".mm-input-dialog[open], .mm-popup-panel:not([hidden])",
        ).length === 0,
    );
    await page.locator(".mm-starter-title").waitFor({ state: "visible" });
    console.log(`Starting empty GitHub document at ${baseUrl}`);
    console.log("Timing:", timing);

    await insertHeading(page, 1, "🌿Markdown Mint", { starter: true });
    await paragraph(page, "Write visually. Stay in Markdown.");
    await formatRange(page, "Write visually. Stay in Markdown.", "Bold");
    await paragraph(
      page,
      "Markdown Mint is a visual Markdown editor for VS Code.",
    );
    await paragraph(
      page,
      "Write bold text, emphasize an idea, remove what you no longer need, add inline code, create links, and keep everything as ordinary Markdown.",
    );
    await formatRange(page, "bold text", "Bold");
    await formatRange(page, "emphasize an idea", "Italic");
    await formatRange(page, "remove what you no longer need", "Strikethrough");
    await formatRange(page, "inline code", "Inline code");
    await selectVisibleText(page, "links");
    await page
      .getByRole("button", { name: "Link selection", exact: true })
      .click();
    const linkPicker = page.locator('.mm-link-picker[aria-hidden="false"]');
    await waitForVisible(linkPicker, "Link picker");
    await linkPicker
      .locator('[data-testid="link-picker-input"]')
      .fill("https://example.com");
    await linkPicker
      .locator('[data-testid="link-picker-input"]')
      .press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector(
          '.mm-rich-panel .ProseMirror a[href="https://example.com"]',
        )?.textContent === "links",
    );
    await pause();
    await page.locator(".mm-rich-panel .ProseMirror").focus();
    await prepareParagraph(page);
    await insertAlert(
      page,
      "TIP",
      "Markdown Mint lets you work with the document itself instead of constantly editing Markdown syntax.",
    );
    await insertHeading(page, 2, "Write naturally");
    await paragraph(
      page,
      "Create headings, lists, checklists, quotes, links, images, code blocks, and more from the same editing surface.",
    );
    await paragraph(page, "A release note can simply look like this:");
    await chooseInsertCommand(page, "Bullet list");
    for (const item of [
      "Finish the feature",
      "Review the documentation",
      "Publish the extension",
    ]) {
      await typeText(page, item);
      if (item !== "Publish the extension") await page.keyboard.press("Enter");
    }
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".mm-rich-panel .ProseMirror ul").length >= 1,
    );
    await paragraph(page, "And nested content stays readable:");
    await chooseInsertCommand(page, "Ordered list");
    await typeText(page, "Prepare the release");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".mm-rich-panel .ProseMirror ol ol").length >=
        1,
    );
    await page
      .locator('.mm-toolbar [data-testid="toolbar-bullet-list"]')
      .click();
    await typeText(page, "Check the Markdown");
    await page.keyboard.press("Enter");
    await typeText(page, "Review the preview");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Tab");
    await typeText(page, "Publish");
    await page.keyboard.press("Enter");
    await typeText(page, "Celebrate 🎉");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const root = document.querySelector(".mm-rich-panel .ProseMirror");
      return Boolean(
        root?.querySelector("ol ul") &&
        root?.textContent?.includes("Celebrate 🎉"),
      );
    });
    await pause(timing.sectionMs);

    await insertHeading(page, 2, "Tables that behave like tables");
    await paragraph(
      page,
      "Instead of carefully editing pipes and spaces, work directly with cells.",
    );
    await insertTable(page, 4, 3, [
      ["Feature", "Status", "Owner"],
      ["Visual editing", "✅ Ready", "Alice"],
      ["Table controls", "🚧 Review", "Sam"],
      ["GitHub profile", "✅ Ready", "Morgan"],
    ]);
    await setTableColumnAlignment(page, 0, "align-left", "left");
    await setTableColumnAlignment(page, 1, "align-center", "center");
    await setTableColumnAlignment(page, 2, "align-right", "right");
    await exitTable(page);
    await paragraph(
      page,
      "Select several cells with the mouse, copy them, click another cell, and paste the whole rectangular range.",
    );
    await paragraph(
      page,
      "Rows and columns can be added, removed, aligned, and edited without manually rebuilding the Markdown table.",
    );

    await insertHeading(page, 2, "GitHub, GitLab, or CommonMark");
    await paragraph(
      page,
      "Markdown Mint can adapt the editing experience to where the document will be used.",
    );
    await insertTable(page, 4, 2, [
      ["Profile", "Typical use"],
      ["GitHub", "GFM tables, task lists, Alerts, Mermaid, math"],
      ["GitLab", "GitLab Markdown plus TOC, description lists, and diff text"],
      [
        "CommonMark",
        "Portable Markdown with fewer platform-specific extensions",
      ],
    ]);
    for (const profile of ["GitHub", "GitLab", "CommonMark"]) {
      const cell = page
        .locator(".mm-rich-panel .ProseMirror table")
        .last()
        .locator("td")
        .filter({ hasText: profile })
        .first();
      await selectVisibleText(page, profile, cell.locator("p"));
      const selectionButton = page.getByRole("button", {
        name: "Bold selection",
        exact: true,
      });
      if (await selectionButton.isVisible()) {
        await selectionButton.click();
      } else {
        unsupportedFeatures.push(
          "Table cell contextual formatting: selectionTouchesTable() in src/webview/editor.ts intentionally hides the Selection Toolbar for table selections; the demo uses the main Bold toolbar on the same real selection as a user-facing fallback.",
        );
        await page.locator('.mm-toolbar [data-testid="toolbar-bold"]').click();
      }
      await page.waitForFunction(
        (expected) =>
          Array.from(
            document.querySelectorAll(
              ".mm-rich-panel .ProseMirror table:last-of-type strong",
            ),
          ).some((node) => node.textContent === expected),
        profile,
      );
    }
    await exitTable(page);
    await paragraph(
      page,
      "The Markdown file remains the same kind of .md file you already use.",
    );
    await formatRange(page, ".md", "Inline code");

    await insertHeading(page, 2, "Diagrams inside the document");
    await paragraph(page, "Documentation does not have to stop at text.");
    await insertMermaid(
      page,
      [
        "flowchart LR",
        "    Draft --> Review",
        "    Review --> Ready{Ready?}",
        "    Ready -->|Yes| Release",
        "    Ready -->|No| Draft",
      ].join("\n"),
    );
    await paragraph(
      page,
      "A diagram can live beside the explanation instead of in another tool.",
    );

    await insertHeading(page, 2, "Math stays readable too");
    await paragraph(
      page,
      "Inline math such as E = mc^2 can stay inside a sentence.",
    );
    unsupportedFeatures.push(
      "Inline Math authoring: src/webview/profileFeatures.ts exposes Math only as a block profile feature; no Rich UI path exists for selecting text and inserting inline Math.",
    );
    console.log(
      "  ! Inline Math is not authored: the inspected Rich UI has no inline Math feature.",
    );
    await paragraph(page, "Larger equations can stand on their own:");
    await insertMath(
      page,
      [
        "\\mathrm{Progress}",
        "=",
        "\\frac{\\mathrm{completed}}{\\mathrm{planned}}",
        "\\times 100\\%",
      ].join("\n"),
    );

    await insertHeading(page, 2, "Code belongs beside the explanation");
    await insertCodeBlock(page, "TypeScript", [
      "const document = {",
      '  format: "Markdown",',
      '  editor: "Markdown Mint",',
      "  visual: true,",
      "};",
    ]);
    await paragraph(
      page,
      "Choose the language and keep syntax-highlighted code together with the rest of the document.",
    );

    await insertHeading(page, 2, "Keep advanced content out of the way");
    await insertDetails(page, "More details", [
      "Collapsible sections can keep long explanations available without making the main document noisy.",
      "",
      "The same document can still contain formatted text, lists, code, and links.",
    ]);

    await insertHeading(page, 2, "Markdown stays Markdown");
    await paragraph(
      page,
      "Markdown Mint does not introduce a proprietary document format.",
    );
    await paragraph(
      page,
      "The visual editor works on the same Markdown document, and the raw source is always available when you need exact control.",
    );
    await insertAlert(
      page,
      "NOTE",
      "Some platform-specific or advanced syntax may still require source editing.",
    );
    await paragraph(page, "That is the main idea:");
    await paragraph(
      page,
      "a richer editing experience without giving up Markdown.",
    );
    await formatRange(
      page,
      "a richer editing experience without giving up Markdown.",
      "Bold",
    );
    await inspectRichDocument(page);
    await pause(timing.sectionMs);

    const sourceButton = page.locator(".mm-source-button");
    await sourceButton.waitFor({ state: "visible" });
    assert.equal(await sourceButton.isEnabled(), true);
    await sourceButton.click();
    await page.waitForFunction(
      () =>
        window.markdownMint?.mode === "source" &&
        document.querySelector(".mm-source-textarea")?.hidden === false,
    );
    await page.locator(".mm-source-textarea").waitFor({ state: "visible" });
    await pause(timing.stepMs);
    const source = await validateSource(page);
    console.log(`Generated source length: ${source.length}`);
    console.log(
      "  ✓ Source contains headings, marks, link, alerts, lists, tables, Mermaid, Math, TypeScript, Details, and NOTE syntax",
    );

    unsupportedFeatures.push(
      "Source→Rich in the standalone browser harness: the production toolbar exposes Source only; VS Code returns through the native source editor, while the harness has no user-facing Rich toggle.",
    );
    console.log(
      "  ! Source→Rich return is unavailable in this standalone harness; leaving Source visible for the final hold.",
    );
    await pause(timing.finalHoldMs);
    console.log("\nDemo report");
    console.log("Created files:");
    console.log("  docs/demo/full-document-expected.md");
    console.log("  scripts/demo/full-document-demo.mjs");
    console.log("Modified files:");
    console.log("  package.json");
    console.log("Run command: npm run demo:full-document");
    console.log("Viewport: 1440 x 1000, headed Chromium");
    console.log("Timing:", timing);
    console.log(
      "Features successfully authored through Rich UI: headings, bold/italic/strikethrough/inline code, links, TIP and NOTE Alerts, bullet and ordered/nested lists, two tables with Tab entry and alignment controls, Mermaid, display Math, TypeScript code block/language picker, Details, and final source inspection.",
    );
    console.log("Features that could not be authored through Rich UI:");
    for (const feature of new Set(unsupportedFeatures))
      console.log(`  - ${feature}`);
    console.log("Markdown Mint bugs discovered:");
    if (bugs.length === 0) console.log("  - None observed during this run.");
    else for (const bug of bugs) console.log(`  - ${bug}`);
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
