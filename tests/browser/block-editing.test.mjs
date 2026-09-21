import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { testAlertConflict } from "./alert-conflict.test.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.MM_BLOCK_BROWSER_TEST_PORT ?? "4175");
const baseUrl = `http://127.0.0.1:${port}`;
const output = resolve(repository, "output/playwright/block-editing");
const rich = ".mm-rich-panel .ProseMirror";
const alertBody = ".mm-rich-panel .mm-alert-body-editor";
const detailsTitle = ".mm-details-summary";
const detailsInput = ".mm-details-summary-input";
const detailsToggle = ".mm-details-toggle";
const undoShortcut = process.platform === "darwin" ? "Meta+z" : "Control+z";
const primaryLinkModifier = process.platform === "darwin" ? "Meta" : "Control";
const redoShortcut =
  process.platform === "darwin" ? "Meta+Shift+z" : "Control+y";
const fence = (language, source) =>
  `\u0060\u0060\u0060${language}\n${source}\n\u0060\u0060\u0060`;
const blocks = (...values) => values.join("\n\n");
const alert = (body, kind = "NOTE") =>
  `> [!${kind}]\n${body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`;
const details = (body, attributes = "open", title = "Summary") =>
  `<details${attributes ? ` ${attributes}` : ""}>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
}

async function load(
  page,
  source,
  profile = "github",
  mode = "rich",
  workspaceSearchDelay = 0,
) {
  const params = new URLSearchParams();
  if (mode === "preview") params.set("mode", "preview");
  if (workspaceSearchDelay > 0)
    params.set("workspaceSearchDelay", String(workspaceSearchDelay));
  const query = params.toString();
  await page.goto(`${baseUrl}/${query ? `?${query}` : ""}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => window.markdownMint?.view);
  await page.evaluate(
    ([markdown, nextProfile]) =>
      window.__markdownMintHarness.deliverExternal(markdown, nextProfile),
    [source, profile],
  );
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.document.markdown === expected &&
      (expected.includes("\r\n") ||
        window.markdownMint.sourceEl.value === expected),
    source,
  );
  await settle(page);
}

async function saved(page) {
  await page.waitForFunction(() => !window.markdownMint.sync.hasPending);
  return page.evaluate(() => ({
    ...window.__markdownMintHarness.document,
    edits: window.__markdownMintHarness.messages.filter(
      (message) => message.type === "edit",
    ).length,
    dirty: window.markdownMint.dirty,
  }));
}

async function expectSource(page, expected) {
  await page.waitForFunction(
    (source) =>
      window.__markdownMintHarness.document.markdown === source &&
      !window.markdownMint.sync.hasPending,
    expected,
  );
  assert.equal((await saved(page)).markdown, expected);
}

// Programmatic setup establishes only the starting selection. Every operation
// under test is delivered through Chromium's real keyboard/mouse input path.
async function caret(page, selector, offset, end = offset) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(
    (element, [start, finish]) => {
      if (
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLInputElement
      ) {
        element.focus();
        element.setSelectionRange(
          start < 0 ? element.value.length + start + 1 : start,
          finish < 0 ? element.value.length + finish + 1 : finish,
        );
        return;
      }
      const view = window.markdownMint.view;
      const position = view.posAtDOM(element, 0);
      const node = view.state.doc.resolve(position).parent;
      const anchor =
        position + (start < 0 ? node.content.size + start + 1 : start);
      const head =
        position + (finish < 0 ? node.content.size + finish + 1 : finish);
      const Selection = view.state.selection.constructor;
      const selection = Selection.near(view.state.doc.resolve(anchor));
      const range = selection.constructor.create(view.state.doc, anchor, head);
      view.dispatch(view.state.tr.setSelection(range));
      view.focus();
    },
    [offset, end],
  );
  await settle(page);
}

async function selection(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const selected = window.markdownMint.view.state.selection;
    return {
      active: active?.className,
      inputStart:
        active instanceof HTMLTextAreaElement ? active.selectionStart : null,
      inputEnd:
        active instanceof HTMLTextAreaElement ? active.selectionEnd : null,
      parent: selected.$from.parent.type.name,
      text: selected.$from.parent.textContent,
      offset: selected.$from.parentOffset,
      empty: selected.empty,
      kind: selected.constructor.name.replace(/^_/, ""),
      nodeKind: selected.node?.attrs.kind,
      dialogs: document.querySelectorAll("dialog[open]").length,
    };
  });
}

async function noEdits(page, before, label) {
  await settle(page);
  const after = await saved(page);
  assert.equal(after.markdown, before.markdown, `${label}: source changed`);
  assert.equal(after.edits, before.edits, `${label}: host edit was emitted`);
  assert.equal(after.dirty, false, `${label}: document became dirty`);
}

async function insertionAffordances(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        !element.hidden &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const visibleCount = (selector) =>
      Array.from(document.querySelectorAll(selector)).filter(isVisible).length;
    const emptyLine = visibleCount(".mm-empty-line-insert");
    const blockGap = visibleCount(".mm-block-gap-insert");
    return { emptyLine, blockGap, totalPlus: emptyLine + blockGap };
  });
}

async function testCodeHeader(page) {
  const body = "  const value = 1;  \n\tconsole.log(value);\n";
  const source = blocks("Before", fence("ts title=example", body), "After");
  await load(page, source);
  const before = await saved(page);
  await page.locator(".mm-code-language-trigger").click();
  await page.locator(".mm-code-language-menu:not([hidden])").waitFor();
  const input = page.locator(".mm-code-language-inline");
  const menu = page.locator(".mm-code-language-menu:not([hidden])");
  assert.equal(
    await input.evaluate((element) => document.activeElement === element),
    true,
    "language picker did not focus its search input",
  );
  assert.equal(await menu.getAttribute("data-input-modality"), "pointer");
  assert.equal(await input.getAttribute("aria-activedescendant"), null);
  assert.equal(await menu.locator(".is-active").count(), 0);
  assert.equal(
    await menu
      .locator('[data-mm-language-option="ts"]')
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await menu
      .locator('[data-mm-language-option=""]')
      .getAttribute("aria-selected"),
    "false",
  );
  await input.fill("javascript");
  assert.equal(await menu.getAttribute("data-input-modality"), "keyboard");
  assert.equal(await menu.locator(".is-active").count(), 1);
  assert.equal(
    await input.getAttribute("aria-activedescendant"),
    await menu.locator(".is-active").getAttribute("id"),
  );
  await menu.locator(".mm-code-language-option").first().hover();
  assert.equal(await menu.getAttribute("data-input-modality"), "pointer");
  assert.equal(await menu.locator(".is-active").count(), 0);
  assert.equal(await input.getAttribute("aria-activedescendant"), null);
  await input.fill("");
  await input.press("Enter");
  await noEdits(page, before, "empty language enter");
  await page.locator(".mm-code-language-trigger").click();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await input.evaluate((element) => document.activeElement === element),
    true,
    "language arrow escaped into a body",
  );
  await page.keyboard.press("Escape");
  await noEdits(page, before, "cancel language chooser");
  await page.locator(".mm-code-language-trigger").click();
  await page
    .locator(
      '.mm-code-language-menu:not([hidden]) [data-mm-language-option=""]',
    )
    .click();
  await page
    .locator(".mm-code-language-confirm-dialog[open]")
    .waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    "code language removal Escape left an open dialog",
  );
  await noEdits(page, before, "cancel code language removal confirmation");
  await page.locator(".mm-code-language-trigger").click();
  await page
    .locator(
      '.mm-code-language-menu:not([hidden]) [data-mm-language-option=""]',
    )
    .click();
  const languageRemoval = page.locator(
    ".mm-code-language-confirm-dialog[open]",
  );
  await languageRemoval.waitFor({ state: "visible" });
  const languageRemovalBox = await languageRemoval.boundingBox();
  assert.ok(languageRemovalBox, "language removal dialog has no geometry");
  await page.mouse.click(
    Math.max(5, languageRemovalBox.x - 20),
    languageRemovalBox.y + 20,
  );
  await languageRemoval.waitFor({ state: "detached" });
  assert.equal(
    await page
      .locator(".mm-code-language-trigger")
      .evaluate((element) => document.activeElement === element),
    true,
    "language removal backdrop did not restore focus",
  );
  await noEdits(page, before, "backdrop code language removal confirmation");
  await page.locator(".mm-code-language-trigger").click();
  await input.fill("custom-language");
  await page.keyboard.press("Enter");
  await expectSource(
    page,
    source.replace("ts title=example", "custom-language title=example"),
  );
  assert.equal(
    await page.locator(".mm-code-block-pre code").textContent(),
    body,
  );
  await page.locator('[data-mm-code-action="copy"]').click();
  assert.equal(
    await page
      .locator(".mm-code-language-menu")
      .evaluate((element) => element.hidden),
    true,
  );
  await caret(page, ".mm-code-block-pre code", 3);
  await page.keyboard.type("X");
  await expectSource(
    page,
    source
      .replace("ts title=example", "custom-language title=example")
      .replace("  const", "  cXonst"),
  );
}

async function testDetailsAndCodeBlockSelection(page) {
  const detailsSource = blocks(
    details("Inner body", "open", "Inner"),
    details(details("Nested body", "open", "Inner"), "open", "Outer"),
    "After",
  );
  await load(page, detailsSource);
  const beforeDetails = await saved(page);
  const outer = page.locator(".mm-details-node").first();
  const inner = page.locator(".mm-details-node").nth(1);
  await inner.click({ position: { x: 2, y: 2 } });
  let state = await selection(page);
  assert.equal(
    state.kind,
    "NodeSelection",
    "inner padding did not select a node",
  );
  const selectedDetails = await page.evaluate(() => ({
    selected: window.markdownMint.view.state.selection.node?.type.name,
    outer: document
      .querySelectorAll(".mm-details-node")[1]
      ?.classList.contains("ProseMirror-selectednode"),
    first: document
      .querySelectorAll(".mm-details-node")[0]
      ?.classList.contains("ProseMirror-selectednode"),
  }));
  assert.equal(selectedDetails.selected, "details");
  assert.equal(selectedDetails.outer, true);
  assert.equal(selectedDetails.first, false);
  await noEdits(page, beforeDetails, "Details padding selection");

  await page.locator(rich).focus();
  await page.keyboard.press("Delete");
  await page.waitForFunction(
    () => document.querySelectorAll(".mm-details-node").length === 1,
  );
  assert.equal((await saved(page)).markdown.includes("Nested body"), false);
  await page.locator(rich).focus();
  await page.keyboard.press(undoShortcut);
  await expectSource(page, detailsSource);
  assert.equal(await page.locator(".mm-details-node").count(), 3);

  const body = outer.locator(":scope > .mm-details-body > p").first();
  await caret(page, ":nth-match(.mm-details-node, 1) .mm-details-body > p", 1);
  await body.click({ position: { x: 8, y: 8 } });
  state = await selection(page);
  assert.notEqual(
    state.kind,
    "NodeSelection",
    "Details body became block selected",
  );
  await outer
    .locator(":scope > .mm-details-header .mm-details-summary")
    .click();
  assert.equal(
    await outer
      .locator(":scope > .mm-details-header .mm-details-summary-input")
      .count(),
    1,
    "summary input was not kept in its Details header",
  );
  assert.equal(
    await outer.locator(".mm-details-summary-input").isVisible(),
    true,
  );
  await page.keyboard.press("Escape");
  const toggle = outer.locator(
    ":scope > .mm-details-header .mm-details-toggle",
  );
  const wasOpen = await outer.getAttribute("data-mm-details-open");
  await toggle.click();
  assert.notEqual(await outer.getAttribute("data-mm-details-open"), wasOpen);
  await toggle.click();

  const codeSource = blocks(
    "Before",
    fence("ts title=example", "const value = 1;"),
    "After",
  );
  await load(page, codeSource);
  const beforeCode = await saved(page);
  const code = page.locator(".mm-code-block").first();
  const codeText = code.locator(".mm-code-block-pre code");
  await caret(page, ".mm-code-block-pre code", 3);
  await codeText.click({ position: { x: 18, y: 12 } });
  assert.notEqual(
    (await selection(page)).kind,
    "NodeSelection",
    "code text click became block selected",
  );
  await code
    .locator(".mm-code-block-header")
    .click({ position: { x: 180, y: 12 } });
  assert.equal((await selection(page)).kind, "NodeSelection");
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.node.type.name,
    ),
    "code_block",
  );
  await noEdits(page, beforeCode, "code header selection");

  await page.locator(rich).focus();
  await page.keyboard.press("Backspace");
  await page.waitForFunction(
    () => document.querySelectorAll(".mm-code-block").length === 0,
  );
  assert.equal((await saved(page)).markdown.includes("example"), false);
  await page.locator(rich).focus();
  await page.keyboard.press(undoShortcut);
  await expectSource(page, codeSource);
  const afterUndoCode = await saved(page);

  await caret(page, ".mm-code-block-pre code", 3);
  await code.locator(".mm-code-line-numbers").click();
  assert.equal((await selection(page)).kind, "NodeSelection");
  await caret(page, ".mm-code-block-pre code", 3);
  await code.locator(".mm-code-language-trigger").click();
  assert.notEqual((await selection(page)).kind, "NodeSelection");
  await page.locator(".mm-code-language-inline").press("Escape");
  await caret(page, ".mm-code-block-pre code", 3);
  await code.locator('[data-mm-code-action="expand"]').click();
  assert.notEqual((await selection(page)).kind, "NodeSelection");
  await page.keyboard.press("Escape");
  await noEdits(page, afterUndoCode, "code controls and selection");
}

async function testAlertHeaderAndSelection(page) {
  const body = "alpha beta gamma\n  indented **Markdown** `source`  ";
  const source = blocks("Before", alert(body), "After");
  await load(page, source);
  const before = await saved(page);
  const textarea = page.locator(alertBody);

  await textarea.click();
  await settle(page);
  let state = await selection(page);
  assert.equal(state.active, "mm-alert-body-editor");
  assert.equal(state.dialogs, 0, "Alert body single click opened settings");
  const focused = await page
    .locator(".mm-alert-node-view")
    .evaluate((element) => ({
      bodyFocused: element.classList.contains("mm-alert-body-focused"),
      selected: element.classList.contains("ProseMirror-selectednode"),
      outline: getComputedStyle(element).outlineStyle,
    }));
  assert.equal(focused.bodyFocused, true, "body focus state was not set");
  assert.equal(focused.selected, true, "Alert NodeSelection was not retained");
  assert.equal(focused.outline, "none", "body focus still shows block outline");

  await caret(page, alertBody, -1);
  await page.keyboard.type("X");
  const typedSource = blocks("Before", alert(`${body}X`), "After");
  await expectSource(page, typedSource);

  const title = page.locator(".markdown-alert-title");
  await title.click();
  state = await selection(page);
  assert.equal(state.dialogs, 0, "Alert header single click opened settings");
  assert.equal(await page.locator(".mm-alert-type-picker").count(), 0);
  assert.equal(await page.locator(".mm-alert-type-select").count(), 0);

  await title.focus();
  await page.keyboard.press("Enter");
  const enterDialog = page.locator(".mm-profile-feature-dialog[open]");
  await enterDialog.waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".mm-profile-feature-dialog[open]").count(),
    1,
  );
  const beforeEnterCancel = await saved(page);
  await enterDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await noEdits(page, beforeEnterCancel, "Alert Enter activation cancel");

  await title.focus();
  await page.keyboard.press("Space");
  const spaceDialog = page.locator(".mm-profile-feature-dialog[open]");
  await spaceDialog.waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".mm-profile-feature-dialog[open]").count(),
    1,
  );
  const beforeSpaceCancel = await saved(page);
  await spaceDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await noEdits(page, beforeSpaceCancel, "Alert Space activation cancel");

  // Simulate text accepted by the native textarea immediately before the
  // double-click. The NodeView must flush it even without a separate input
  // event before opening the existing edit dialog.
  await textarea.evaluate((element) => {
    element.focus();
    element.value = "latest native body";
  });
  await textarea.dblclick({ position: { x: 50, y: 12 } });
  const dialog = page.locator(".mm-profile-feature-dialog[open]");
  await dialog.waitFor({ state: "visible" });
  assert.equal(
    await dialog.locator('[data-feature-field="alert-type"]').inputValue(),
    "NOTE",
  );
  assert.equal(
    await dialog.locator('[data-feature-field="body"]').inputValue(),
    "latest native body",
  );
  assert.equal(
    await page
      .locator(".mm-alert-node-view")
      .evaluate((element) => getComputedStyle(element).outlineStyle),
    "none",
    "Alert dialog left a selection outline behind",
  );
  const syncedSource = blocks("Before", alert("latest native body"), "After");
  await expectSource(page, syncedSource);

  const beforeCancel = await saved(page);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await noEdits(page, beforeCancel, "Alert cancel");
  state = await selection(page);
  assert.equal(state.active, "mm-alert-body-editor");
  assert.equal(state.dialogs, 0);
  const afterCancel = await page
    .locator(".mm-alert-node-view")
    .evaluate((element) => ({
      bodyFocused: element.classList.contains("mm-alert-body-focused"),
      outline: getComputedStyle(element).outlineStyle,
    }));
  assert.equal(afterCancel.bodyFocused, true);
  assert.equal(afterCancel.outline, "none");

  await title.dblclick();
  await dialog.waitFor({ state: "visible" });
  assert.equal(
    await dialog.locator('[data-feature-field="body"]').inputValue(),
    "latest native body",
  );
  await dialog
    .locator('[data-feature-field="alert-type"]')
    .selectOption("WARNING");
  await dialog.locator('[data-feature-field="body"]').fill("updated by dialog");
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  const updated = blocks(
    "Before",
    alert("updated by dialog", "WARNING"),
    "After",
  );
  await expectSource(page, updated);
  assert.equal(await page.locator(".mm-alert-node-view").count(), 1);
  assert.equal(await page.locator(".mm-alert-type-picker").count(), 0);
  assert.equal(await page.locator(".mm-alert-type-select").count(), 0);
  state = await selection(page);
  assert.equal(state.active, "mm-alert-body-editor");
  assert.equal(state.dialogs, 0);
  const afterUpdate = await page
    .locator(".mm-alert-node-view")
    .evaluate((element) => ({
      bodyFocused: element.classList.contains("mm-alert-body-focused"),
      outline: getComputedStyle(element).outlineStyle,
    }));
  assert.equal(afterUpdate.bodyFocused, true);
  assert.equal(afterUpdate.outline, "none");

  // Keep the drag selection check separate from the dialog behavior.
  const finalTextarea = page.locator(alertBody);
  const box = await finalTextarea.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + 10, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 12, { steps: 8 });
  await page.mouse.up();
  assert.equal(
    (await selection(page)).dialogs,
    0,
    "Alert body drag opened settings",
  );
  assert.equal((await selection(page)).dialogs, 0);
  assert.equal((await saved(page)).edits, before.edits + 3);
}

