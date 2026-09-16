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
  typeMs: envNumber("MM_DEMO_TYPE_MS", 10),
  stepMs: envNumber("MM_DEMO_STEP_MS", 100),
  sectionMs: envNumber("MM_DEMO_SECTION_MS", 100),
  featureRevealMs: envNumber("MM_DEMO_FEATURE_REVEAL_MS", 700),
  featureNavigateMs: envNumber("MM_DEMO_FEATURE_NAVIGATE_MS", 100),
  featureCommitMs: envNumber("MM_DEMO_FEATURE_COMMIT_MS", 650),
  featureResultMs: envNumber("MM_DEMO_FEATURE_RESULT_MS", 900),
  scrollMs: envNumber("MM_DEMO_SCROLL_MS", 650),
  sourceHoldMs: envNumber("MM_DEMO_SOURCE_HOLD_MS", 1200, 1200),
  finalHoldMs: envNumber("MM_DEMO_FINAL_HOLD_MS", 1000),
  slowMo: envNumber("MM_DEMO_SLOWMO", 20),
};
const port = Math.trunc(envNumber("MM_DEMO_PORT", 4176, 1024));
const baseUrl = `http://127.0.0.1:${port}`;
const demoBackground = process.env.MM_DEMO_BACKGROUND ?? "#FCF7E5";
const demoForeground = process.env.MM_DEMO_FOREGROUND ?? "#3B3A32";
const unsupportedFeatures = [];
const bugs = [];
const centeredFeatures = [];
const headingConversions = [];

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

async function centerOn(page, locator, description) {
  await waitForVisible(locator, `${description} target`);
  await locator.evaluate((element, maxDuration) => {
    element.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
    return new Promise((resolve) => {
      const started = performance.now();
      let previousTop = element.getBoundingClientRect().top;
      let stableFrames = 0;
      const settle = () => {
        const rect = element.getBoundingClientRect();
        const currentTop = rect.top;
        const centered =
          Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2) < 90;
        if (Math.abs(currentTop - previousTop) < 0.5) stableFrames += 1;
        else stableFrames = 0;
        previousTop = currentTop;
        if (
          (centered && stableFrames >= 2) ||
          performance.now() - started >= maxDuration
        ) {
          resolve();
          return;
        }
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    });
  }, timing.scrollMs);
  centeredFeatures.push(description);
  await pause();
}

async function featureReveal() {
  await pause(timing.featureRevealMs);
}

async function featureNavigate() {
  await pause(timing.featureNavigateMs);
}

async function featureCommit() {
  await pause(timing.featureCommitMs);
}