async function testHorizontalNavigation(page) {
  const flowSource = blocks("Paragraph A", "Paragraph B");
  await load(page, flowSource);
  const flowBefore = await saved(page);
  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("ArrowRight");
  let state = await selection(page);
  assert.equal(state.kind, "TextSelection");
  assert.equal(state.text, "Paragraph B", "paragraph Right took two presses");
  assert.equal(state.offset, 0);
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);
  await page.keyboard.press("ArrowLeft");
  state = await selection(page);
  assert.equal(state.kind, "TextSelection");
  assert.equal(state.text, "Paragraph A", "paragraph Left took two presses");
  assert.equal(state.offset, "Paragraph A".length);
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);
  await noEdits(page, flowBefore, "one-key paragraph horizontal navigation");

  const source = blocks(
    "Before",
    fence("ts", "code"),
    alert("alert"),
    details("Details body"),
    "After",
  );
  await load(page, source);
  const before = await saved(page);
  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).parent,
    "code_block",
    "paragraph -> code",
  );
  assert.equal((await selection(page)).offset, 0);
  await page.keyboard.press("ArrowLeft");
  assert.equal((await selection(page)).text, "Before", "code -> paragraph");
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).kind,
    "BlockBoundarySelection",
    "code -> Alert did not expose the structural boundary",
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 1);
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).active,
    "mm-alert-body-editor",
    "code -> Alert",
  );
  assert.equal((await selection(page)).inputStart, 0);
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    (await selection(page)).kind,
    "BlockBoundarySelection",
    "Alert -> code did not expose the structural boundary",
  );
  await page.keyboard.press("ArrowLeft");
  assert.equal((await selection(page)).parent, "code_block", "Alert -> code");
  await caret(page, alertBody, -1);
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).kind,
    "BlockBoundarySelection",
    "Alert -> open Details did not expose the structural boundary",
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).text,
    "Details body",
    "Alert -> open Details body",
  );
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    (await selection(page)).kind,
    "BlockBoundarySelection",
    "Details -> Alert did not expose the structural boundary",
  );
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    (await selection(page)).active,
    "mm-alert-body-editor",
    "Details -> Alert",
  );
  await caret(page, ".mm-details-body > p", -1);
  await page.keyboard.press("ArrowRight");
  assert.equal((await selection(page)).text, "After", "Details -> paragraph");
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    (await selection(page)).text,
    "Details body",
    "paragraph -> Details",
  );
  await noEdits(page, before, "bidirectional horizontal navigation");
}

async function testInsertAffordances(page) {
  await load(page, "Before");
  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("Enter");
  await settle(page);
  const empty = page.locator(`${rich} > p:last-child`);
  await empty.waitFor();
  const plus = page.locator(".mm-empty-line-insert");
  await plus.waitFor({ state: "visible" });
  const afterEnter = await saved(page);

  await plus.click();
  const popup = page.locator("#mm-empty-line-insert-popup");
  await popup.waitFor({ state: "visible" });
  assert.equal(
    (await selection(page)).kind,
    "TextSelection",
    "+ opened insertion UI without a boundary selection",
  );
  await page.keyboard.press("Escape");
  await caret(page, `${rich} > p:last-child`, 0);
  await page.keyboard.type("/");
  await popup.waitFor({ state: "visible" });
  const slashState = await selection(page);
  assert.equal(slashState.text, "", "slash trigger changed paragraph text");
  assert.equal(slashState.kind, "TextSelection");
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      !window.markdownMint.sync.hasPending &&
      window.__markdownMintHarness.document.markdown.includes("/"),
  );
  assert.equal(
    (await saved(page)).edits,
    afterEnter.edits + 1,
    "slash cancellation did not materialize exactly one edit",
  );
}

async function testBlockGapInsertion(page) {
  const source = blocks("Before", fence("ts", "code"), "After");
  await load(page, source);
  const before = await saved(page);
  const initialBlocks = page.locator(`${rich} > *`);
  assert.equal(await initialBlocks.count(), 3);
  const initialMetrics = await initialBlocks.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    }),
  );
  const stage = page.locator(".mm-stage");
  const initialScrollHeight = await stage.evaluate(
    (element) => element.scrollHeight,
  );
  const first = await initialBlocks.nth(0).boundingBox();
  const second = await initialBlocks.nth(1).boundingBox();
  assert.ok(first && second, "top-level block geometry was unavailable");
  const gapY = ((first?.y ?? 0) + (first?.height ?? 0) + (second?.y ?? 0)) / 2;
  await page.mouse.move(20, gapY);
  const gap = page.locator(".mm-block-gap-insert");
  await gap.waitFor({ state: "visible" });
  assert.equal(await gap.count(), 1);
  assert.deepEqual(await insertionAffordances(page), {
    emptyLine: 0,
    blockGap: 1,
    totalPlus: 1,
  });
  const visibleMetrics = await initialBlocks.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    }),
  );
  assert.deepEqual(
    visibleMetrics,
    initialMetrics,
    "showing the gap button shifted a top-level block",
  );
  assert.equal(
    await stage.evaluate((element) => element.scrollHeight),
    initialScrollHeight,
    "showing the gap button changed scroll height",
  );

  const popup = page.locator("#mm-empty-line-insert-popup");
  await gap.click();
  await popup.waitFor({ state: "visible" });
  assert.deepEqual(await insertionAffordances(page), {
    emptyLine: 1,
    blockGap: 0,
    totalPlus: 1,
  });
  assert.equal(
    await page.locator(".mm-empty-line-insert").getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(await gap.getAttribute("aria-expanded"), "false");
  const transient = await selection(page);
  assert.equal(transient.kind, "TextSelection");
  assert.equal(transient.parent, "paragraph");
  assert.equal(transient.text, "");
  await noEdits(page, before, "block-gap click");

  await popup.getByRole("menuitem", { name: "Code block" }).click();
  const committed = await saved(page);
  assert.equal(committed.edits, before.edits + 1);
  assert.match(committed.markdown, /Before[\s\S]*```[\s\S]*```[\s\S]*After/);
}

async function testInsertionAffordanceOwnership(page) {
  const tableSource = "| H1 | H2 |\n| --- | --- |\n| A1 | A2 |";
  const authored = `${fence("ts", "code")}\n\n\n${tableSource}`;

  // A source-authored empty paragraph owns both adjacent direct-child
  // boundaries. Hovering either side must not create a second plus.
  await load(page, authored);
  assert.deepEqual(await richDocumentShape(page), {
    types: ["code_block", "paragraph", "table"],
    emptyParagraphs: 1,
  });
  assert.equal(await page.locator(".mm-empty-line-insert").count(), 1);
  assert.equal(await page.locator(".mm-block-gap-insert").count(), 1);
  await caret(page, `${rich} > p`, 0);
  await page.locator(".mm-empty-line-insert").waitFor({ state: "visible" });
  const authoredBefore = await saved(page);
  const authoredEmpty = page.locator(`${rich} > p`);
  const authoredEmptyBox = await authoredEmpty.boundingBox();
  assert.ok(
    authoredEmptyBox,
    "source-authored empty paragraph has no geometry",
  );
  for (const y of [
    authoredEmptyBox.y - 2,
    authoredEmptyBox.y + authoredEmptyBox.height / 2,
    authoredEmptyBox.y + authoredEmptyBox.height + 2,
  ]) {
    await page.mouse.move(authoredEmptyBox.x + 4, y);
    await settle(page);
    assert.deepEqual(
      await insertionAffordances(page),
      { emptyLine: 1, blockGap: 0, totalPlus: 1 },
      `source-authored empty paragraph lost ownership at y=${y}`,
    );
  }
  await noEdits(page, authoredBefore, "source-authored empty paragraph hover");

  // A block-gap click materializes a transient paragraph without a host edit;
  // that paragraph immediately becomes the only visible insertion owner and
  // remains so while the existing Insert Block popup is open or cancelled.
  const pureGap = blocks(fence("ts", "code"), tableSource);
  await load(page, pureGap);
  const transientBefore = await saved(page);
  const pureBlocks = page.locator(`${rich} > *`);
  const previousBox = await pureBlocks.nth(0).boundingBox();
  const nextBox = await pureBlocks.nth(1).boundingBox();
  assert.ok(previousBox && nextBox, "pure Code/Table gap has no geometry");
  const pureGapY =
    ((previousBox?.y ?? 0) + (previousBox?.height ?? 0) + (nextBox?.y ?? 0)) /
    2;
  await page.mouse.move(20, pureGapY);
  const gap = page.locator(".mm-block-gap-insert");
  await gap.waitFor({ state: "visible" });
  assert.deepEqual(await insertionAffordances(page), {
    emptyLine: 0,
    blockGap: 1,
    totalPlus: 1,
  });
  await gap.click();
  const popup = page.locator("#mm-empty-line-insert-popup");
  await popup.waitFor({ state: "visible" });
  assert.deepEqual(await insertionAffordances(page), {
    emptyLine: 1,
    blockGap: 0,
    totalPlus: 1,
  });
  assert.equal((await selection(page)).parent, "paragraph");
  assert.equal((await selection(page)).text, "");
  await noEdits(page, transientBefore, "transient block-gap paragraph");
  await page.keyboard.press("Escape");
  await settle(page);
  assert.deepEqual(await insertionAffordances(page), {
    emptyLine: 1,
    blockGap: 0,
    totalPlus: 1,
  });
  await noEdits(
    page,
    transientBefore,
    "cancelled transient block-gap paragraph",
  );

  // BBS remains an internal navigation state: it owns insertion through the
  // virtual caret, so neither plus affordance is exposed.
  await load(page, pureGap);
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowDown");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  assert.deepEqual(await insertionAffordances(page), {
    emptyLine: 0,
    blockGap: 0,
    totalPlus: 0,
  });
  assert.equal(
    await page.locator(".mm-block-boundary-cursor").isVisible(),
    true,
  );

  // A pure Code/Table gap still has one block-gap owner and still opens the
  // existing insertion menu. The click remains a no-edit transient action.
  await load(page, pureGap);
  const pureBefore = await saved(page);
  const pureInitialBlocks = page.locator(`${rich} > *`);
  const pureFirst = await pureInitialBlocks.nth(0).boundingBox();
  const pureSecond = await pureInitialBlocks.nth(1).boundingBox();
  assert.ok(pureFirst && pureSecond, "Code/Table blocks lost geometry");
  const codeTableGapY =
    ((pureFirst?.y ?? 0) + (pureFirst?.height ?? 0) + (pureSecond?.y ?? 0)) / 2;
  await page.mouse.move(20, codeTableGapY);
  await page.locator(".mm-block-gap-insert").waitFor({ state: "visible" });
  assert.deepEqual(await insertionAffordances(page), {
    emptyLine: 0,
    blockGap: 1,
    totalPlus: 1,
  });
  await page.locator(".mm-block-gap-insert").click();
  await popup.waitFor({ state: "visible" });
  assert.deepEqual(await insertionAffordances(page), {
    emptyLine: 1,
    blockGap: 0,
    totalPlus: 1,
  });
  await noEdits(page, pureBefore, "Code/Table block-gap popup");
  await page.keyboard.press("Escape");

  // Large source blank runs contain bounded empty paragraphs plus one raw
  // blank-spacer atom. None of their adjacent structural boundaries is a
  // second block-gap insertion point.
  const largeBlankRun = `Before${"\n".repeat(1_000)}After`;
  await load(page, largeBlankRun);
  const largeShape = await richDocumentShape(page);
  assert.ok(largeShape.emptyParagraphs > 0);
  assert.ok(largeShape.types.includes("raw_block"));
  const largeBefore = await saved(page);
  await caret(page, `${rich} > p:nth-of-type(2)`, 0);
  await page.locator(".mm-empty-line-insert").waitFor({ state: "visible" });
  const spacer = page.locator(".mm-rich-panel .mm-blank-spacer");
  await spacer.waitFor();
  await spacer.scrollIntoViewIfNeeded();
  const spacerBox = await spacer.boundingBox();
  assert.ok(spacerBox, "blank spacer has no geometry");
  await page.mouse.move(spacerBox.x + 4, spacerBox.y + spacerBox.height / 2);
  await settle(page);
  assert.deepEqual(await insertionAffordances(page), {
    emptyLine: 1,
    blockGap: 0,
    totalPlus: 1,
  });
  assert.equal(await page.locator(".mm-empty-line-insert").count(), 1);
  assert.equal(await page.locator(".mm-block-gap-insert").count(), 1);
  await noEdits(page, largeBefore, "blank-spacer hover");
}

async function testProfileFeaturesAtStructuralBoundary(page) {
  const tableSource = "| A | B |\n| --- | --- |\n| a | b |";
  const source = blocks(fence("text", "code"), tableSource);
  const cases = [
    {
      id: "alert",
      configure: async (dialog) => {
        await dialog.locator('[data-feature-field="body"]').fill("Alert body");
      },
      expected: blocks(fence("text", "code"), alert("Alert body"), tableSource),
      node: { type: "raw_block", kind: "alert" },
    },
    {
      id: "details",
      configure: async (dialog) => {
        await dialog.locator('[data-feature-field="title"]').fill("More");
        await dialog
          .locator('[data-feature-field="body"]')
          .fill("Details body");
      },
      expected: blocks(
        fence("text", "code"),
        "<details>\n<summary>More</summary>\n\nDetails body\n\n</details>",
        tableSource,
      ),
      node: { type: "details", kind: "details" },
    },
    {
      id: "math",
      configure: async (dialog) => {
        await dialog.locator('[data-feature-field="body"]').fill("x^2");
      },
      expected: blocks(fence("text", "code"), "$$\nx^2\n$$", tableSource),
      node: { type: "raw_block", kind: "math-block" },
    },
    {
      id: "mermaid",
      configure: async (dialog) => {
        await dialog
          .locator('[data-feature-field="body"]')
          .fill("graph TD\nA-->B");
      },
      expected: blocks(
        fence("text", "code"),
        "```mermaid\ngraph TD\nA-->B\n```",
        tableSource,
      ),
      node: { type: "raw_block", kind: "protected-fence" },
    },
  ];

  for (const entry of cases) {
    await load(page, source);
    await caret(page, ".mm-code-block-pre code", -1);
    await page.keyboard.press("ArrowDown");
    assert.equal(
      (await selection(page)).kind,
      "BlockBoundarySelection",
      `${entry.id}: Code did not expose a boundary before Table`,
    );
    const before = await saved(page);
    const dialog = page.locator('[data-feature-dialog="true"]');
    await page.locator(`[data-profile-feature="${entry.id}"]`).click();
    await dialog.waitFor({ state: "visible" });
    await entry.configure(dialog);
    await dialog.getByRole("button", { name: "Insert", exact: true }).click();
    const committed = await saved(page);
    assert.equal(committed.markdown, entry.expected, `${entry.id}: source`);
    assert.equal(committed.edits, before.edits + 1, `${entry.id}: edit count`);
    assert.deepEqual(
      await page.evaluate(() => {
        const doc = window.markdownMint.view.state.doc;
        return Array.from({ length: doc.childCount }, (_, index) => ({
          type: doc.child(index).type.name,
          kind: doc.child(index).attrs.kind,
        }));
      }),
      [
        { type: "code_block", kind: undefined },
        entry.node,
        { type: "table", kind: undefined },
      ],
      `${entry.id}: top-level order or extra paragraph`,
    );
    assert.equal((await selection(page)).kind, "NodeSelection");
    assert.equal((await selection(page)).nodeKind, entry.node.kind);
  }

  await load(page, source);
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowDown");
  const beforeCancel = await saved(page);
  await page.locator('[data-profile-feature="details"]').click();
  const cancelDialog = page.locator('[data-feature-dialog="true"]');
  await cancelDialog.waitFor({ state: "visible" });
  await cancelDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await noEdits(page, beforeCancel, "boundary feature cancel");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  assert.equal(
    await page.evaluate(() => window.markdownMint.view.state.doc.childCount),
    2,
  );
}