async function featureResult() {
  await pause(timing.featureResultMs);
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
      parent: selection?.$from?.parent?.type?.name,
      empty: selection?.empty,
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

async function typeHeadingShortcut(
  page,
  level,
  text,
  { starter = false } = {},
) {
  if (starter) {
    // The empty-document starter is a virtual H1. Materialize one empty
    // paragraph, remove that untouched virtual heading with the normal
    // Backspace path, and then use the same input rule as every later
    // heading.
    await focusEditor(page);
    await page.keyboard.press("Enter");
    await waitForEmptyParagraph(page);
    await page.keyboard.press("Backspace");
    await waitForEmptyParagraph(page);
  } else {
    await newParagraph(page);
  }
  const emptyParagraph = page.locator(".mm-rich-panel .ProseMirror p").last();
  await centerOn(
    page,
    emptyParagraph,
    starter ? "first heading transformation" : `heading level ${level}`,
  );
  await focusEditor(page);
  for (let index = 0; index < level; index += 1) await page.keyboard.type("#");
  await pause();
  await page.keyboard.type(" ");
  await page.waitForFunction((expectedLevel) => {
    const selection = window.markdownMint?.view?.state.selection;
    return (
      selection?.$from?.parent?.type?.name === "heading" &&
      selection.$from.parent.attrs.level === Number(expectedLevel)
    );
  }, level);
  headingConversions.push({ level, text });
  await pause();
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
  await centerOn(
    page,
    page
      .locator(`.mm-rich-panel .ProseMirror h${level}`)
      .filter({ hasText: text })
      .last(),
    `heading result: ${text}`,
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

async function selectVisibleText(
  page,
  text,
  scope,
  description = `selection: ${text}`,
) {
  const target =
    scope ??
    page
      .locator(".mm-rich-panel .ProseMirror p")
      .filter({ hasText: text })
      .first();
  await centerOn(page, target, description);
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
  const button = page.getByRole("button", {
    name: `${label} selection`,
    exact: true,
  });
  await waitForVisible(button, `${label} selection button`);
  await featureReveal();
  await button.click();
  await featureResult();
}

async function formatRange(page, text, label) {
  await selectVisibleText(page, text, undefined, `${label} contextual toolbar`);
  await applySelectionToolbar(page, label);
}

async function openSlashMenu(page) {
  await prepareParagraph(page);
  await centerOn(
    page,
    page.locator(".mm-rich-panel .ProseMirror p").last(),
    "slash command",
  );
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
  await featureReveal();
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
  for (let index = 0; index < targetIndex; index += 1) {
    await page.keyboard.press("Tab");
    await featureNavigate();
  }
  await page.waitForFunction(
    (expected) =>
      document.activeElement?.getAttribute("aria-label") === expected,
    targetLabel,
  );
  await featureCommit();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const currentMenu = document.querySelector(".mm-empty-line-popup");
    if (!currentMenu) return true;
    const style = getComputedStyle(currentMenu);
    return (
      currentMenu.hidden ||
      currentMenu.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden"
    );
  });
  await featureResult();
}

async function insertTaskList(page, items) {
  await chooseInsertCommand(page, "Task list");
  const checkbox = page.locator(".mm-rich-panel .mm-task-checkbox").first();
  await checkbox.waitFor({ state: "visible" });
  await centerOn(page, checkbox, "task list");
  for (let index = 0; index < items.length; index += 1) {
    await typeText(page, items[index]);
    if (index < items.length - 1) await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (expectedItems) =>
      Array.from(document.querySelectorAll(".mm-rich-panel .mm-task-item"))
        .map((item) =>
          item.querySelector(".mm-task-content")?.textContent?.trim(),
        )
        .slice(-expectedItems.length)
        .join("\n") === expectedItems.join("\n"),
    items,
  );
  const checkboxes = page.locator(".mm-rich-panel .mm-task-checkbox");
  await centerOn(page, checkboxes.first(), "task list checkboxes");
  await featureReveal();
  await checkboxes.nth(0).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".mm-rich-panel .mm-task-checkbox")[0]?.checked,
  );
  await featureResult();
  await featureCommit();
  await checkboxes.nth(1).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".mm-rich-panel .mm-task-checkbox")[1]?.checked,
  );
  await featureResult();
}

async function insertAlert(page, type, body) {
  await chooseInsertCommand(page, "Alert");
  const dialog = page.locator(".mm-profile-feature-dialog[open]");
  await waitForVisible(dialog, "Alert dialog");
  await centerOn(page, dialog, "Alert");
  await featureReveal();
  await dialog.locator('[data-feature-field="alert-type"]').selectOption(type);
  await featureNavigate();
  await dialog.locator('[data-feature-field="body"]').fill(body);
  await featureCommit();
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
  await centerOn(
    page,
    page.locator(".mm-rich-panel .mm-alert-node-view").last(),
    "Alert result",
  );
  await featureResult();
}