async function testStructuralBoundaryNavigationAndInsertion(page) {
  const tableSource = "| H1 | H2 |\n| --- | --- |\n| A1 | A2 |";
  const source = blocks(fence("ts", "code"), tableSource, "After");

  await load(page, source);
  const table = page.locator(`${rich} > table`);
  const beforeTyping = await saved(page);
  await caret(page, ".mm-code-block-pre code", -1);
  await settle(page);
  const initialTableLayout = await table.evaluate((element) => {
    const stage = document.querySelector(".mm-stage");
    const stageTop = stage?.getBoundingClientRect().top ?? 0;
    const rect = element.getBoundingClientRect();
    return {
      rectTop: rect.top,
      stageScrollTop: stage?.scrollTop ?? 0,
      top: rect.top - stageTop + (stage?.scrollTop ?? 0),
      marginTop: getComputedStyle(element).marginTop,
      marginBottom: getComputedStyle(element).marginBottom,
      lineHeight: Number.parseFloat(
        getComputedStyle(element.parentElement).lineHeight,
      ),
    };
  });
  await page.keyboard.press("ArrowDown");
  await settle(page);
  assert.equal(
    (await selection(page)).kind,
    "BlockBoundarySelection",
    "Code -> Table did not expose one insertion boundary",
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 1);
  const activeBoundary = await page
    .locator(".mm-block-boundary-cursor")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const stage = document.querySelector(".mm-stage");
      const stageTop = stage?.getBoundingClientRect().top ?? 0;
      const tableElement = document.querySelector(
        ".mm-rich-panel .ProseMirror > table",
      );
      const tableRect = tableElement?.getBoundingClientRect();
      return {
        display: style.display,
        position: style.position,
        height: Number.parseFloat(style.height),
        tableTop: tableRect
          ? tableRect.top - stageTop + (stage?.scrollTop ?? 0)
          : Number.NaN,
      };
    });
  assert.equal(activeBoundary.display, "block");
  assert.equal(activeBoundary.position, "relative");
  assert.ok(activeBoundary.height > 0, "boundary spacer has no layout height");
  const tableShift = activeBoundary.tableTop - initialTableLayout.top;
  assert.ok(
    Math.abs(tableShift - initialTableLayout.lineHeight) <
      initialTableLayout.lineHeight * 0.45,
    `boundary spacer shifted Table by ${tableShift}px, expected about ${initialTableLayout.lineHeight}px`,
  );
  await noEdits(page, beforeTyping, "structural boundary selection");
  const sourceBeforeExit = (await saved(page)).markdown;
  await page.keyboard.press("ArrowDown");
  await settle(page);
  assert.equal((await selection(page)).text, "H1");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);
  const restoredTableTop = await table.evaluate((element) => {
    const stage = document.querySelector(".mm-stage");
    const stageTop = stage?.getBoundingClientRect().top ?? 0;
    return (
      element.getBoundingClientRect().top - stageTop + (stage?.scrollTop ?? 0)
    );
  });
  assert.ok(
    Math.abs(restoredTableTop - initialTableLayout.top) < 1,
    `leaving the boundary did not restore the Table position: initial=${initialTableLayout.top}, active=${activeBoundary.tableTop}, restored=${restoredTableTop}`,
  );
  await noEdits(
    page,
    { ...beforeTyping, markdown: sourceBeforeExit },
    "boundary exit",
  );

  await load(page, source);
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowDown");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  await page.keyboard.type("hello");
  await expectSource(
    page,
    blocks(fence("ts", "code"), "hello", tableSource, "After"),
  );
  assert.equal(
    await page.locator(`${rich} > *`).count(),
    4,
    "boundary typing inserted an unexpected extra paragraph",
  );

  await load(page, source);
  const beforeSlash = await saved(page);
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowDown");
  await noEdits(page, beforeSlash, "structural slash boundary selection");
  await page.keyboard.type("/");
  const popup = page.locator("#mm-empty-line-insert-popup");
  await popup.waitFor({ state: "visible" });
  assert.equal((await selection(page)).text, "");
  assert.equal((await selection(page)).parent, "paragraph");
  await popup.getByRole("menuitem", { name: "Code block" }).click();
  const slashCommitted = await saved(page);
  assert.ok(slashCommitted.edits > beforeSlash.edits);
  assert.match(
    slashCommitted.markdown,
    /```ts\ncode\n```[\s\S]*```[\s\S]*```[\s\S]*\| H1 \|/,
    "slash insertion did not place a new Code block between the targets",
  );
  assert.equal(slashCommitted.markdown.includes("\n/\n"), false);

  await load(page, source);
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowDown");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  await page.keyboard.press("Enter");
  let state = await selection(page);
  assert.equal(state.kind, "TextSelection");
  assert.equal(state.parent, "paragraph");
  assert.equal(state.text, "");
  await page.keyboard.type("hello");
  await expectSource(
    page,
    blocks(fence("ts", "code"), "hello", tableSource, "After"),
  );

  const structuralSource = blocks(
    fence("ts", "code"),
    tableSource,
    alert("alert"),
    "After",
  );
  await load(page, structuralSource);
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowDown");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(state.text, "H1", "boundary did not enter the Table target");
  await caret(page, `${rich} tbody tr:last-child td:first-child p`, -1);
  await page.keyboard.press("ArrowDown");
  assert.equal(
    (await selection(page)).kind,
    "BlockBoundarySelection",
    "Table -> Alert did not expose the structural boundary",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(
    (await selection(page)).active,
    "mm-alert-body-editor",
    "boundary did not enter the Alert target",
  );
  await caret(page, alertBody, -1);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(state.text, "After", "Alert -> flow did not remain direct");
  assert.equal(state.kind, "TextSelection");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  const atomicSource = blocks(
    "Paragraph A",
    "---",
    "$$\nx^2\n$$",
    "![image](https://example.com/image.png)",
    "Paragraph B",
  );
  await load(page, atomicSource);
  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(state.kind, "NodeSelection");
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.node.type.name,
    ),
    "horizontal_rule",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(state.nodeKind, "math-block");
  await page.keyboard.press("ArrowDown");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.node.type.name,
    ),
    "image",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal((await selection(page)).text, "Paragraph B");
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.node.type.name,
    ),
    "image",
  );
  await page.keyboard.press("ArrowUp");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  await page.keyboard.press("ArrowUp");
  assert.equal((await selection(page)).nodeKind, "math-block");
  await page.keyboard.press("ArrowUp");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.node.type.name,
    ),
    "horizontal_rule",
  );
}

async function testStructuralDocumentEdges(page) {
  const finalAlertSource = blocks(fence("ts", "code"), alert("final alert"));
  await load(page, finalAlertSource);
  const beforeAlert = await saved(page);
  await caret(page, alertBody, -1);
  await page.keyboard.press("ArrowDown");
  let state = await selection(page);
  assert.equal(state.kind, "BlockBoundarySelection");
  assert.equal(
    await page.evaluate(() => window.markdownMint.view.state.selection.head),
    await page.evaluate(() => window.markdownMint.view.state.doc.content.size),
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 1);
  await noEdits(page, beforeAlert, "final Alert document-end boundary");

  const stableEdge = await page.evaluate(() => {
    const stage = document.querySelector(".mm-stage");
    const selected = window.markdownMint.view.state.selection;
    return {
      from: selected.from,
      to: selected.to,
      kind: selected.constructor.name.replace(/^_/, ""),
      scrollTop: stage?.scrollTop ?? 0,
      scrollY: window.scrollY,
    };
  });
  for (const key of [
    "ArrowDown",
    "ArrowDown",
    "ArrowDown",
    "ArrowRight",
    "ArrowRight",
    "ArrowRight",
  ]) {
    await page.keyboard.press(key);
  }
  const unchangedEdge = await page.evaluate(() => {
    const stage = document.querySelector(".mm-stage");
    const selected = window.markdownMint.view.state.selection;
    return {
      from: selected.from,
      to: selected.to,
      kind: selected.constructor.name.replace(/^_/, ""),
      scrollTop: stage?.scrollTop ?? 0,
      scrollY: window.scrollY,
    };
  });
  assert.deepEqual(
    unchangedEdge,
    stableEdge,
    "document-end boundary leaked native scrolling",
  );
  await noEdits(page, beforeAlert, "document-end boundary no-op arrows");

  await page.keyboard.press("ArrowUp");
  state = await selection(page);
  assert.equal(state.active, "mm-alert-body-editor");
  assert.equal(state.kind, "NodeSelection");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);
  await noEdits(page, beforeAlert, "closing final Alert document-end boundary");

  await caret(page, alertBody, -1);
  await page.keyboard.press("ArrowDown");
  assert.equal((await selection(page)).kind, "BlockBoundarySelection");
  await page.keyboard.type("After alert");
  await expectSource(
    page,
    blocks(fence("ts", "code"), alert("final alert"), "After alert"),
  );

  await load(page, finalAlertSource);
  const beforeSlash = await saved(page);
  await caret(page, alertBody, -1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("/");
  const popup = page.locator("#mm-empty-line-insert-popup");
  await popup.waitFor({ state: "visible" });
  const slashState = await saved(page);
  assert.equal(slashState.markdown, beforeSlash.markdown);
  assert.equal(slashState.edits, beforeSlash.edits);
  await popup.getByRole("menuitem", { name: "Code block" }).click();
  const slashCommitted = await saved(page);
  assert.ok(slashCommitted.edits > beforeSlash.edits);
  assert.match(slashCommitted.markdown, /final alert[\s\S]*```/);

  const firstStructuralSource = blocks(fence("ts", "code"), "After");
  await load(page, firstStructuralSource);
  const beforeStart = await saved(page);
  await caret(page, ".mm-code-block-pre code", 0);
  await page.keyboard.press("ArrowUp");
  state = await selection(page);
  assert.equal(state.kind, "BlockBoundarySelection");
  assert.equal(
    await page.evaluate(() => window.markdownMint.view.state.selection.head),
    0,
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 1);
  await noEdits(page, beforeStart, "first structural document-start boundary");
  await page.keyboard.type("Before");
  await expectSource(page, blocks("Before", fence("ts", "code"), "After"));

  await load(page, "First paragraph");
  const beforeFlowEdge = await saved(page);
  await caret(page, `${rich} > p:first-child`, 0);
  await page.keyboard.press("ArrowUp");
  state = await selection(page);
  assert.equal(state.kind, "TextSelection");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);
  await noEdits(page, beforeFlowEdge, "flow document-start edge");
}

async function testDirectVerticalBlockNavigation(page) {
  const source = blocks("Paragraph A", "Paragraph B");
  await load(page, source);
  const before = await saved(page);

  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("ArrowDown");
  let state = await selection(page);
  assert.equal(
    state.kind,
    "TextSelection",
    "Down did not select a real text target",
  );
  assert.equal(
    state.text,
    "Paragraph B",
    "Down did not enter the next paragraph",
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await page.keyboard.press("ArrowUp");
  state = await selection(page);
  assert.equal(
    state.kind,
    "TextSelection",
    "Up did not return to a real text target",
  );
  assert.equal(
    state.text,
    "Paragraph A",
    "Up did not return to the previous paragraph",
  );
  await noEdits(page, before, "direct paragraph vertical navigation");

  const atomicSource = blocks("Paragraph A", "---", "Paragraph B");
  await load(page, atomicSource);
  const atomicBefore = await saved(page);
  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(
    state.kind,
    "NodeSelection",
    "ArrowDown did not select the atomic HR",
  );
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.node.type.name,
    ),
    "horizontal_rule",
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(
    state.text,
    "Paragraph B",
    "ArrowDown stopped before the paragraph after the HR",
  );
  await page.keyboard.press("ArrowUp");
  state = await selection(page);
  assert.equal(
    state.kind,
    "NodeSelection",
    "ArrowUp did not return to the atomic HR",
  );
  await page.keyboard.press("ArrowUp");
  assert.equal((await selection(page)).text, "Paragraph A");
  await noEdits(page, atomicBefore, "atomic vertical navigation");

  const imageSource = blocks(
    "Paragraph A",
    "![image](https://example.com/image.png)",
    "Paragraph B",
  );
  await load(page, imageSource);
  const imageBefore = await saved(page);
  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(state.kind, "NodeSelection", "image was not treated as atomic");
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.node.type.name,
    ),
    "image",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal((await selection(page)).text, "Paragraph B");
  await page.keyboard.press("ArrowUp");
  assert.equal((await selection(page)).kind, "NodeSelection");
  await page.keyboard.press("ArrowUp");
  assert.equal((await selection(page)).text, "Paragraph A");
  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("ArrowRight");
  assert.equal((await selection(page)).kind, "NodeSelection");
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.node.type.name,
    ),
    "image",
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);
  await page.keyboard.press("ArrowRight");
  assert.equal((await selection(page)).text, "Paragraph B");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await selection(page)).kind, "NodeSelection");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await selection(page)).text, "Paragraph A");
  await noEdits(page, imageBefore, "image atomic vertical navigation");
}

async function testArrowDocumentEdges(page) {
  const source = blocks("Top", "Bottom");
  await load(page, source);
  const before = await saved(page);

  for (const [selector, offset, key, label] of [
    [`${rich} > p:first-child`, 0, "ArrowLeft", "top Left"],
    [`${rich} > p:first-child`, 0, "ArrowUp", "top Up"],
    [`${rich} > p:last-child`, -1, "ArrowRight", "bottom Right"],
    [`${rich} > p:last-child`, -1, "ArrowDown", "bottom Down"],
  ]) {
    await caret(page, selector, offset);
    const initial = await page.evaluate(() => {
      const selected = window.markdownMint.view.state.selection;
      const stage = document.querySelector(".mm-stage");
      return {
        from: selected.from,
        to: selected.to,
        kind: selected.constructor.name.replace(/^_/, ""),
        scrollTop: stage?.scrollTop ?? 0,
        scrollY: window.scrollY,
      };
    });
    await page.evaluate(() => {
      window.__markdownMintEdgeEvents = [];
      window.markdownMint.view.dom.addEventListener(
        "keydown",
        (event) => {
          if (/^Arrow(Left|Right|Up|Down)$/.test(event.key))
            window.__markdownMintEdgeEvents.push({
              key: event.key,
              defaultPrevented: event.defaultPrevented,
            });
        },
        { once: true },
      );
    });
    await page.keyboard.press(key);
    const actual = await page.evaluate(() => {
      const selected = window.markdownMint.view.state.selection;
      const stage = document.querySelector(".mm-stage");
      return {
        from: selected.from,
        to: selected.to,
        kind: selected.constructor.name.replace(/^_/, ""),
        scrollTop: stage?.scrollTop ?? 0,
        scrollY: window.scrollY,
        event: window.__markdownMintEdgeEvents.at(-1),
      };
    });
    assert.deepEqual(actual.event, { key, defaultPrevented: true }, label);
    assert.deepEqual(
      {
        from: actual.from,
        to: actual.to,
        kind: actual.kind,
        scrollTop: actual.scrollTop,
        scrollY: actual.scrollY,
      },
      initial,
      `${label}: edge navigation changed selection or scroll`,
    );
    assert.equal(
      await page.locator(".mm-block-boundary-cursor").count(),
      0,
      `${label}: edge navigation created a boundary`,
    );
  }
  await noEdits(page, before, "document edge arrow handling");
}

async function testWrappedVerticalNavigation(page) {
  await page.setViewportSize({ width: 460, height: 800 });
  const body =
    "This long logical line wraps in the native Alert textarea. ".repeat(8);
  const source = blocks(
    "Previous paragraph with enough text",
    alert(body),
    fence("ts", "012345678901234567890123456789"),
    alert("last alert"),
  );
  await load(page, source);
  const before = await saved(page);
  const textarea = page.locator(alertBody).first();
  const layout = await textarea.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
  }));
  assert.ok(
    layout.height > layout.lineHeight * 3,
    "fixture must occupy multiple real display rows",
  );
  await caret(page, `:nth-match(${alertBody}, 1)`, 5);
  await page.keyboard.press("ArrowDown");
  let state = await selection(page);
  assert.equal(
    state.active,
    "mm-alert-body-editor",
    "wrapped first-row Down escaped prematurely",
  );
  assert.ok(
    state.inputStart > 5 && state.inputStart < body.length - 1,
    "Down did not move to the next visible row",
  );
  await page.keyboard.press("ArrowUp");
  assert.equal((await selection(page)).active, "mm-alert-body-editor");
  await caret(page, `:nth-match(${alertBody}, 1)`, body.length - 3);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(
    state.kind,
    "BlockBoundarySelection",
    "last displayed Alert row Down did not stop at the structural gap",
  );
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(state.parent, "code_block", "boundary did not enter code");
  await page.keyboard.press("ArrowUp");
  assert.equal(
    (await selection(page)).kind,
    "BlockBoundarySelection",
    "code Up did not stop at the structural gap",
  );
  await page.keyboard.press("ArrowUp");
  assert.equal((await selection(page)).active, "mm-alert-body-editor");
  await caret(page, `:nth-match(${alertBody}, 1)`, 3);
  await page.keyboard.press("ArrowUp");
  assert.equal(
    (await selection(page)).text,
    "Previous paragraph with enough text",
    "first displayed Alert row Up did not leave",
  );
  await noEdits(page, before, "vertical actual-target navigation");
  await caret(page, `:nth-match(${alertBody}, 1)`, -1);
  await page.keyboard.press("ArrowDown");
  assert.equal(
    (await selection(page)).kind,
    "BlockBoundarySelection",
    "final Alert row did not stop at the structural gap",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(
    (await selection(page)).parent,
    "code_block",
    "final Alert row did not enter code after the boundary",
  );
  await page.keyboard.type("Z");
  await page.waitForFunction(() =>
    window.__markdownMintHarness.document.markdown.includes("Z"),
  );
  assert.match((await saved(page)).markdown, /```ts\n[^`]*Z/);
  await page.setViewportSize({ width: 960, height: 900 });
}

async function testTableNavigation(page) {
  const source = blocks(
    "Before",
    "| H1 | H2 |\n| --- | --- |\n| A1 | A2 |",
    "After",
  );
  await load(page, source);
  const before = await saved(page);

  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("ArrowDown");
  let state = await selection(page);
  assert.equal(state.kind, "TextSelection");
  assert.equal(state.text, "H1", "paragraph Down did not enter the table");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(page, `${rich} tr:first-child th:first-child p`, 0);
  await page.keyboard.press("ArrowUp");
  state = await selection(page);
  assert.equal(state.text, "Before", "table Up did not leave directly");
  assert.equal(state.offset, "Before".length);
  assert.equal(state.kind, "TextSelection");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(state.text, "H1", "paragraph Down did not return directly");
  assert.equal(state.kind, "TextSelection");

  await caret(page, `${rich} tbody tr:last-child td:first-child p`, -1);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(state.kind, "TextSelection", "table Down stopped at a boundary");
  assert.equal(
    state.text,
    "After",
    "table Down did not leave to the next paragraph",
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await page.keyboard.press("ArrowUp");
  state = await selection(page);
  assert.equal(state.text, "A2", "table Up did not return to a table cell");
  assert.equal(state.kind, "TextSelection");

  await caret(page, `${rich} tr:first-child th:first-child p`, 0);
  await page.keyboard.press("ArrowLeft");
  state = await selection(page);
  assert.equal(state.text, "Before", "table Left did not leave directly");
  assert.equal(state.offset, "Before".length);
  assert.equal(state.kind, "TextSelection");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(page, `${rich} tbody tr:last-child td:last-child p`, -1);
  await page.keyboard.press("ArrowRight");
  state = await selection(page);
  assert.equal(state.text, "After", "table Right did not leave directly");
  assert.equal(state.offset, 0);
  assert.equal(state.kind, "TextSelection");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(page, `${rich} > p:last-child`, 0);
  await page.keyboard.press("ArrowLeft");
  state = await selection(page);
  assert.equal(state.text, "A2", "table Left did not return directly");
  assert.equal(state.kind, "TextSelection");
  await page.keyboard.press("ArrowRight");
  assert.equal((await selection(page)).text, "After");
  await noEdits(page, before, "table vertical navigation");
}

async function testSpreadsheetTablePasteHistory(page) {
  const source = blocks(
    "Before",
    "| H1 | H2 |\n| --- | --- |\n| A1 | A2 |",
    "After",
  );
  await load(page, source);
  await caret(page, `${rich} > p:first-child`, -1);
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "Name\tScore\nAlice\t90");
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    });
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    if (!editor) throw new Error("Rich Editor was not rendered");
    editor.dispatchEvent(event);
  });
  const changed = blocks(
    "Before",
    "| Name | Score |\n| --- | --- |\n| Alice | 90 |",
    "| H1 | H2 |\n| --- | --- |\n| A1 | A2 |",
    "After",
  );
  await expectSource(page, changed);
  assert.equal(
    await page.locator(`${rich} > table`).count(),
    2,
    "spreadsheet paste did not insert one table block",
  );

  await page.keyboard.press(undoShortcut);
  await expectSource(page, source);
  assert.equal(
    await page.locator(`${rich} > table`).count(),
    1,
    "one Undo did not remove the pasted table",
  );

  await page.keyboard.press(redoShortcut);
  await expectSource(page, changed);
  assert.equal(
    await page.locator(`${rich} > table`).count(),
    2,
    "one Redo did not restore the pasted table",
  );
}

async function testMergedHtmlTablePaste(page) {
  const source = blocks(
    "Before",
    "| H1 | H2 |\n| --- | --- |\n| A1 | A2 |",
    "After",
  );
  const html =
    '<table><tr><th rowspan="2">A</th><td colspan="2">B</td><td>C</td></tr><tr><td>D</td><td colspan="2">E</td></tr></table>';
  await load(page, source);
  await caret(page, `${rich} > p:first-child`, -1);
  await page.evaluate((markup) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/html", markup);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    });
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    if (!editor) throw new Error("Rich Editor was not rendered");
    editor.dispatchEvent(event);
    if (!event.defaultPrevented)
      throw new Error("Merged HTML table paste was not handled");
  }, html);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".mm-rich-panel .ProseMirror > table")
        .length === 2,
  );
  await page.waitForFunction(() => {
    const table = document.querySelector(".mm-rich-panel .ProseMirror > table");
    const rows = table ? Array.from(table.querySelectorAll("tr")) : [];
    return rows.length === 2 && rows.every((row) => row.children.length === 4);
  });
  const values = await page
    .locator(`${rich} > table`)
    .first()
    .locator("tr")
    .evaluateAll((rows) =>
      rows.map((row) =>
        Array.from(row.children).map((cell) => cell.textContent ?? ""),
      ),
    );
  assert.deepEqual(values, [
    ["A", "B", "", "C"],
    ["", "D", "E", ""],
  ]);
  assert.match((await saved(page)).markdown, /\| A \| B \|/);

  const crossingGroupHtml =
    '<table><thead><tr><th rowspan="2">H</th><th>J</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>';
  await load(page, source);
  await caret(page, `${rich} > p:first-child`, -1);
  const before = await saved(page);
  await page.evaluate((markup) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/html", markup);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    });
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    if (!editor) throw new Error("Rich Editor was not rendered");
    editor.dispatchEvent(event);
    if (!event.defaultPrevented)
      throw new Error("Crossing row-group paste was not rejected");
  }, crossingGroupHtml);
  await expectSource(page, source);
  const after = await saved(page);
  assert.equal(after.edits, before.edits);

  const overlappingSpanHtml =
    '<table><tbody><tr><td>A</td><td rowspan="2">B</td></tr><tr><td colspan="2">C</td><td>D</td></tr></tbody></table>';
  await load(page, source);
  await caret(page, `${rich} > p:first-child`, -1);
  const overlappingBefore = await saved(page);
  await page.evaluate((markup) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/html", markup);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    });
    const editor = document.querySelector(".mm-rich-panel .ProseMirror");
    if (!editor) throw new Error("Rich Editor was not rendered");
    editor.dispatchEvent(event);
    if (!event.defaultPrevented)
      throw new Error("Overlapping HTML spans were not rejected");
  }, overlappingSpanHtml);
  await expectSource(page, source);
  const overlappingAfter = await saved(page);
  assert.equal(overlappingAfter.edits, overlappingBefore.edits);
}

async function testNestedBlockquoteTableNavigation(page) {
  const source = blocks(
    [
      "> Before",
      ">",
      "> | H1 | H2 |",
      "> | --- | --- |",
      "> | A1 | A2 |",
      ">",
      "> After",
    ].join("\n"),
    "Root after",
  );
  await load(page, source);
  const before = await saved(page);

  await caret(page, `${rich} blockquote > p:first-of-type`, -1);
  await page.keyboard.press("ArrowDown");
  let state = await selection(page);
  assert.equal(state.kind, "TextSelection");
  assert.equal(state.text, "H1", "nested paragraph Down did not enter table");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(page, `${rich} blockquote tr:first-child th:first-child p`, 0);
  await page.keyboard.press("ArrowUp");
  state = await selection(page);
  assert.equal(state.text, "Before", "nested table Up did not leave directly");
  assert.equal(state.kind, "TextSelection");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(page, `${rich} blockquote > p:first-of-type`, -1);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(
    state.text,
    "H1",
    "nested paragraph Down did not return directly",
  );
  assert.equal(state.kind, "TextSelection");

  await caret(
    page,
    `${rich} blockquote tbody tr:last-child td:first-child p`,
    -1,
  );
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(state.kind, "TextSelection");
  assert.equal(
    state.text,
    "After",
    "nested table Down did not enter the containing blockquote paragraph",
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(page, `${rich} blockquote > p:last-of-type`, 0);
  await page.keyboard.press("ArrowUp");
  state = await selection(page);
  assert.equal(state.kind, "TextSelection");
  assert.ok(
    ["A1", "A2"].includes(state.text),
    `nested table Up selected ${state.text ?? "no cell"}`,
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(page, `${rich} blockquote > p:last-of-type`, -1);
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(
    state.text,
    "Root after",
    "nested container exit escaped incorrectly",
  );
  assert.equal(state.kind, "TextSelection");
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(page, `${rich} blockquote tr:first-child th:first-child p`, 0);
  await page.keyboard.press("ArrowLeft");
  state = await selection(page);
  assert.equal(
    state.text,
    "Before",
    "nested table Left did not leave directly",
  );
  assert.equal(state.kind, "TextSelection");
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.$from.depth > 1,
    ),
    true,
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);

  await caret(
    page,
    `${rich} blockquote tbody tr:last-child td:last-child p`,
    -1,
  );
  await page.keyboard.press("ArrowRight");
  state = await selection(page);
  assert.equal(
    state.text,
    "After",
    "nested table Right did not leave directly",
  );
  assert.equal(state.kind, "TextSelection");
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.selection.$from.depth > 1,
    ),
    true,
  );
  assert.equal(await page.locator(".mm-block-boundary-cursor").count(), 0);
  await noEdits(page, before, "nested blockquote table navigation");
}

async function testExpandedCodeVerticalNavigation(page) {
  const body = "0123456789\nabcdefghij\nABCDEFGHIJ";
  const source = blocks("Before", fence("text", body), "After");
  await load(page, source);
  const before = await saved(page);
  await page.locator('[data-mm-code-action="expand"]').click();
  await page.locator(".mm-code-block-expanded").waitFor();
  await caret(page, ".mm-code-block-pre code", 14);
  const nativeCaret = async () => {
    await settle(page);
    return page.locator(".mm-code-block-pre code").evaluate((code) => {
      const selected = window.getSelection();
      const range = selected.getRangeAt(0);
      const prefix = code.ownerDocument.createRange();
      prefix.setStart(code, 0);
      prefix.setEnd(selected.focusNode, selected.focusOffset);
      const rect = range.getBoundingClientRect();
      return {
        inside: code.contains(selected.focusNode),
        collapsed: selected.isCollapsed,
        offset: prefix.toString().length,
        left: rect.left,
        top: rect.top,
      };
    });
  };
  const middle = await nativeCaret();
  assert.equal(middle.offset, 14);
  for (const [key, expected, relativeRow] of [
    ["ArrowDown", 25, 1],
    ["ArrowDown", 25, 1],
    ["ArrowUp", 14, 0],
    ["ArrowUp", 3, -1],
    ["ArrowUp", 3, -1],
    ["ArrowDown", 14, 0],
  ]) {
    await page.keyboard.press(key);
    const actual = await nativeCaret();
    assert.equal(actual.inside, true, `${key} escaped expanded code`);
    assert.equal(actual.collapsed, true);
    assert.equal(actual.offset, expected, `${key}: native caret offset`);
    assert.equal((await selection(page)).offset, expected);
    assert.equal(Math.sign(actual.top - middle.top), relativeRow);
    assert.ok(Math.abs(actual.left - middle.left) <= 1, `${key}: column lost`);
  }
  await page.screenshot({ path: resolve(output, "expanded-code-caret.png") });
  await noEdits(page, before, "expanded code row navigation and boundaries");
  await page.keyboard.press("Escape");
}

async function testCodeVerticalNavigation(page) {
  const lines = [
    "function greet(name) {",
    "  console.log(`Hello, ${name}!`);",
    "}",
    "",
    'greet("Markdown");',
  ];
  const body = lines.join("\n");
  const source = blocks("Before", fence("javascript", body), "After");
  const viewports = [
    { width: 760, height: 180 },
    { width: 520, height: 190 },
  ];
  const startColumn = 4;
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const expectedDown = [
    starts[1] + startColumn,
    starts[2] + Math.min(startColumn, lines[2].length),
    starts[3],
    starts[4] + startColumn,
  ];

  for (let iteration = 0; iteration < 20; iteration += 1) {
    await page.setViewportSize(viewports[iteration % viewports.length]);
    await load(page, source);
    const before = await saved(page);
    await caret(page, ".mm-code-block-pre code", startColumn);
    await page.evaluate(() => {
      const dom = window.markdownMint.view.dom;
      window.__markdownMintVerticalKeys = [];
      dom.addEventListener("keydown", (event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown")
          window.__markdownMintVerticalKeys.push({
            key: event.key,
            defaultPrevented: event.defaultPrevented,
          });
      });
    });
    let state = await selection(page);
    assert.equal(state.parent, "code_block");
    assert.equal(state.offset, startColumn);

    const initialScrollTop = await page.evaluate(
      () => document.querySelector(".mm-stage")?.scrollTop ?? 0,
    );
    const codeScrollPositions = [];
    for (const expected of expectedDown) {
      await page.keyboard.press("ArrowDown");
      await settle(page);
      state = await selection(page);
      assert.equal(state.parent, "code_block");
      assert.equal(state.offset, expected);
      const layout = await page.evaluate(() => {
        const stage = document.querySelector(".mm-stage");
        const view = window.markdownMint.view;
        const rect = view.coordsAtPos(view.state.selection.head);
        const stageRect = stage?.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          stageTop: stageRect?.top ?? 0,
          stageBottom: stageRect?.bottom ?? 0,
          scrollTop: stage?.scrollTop ?? 0,
        };
      });
      codeScrollPositions.push(layout.scrollTop);
      assert.ok(
        layout.top >= layout.stageTop - 2 &&
          layout.bottom <= layout.stageBottom + 2,
        "native ArrowDown did not keep the caret in the viewport",
      );
    }
    assert.ok(
      (
        await page.evaluate(
          () => window.markdownMint.view.state.selection.constructor.name,
        )
      ).includes("TextSelection"),
      "the final code row was not reached before the boundary",
    );
    const downEvents = await page.evaluate(
      () => window.__markdownMintVerticalKeys,
    );
    assert.deepEqual(
      downEvents.map((event) => event.defaultPrevented),
      [false, false, false, false],
      "interior code rows were intercepted instead of using native movement",
    );
    const afterCodeScroll = await page.evaluate(
      () => document.querySelector(".mm-stage")?.scrollTop ?? 0,
    );
    assert.ok(
      Math.max(...codeScrollPositions, afterCodeScroll) > initialScrollTop,
      `moving to a later code row did not scroll the stage (${initialScrollTop} -> ${codeScrollPositions.join(",")} -> ${afterCodeScroll})`,
    );

    await page.keyboard.press("ArrowDown");
    state = await selection(page);
    assert.equal(
      state.parent,
      "paragraph",
      "last code row did not enter the next block",
    );
    assert.equal(state.text, "After");
    const boundaryEvent = await page.evaluate(() =>
      window.__markdownMintVerticalKeys.at(-1),
    );
    assert.deepEqual(boundaryEvent, {
      key: "ArrowDown",
      defaultPrevented: true,
    });
    await page.keyboard.press("ArrowUp");
    state = await selection(page);
    assert.equal(state.parent, "code_block");
    assert.equal(state.offset, expectedDown[3]);
    for (const expected of [
      starts[3],
      starts[2] + Math.min(startColumn, lines[2].length),
      starts[1] + startColumn,
      startColumn,
    ]) {
      await page.keyboard.press("ArrowUp");
      await settle(page);
      state = await selection(page);
      assert.equal(state.parent, "code_block");
      assert.equal(state.offset, expected);
    }
    await page.keyboard.press("ArrowUp");
    state = await selection(page);
    assert.equal(
      state.parent,
      "paragraph",
      "first code row did not enter the previous block",
    );
    assert.equal(state.text, "Before");
    const upEvents = await page.evaluate(() =>
      window.__markdownMintVerticalKeys
        .filter((event) => event.key === "ArrowUp")
        .map((event) => event.defaultPrevented),
    );
    assert.deepEqual(
      upEvents,
      [true, false, false, false, false, true],
      "interior code rows were intercepted on reverse native movement",
    );
    await noEdits(
      page,
      before,
      `native code vertical movement iteration ${iteration + 1}`,
    );
  }

  // A wrapped logical line must expose every visual row to the browser. The
  // logical end is a block edge only after the final wrapped row is reached.
  await page.setViewportSize({ width: 420, height: 420 });
  const wrappedLine =
    "const message = `This deliberately long JavaScript line keeps moving " +
    "through wrapped visual rows while preserving the desired column`;";
  const wrappedSource = blocks(
    "Before",
    fence("javascript", wrappedLine),
    "After",
  );
  await load(page, wrappedSource);
  const wrappedBefore = await saved(page);
  const wrappedBlock = page.locator(".mm-code-block").first();
  await wrappedBlock.locator('[data-mm-code-action="more"]').click();
  await wrappedBlock.locator('[data-mm-code-menu-option="wrap"]').click();
  await settle(page);
  const wrappedRows = await page.evaluate(() => {
    const code = document.querySelector(".mm-code-block-pre code");
    if (!code) return 0;
    const range = document.createRange();
    range.selectNodeContents(code);
    return new Set(
      Array.from(range.getClientRects()).map((rect) => Math.round(rect.top)),
    ).size;
  });
  assert.ok(
    wrappedRows >= 3,
    `wrapped fixture has only ${wrappedRows} visual rows`,
  );
  await caret(page, ".mm-code-block-pre code", 5);
  await page.evaluate(() => {
    const dom = window.markdownMint.view.dom;
    window.__markdownMintVerticalKeys = [];
    dom.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown")
        window.__markdownMintVerticalKeys.push({
          key: event.key,
          defaultPrevented: event.defaultPrevented,
        });
    });
  });
  let wrappedState = await selection(page);
  let previousOffset = wrappedState.offset;
  let previousTop = await page.evaluate(() => {
    const view = window.markdownMint.view;
    return view.coordsAtPos(view.state.selection.head).top;
  });
  for (let row = 0; row < 3; row += 1) {
    await page.keyboard.press("ArrowDown");
    await settle(page);
    wrappedState = await selection(page);
    assert.equal(wrappedState.parent, "code_block");
    assert.ok(
      wrappedState.offset > previousOffset,
      "wrapped ArrowDown did not advance within the logical line",
    );
    const currentTop = await page.evaluate(() => {
      const view = window.markdownMint.view;
      return view.coordsAtPos(view.state.selection.head).top;
    });
    assert.ok(
      currentTop > previousTop + 1,
      "wrapped ArrowDown stayed on the same visual row",
    );
    previousOffset = wrappedState.offset;
    previousTop = currentTop;
  }
  const wrappedEvents = await page.evaluate(
    () => window.__markdownMintVerticalKeys,
  );
  assert.deepEqual(
    wrappedEvents.map((event) => event.defaultPrevented),
    [false, false, false],
    "wrapped interior rows were intercepted instead of using native movement",
  );
  await noEdits(page, wrappedBefore, "wrapped code interior movement");
  await page.setViewportSize({ width: 960, height: 900 });
}

async function testSelectionAndModifiers(page) {
  const source = blocks("Before", alert("alpha beta"), "After");
  await load(page, source);
  const before = await saved(page);
  await caret(page, alertBody, 0, 5);
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    (await selection(page)).active,
    "mm-alert-body-editor",
    "range collapse must stay in Alert",
  );
  await caret(page, alertBody, 1);
  await page.keyboard.press("Shift+ArrowLeft");
  const range = await selection(page);
  assert.equal(range.active, "mm-alert-body-editor");
  assert.equal(range.inputEnd - range.inputStart, 1);
  await caret(page, alertBody, 0);
  await page.keyboard.press("Alt+ArrowLeft");
  assert.equal(
    (await selection(page)).active,
    "mm-alert-body-editor",
    "modified arrow was intercepted by block navigation",
  );
  await noEdits(page, before, "selection and modified arrows");
}