async function insertTable(page, rows, columns, values) {
  await chooseInsertCommand(page, "Insert table");
  const dialog = page.locator(".mm-table-dialog[open]");
  await waitForVisible(dialog, "Table dialog");
  await featureReveal();
  const cell = dialog.getByRole("gridcell", {
    name: `${columns} columns by ${rows} rows`,
    exact: true,
  });
  await cell.click();
  await featureNavigate();
  await featureCommit();
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
  await centerOn(page, table, "table insertion/editing");
  await featureResult();
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
  await featureResult();
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

async function insertCodeBlock(page, language, lines) {
  await chooseInsertCommand(page, "Code block");
  const codeBlock = page.locator(".mm-rich-panel .mm-code-block").last();
  await codeBlock.waitFor({ state: "visible" });
  await centerOn(page, codeBlock, "Code block");
  await featureReveal();
  const languageTrigger = codeBlock.locator(".mm-code-language-trigger");
  await languageTrigger.click();
  const input = codeBlock.locator(".mm-code-language-inline");
  await input.waitFor({ state: "visible" });
  await featureReveal();
  await input.fill(language);
  const option = codeBlock.locator('[data-mm-language-option="typescript"]');
  await option.waitFor({ state: "visible" });
  await featureCommit();
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
  await featureResult();
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
  await centerOn(page, codeBlock, "Code block result");
  await featureResult();
}

async function insertDetails(page, summary, bodyLines) {
  await chooseInsertCommand(page, "Details");
  const dialog = page.locator(".mm-profile-feature-dialog[open]");
  await waitForVisible(dialog, "Details dialog");
  await centerOn(page, dialog, "Details");
  await featureReveal();
  await dialog.locator('[data-feature-field="title"]').fill(summary);
  await dialog
    .locator('[data-feature-field="body"]')
    .fill(bodyLines.join("\n"));
  await featureCommit();
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
  await centerOn(page, details, "Details result");
  await featureResult();
  const toggle = details.locator(
    ":scope > .mm-details-header > .mm-details-toggle",
  );
  let detailsToggleVerified = false;
  try {
    await featureCommit();
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
    await featureResult();
    await featureCommit();
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
    await featureResult();
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
  await featureResult();
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
  assert.equal(
    canonicalSource(actual),
    canonicalSource(expected),
    "Generated Markdown differs from the expected semantic document",
  );
  for (const structure of [
    "# 🌿Markdown Mint",
    "## Write naturally",
    "**formatting right where you are**",
    "- [x] Write the content",
    "- [x] Review the document",
    "- [ ] Publish",
    "|Feature|Experience|",
    "> [!TIP]",
    "Insert Alerts without writing the syntax by hand.",
    "```typescript",
    'const editor = "Markdown Mint";',
    "<details>",
    "## Markdown stays Markdown",
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
    const tasks = Array.from(root?.querySelectorAll(".mm-task-item") ?? []).map(
      (item) => ({
        text: item.querySelector(".mm-task-content")?.textContent?.trim(),
        checked: item.querySelector(".mm-task-checkbox")?.checked,
      }),
    );
    return {
      headings: text("h1,h2"),
      strong: text("strong"),
      tasks,
      tables,
      alerts: Array.from(root?.querySelectorAll(".markdown-alert") ?? []).map(
        (alert) => alert.className,
      ),
      codeBlock: root?.querySelector(".mm-code-block")?.dataset.mmCodeLanguage,
      details: {
        summary: root?.querySelector(".mm-details-summary")?.textContent,
        body: root
          ?.querySelector(".mm-details-body")
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
        open: root?.querySelector(".mm-details-node")?.dataset.mmDetailsOpen,
      },
    };
  });
  assert.deepEqual(report.headings, [
    "🌿Markdown Mint",
    "Write naturally",
    "Edit tables visually",
    "Use richer Markdown",
    "Keep details tidy",
    "Markdown stays Markdown",
  ]);
  assert.deepEqual(report.strong, ["formatting right where you are"]);
  assert.deepEqual(report.tasks, [
    { text: "Write the content", checked: true },
    { text: "Review the document", checked: true },
    { text: "Publish", checked: false },
  ]);
  assert.equal(report.tables.length, 1);
  assert.deepEqual(report.tables[0], {
    rows: 3,
    columns: 2,
    cells: [
      "Feature",
      "Experience",
      "Cell editing",
      "Direct",
      "Navigation",
      "Tab",
    ],
  });
  assert.equal(report.alerts.length, 1);
  assert.equal(report.codeBlock, "TypeScript");
  assert.equal(report.details.summary, "More features");
  assert.equal(
    report.details.body,
    "Use collapsible sections to keep extra information available without cluttering the document.",
  );
  assert.equal(report.details.open, "true");
  console.log("Rich document inspection:", JSON.stringify(report, null, 2));
}

async function main() {
  const startedAt = Date.now();
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
    const backgroundInspection = await page.evaluate(
      ({ background, foreground }) => {
        const root = document.documentElement;
        root.style.setProperty("--vscode-editor-background", background);
        const parseRgb = (color) => {
          const match = color.match(/rgba?\(([^)]+)\)/);
          if (!match) return null;
          const channels = match[1]
            .split(",")
            .slice(0, 3)
            .map((channel) => Number.parseFloat(channel.trim()));
          return channels.length === 3 && channels.every(Number.isFinite)
            ? channels
            : null;
        };
        const luminance = (color) => {
          const channels = parseRgb(color);
          if (!channels) return null;
          return channels.reduce((total, channel, index) => {
            const normalized = channel / 255;
            const linear =
              normalized <= 0.03928
                ? normalized / 12.92
                : ((normalized + 0.055) / 1.055) ** 2.4;
            return total + [0.2126, 0.7152, 0.0722][index] * linear;
          }, 0);
        };
        const initialForeground = getComputedStyle(document.body).color;
        const initialBackground = getComputedStyle(
          document.body,
        ).backgroundColor;
        const foregroundLuminance = luminance(initialForeground);
        const backgroundLuminance = luminance(initialBackground);
        const contrastRatio =
          foregroundLuminance === null || backgroundLuminance === null
            ? null
            : (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
              (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
        const foregroundFallback =
          contrastRatio !== null && contrastRatio < 4.5;
        if (foregroundFallback) {
          for (const [name, value] of Object.entries({
            "--vscode-editor-foreground": foreground,
            "--vscode-foreground": foreground,
            "--vscode-editorWidget-foreground": foreground,
            "--vscode-input-foreground": foreground,
            "--vscode-dropdown-foreground": foreground,
            "--vscode-descriptionForeground": foreground,
            "--vscode-disabledForeground": foreground,
          }))
            root.style.setProperty(name, value);
        }
        return {
          foregroundFallback,
          contrastRatio,
          variable: root.style.getPropertyValue("--vscode-editor-background"),
          body: getComputedStyle(document.body).backgroundColor,
          foreground: getComputedStyle(document.body).color,
        };
      },
      { background: demoBackground, foreground: demoForeground },
    );
    await page.waitForFunction(() => Boolean(window.markdownMint?.view));
    await page.locator(".mm-rich-panel .ProseMirror").waitFor({
      state: "attached",
    });
    const toolbarBackground = await page.evaluate(() => {
      const toolbar = document.querySelector(".mm-toolbar");
      return toolbar ? getComputedStyle(toolbar).backgroundColor : "";
    });
    assert.equal(backgroundInspection.variable, demoBackground);
    assert.notEqual(backgroundInspection.body, "rgba(0, 0, 0, 0)");
    assert.ok(toolbarBackground);
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

    await typeHeadingShortcut(page, 1, "🌿Markdown Mint", { starter: true });
    await paragraph(
      page,
      "Markdown Mint is a visual Markdown editor for VS Code.",
    );
    await paragraph(
      page,
      "Write naturally, use visual controls when you need them, and keep everything as Markdown.",
    );

    await typeHeadingShortcut(page, 2, "Write naturally");
    await paragraph(
      page,
      "Type Markdown-style shortcuts and Mint turns them into structured content as you write.",
    );
    await paragraph(
      page,
      "Select text and apply formatting right where you are.",
    );
    await formatRange(page, "formatting right where you are", "Bold");
    await paragraph(
      page,
      "Use `/` to insert blocks without leaving the document.",
    );
    await insertTaskList(page, [
      "Write the content",
      "Review the document",
      "Publish",
    ]);

    await typeHeadingShortcut(page, 2, "Edit tables visually");
    await paragraph(page, "Work with cells instead of pipes and spaces.");
    await insertTable(page, 3, 2, [
      ["Feature", "Experience"],
      ["Cell editing", "Direct"],
      ["Navigation", "Tab"],
    ]);
    await exitTable(page);
    await paragraph(
      page,
      "Add rows, move between cells, and keep the Markdown table underneath.",
    );

    await typeHeadingShortcut(page, 2, "Use richer Markdown");
    await paragraph(
      page,
      "GitHub-specific blocks are available from the same editor.",
    );
    await insertAlert(
      page,
      "TIP",
      "Insert Alerts without writing the syntax by hand.",
    );
    await paragraph(page, "Code blocks stay beside the explanation:");
    await insertCodeBlock(page, "TypeScript", [
      'const editor = "Markdown Mint";',
    ]);

    await typeHeadingShortcut(page, 2, "Keep details tidy");
    await insertDetails(page, "More features", [
      "Use collapsible sections to keep extra information available without cluttering the document.",
    ]);

    await typeHeadingShortcut(page, 2, "Markdown stays Markdown");
    await paragraph(page, "Your `.md` file remains the source of truth.");
    await paragraph(
      page,
      "Switch to Source whenever you want to inspect the Markdown directly.",
    );
    await centerOn(
      page,
      page
        .locator(".mm-rich-panel .ProseMirror p")
        .filter({
          hasText:
            "Switch to Source whenever you want to inspect the Markdown directly.",
        })
        .last(),
      "final Markdown stays Markdown section",
    );
    await inspectRichDocument(page);
    assert.deepEqual(
      headingConversions.map(({ level }) => level),
      [1, 2, 2, 2, 2, 2],
      "Every demo heading must be created by its Markdown input rule",
    );
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
    await pause(timing.sourceHoldMs);
    const source = await validateSource(page);
    console.log(`Generated source length: ${source.length}`);
    console.log(
      "  ✓ Source contains headings, one bold mark, task-list syntax, one table, TIP Alert syntax, TypeScript, Details, and final Source text",
    );

    unsupportedFeatures.push(
      "Source→Rich in the standalone browser harness: the production toolbar exposes Source only; VS Code returns through the native source editor, while the harness has no user-facing Rich toggle.",
    );
    console.log(
      "  ! Source→Rich return is unavailable in this standalone harness; leaving Source visible for the final hold.",
    );
    await pause(timing.finalHoldMs);
    console.log("\nDemo report");
    console.log("Files exercised:");
    console.log("  docs/demo/full-document-expected.md");
    console.log("  scripts/demo/full-document-demo.mjs");
    console.log("Run command: npm run demo:full-document");
    console.log("Viewport: 1440 x 1000, headed Chromium");
    console.log(
      `Background: ${demoBackground} via demo-only --vscode-editor-background override`,
    );
    console.log(
      `Foreground fallback: ${backgroundInspection.foregroundFallback ? `applied ${demoForeground}` : "not needed"}`,
    );
    console.log("Timing:", timing);
    console.log(
      `Approximate run duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    console.log(
      `Heading input-rule conversions: ${headingConversions.length} (${headingConversions.map(({ level }) => `H${level}`).join(", ")})`,
    );
    console.log(
      `Every heading used the real # + Space input rule: ${headingConversions.length === 6}`,
    );
    console.log(
      `Centered feature targets: ${[...new Set(centeredFeatures)].join(", ")}`,
    );
    console.log(
      "Features successfully authored through Rich UI: headings, one Bold selection, one slash Task list, one table with Tab entry, one TIP Alert, one TypeScript code block, one Details block, and final Source inspection.",
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