async function testRichEditorLinks(page) {
  await load(page, "[README](../README.md)");
  const plainBefore = await saved(page);
  const plainLink = page.locator(`${rich} a[href]`);
  await plainLink.click();
  await noEdits(page, plainBefore, "plain Rich Editor link click");
  assert.equal(
    await page.evaluate(
      () =>
        window.__markdownMintHarness.messages.filter(
          (message) => message.type === "open-link",
        ).length,
    ),
    0,
    "plain link click sent an open-link message",
  );

  await load(page, "[README](../README.md)");
  const relativeBefore = await saved(page);
  await page
    .locator(`${rich} a[href]`)
    .click({ modifiers: [primaryLinkModifier] });
  await page.waitForFunction(
    () =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "open-link",
      ).length === 1,
  );
  const relativeOpen = await page.evaluate(() =>
    window.__markdownMintHarness.messages.find(
      (message) => message.type === "open-link",
    ),
  );
  assert.deepEqual(relativeOpen, {
    protocolVersion: 1,
    type: "open-link",
    href: "../README.md",
  });
  await noEdits(
    page,
    relativeBefore,
    "modified relative Rich Editor link click",
  );

  await load(page, "[Example](https://example.com)");
  const externalBefore = await saved(page);
  await page
    .locator(`${rich} a[href]`)
    .click({ modifiers: [primaryLinkModifier] });
  await page.waitForFunction(
    () =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "open-link",
      ).length === 1,
  );
  const externalOpen = await page.evaluate(() =>
    window.__markdownMintHarness.messages.find(
      (message) => message.type === "open-link",
    ),
  );
  assert.equal(externalOpen.href, "https://example.com");
  await noEdits(
    page,
    externalBefore,
    "modified external Rich Editor link click",
  );

  await load(page, "[Section](#section)\n\n# Section");
  const fragmentBefore = await saved(page);
  await page.evaluate(() => {
    const target = document.querySelector("#section");
    if (!target) throw new Error("heading fragment target is not rendered");
    window.__markdownMintFragmentScrolls = 0;
    target.scrollIntoView = () => {
      window.__markdownMintFragmentScrolls += 1;
    };
  });
  await page
    .locator(`${rich} a[href="#section"]`)
    .click({ modifiers: [primaryLinkModifier] });
  await page.waitForFunction(() => window.__markdownMintFragmentScrolls === 1);
  assert.equal(
    await page.evaluate(
      () =>
        window.__markdownMintHarness.messages.filter(
          (message) => message.type === "open-link",
        ).length,
    ),
    0,
  );
  await noEdits(page, fragmentBefore, "heading fragment navigation");

  await load(page, "[[_TOC_]]\n\n# Section", "gitlab");
  const tocBefore = await saved(page);
  await page.evaluate(() => {
    const target = document.querySelector("#section");
    if (!target) throw new Error("TOC fragment target is not rendered");
    window.__markdownMintFragmentScrolls = 0;
    target.scrollIntoView = () => {
      window.__markdownMintFragmentScrolls += 1;
    };
  });
  await page
    .locator(`${rich} .table-of-contents a[href]`)
    .click({ modifiers: [primaryLinkModifier] });
  await page.waitForFunction(() => window.__markdownMintFragmentScrolls === 1);
  assert.equal(
    await page.evaluate(
      () =>
        window.__markdownMintHarness.messages.filter(
          (message) => message.type === "open-link",
        ).length,
    ),
    0,
  );
  await noEdits(page, tocBefore, "TOC fragment navigation");
}

async function testModalEscapeCancellation(page) {
  const discardChanges = async () => {
    const confirmation = page.locator(".mm-discard-changes-dialog[open]");
    await confirmation.waitFor({ state: "visible" });
    await confirmation.locator("button", { hasText: "Discard" }).click();
    await confirmation.waitFor({ state: "detached" });
  };
  const expectEditorContinuation = async (expected, label) => {
    await caret(page, `${rich} > p:first-child`, -1);
    await page.keyboard.type("X");
    await expectSource(page, expected);
    assert.equal(
      await page.locator("dialog[open]").count(),
      0,
      `${label}: dialog reopened while continuing to edit`,
    );
  };

  await load(page, "Before");
  await caret(page, `${rich} > p:first-child`, -1);
  const linkBefore = await saved(page);
  const linkButton = page.locator('[data-testid="toolbar-link"]');
  await linkButton.click();
  const linkDialog = page.locator(
    'dialog[aria-labelledby="mm-link-dialog-title"]',
  );
  await linkDialog.waitFor({ state: "visible" });
  await linkDialog.locator("input").first().fill("./changed.md");
  await page.keyboard.press("Escape");
  await page.locator(".mm-discard-changes-dialog[open]").waitFor({
    state: "visible",
  });
  assert.equal(
    await linkDialog.getAttribute("open"),
    "",
    "Link Escape closed the editor before discard was confirmed",
  );
  await discardChanges();
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    "Link Escape left an open dialog",
  );
  assert.equal(
    await linkButton.evaluate((element) => document.activeElement === element),
    true,
    "Link Escape did not restore focus to its invoker",
  );
  await noEdits(page, linkBefore, "Link modal Escape cancellation");
  await expectEditorContinuation("BeforeX", "Link modal Escape");

  await load(page, "Before");
  await caret(page, `${rich} > p:first-child`, -1);
  const imageBefore = await saved(page);
  const imageButton = page.locator('[data-testid="toolbar-image"]');
  await imageButton.click();
  const imageDialog = page.locator(
    'dialog[aria-labelledby="mm-image-dialog-title"]',
  );
  await imageDialog.waitFor({ state: "visible" });
  await imageDialog.locator("input").first().fill("./changed.png");
  await page.keyboard.press("Escape");
  await page.locator(".mm-discard-changes-dialog[open]").waitFor({
    state: "visible",
  });
  await discardChanges();
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    "Image Escape left an open dialog",
  );
  assert.equal(
    await imageButton.evaluate((element) => document.activeElement === element),
    true,
    "Image Escape did not restore focus to its invoker",
  );
  await noEdits(page, imageBefore, "Image modal Escape cancellation");
  await expectEditorContinuation("BeforeX", "Image modal Escape");

  await load(page, "Before");
  const tableBefore = await saved(page);
  const tableButton = page.locator('[data-testid="toolbar-table"]');
  await tableButton.click();
  await page.locator(".mm-table-dialog[open]").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    "Table Escape left an open dialog",
  );
  await noEdits(page, tableBefore, "Table modal Escape cancellation");
  await expectEditorContinuation("BeforeX", "Table modal Escape");

  await load(page, "Before");
  const emojiBefore = await saved(page);
  const emojiButton = page.locator('[data-testid="toolbar-emoji"]');
  await emojiButton.click();
  await page.locator(".mm-emoji-dialog[open]").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    "Emoji Escape left an open dialog",
  );
  assert.equal(
    await emojiButton.evaluate((element) => document.activeElement === element),
    true,
    "Emoji Escape did not restore focus to its invoker",
  );
  await emojiButton.click();
  const emojiCancelDialog = page.locator(".mm-emoji-dialog[open]");
  await emojiCancelDialog.waitFor({ state: "visible" });
  await emojiCancelDialog.getByRole("button", { name: "Cancel" }).click();
  await emojiCancelDialog.waitFor({ state: "hidden" });
  assert.equal(
    await emojiButton.evaluate((element) => document.activeElement === element),
    true,
    "Emoji Cancel did not restore focus to its invoker",
  );
  await noEdits(page, emojiBefore, "Emoji modal Escape cancellation");
  await expectEditorContinuation("BeforeX", "Emoji modal Escape");

  await load(page, "Before");
  const mermaidBefore = await saved(page);
  const mermaidButton = page.locator('[data-profile-feature="mermaid"]');
  await mermaidButton.click();
  const mermaidDialog = page.locator('[data-feature-dialog="true"][open]');
  await mermaidDialog.waitFor({ state: "visible" });
  await mermaidDialog
    .locator('[data-feature-field="body"]')
    .fill("flowchart TD\n    A --> B");
  await page.keyboard.press("Escape");
  await page.locator(".mm-discard-changes-dialog[open]").waitFor({
    state: "visible",
  });
  await discardChanges();
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    "ProfileFeature Escape left an open dialog",
  );
  await noEdits(
    page,
    mermaidBefore,
    "ProfileFeature modal Escape cancellation",
  );
  await expectEditorContinuation("BeforeX", "ProfileFeature modal Escape");
}

async function testModalBackdropCancellation(page) {
  await load(page, "Before");
  await caret(page, `${rich} > p:first-child`, -1);
  const linkButton = page.locator('[data-testid="toolbar-link"]');
  await linkButton.click();
  const dialog = page.locator('dialog[aria-labelledby="mm-link-dialog-title"]');
  await dialog.waitFor({ state: "visible" });
  const box = await dialog.boundingBox();
  assert.ok(box, "Link dialog has no browser geometry");

  await page.mouse.click(box.x + 20, box.y + 20);
  assert.equal(
    await dialog.getAttribute("open"),
    "",
    "dialog-internal click was treated as backdrop",
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await linkButton.click();
  const dragDialog = page.locator(
    'dialog[aria-labelledby="mm-link-dialog-title"]',
  );
  await dragDialog.waitFor({ state: "visible" });
  const dragBox = await dragDialog.boundingBox();
  assert.ok(dragBox, "Link dialog has no geometry for drag regression");
  await page.mouse.move(dragBox.x + 20, dragBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(Math.max(5, dragBox.x - 20), dragBox.y + 20);
  await page.mouse.up();
  assert.equal(
    await dragDialog.getAttribute("open"),
    "",
    "inside-to-outside drag was treated as backdrop cancel",
  );
  await page.keyboard.press("Escape");
  await dragDialog.waitFor({ state: "hidden" });

  await linkButton.click();
  const cleanDialog = page.locator(
    'dialog[aria-labelledby="mm-link-dialog-title"]',
  );
  await cleanDialog.waitFor({ state: "visible" });
  const cleanBox = await cleanDialog.boundingBox();
  assert.ok(cleanBox, "Link dialog has no geometry for clean backdrop test");
  await page.mouse.click(Math.max(5, cleanBox.x - 20), cleanBox.y + 20);
  await cleanDialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.locator(".mm-discard-changes-dialog[open]").count(),
    0,
    "clean backdrop cancel opened discard confirmation",
  );

  await linkButton.click();
  const dirtyDialog = page.locator(
    'dialog[aria-labelledby="mm-link-dialog-title"]',
  );
  await dirtyDialog.waitFor({ state: "visible" });
  await dirtyDialog.locator("input").first().fill("./changed.md");
  const dirtyBox = await dirtyDialog.boundingBox();
  assert.ok(dirtyBox, "Link dialog has no geometry for dirty backdrop test");
  await page.mouse.click(Math.max(5, dirtyBox.x - 20), dirtyBox.y + 20);
  const confirmation = page.locator(".mm-discard-changes-dialog[open]");
  await confirmation.waitFor({ state: "visible" });
  assert.equal(
    await dirtyDialog.getAttribute("open"),
    "",
    "dirty backdrop closed Link before confirmation",
  );
  await confirmation.locator("button", { hasText: "Keep editing" }).click();
  assert.equal(
    await dirtyDialog.locator("input").first().inputValue(),
    "./changed.md",
    "Keep editing lost the Link draft",
  );
  await dirtyDialog
    .locator(".mm-dialog-actions button", { hasText: "Cancel" })
    .click();
  await page
    .locator(".mm-discard-changes-dialog[open]")
    .locator("button", { hasText: "Discard" })
    .click();
  await dirtyDialog.waitFor({ state: "hidden" });

  await load(page, "Before");
  const emojiButton = page.locator('[data-testid="toolbar-emoji"]');
  await emojiButton.click();
  const emojiDialog = page.locator(".mm-emoji-dialog[open]");
  await emojiDialog.waitFor({ state: "visible" });
  await emojiDialog.locator(".mm-emoji-search").fill("rocket");
  const emojiBox = await emojiDialog.boundingBox();
  assert.ok(emojiBox, "Emoji dialog has no browser geometry");
  await page.mouse.click(Math.max(5, emojiBox.x - 20), emojiBox.y + 20);
  await emojiDialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.locator(".mm-discard-changes-dialog[open]").count(),
    0,
    "Emoji backdrop opened discard confirmation",
  );
  assert.equal(
    await emojiButton.evaluate((element) => document.activeElement === element),
    true,
    "Emoji backdrop did not restore focus to its invoker",
  );
}

async function testModalKeyboardActivation(page) {
  await load(page, "Before");
  await caret(page, `${rich} > p:first-child`, -1);
  const linkButton = page.locator('[data-testid="toolbar-link"]');
  await linkButton.click();
  const linkDialog = page.locator(
    'dialog[aria-labelledby="mm-link-dialog-title"]',
  );
  await linkDialog.waitFor({ state: "visible" });
  const linkUrl = linkDialog.locator("input").first();
  const linkText = linkDialog.locator('input[placeholder="Selected text"]');
  await linkUrl.fill("https://example.com");
  await linkText.fill("Keyboard link");
  await linkText.focus();
  for (let index = 0; index < 3; index += 1) await page.keyboard.press("Tab");
  const insertLink = linkDialog.getByRole("button", { name: "Insert link" });
  assert.equal(
    await insertLink.evaluate((element) => document.activeElement === element),
    true,
    "Tab did not focus Insert link",
  );
  await page.keyboard.press("Enter");
  await linkDialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.locator(".mm-discard-changes-dialog[open]").count(),
    0,
    "keyboard Insert link opened discard confirmation",
  );
  await expectSource(page, "Before[Keyboard link](https://example.com)");

  await load(page, "Before");
  await caret(page, `${rich} > p:first-child`, -1);
  await linkButton.click();
  await linkDialog.waitFor({ state: "visible" });
  await linkDialog.locator("input").first().fill("./discarded.md");
  await linkDialog.getByRole("button", { name: "Cancel" }).click();
  const discardConfirmation = page.locator(".mm-discard-changes-dialog[open]");
  await discardConfirmation.waitFor({ state: "visible" });
  const discardButton = discardConfirmation.getByRole("button", {
    name: "Discard",
  });
  await page.keyboard.press("Tab");
  assert.equal(
    await discardButton.evaluate(
      (element) => document.activeElement === element,
    ),
    true,
    "Tab did not focus Discard",
  );
  await page.keyboard.press("Enter");
  await discardConfirmation.waitFor({ state: "detached" });
  await linkDialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    "keyboard Discard left an open dialog",
  );

  await load(page, "Before");
  await caret(page, `${rich} > p:first-child`, -1);
  await linkButton.click();
  await linkDialog.waitFor({ state: "visible" });
  const keptUrl = linkDialog.locator("input").first();
  await keptUrl.fill("./kept.md");
  await linkDialog.getByRole("button", { name: "Cancel" }).click();
  const keepConfirmation = page.locator(".mm-discard-changes-dialog[open]");
  await keepConfirmation.waitFor({ state: "visible" });
  const keepButton = keepConfirmation.getByRole("button", {
    name: "Keep editing",
  });
  assert.equal(
    await keepButton.evaluate((element) => document.activeElement === element),
    true,
    "Keep editing was not focused in the discard confirmation",
  );
  await page.keyboard.press("Enter");
  await keepConfirmation.waitFor({ state: "detached" });
  assert.equal(await linkDialog.isVisible(), true, "Keep editing closed Link");
  assert.equal(await keptUrl.inputValue(), "./kept.md");
  assert.equal(
    await keptUrl.evaluate((element) => document.activeElement === element),
    true,
    "Keep editing did not restore Link focus",
  );
  await linkDialog.getByRole("button", { name: "Cancel" }).click();
  await keepConfirmation.waitFor({ state: "visible" });
  await keepConfirmation.getByRole("button", { name: "Discard" }).click();
  await keepConfirmation.waitFor({ state: "detached" });

  await load(page, "Before");
  const tableButton = page.locator('[data-testid="toolbar-table"]');
  await tableButton.click();
  const tableDialog = page.locator(".mm-table-dialog[open]");
  await tableDialog.waitFor({ state: "visible" });
  await tableDialog.locator('input[type="number"]').first().fill("4");
  const insertTable = tableDialog.getByRole("button", { name: "Insert table" });
  await insertTable.focus();
  await page.keyboard.press("Enter");
  await tableDialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.locator(".mm-discard-changes-dialog[open]").count(),
    0,
    "keyboard Insert table opened discard confirmation",
  );
  await page.waitForFunction(
    () =>
      !window.markdownMint.sync.hasPending &&
      window.__markdownMintHarness.document.markdown.includes("|"),
  );
}

async function testWorkspaceFileAutocomplete(page) {
  await load(page, "Target");
  await caret(page, `${rich} > p`, 0, -1);
  await page.locator('[data-testid="toolbar-link"]').click();
  const linkPicker = page.locator('[data-testid="link-selection-picker"]');
  await linkPicker.waitFor({ state: "visible" });
  assert.equal(
    await page
      .locator('dialog[aria-labelledby="mm-link-dialog-title"]:visible')
      .count(),
    0,
    "selected text opens the lightweight picker",
  );
  assert.equal(
    await linkPicker.locator('input[placeholder="Selected text"]').count(),
    0,
    "selected text does not show a second Link text field",
  );
  assert.ok(
    await page.evaluate(() =>
      window.__markdownMintHarness.messages.some(
        (message) => message.type === "workspace-file-search-warmup",
      ),
    ),
    "opening the Link picker did not start workspace search warmup",
  );
  const linkInput = linkPicker.locator('[data-testid="link-picker-input"]');
  await page.evaluate(() => {
    window.__markdownMintDebugFileSearch = true;
    performance.clearMarks();
  });
  await linkInput.fill("ho");
  const linkOptions = linkPicker.locator(".mm-file-autocomplete-option");
  await linkOptions.first().waitFor({ state: "visible" });
  const searchTiming = await page.evaluate(() => {
    const phases = new Map();
    for (const entry of performance.getEntriesByType("mark")) {
      const match = entry.name.match(
        /^markdown-mint:file-search:(\d+):(input|dom-update)$/,
      );
      if (!match) continue;
      const [, id, phase] = match;
      const current = phases.get(id) ?? {};
      current[phase] = entry.startTime;
      phases.set(id, current);
    }
    return [...phases.values()].at(-1) ?? {};
  });
  assert.ok(
    Number.isFinite(searchTiming.input) &&
      Number.isFinite(searchTiming["dom-update"]),
    "file search timing marks were not recorded",
  );
  assert.ok(
    searchTiming["dom-update"] - searchTiming.input <= 100,
    `cached workspace search rendered too slowly: ${searchTiming["dom-update"] - searchTiming.input}ms`,
  );
  assert.equal(
    await linkOptions
      .first()
      .locator(".mm-file-autocomplete-name")
      .textContent(),
    "hoge.pdf",
  );
  assert.ok((await linkOptions.count()) > 1, "multiple link candidates render");
  assert.equal(
    await linkPicker
      .locator(".mm-file-autocomplete")
      .evaluate((element) => getComputedStyle(element).position),
    "static",
    "candidate list stays in the picker layout",
  );
  const listStyle = await linkPicker
    .locator(".mm-file-autocomplete")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        boxShadow: style.boxShadow,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
      };
    });
  assert.equal(
    listStyle.boxShadow,
    "none",
    "candidate list has a panel shadow",
  );
  assert.equal(
    listStyle.borderStyle,
    "none",
    "candidate list retains a strong outer border",
  );
  assert.equal(
    listStyle.borderRadius,
    "0px",
    "candidate list retains rounded corners",
  );
  assert.equal(
    await linkPicker
      .locator(".mm-file-autocomplete")
      .getAttribute("data-search-state"),
    "results",
  );
  const initialFooter = await linkPicker
    .locator(".mm-file-autocomplete-footer")
    .textContent();
  assert.equal(initialFooter, "../specs/hoge.pdf");
  await linkOptions.first().hover();
  await linkInput.press("ArrowDown");
  assert.equal(await linkPicker.locator(".is-active").count(), 1);
  assert.equal(
    await linkPicker
      .locator(".is-active .mm-file-autocomplete-name")
      .textContent(),
    "hoge-design.md",
  );
  assert.equal(
    await linkPicker.locator(".mm-file-autocomplete-footer").textContent(),
    "../docs/hoge-design.md",
    "footer did not follow the active candidate",
  );
  const linkOptionBackgrounds = await linkOptions.evaluateAll((options) =>
    options.map((option) => getComputedStyle(option).backgroundColor),
  );
  assert.notEqual(
    linkOptionBackgrounds[0],
    linkOptionBackgrounds[1],
    "a stationary hover does not add a second active highlight",
  );
  await linkOptions.first().hover();
  assert.equal(await linkPicker.locator(".is-active").count(), 1);
  assert.equal(
    await linkPicker
      .locator(".is-active .mm-file-autocomplete-name")
      .textContent(),
    "hoge.pdf",
    "real pointer movement changes the active candidate",
  );
  await linkOptions.nth(1).hover();
  await linkInput.press("Enter");
  assert.equal(
    await linkPicker.isVisible(),
    false,
    "selected text applies through the active candidate",
  );
  await expectSource(page, "[Target](../docs/hoge-design.md)");

  await load(page, "Target");
  await caret(page, `${rich} > p`, 0, -1);
  await page.locator('[data-testid="toolbar-link"]').click();
  const clickPicker = page.locator('[data-testid="link-selection-picker"]');
  const clickInput = clickPicker.locator('[data-testid="link-picker-input"]');
  await clickInput.fill("ho");
  const clickOptions = clickPicker.locator(".mm-file-autocomplete-option");
  await clickOptions.first().waitFor({ state: "visible" });
  await clickOptions.nth(1).click();
  await expectSource(page, "[Target](../docs/hoge-design.md)");

  await load(page, "Target");
  await caret(page, `${rich} > p`, 0, -1);
  await page.locator('[data-testid="toolbar-link"]').click();
  const externalPicker = page.locator('[data-testid="link-selection-picker"]');
  await externalPicker.waitFor({ state: "visible" });
  const externalInput = externalPicker.locator(
    '[data-testid="link-picker-input"]',
  );
  await externalInput.fill("https://example.com");
  await externalInput.press("Enter");
  await expectSource(page, "[Target](https://example.com)");

  await load(page, "Target");
  await caret(page, `${rich} > p`, 0, -1);
  await page.locator('[data-testid="toolbar-link"]').click();
  const scrollPicker = page.locator('[data-testid="link-selection-picker"]');
  await scrollPicker.waitFor({ state: "visible" });
  const scrollInput = scrollPicker.locator('[data-testid="link-picker-input"]');
  await scrollInput.fill("candidate");
  const scrollOptions = scrollPicker.locator(".mm-file-autocomplete-option");
  await scrollOptions.first().waitFor({ state: "visible" });
  const beforeScroll = await page.evaluate(() => ({
    window: window.scrollY,
    document: document.documentElement.scrollTop,
    body: document.body.scrollTop,
    stage: document.querySelector(".mm-stage")?.scrollTop ?? 0,
  }));
  for (let index = 0; index < 9; index += 1)
    await scrollInput.press("ArrowDown");
  const afterScroll = await page.evaluate(() => ({
    window: window.scrollY,
    document: document.documentElement.scrollTop,
    body: document.body.scrollTop,
    stage: document.querySelector(".mm-stage")?.scrollTop ?? 0,
    list:
      document.querySelector(
        '[data-testid="link-selection-picker"] .mm-file-autocomplete',
      )?.scrollTop ?? 0,
  }));
  assert.deepEqual(
    {
      window: afterScroll.window,
      document: afterScroll.document,
      body: afterScroll.body,
      stage: afterScroll.stage,
    },
    {
      window: beforeScroll.window,
      document: beforeScroll.document,
      body: beforeScroll.body,
      stage: beforeScroll.stage,
    },
    "candidate navigation does not scroll the editor or outer viewport",
  );
  assert.ok(afterScroll.list > 0, "only the candidate list scrolls");
  await scrollInput.press("Escape");

  await load(page, "Target");
  await caret(page, `${rich} > p`, -1);
  const linkBefore = await saved(page);
  await page.locator('[data-testid="toolbar-link"]').click();
  const linkDialog = page.locator(
    'dialog[aria-labelledby="mm-link-dialog-title"]',
  );
  await linkDialog.waitFor({ state: "visible" });
  const linkText = linkDialog.locator('input[placeholder="Selected text"]');
  const linkModalInput = linkDialog.locator("input").first();
  await linkText.fill("Custom label");
  await linkModalInput.fill("ho");
  const linkModalOptions = linkDialog.locator(".mm-file-autocomplete-option");
  await linkModalOptions.first().waitFor({ state: "visible" });
  assert.equal(
    await linkDialog
      .locator(".mm-file-autocomplete")
      .evaluate((element) => getComputedStyle(element).position),
    "static",
    "modal candidate list stays in normal layout",
  );
  await linkModalInput.press("Enter");
  assert.equal(await linkDialog.isVisible(), true);
  assert.equal(await linkModalInput.inputValue(), "../specs/hoge.pdf");
  assert.equal(await linkText.inputValue(), "Custom label");
  await noEdits(page, linkBefore, "link modal candidate selection");
  await linkDialog.getByRole("button", { name: "Insert link" }).click();
  await expectSource(page, "Target[Custom label](../specs/hoge.pdf)");

  await load(page, "Target");
  await caret(page, `${rich} > p`, 0, -1);
  const imageBefore = await saved(page);
  await page.locator('[data-testid="toolbar-image"]').click();
  const imageDialog = page.locator(
    'dialog[aria-labelledby="mm-image-dialog-title"]',
  );
  await imageDialog.waitFor({ state: "visible" });
  const imageInput = imageDialog.locator("input").first();
  const altInput = imageDialog.locator("input").nth(1);
  await altInput.fill("Keep alt");
  await imageInput.fill("lo");
  const imageOptions = imageDialog.locator(".mm-file-autocomplete-option");
  await imageOptions.first().waitFor({ state: "visible" });
  assert.equal(
    await imageOptions
      .first()
      .locator(".mm-file-autocomplete-name")
      .textContent(),
    "logo.png",
  );
  assert.ok(
    (await imageOptions.count()) > 1,
    "multiple image candidates render",
  );
  assert.equal(
    await imageDialog
      .locator(".mm-file-autocomplete")
      .evaluate((element) => getComputedStyle(element).position),
    "static",
    "image candidate list stays in normal layout",
  );
  await imageOptions.nth(1).hover();
  assert.equal(await imageDialog.locator(".is-active").count(), 1);
  assert.equal(
    await imageDialog
      .locator(".is-active .mm-file-autocomplete-name")
      .textContent(),
    "logo-dark.svg",
  );
  await imageInput.press("Enter");
  assert.equal(await imageInput.inputValue(), "../assets/logo-dark.svg");
  assert.equal(await altInput.inputValue(), "Keep alt");
  await noEdits(page, imageBefore, "image autocomplete selection");
  await imageDialog.getByRole("button", { name: "Insert image" }).click();
  await expectSource(page, "![Keep alt](../assets/logo-dark.svg)");

  await load(page, "Target");
  await caret(page, `${rich} > p`, 0, -1);
  await page.locator('[data-testid="toolbar-link"]').click();
  const excludedPicker = page.locator('[data-testid="link-selection-picker"]');
  const excludedInput = excludedPicker.locator(
    '[data-testid="link-picker-input"]',
  );
  await excludedInput.fill("guide");
  const excludedList = excludedPicker.locator(".mm-file-autocomplete");
  await excludedList.waitFor({ state: "visible" });
  assert.equal(
    await excludedList.locator(".mm-file-autocomplete-option").count(),
    0,
    ".git/node_modules candidates leaked into the picker",
  );
  assert.equal(
    await excludedList.getAttribute("data-search-state"),
    "empty",
    "excluded-only query did not resolve to the empty state",
  );
}

async function testWorkspaceFileAutocompleteLoading(page) {
  await load(page, "Target", "github", "rich", 1000);
  await caret(page, `${rich} > p`, 0, -1);
  const pickerBefore = await saved(page);
  await page.locator('[data-testid="toolbar-link"]').click();
  const picker = page.locator('[data-testid="link-selection-picker"]');
  const pickerInput = picker.locator('[data-testid="link-picker-input"]');
  await pickerInput.fill("ho");
  await pickerInput.press("Enter");
  assert.equal(
    await picker.isVisible(),
    true,
    "loading Enter closed the selected-text picker",
  );
  await noEdits(page, pickerBefore, "selected-text loading Enter");
  const pickerOptions = picker.locator(".mm-file-autocomplete-option");
  await pickerOptions.first().waitFor({ state: "visible" });
  assert.equal(
    await picker.isVisible(),
    true,
    "a delayed result replayed the ignored selected-text Enter",
  );
  await pickerInput.press("Enter");
  await expectSource(page, "[Target](../specs/hoge.pdf)");

  const assertLoadingModal = async (kind, query, label) => {
    await load(page, "Target", "github", "rich", 1000);
    await caret(page, `${rich} > p`, -1);
    const before = await saved(page);
    await page.locator(`[data-testid="toolbar-${kind}"]`).click();
    const dialog = page.locator(
      `dialog[aria-labelledby="mm-${kind}-dialog-title"]`,
    );
    await dialog.waitFor({ state: "visible" });
    const destination = dialog.locator("input").first();
    if (kind === "link")
      await dialog.locator('input[placeholder="Selected text"]').fill("Label");
    else await dialog.locator("input").nth(1).fill("Alt text");
    await destination.fill(query);

    await destination.press("Enter");
    await noEdits(page, before, `${label} plain Enter`);
    assert.equal(
      await dialog.isVisible(),
      true,
      `${label} plain Enter closed the dialog`,
    );

    await destination.press(`${primaryLinkModifier}+Enter`);
    await noEdits(page, before, `${label} modified Enter`);
    assert.equal(
      await dialog.isVisible(),
      true,
      `${label} modified Enter closed the dialog`,
    );

    await dialog
      .getByRole("button", {
        name: kind === "link" ? "Insert link" : "Insert image",
      })
      .click();
    await noEdits(page, before, `${label} button submit`);
    assert.equal(
      await dialog.isVisible(),
      true,
      `${label} button submit closed the dialog`,
    );

    await dialog.locator(".mm-file-autocomplete-option").first().waitFor({
      state: "visible",
    });
    await noEdits(page, before, `${label} delayed result`);
    await page.keyboard.press("Escape");
    const discardConfirmation = page.locator(
      ".mm-discard-changes-dialog[open]",
    );
    await discardConfirmation.waitFor({ state: "visible" });
    await discardConfirmation.locator("button", { hasText: "Discard" }).click();
    await discardConfirmation.waitFor({ state: "detached" });
    assert.equal(
      await page.locator("dialog[open]").count(),
      0,
      `${label} could not be cancelled after the delayed result`,
    );
  };

  await assertLoadingModal("link", "ho", "link modal loading");
  await assertLoadingModal("image", "lo", "image modal loading");
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

function summarizeTimings(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
    over100: values.filter((value) => value > 100).length,
  };
}

async function loadFileSearchBenchmark(page, source, fileCount) {
  await page.goto(`${baseUrl}/?workspaceFiles=${fileCount}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => window.markdownMint?.view);
  await page.evaluate(
    ([markdown]) => window.__markdownMintHarness.deliverExternal(markdown),
    [source],
  );
  await page.waitForFunction(
    (expected) => window.__markdownMintHarness.document.markdown === expected,
    source,
  );
  await settle(page);
}

async function benchmarkFileSearchSurface(page, surface, fileCount, samples) {
  const source = "Target";
  await loadFileSearchBenchmark(page, source, fileCount);
  let input;
  if (surface === "selected-text picker") {
    await caret(page, `${rich} > p`, 0, -1);
    await page.locator('[data-testid="toolbar-link"]').click();
    const picker = page.locator('[data-testid="link-selection-picker"]');
    await picker.waitFor({ state: "visible" });
    input = picker.locator('[data-testid="link-picker-input"]');
  } else if (surface === "Link modal") {
    await caret(page, `${rich} > p`, -1);
    await page.locator('[data-testid="toolbar-link"]').click();
    const dialog = page.locator(
      'dialog[aria-labelledby="mm-link-dialog-title"]',
    );
    await dialog.waitFor({ state: "visible" });
    input = dialog.locator("input").first();
  } else {
    await caret(page, `${rich} > p`, -1);
    await page.locator('[data-testid="toolbar-image"]').click();
    const dialog = page.locator(
      'dialog[aria-labelledby="mm-image-dialog-title"]',
    );
    await dialog.waitFor({ state: "visible" });
    input = dialog.locator("input").first();
  }

  await page.evaluate(() => {
    window.__markdownMintDebugFileSearch = true;
    performance.clearMarks();
    performance.clearMeasures();
  });
  const options = page.locator(".mm-file-autocomplete-option");
  for (let sample = 0; sample < samples; sample += 1) {
    await input.fill("");
    await input.fill("benchmark");
    await options.first().waitFor({ state: "visible" });
  }
  await settle(page);
  const measurements = await page.evaluate(() => {
    const byId = new Map();
    for (const entry of performance.getEntriesByType("mark")) {
      const match = entry.name.match(
        /^markdown-mint:file-search:(\d+):(input|host-result|dom-update|paint-opportunity)$/,
      );
      if (!match) continue;
      const [, id, phase] = match;
      const current = byId.get(id) ?? {};
      current[phase] = entry.startTime;
      byId.set(id, current);
    }
    return [...byId.values()]
      .filter(
        (timing) =>
          Number.isFinite(timing.input) &&
          Number.isFinite(timing["host-result"]) &&
          Number.isFinite(timing["dom-update"]) &&
          Number.isFinite(timing["paint-opportunity"]),
      )
      .map((timing) => ({
        hostRoundTrip: timing["host-result"] - timing.input,
        domMutation: timing["dom-update"] - timing["host-result"],
        paintOpportunity: timing["paint-opportunity"] - timing.input,
      }));
  });
  assert.ok(
    measurements.length >= samples,
    `${surface} ${fileCount} benchmark produced ${measurements.length}/${samples} complete timings`,
  );

  await input.press("Escape");
  await page.evaluate(() => {
    window.__markdownMintDebugFileSearch = false;
  });
  return {
    hostRoundTrip: measurements.map((timing) => timing.hostRoundTrip),
    domMutation: measurements.map((timing) => timing.domMutation),
    paintOpportunity: measurements.map((timing) => timing.paintOpportunity),
  };
}

async function testWorkspaceFileAutocompleteBenchmark(page) {
  const samples = Math.max(
    20,
    Number.parseInt(process.env.MM_FILE_SEARCH_BENCHMARK_SAMPLES ?? "30", 10),
  );
  const surfaces = ["Link modal", "Image modal", "selected-text picker"];
  const rows = [];
  for (const fileCount of [1000, 10000, 50000]) {
    for (const surface of surfaces) {
      const timings = await benchmarkFileSearchSurface(
        page,
        surface,
        fileCount,
        samples,
      );
      for (const [metric, values] of Object.entries(timings))
        rows.push({ fileCount, surface, metric, ...summarizeTimings(values) });
    }
  }

  console.log(
    "File autocomplete browser harness benchmark (cache-warm mock data)",
  );
  console.log(
    `Samples: ${samples}; hostRoundTrip is harness message handling, domMutation is Webview DOM work, and paintOpportunity is input to the next requestAnimationFrame.`,
  );
  console.log(
    "The requestAnimationFrame timestamp is a paint opportunity, not proof that pixels were painted.",
  );
  console.log("");
  console.log(
    "| files | surface | metric | p50 ms | p95 ms | p99 ms | max ms | >100ms |",
  );
  console.log("| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    console.log(
      `| ${row.fileCount} | ${row.surface} | ${row.metric} | ${row.p50.toFixed(3)} | ${row.p95.toFixed(3)} | ${row.p99.toFixed(3)} | ${row.max.toFixed(3)} | ${row.over100} |`,
    );
  }
}

async function testVerticalGoalAndEmptyEdges(page) {
  const long = "0123456789012345678901234567890123456789";
  for (const middle of [alert("x"), "x"]) {
    const source = blocks(fence("ts", long), middle, fence("ts", long));
    await load(page, source);
    const before = await saved(page);
    await caret(page, ":nth-match(.mm-code-block-pre code, 1)", 18);
    const originalX = await page.evaluate(
      () =>
        window.markdownMint.view.coordsAtPos(
          window.markdownMint.view.state.selection.from,
        ).left,
    );
    await page.keyboard.press("ArrowDown");
    if (middle.startsWith(">")) {
      assert.equal(
        (await selection(page)).kind,
        "BlockBoundarySelection",
        "Code -> Alert did not stop at the structural gap",
      );
      await page.keyboard.press("ArrowDown");
    }
    const short = await selection(page);
    if (middle.startsWith(">"))
      assert.equal(short.inputStart, 1, "short Alert must clamp to its end");
    else assert.equal(short.offset, 1, "short paragraph must clamp to its end");
    await page.keyboard.press("ArrowDown");
    if (middle.startsWith(">")) {
      assert.equal(
        (await selection(page)).kind,
        "BlockBoundarySelection",
        "Alert -> Code did not stop at the structural gap",
      );
      await page.keyboard.press("ArrowDown");
    }
    const afterX = await page.evaluate(
      () =>
        window.markdownMint.view.coordsAtPos(
          window.markdownMint.view.state.selection.from,
        ).left,
    );
    assert.equal((await selection(page)).parent, "code_block");
    assert.ok(
      Math.abs(afterX - originalX) <= 8,
      `vertical goal lost through short body: ${originalX}px -> ${afterX}px`,
    );
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press("ArrowUp");
      await settle(page);
    }
    await page.keyboard.press(middle.startsWith(">") ? "ArrowUp" : "ArrowDown");
    await settle(page);
    assert.equal(
      (await selection(page)).offset,
      18,
      "reverse vertical navigation lost desired column",
    );
    await noEdits(page, before, "persistent vertical goal");
  }

  for (const source of [
    alert(""),
    fence("ts", ""),
    details(""),
    "$$\nx^2\n$$",
  ]) {
    await load(page, source);
    const before = await saved(page);
    if (source.startsWith(">")) await caret(page, alertBody, 0);
    else if (source.startsWith("```"))
      await caret(page, ".mm-code-block-pre code", 0);
    else if (source.startsWith("<"))
      await caret(page, ".mm-details-body > p", 0);
    else await page.locator(".mm-rich-panel .mm-math-block").click();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await noEdits(page, before, "empty body/document edge traversal");
  }
}

async function testNestedDetailsAndComposition(page) {
  const nested = details("Nested paragraph", "open", "Inner");
  const body = blocks(
    "First paragraph",
    "- list item",
    fence("ts", "code"),
    nested,
    "Last paragraph",
  );
  const source = blocks(details(body, "open", "Outer"), "Outside");
  await load(page, source);
  const before = await saved(page);
  const outer = page.locator(".mm-details-node").first();
  const inner = page.locator(".mm-details-node").nth(1);
  await inner.locator(":scope > .mm-details-header .mm-details-toggle").click();
  assert.equal(await inner.getAttribute("data-mm-details-open"), "false");
  assert.equal(
    await outer.getAttribute("data-mm-details-open"),
    "true",
    "nested toggle affected outer Details",
  );
  await inner
    .locator(":scope > .mm-details-header .mm-details-summary")
    .click();
  await inner.locator(".mm-details-summary-input").fill("Inner renamed");
  await page.keyboard.press("Escape");
  await noEdits(page, before, "nested toggle and title cancellation");
  await inner.locator(":scope > .mm-details-header .mm-details-toggle").click();
  await caret(page, ".mm-details-body li p", -1);
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).parent,
    "code_block",
    "list -> code inside Details",
  );
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    (await selection(page)).text,
    "list item",
    "code -> list inside Details",
  );
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).text,
    "Nested paragraph",
    "code -> nested open Details",
  );
  await page.keyboard.press("ArrowLeft");
  assert.equal((await selection(page)).parent, "code_block");
  await noEdits(page, before, "structured nested Details navigation");

  const title = outer.locator(
    ":scope > .mm-details-header .mm-details-summary",
  );
  const input = outer.locator(
    ":scope > .mm-details-header .mm-details-summary-input",
  );
  await title.click();
  // This checks DOM composition event ordering only, not a native OS IME.
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.fill("Outer composing");
  await page.keyboard.press("Enter");
  assert.equal(
    await input.isVisible(),
    true,
    "IME Enter finished title editing",
  );
  await input.dispatchEvent("compositionend", { data: "Outer composing" });
  await page.keyboard.press("Escape");
  await page.locator(`${rich} > p:last-child`).click();
  await noEdits(page, before, "composition/cancel title event sequence");
}

async function testRenderedTraversal(page) {
  const source = blocks(
    "Before",
    details("Hidden body", ""),
    "$$\nx^2\n$$",
    fence("mermaid", "flowchart LR\n  A --> B"),
    "After",
  );
  await load(page, source);
  const before = await saved(page);
  await caret(page, `${rich} > p:first-child`, -1);
  const kinds = [];
  const expectedTargets = ["details", "math-block", "protected-fence"];
  for (const [index, expectedKind] of expectedTargets.entries()) {
    await page.keyboard.press("ArrowRight");
    const entered = await selection(page);
    kinds.push(entered.nodeKind ?? entered.parent);
    assert.equal(
      entered.kind,
      "NodeSelection",
      `rendered target was not an atomic selection: ${expectedKind}`,
    );
    assert.equal(
      entered.nodeKind,
      expectedKind,
      `unexpected rendered target: ${kinds.join(", ")}`,
    );
    assert.equal(entered.dialogs, 0, "arrow traversal opened a source dialog");
    assert.equal(
      await page
        .locator(".mm-details-node")
        .first()
        .evaluate((element) => element.dataset.mmDetailsOpen === "true"),
      false,
      "traversal expanded Details",
    );
    if (index < expectedTargets.length - 1) {
      await page.keyboard.press("ArrowRight");
      assert.equal(
        (await selection(page)).kind,
        "BlockBoundarySelection",
        `missing rendered structural boundary after ${expectedKind}`,
      );
    }
  }
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).text,
    "After",
    `rendered blocks trapped the caret: ${kinds.join(", ")}`,
  );
  for (const [index, expectedKind] of [
    "protected-fence",
    "math-block",
    "details",
  ].entries()) {
    await page.keyboard.press("ArrowLeft");
    const entered = await selection(page);
    assert.equal(entered.kind, "NodeSelection");
    assert.equal(entered.nodeKind, expectedKind);
    if (index < 2) {
      await page.keyboard.press("ArrowLeft");
      assert.equal(
        (await selection(page)).kind,
        "BlockBoundarySelection",
        `missing reverse rendered structural boundary before ${expectedKind}`,
      );
    }
  }
  await page.keyboard.press("ArrowLeft");
  assert.equal((await selection(page)).text, "Before");
  await noEdits(
    page,
    before,
    "closed Details and consecutive rendered traversal",
  );
}

async function testDetailsHeader(page) {
  const body =
    "Body **format**  \nnext line\n\n- first\n- second\n\n" +
    fence("ts", "  preserve();");
  const source = blocks(
    details(body, 'data-unknown="kept"', "<em>Summary</em> &amp; more"),
    "Outside",
  );
  await load(page, source);
  const before = await saved(page);
  const title = page.locator(detailsTitle).first();
  const toggle = page.locator(detailsToggle).first();
  const input = page.locator(detailsInput).first();
  const container = page.locator(".mm-details-node").first();
  await title.click();
  await input.waitFor({ state: "visible" });
  await page
    .locator(".mm-details-node")
    .first()
    .screenshot({ path: resolve(output, "details-inline-heading.png") });
  assert.equal(
    await container.evaluate(
      (element) => element.dataset.mmDetailsOpen === "true",
    ),
    false,
    "title click toggled Details",
  );
  assert.equal((await selection(page)).dialogs, 0, "title click opened modal");
  await page.keyboard.press("Enter");
  await noEdits(page, before, "unchanged Details title");
  await title.click();
  await input.fill("cancel me");
  await page.keyboard.press("Escape");
  await page.locator(`${rich} > p:last-child`).click();
  await noEdits(page, before, "Escape followed by blur");
  await title.click();
  await input.fill("<em>Changed</em> &amp; more");
  await page.keyboard.press("Enter");
  const changed = source.replace("<em>Summary</em>", "<em>Changed</em>");
  await expectSource(page, changed);
  assert.equal(
    await container.evaluate(
      (element) => element.dataset.mmDetailsOpen === "true",
    ),
    false,
  );
  await toggle.click();
  await page
    .locator(".mm-details-node")
    .first()
    .screenshot({ path: resolve(output, "details-expanded-body.png") });
  assert.equal(
    await container.evaluate(
      (element) => element.dataset.mmDetailsOpen === "true",
    ),
    true,
  );
  assert.equal(await input.isVisible(), false, "toggle entered title editing");
  const opened = await saved(page);
  await title.click();
  await input.fill("<strong>Long &amp; special</strong>");
  await page.locator(`${rich} > p:last-child`).click();
  await expectSource(
    page,
    changed.replace(
      "<em>Changed</em> &amp; more",
      "<strong>Long &amp; special</strong>",
    ),
  );
  assert.equal(
    (await selection(page)).text,
    "Outside",
    "blur commit stole explicit click focus",
  );
  assert.equal(
    await container.evaluate(
      (element) => element.dataset.mmDetailsOpen === "true",
    ),
    true,
  );
  assert.equal((await saved(page)).edits, opened.edits + 1);
  await title.click();
  await page.keyboard.press("Tab");
  assert.equal(
    await input.isVisible(),
    false,
    "Tab did not finish title editing",
  );
  await title.click();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await input.isVisible(),
    false,
    "Shift+Tab did not finish title editing",
  );
  await caret(page, ".mm-details-body > p:first-child", -1);
  await page.keyboard.type("X");
  await page.waitForFunction(() =>
    window.__markdownMintHarness.document.markdown.includes("next lineX"),
  );
  assert.match((await saved(page)).markdown, /data-unknown="kept"/);
  await toggle.click();
  assert.equal(
    await container.evaluate(
      (element) => element.dataset.mmDetailsOpen === "true",
    ),
    false,
  );
  assert.equal(
    await toggle.evaluate((element) => document.activeElement === element),
    true,
    "folding left focus in hidden body",
  );
}

async function testDetailsBetweenEscapedBackticks(page) {
  const prefix = "Literal backtick before: \\`";
  const suffix = "Another literal backtick after: \\`";
  const source = blocks(
    prefix,
    details("Editable body", 'open data-note="keep > attribute"', "Summary"),
    suffix,
  );
  await load(page, source);
  const before = await saved(page);
  const container = page.locator(`${rich} > .mm-details-node`);
  assert.equal(
    await container.count(),
    1,
    "escaped backticks hid the structured Details editor",
  );
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.doc.child(1).type.name,
    ),
    "details",
  );
  assert.equal(await container.getAttribute("data-mm-details-open"), "true");
  await noEdits(page, before, "render Details between escaped backticks");

  await container.locator(detailsTitle).click();
  const input = container.locator(detailsInput);
  await input.waitFor({ state: "visible" });
  assert.equal((await selection(page)).dialogs, 0);
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  await page.keyboard.press("Enter");
  const renamed = source.replace(
    "<summary>Summary</summary>",
    "<summary>Summary edited</summary>",
  );
  await expectSource(page, renamed);
  assert.equal(await container.getAttribute("data-mm-details-open"), "true");

  await caret(page, ".mm-details-body > p", -1);
  await page.keyboard.type(" updated");
  const edited = renamed.replace("Editable body", "Editable body updated");
  await expectSource(page, edited);
  assert.equal(
    await container.locator(".mm-details-body > p").textContent(),
    "Editable body updated",
  );
  assert.equal((await selection(page)).dialogs, 0);
  assert.equal((await saved(page)).markdown, edited);
  await page.screenshot({
    path: resolve(output, "details-escaped-backticks.png"),
  });
}

async function testDetailsWithUnmatchedBacktickAndRawScript(page) {
  const source = [
    "`unmatched",
    '<details data-test="keep">',
    "<summary>Summary</summary>",
    "<script>",
    'const value = "</details>";',
    "</script>",
    "Editable body",
    "</details>",
  ].join("\n");
  await load(page, source);
  const before = await saved(page);
  const container = page.locator(`${rich} > .mm-details-node`);
  assert.equal(
    await container.count(),
    1,
    "unmatched paragraph backtick or script text hid structured Details",
  );
  assert.equal(
    await page.evaluate(
      () => window.markdownMint.view.state.doc.child(1).type.name,
    ),
    "details",
  );
  const toggle = container.locator(detailsToggle);
  assert.equal(await container.getAttribute("data-mm-details-open"), "false");
  for (const open of [true, false, true]) {
    await toggle.click();
    assert.equal(
      await container.getAttribute("data-mm-details-open"),
      String(open),
    );
  }
  await noEdits(page, before, "toggle Details containing raw script text");
  assert.equal(await container.locator("script").count(), 0);
  assert.equal(await page.evaluate("typeof value"), "undefined");

  await container.locator(detailsTitle).click();
  await container.locator(detailsInput).waitFor({ state: "visible" });
  assert.equal((await selection(page)).dialogs, 0);
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  await page.keyboard.press("Enter");
  const renamed = source.replace(
    "<summary>Summary</summary>",
    "<summary>Summary edited</summary>",
  );
  assert.equal(
    (await saved(page)).markdown,
    renamed,
    "summary editing must preserve the raw script source and Details bounds",
  );

  await caret(page, ".mm-details-body > p", -1);
  await page.keyboard.type(" updated");
  const edited = renamed.replace("Editable body", "Editable body updated");
  assert.equal(
    (await saved(page)).markdown,
    edited,
    "body editing must preserve the raw script source and Details bounds",
  );
  assert.equal(
    await container.locator(".mm-details-body > p").textContent(),
    "Editable body updated",
  );
  assert.equal(await container.locator("script").count(), 0);
  assert.equal(await page.evaluate("typeof value"), "undefined");
  assert.equal((await selection(page)).dialogs, 0);
  await page.screenshot({
    path: resolve(output, "details-unmatched-backtick-raw-script.png"),
  });
}

async function testDetailsWithInlineHtmlAttributeTags(page) {
  const source = [
    '<details data-test="keep" open>',
    '<summary><span title="</details>">Summary</span></summary>',
    "",
    'Text <span data-open="<details>" data-close="</details>">Example</span>',
    "",
    "Editable body",
    "",
    "</details>",
  ].join("\n");
  await load(page, source);
  const before = await saved(page);
  const container = page.locator(`${rich} > .mm-details-node`);
  assert.equal(await container.count(), 1);
  assert.equal(await container.getAttribute("data-mm-details-open"), "true");
  assert.equal(
    await container
      .locator('[title="</details>"], [data-open="<details>"]')
      .count(),
    0,
    "inline HTML attributes must be rendered without executable attributes",
  );

  const toggle = container.locator(detailsToggle);
  await toggle.click();
  assert.equal(await container.getAttribute("data-mm-details-open"), "false");
  await toggle.click();
  assert.equal(await container.getAttribute("data-mm-details-open"), "true");
  await noEdits(page, before, "toggle Details with inline attribute tags");

  await container.locator(detailsTitle).click();
  const input = container.locator(detailsInput);
  await input.waitFor({ state: "visible" });
  assert.equal((await selection(page)).dialogs, 0);
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  await page.keyboard.press("Enter");
  const renamed = source.replace(
    "</span></summary>",
    "</span> edited</summary>",
  );
  await expectSource(page, renamed);

  await caret(page, ".mm-details-body > p:last-of-type", -1);
  await page.keyboard.type(" updated");
  const edited = renamed.replace("Editable body", "Editable body updated");
  await expectSource(page, edited);
  assert.equal(
    await container.locator(".mm-details-body > p:last-of-type").textContent(),
    "Editable body updated",
  );
  assert.equal((await saved(page)).markdown, edited);
  assert.equal((await selection(page)).dialogs, 0);
  assert.equal(await container.locator("script").count(), 0);
  assert.equal(
    await container
      .locator('[title="</details>"], [data-open="<details>"]')
      .count(),
    0,
  );
  await page.screenshot({
    path: resolve(output, "details-inline-html-attribute-tags.png"),
  });
}

async function testMathAndMermaidHeaders(page) {
  let mathDialogWidth = 0;
  for (const [kind, source, replacement] of [
    ["math", "$$\nx^2\n$$", "y^3"],
    [
      "mermaid",
      fence("mermaid", "flowchart LR\n  A --> B"),
      "flowchart TD\n  C --> D",
    ],
  ]) {
    await load(page, blocks("Before", source, "After"));
    const before = await saved(page);
    const body = page
      .locator(
        kind === "math"
          ? ".mm-rich-panel .mm-math-block"
          : ".mm-rich-panel .mm-mermaid",
      )
      .first();
    await body.click();
    assert.equal(
      (await selection(page)).dialogs,
      0,
      `${kind} drawing click opened editing`,
    );
    const label = kind === "math" ? "Math" : "Mermaid";
    const rendered = page.locator(
      `.mm-rendered-node[role="button"][aria-label="Edit ${label}"]`,
    );
    await rendered.waitFor();
    assert.equal(
      await page.locator(".mm-block-source-trigger").count(),
      0,
      `${kind} source label was left in the rendered block`,
    );
    await rendered.dblclick();
    const dialog = page.locator(".mm-profile-feature-dialog[open]");
    await dialog.waitFor();
    assert.equal(
      await dialog.getAttribute("data-profile-feature-mode"),
      "edit",
    );
    assert.equal(await dialog.locator("h2").textContent(), `Edit ${label}`);
    if (kind === "mermaid") {
      await page.waitForFunction(
        () =>
          document.querySelector(
            ".mm-profile-feature-dialog[open] .mm-mermaid-validation-status",
          )?.textContent === "✓ Valid · Flowchart",
      );
      assert.equal(
        await dialog.locator(".mm-mermaid-version").textContent(),
        "Mermaid 11.17.2",
      );
      assert.equal(
        await dialog.locator(".mm-mermaid-dialog-meta").getAttribute("hidden"),
        null,
      );
      const layout = await dialog.evaluate((element) => {
        const body = element.querySelector('[data-feature-field="body"]');
        const rect = element.getBoundingClientRect();
        const bodyRect = body?.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          bodyHeight: bodyRect?.height ?? 0,
          bodyFlex: body ? getComputedStyle(body).flex : "",
        };
      });
      assert.ok(layout.width > mathDialogWidth, "Mermaid dialog did not grow");
      assert.ok(layout.width > 700, "Mermaid dialog is still too narrow");
      assert.ok(layout.height > 500, "Mermaid dialog is still too short");
      assert.ok(
        layout.bodyHeight > 400,
        "Mermaid editor did not fill the modal",
      );
      assert.match(layout.bodyFlex, /1\s+1\s+auto/);
    } else {
      mathDialogWidth = await dialog.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await noEdits(page, before, `${kind} cancel`);
    for (const key of ["Enter", "Space"]) {
      await rendered.focus();
      await page.keyboard.press(key);
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await noEdits(page, before, `${kind} ${key} keyboard cancel`);
    }
    await rendered.dblclick();
    await dialog.locator('[data-feature-field="body"]').fill(replacement);
    await dialog.locator('button[type="submit"]').click();
    await page.waitForFunction(() => !window.markdownMint.sync.hasPending);
    const updated = (await saved(page)).markdown;
    assert.ok(updated.includes(replacement));
    assert.equal(
      await page
        .locator(`.mm-rendered-node[role="button"][aria-label="Edit ${label}"]`)
        .count(),
      1,
      `${kind} edit inserted a duplicate block`,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement === document.body),
      false,
      `${kind} source update lost focus after its header was replaced`,
    );
  }
}

async function testAllMathSources(page) {
  const source = [
    "Before $a+b$ After.",
    "",
    "$$",
    "c+d",
    "$$",
    "",
    fence("math", "e+f"),
    "",
    fence("latex", "g+h"),
    "",
    fence("tex", "i+j"),
    "",
    fence("asciimath", "k+l"),
  ].join("\n");
  let current = source;
  await load(page, source);
  let baseline = await saved(page);

  const inline = page.locator(
    `${rich} .mm-rendered-inline[data-mm-editable-math="true"]`,
  );
  await inline.waitFor();
  assert.equal(await inline.getAttribute("tabindex"), "-1");
  await inline.click();
  assert.equal((await selection(page)).kind, "NodeSelection");
  assert.equal((await selection(page)).dialogs, 0);
  await inline.dblclick();
  let dialog = page.locator(".mm-profile-feature-dialog[open]");
  await dialog.waitFor();
  assert.equal(
    await dialog.locator('[data-feature-field="body"]').inputValue(),
    "a+b",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await noEdits(page, baseline, "inline Math cancel");

  for (const key of ["Enter", "Space"]) {
    await inline.focus();
    await page.keyboard.press(key);
    await dialog.waitFor();
    assert.equal(
      await dialog.locator('[data-feature-field="body"]').inputValue(),
      "a+b",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await noEdits(page, baseline, `inline Math ${key} cancel`);
  }

  const paragraph = page.locator(`${rich} > p`).first();
  await paragraph.dblclick({ position: { x: 3, y: 3 } });
  assert.equal((await selection(page)).dialogs, 0);

  await inline.dblclick();
  dialog = page.locator(".mm-profile-feature-dialog[open]");
  await dialog.locator('[data-feature-field="body"]').fill("A+B");
  await dialog.locator('button[type="submit"]').click();
  current = current.replace("a+b", "A+B");
  await expectSource(page, current);
  baseline = await saved(page);

  const bodies = [
    ["c+d", "C+D"],
    ["e+f", "E+F"],
    ["g+h", "G+H"],
    ["i+j", "I+J"],
    ["k+l", "K+L"],
  ];
  const blockButtons = page.locator(
    `${rich} > .mm-rendered-node:not(.mm-rendered-inline)[aria-label="Edit Math"]`,
  );
  assert.equal(await blockButtons.count(), bodies.length);
  for (let index = 0; index < bodies.length; index += 1) {
    const [body, replacement] = bodies[index];
    const rendered = blockButtons.nth(index);
    await rendered.waitFor();
    assert.equal(await rendered.getAttribute("aria-label"), "Edit Math");
    await rendered.locator(".mm-math-block").click();
    assert.equal((await selection(page)).dialogs, 0);
    await rendered.dblclick();
    dialog = page.locator(".mm-profile-feature-dialog[open]");
    await dialog.waitFor();
    assert.equal(
      await dialog.locator('[data-feature-field="body"]').inputValue(),
      body,
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await noEdits(page, baseline, `Math block ${index} cancel`);

    await rendered.dblclick();
    await dialog.locator('[data-feature-field="body"]').fill(replacement);
    await dialog.locator('button[type="submit"]').click();
    current = current.replace(body, replacement);
    await expectSource(page, current);
    baseline = await saved(page);
  }

  assert.match(current, /\$\$\nC\+D\n\$\$/);
  assert.match(current, /```math\nE\+F\n```/);
  assert.match(current, /```latex\nG\+H\n```/);
  assert.match(current, /```tex\nI\+J\n```/);
  assert.match(current, /```asciimath\nK\+L\n```/);
  assert.equal(
    await page
      .locator(
        `${rich} > .mm-rendered-node:not(.mm-rendered-inline)[aria-label="Edit Math"]`,
      )
      .count(),
    bodies.length,
  );
}

async function testLinkedInlineMathGenericSerializer(page) {
  const source = "Before **[$x$](https://example.com)** After";
  let current = source;
  await load(page, source);

  const math = page.locator(
    `${rich} .mm-rendered-inline[data-mm-editable-math="true"]`,
  );
  await math.dblclick();
  let dialog = page.locator(".mm-profile-feature-dialog[open]");
  await dialog.locator('[data-feature-field="body"]').fill("y");
  await dialog.locator('button[type="submit"]').click();
  current = current.replace("$x$", "$y$");
  await expectSource(page, current);

  await caret(page, `${rich} > p:first-child`, 0, "Before".length);
  await page.keyboard.type("Changed");
  current = current.replace("Before", "Changed");
  await page.waitForFunction(() => !window.markdownMint.sync.hasPending);
  const genericSource = (await saved(page)).markdown;
  assert.equal(genericSource.replace(/\u00a0/g, " "), current);

  const atoms = await page.evaluate(() => {
    const result = [];
    window.markdownMint.view.state.doc.descendants((node) => {
      if (node.type.name !== "raw_inline") return;
      if (node.attrs.kind !== "math_inline") return;
      const link = node.marks.find((mark) => mark.type.name === "link");
      result.push({
        source: node.attrs.source,
        marks: node.marks.map((mark) => mark.type.name),
        href: link?.attrs.href,
      });
    });
    return result;
  });
  assert.deepEqual(atoms, [
    {
      source: "$y$",
      marks: ["strong", "link"],
      href: "https://example.com",
    },
  ]);
}

async function richDocumentShape(page) {
  return page.evaluate(() => {
    const nodes = [];
    window.markdownMint.view.state.doc.forEach((node) => nodes.push(node));
    return {
      types: nodes.map((node) => node.type.name),
      emptyParagraphs: nodes.filter(
        (node) => node.type.name === "paragraph" && node.content.size === 0,
      ).length,
    };
  });
}

async function testBlankLineRoundTrip(page) {
  await page.setViewportSize({ width: 960, height: 900 });

  const authored = "one\n\n\n\ntwo";
  await load(page, authored);
  assert.deepEqual(await richDocumentShape(page), {
    types: ["paragraph", "paragraph", "paragraph", "paragraph"],
    emptyParagraphs: 2,
  });
  assert.equal(
    await page
      .locator(`${rich} > p`)
      .evaluateAll((paragraphs) =>
        paragraphs
          .slice(1, -1)
          .every((paragraph) => paragraph.getBoundingClientRect().height > 0),
      ),
    true,
    "source-authored blank paragraphs are not visible in Rich",
  );
  assert.equal((await saved(page)).markdown, authored);

  const authoredCrlf = "one\r\n\r\n\r\n\r\ntwo";
  await load(page, authoredCrlf);
  assert.deepEqual(await richDocumentShape(page), {
    types: ["paragraph", "paragraph", "paragraph", "paragraph"],
    emptyParagraphs: 2,
  });
  assert.equal((await saved(page)).markdown, authoredCrlf);

  await load(page, "one");
  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("Enter");
  await expectSource(page, "one\n\n");
  await page.keyboard.press("Enter");
  await expectSource(page, "one\n\n\n");
  await page.keyboard.insertText("two");
  const entered = "one\n\n\ntwo";
  await expectSource(page, entered);
  assert.deepEqual(await richDocumentShape(page), {
    types: ["paragraph", "paragraph", "paragraph"],
    emptyParagraphs: 1,
  });

  await load(page, entered);
  assert.deepEqual(await richDocumentShape(page), {
    types: ["paragraph", "paragraph", "paragraph"],
    emptyParagraphs: 1,
  });

  const crlfStart = "one\r\n";
  await load(page, crlfStart);
  await caret(page, `${rich} > p:first-child`, -1);
  await page.keyboard.press("Enter");
  await expectSource(page, "one\r\n\r\n");
  await page.keyboard.press("Enter");
  await expectSource(page, "one\r\n\r\n\r\n");
  await page.keyboard.insertText("two");
  const enteredCrlf = "one\r\n\r\n\r\ntwo\r\n";
  await expectSource(page, enteredCrlf);
  assert.deepEqual(await richDocumentShape(page), {
    types: ["paragraph", "paragraph", "paragraph"],
    emptyParagraphs: 1,
  });
  assert.equal((await saved(page)).markdown.includes("\n"), true);
  assert.equal((await saved(page)).markdown.includes("\r\n"), true);
  assert.equal(
    (await saved(page)).markdown.replace(/\r\n/g, "").includes("\n"),
    false,
  );
  await load(page, enteredCrlf);
  assert.deepEqual(await richDocumentShape(page), {
    types: ["paragraph", "paragraph", "paragraph"],
    emptyParagraphs: 1,
  });

  await load(page, "one");
  const beforeClick = await saved(page);
  const blockBox = await page.locator(`${rich} > p:first-child`).boundingBox();
  const stageBox = await page.locator(".mm-stage").boundingBox();
  assert.ok(blockBox && stageBox, "missing Rich block geometry");
  const blockBottom = blockBox.y + blockBox.height;
  const clickY = Math.min(blockBottom + 120, stageBox.y + stageBox.height - 12);
  assert.ok(clickY > blockBottom, "Rich stage has no trailing click area");
  await page.mouse.click(stageBox.x + 24, clickY);
  await noEdits(page, beforeClick, "trailing blank click");
  const clickedShape = await richDocumentShape(page);
  assert.ok(
    clickedShape.emptyParagraphs > 0,
    "click did not create transient paragraphs",
  );

  await page.keyboard.insertText("two");
  await expectSource(page, "one\n\ntwo");
  assert.equal((await saved(page)).markdown.match(/\n{3,}/u), null);
  assert.deepEqual(await richDocumentShape(page), {
    types: ["paragraph", "paragraph"],
    emptyParagraphs: 0,
  });

  await page.keyboard.press(undoShortcut);
  await expectSource(page, "one");
  assert.deepEqual(await richDocumentShape(page), {
    types: ["paragraph"],
    emptyParagraphs: 0,
  });
}

async function testAuthoritativeTerminalWhitespace(page) {
  const cases = [
    {
      initial: "one\n\n\n",
      authoritative: "one\n\n",
      afterInput: "one\n\nnext",
      emptyParagraphs: 1,
    },
    {
      initial: "one\n\n\n\n",
      authoritative: "one\n",
      afterInput: "onenext\n",
      emptyParagraphs: 0,
    },
    {
      initial: "one\r\n\r\n\r\n",
      authoritative: "one\r\n\r\n",
      afterInput: "one\r\n\r\nnext",
      emptyParagraphs: 1,
    },
    {
      initial: "one\r\n\r\n\r\n\r\n",
      authoritative: "one\r\n",
      afterInput: "onenext\r\n",
      emptyParagraphs: 0,
    },
  ];

  for (const testCase of cases) {
    await load(page, testCase.initial);
    await page.evaluate(
      (markdown) =>
        window.__markdownMintHarness.deliverExternal(markdown, "github"),
      testCase.authoritative,
    );
    await page.waitForFunction(
      (markdown) =>
        window.__markdownMintHarness.document.markdown === markdown &&
        !window.markdownMint.sync.hasPending,
      testCase.authoritative,
    );
    await settle(page);

    assert.deepEqual(await richDocumentShape(page), {
      types: Array.from(
        { length: testCase.emptyParagraphs + 1 },
        () => "paragraph",
      ),
      emptyParagraphs: testCase.emptyParagraphs,
    });
    assert.equal(
      await page.evaluate((markdown) => {
        window.markdownMint.core.parseMarkdown("cache-bust", "github");
        const authoritative = window.markdownMint.core.parseMarkdown(
          markdown,
          "github",
        ).doc;
        return window.markdownMint.view.state.doc.eq(authoritative);
      }, testCase.authoritative),
      true,
      "Rich document diverged from the authoritative parse",
    );
    const caretValid = await page.evaluate(() => {
      const { selection, doc } = window.markdownMint.view.state;
      return (
        selection.from >= 0 &&
        selection.to <= doc.content.size &&
        selection.$from.parent.type.name === "paragraph"
      );
    });
    assert.equal(caretValid, true, "authoritative update lost a valid caret");

    await caret(page, `${rich} > p:last-child`, -1);
    await page.keyboard.insertText("next");
    await expectSource(page, testCase.afterInput);
    assert.equal(
      testCase.afterInput.replace(/\r\n|\r/g, "\n").match(/\n{3,}/u),
      null,
      "deleted terminal blank paragraphs were regenerated",
    );
  }
}

async function testDocumentFixtures(page) {
  const fixtures = [
    ["common-test.md", "commonmark"],
    ["github-test.md", "github"],
    ["github-test-class-B.md", "github"],
    ["gitlab-test.md", "gitlab"],
    ["gitlab-test-class-B.md", "gitlab"],
  ];
  for (const [filename, profile] of fixtures) {
    const source = await readFile(
      resolve(repository, "tests", "md", filename),
      "utf8",
    );
    for (const mode of ["rich", "preview", "native"]) {
      if (mode === "native") {
        await page.goto(
          `${baseUrl}/native.html?fixture=document&file=${encodeURIComponent(filename)}`,
          { waitUntil: "domcontentloaded" },
        );
      } else await load(page, source, profile, mode);
      const root =
        mode === "native"
          ? '[data-testid="native-content"]'
          : mode === "preview"
            ? ".mm-preview-panel .markdown-body"
            : rich;
      await page.locator(root).waitFor({ state: "visible" });
      await page.waitForFunction(
        (selector) =>
          Array.from(
            document
              .querySelector(selector)
              .querySelectorAll('[data-mm-mermaid-state="pending"]'),
          ).every((element) => element.closest("details:not([open])")),
        root,
      );
      if (profile !== "commonmark")
        await page.waitForFunction((selector) => {
          const content = document.querySelector(selector);
          return Boolean(
            content?.querySelectorAll(".mm-mermaid svg").length &&
            !content.querySelector('[data-mm-mermaid-state="rendering"]'),
          );
        }, root);
      const result = await page.locator(root).evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        headings: element.querySelectorAll("h1,h2,h3").length,
        code: element.querySelectorAll("pre code").length,
        math: element.querySelectorAll(".katex").length,
        diagrams: element.querySelectorAll(".mm-mermaid svg").length,
        failures: Array.from(
          element.querySelectorAll('[data-mm-mermaid-state="error"]'),
        ).map((node) => node.textContent),
        editableHeaders: element.querySelectorAll(
          '.mm-details-summary,.mm-rendered-node[role="button"][aria-label^="Edit "]',
        ).length,
      }));
      assert.ok(result.width > 200, `${filename} ${mode}: invisible content`);
      assert.ok(result.headings > 10, `${filename} ${mode}: missing headings`);
      assert.ok(result.code > 0, `${filename} ${mode}: missing code`);
      if (profile !== "commonmark") {
        assert.ok(result.math > 0, `${filename} ${mode}: missing math`);
        assert.ok(result.diagrams > 0, `${filename} ${mode}: missing Mermaid`);
      }
      assert.deepEqual(
        result.failures,
        [],
        `${filename} ${mode}: Mermaid render failure`,
      );
      if (mode !== "rich")
        assert.equal(
          result.editableHeaders,
          0,
          `${filename} ${mode}: leaked rich editing controls`,
        );
      if (mode !== "native")
        assert.equal(
          (await saved(page)).markdown,
          source,
          `${filename} ${mode}: display changed source`,
        );
      await page.screenshot({
        path: resolve(output, `${filename}-${mode}.png`),
        fullPage: false,
      });
      for (const [kind, selector] of [
        ["code", ".mm-code-block"],
        ["alert", ".markdown-alert"],
        ["details", ".mm-details-node, details"],
        ["math", ".mm-math-block"],
        ["mermaid", ".mm-mermaid"],
      ]) {
        const block = page.locator(root).locator(selector).first();
        if ((await block.count()) && (await block.isVisible()))
          await block.screenshot({
            path: resolve(output, `${filename}-${mode}-${kind}.png`),
          });
      }
      console.log(`Display smoke passed: ${filename} (${profile}, ${mode}).`);
    }
  }
}

async function main() {
  const server = spawn(process.execPath, ["tests/browser/server.mjs"], {
    cwd: repository,
    env: { ...process.env, MM_BROWSER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  let browser;
  let page;
  try {
    await mkdir(output, { recursive: true });
    await rm(resolve(output, "failure.png"), { force: true });
    for (let attempt = 0; ; attempt += 1) {
      try {
        if ((await fetch(baseUrl)).ok) break;
      } catch {
        /* server is still binding */
      }
      if (attempt >= 120)
        throw new Error(`Browser server failed: ${serverOutput}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    const executablePath =
      process.env.MM_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      `Missing Chromium: ${executablePath}. Run npx playwright install chromium or set MM_BROWSER_EXECUTABLE_PATH.`,
    );
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({
      viewport: { width: 960, height: 900 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(8000);
    const browserTests = [
      testCodeHeader,
      testDetailsAndCodeBlockSelection,
      testAlertHeaderAndSelection,
      testAlertConflict,
      testHorizontalNavigation,
      testInsertAffordances,
      testBlockGapInsertion,
      testInsertionAffordanceOwnership,
      testProfileFeaturesAtStructuralBoundary,
      testStructuralBoundaryNavigationAndInsertion,
      testStructuralDocumentEdges,
      testDirectVerticalBlockNavigation,
      testArrowDocumentEdges,
      testWrappedVerticalNavigation,
      testTableNavigation,
      testSpreadsheetTablePasteHistory,
      testMergedHtmlTablePaste,
      testNestedBlockquoteTableNavigation,
      testCodeVerticalNavigation,
      testExpandedCodeVerticalNavigation,
      testSelectionAndModifiers,
      testRichEditorLinks,
      testModalEscapeCancellation,
      testModalBackdropCancellation,
      testModalKeyboardActivation,
      testWorkspaceFileAutocomplete,
      testWorkspaceFileAutocompleteLoading,
      testVerticalGoalAndEmptyEdges,
      testNestedDetailsAndComposition,
      testRenderedTraversal,
      testDetailsHeader,
      testDetailsBetweenEscapedBackticks,
      testDetailsWithUnmatchedBacktickAndRawScript,
      testDetailsWithInlineHtmlAttributeTags,
      testMathAndMermaidHeaders,
      testAllMathSources,
      testLinkedInlineMathGenericSerializer,
      testBlankLineRoundTrip,
      testAuthoritativeTerminalWhitespace,
      testDocumentFixtures,
    ];
    if (process.env.MM_FILE_SEARCH_BENCHMARK === "1")
      browserTests.push(testWorkspaceFileAutocompleteBenchmark);
    for (const test of browserTests) {
      if (
        process.env.MM_BLOCK_BROWSER_CASE &&
        !test.name.includes(process.env.MM_BLOCK_BROWSER_CASE)
      )
        continue;
      console.log(`Running ${test.name}`);
      await test(page);
      console.log(`Passed ${test.name}`);
    }
    console.log(
      "Block editing browser checks passed. Native preview checks use the native CSS/script cascade; OS IME still requires a real VS Code check.",
    );
  } catch (error) {
    await page
      ?.screenshot({ path: resolve(output, "failure.png"), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    server.kill("SIGINT");
  }
}

await main();
