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

async function load(page, source, profile = "github", mode = "rich") {
  await page.goto(`${baseUrl}/${mode === "preview" ? "?mode=preview" : ""}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => window.markdownMint?.view);
  await page.evaluate(
    ([markdown, nextProfile]) =>
      window.__markdownMintHarness.deliverExternal(markdown, nextProfile),
    [source, profile],
  );
  await page.waitForFunction(
    (expected) => window.markdownMint.sourceEl.value === expected,
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

async function expectBoundary(page, label) {
  const state = await selection(page);
  assert.equal(
    state.kind,
    "BlockBoundarySelection",
    `${label}: missing boundary selection`,
  );
  assert.equal(
    await page.locator(".mm-block-boundary-cursor").count(),
    1,
    `${label}: virtual caret was not rendered`,
  );
}

async function testCodeHeader(page) {
  const body = "  const value = 1;  \n\tconsole.log(value);\n";
  const source = blocks("Before", fence("ts title=example", body), "After");
  await load(page, source);
  const before = await saved(page);
  await page.locator(".mm-code-language-trigger").click();
  await page.locator(".mm-code-language-menu:not([hidden])").waitFor();
  const input = page.locator(".mm-code-language-inline");
  await input.fill("javascript");
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await input.evaluate((element) => document.activeElement === element),
    true,
    "language arrow escaped into a body",
  );
  await page.keyboard.press("Escape");
  await noEdits(page, before, "cancel language chooser");
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
  await expectBoundary(page, "paragraph -> code boundary");
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).parent,
    "code_block",
    "paragraph -> code",
  );
  assert.equal((await selection(page)).offset, 0);
  await page.keyboard.press("ArrowLeft");
  await expectBoundary(page, "code -> paragraph boundary");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await selection(page)).text, "Before", "code -> paragraph");
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowRight");
  await expectBoundary(page, "code -> Alert boundary");
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).active,
    "mm-alert-body-editor",
    "code -> Alert",
  );
  assert.equal((await selection(page)).inputStart, 0);
  await page.keyboard.press("ArrowLeft");
  await expectBoundary(page, "Alert -> code boundary");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await selection(page)).parent, "code_block", "Alert -> code");
  await caret(page, alertBody, -1);
  await page.keyboard.press("ArrowRight");
  await expectBoundary(page, "Alert -> Details boundary");
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await selection(page)).text,
    "Details body",
    "Alert -> open Details body",
  );
  await page.keyboard.press("ArrowLeft");
  await expectBoundary(page, "Details -> Alert boundary");
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    (await selection(page)).active,
    "mm-alert-body-editor",
    "Details -> Alert",
  );
  await caret(page, ".mm-details-body > p", -1);
  await page.keyboard.press("ArrowRight");
  await expectBoundary(page, "Details -> paragraph boundary");
  await page.keyboard.press("ArrowRight");
  assert.equal((await selection(page)).text, "After", "Details -> paragraph");
  await page.keyboard.press("ArrowLeft");
  await expectBoundary(page, "paragraph -> Details boundary");
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    (await selection(page)).text,
    "Details body",
    "paragraph -> Details",
  );
  await noEdits(page, before, "bidirectional horizontal navigation");
  await page.keyboard.type("X");
  await expectSource(page, source.replace("Details body", "Details bodyX"));

  const insertionSource = blocks("Before", fence("ts", "code"), "After");
  await load(page, insertionSource);
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowRight");
  await expectBoundary(page, "boundary before paragraph insertion");
  await page.keyboard.type("X");
  await expectSource(page, blocks("Before", fence("ts", "code"), "X", "After"));
  await page.keyboard.press(undoShortcut);
  await expectSource(page, insertionSource);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+z" : "Control+y",
  );
  await expectSource(page, blocks("Before", fence("ts", "code"), "X", "After"));
  await load(page, insertionSource);
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowRight");
  await expectBoundary(page, "boundary before paste");
  await page.evaluate(() => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "Pasted");
    window.markdownMint.view.dom.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  });
  await expectSource(
    page,
    blocks("Before", fence("ts", "code"), "Pasted", "After"),
  );
  await load(page, insertionSource);
  await caret(page, ".mm-code-block-pre code", -1);
  await page.keyboard.press("ArrowRight");
  await expectBoundary(page, "boundary before slash input");
  await page.keyboard.type("/");
  await page.waitForTimeout(150);
  const slashState = await page.evaluate(() => ({
    popupHidden: document.querySelector("#mm-empty-line-insert-popup")?.hidden,
    paragraphText:
      window.markdownMint.view.state.selection.$from.parent.textContent,
  }));
  assert.equal(
    slashState.popupHidden,
    false,
    "boundary slash did not open Insert block",
  );
  assert.equal(
    slashState.paragraphText,
    "",
    "slash popup changed paragraph text",
  );
  await page.keyboard.press("Escape");
  await expectSource(page, blocks("Before", fence("ts", "code"), "/", "After"));
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
  await expectBoundary(page, "last Alert row -> code boundary");
  await page.keyboard.press("ArrowDown");
  state = await selection(page);
  assert.equal(
    state.parent,
    "code_block",
    "last displayed Alert row Down did not enter code",
  );
  await page.keyboard.press("ArrowUp");
  await expectBoundary(page, "code -> Alert boundary");
  await page.keyboard.press("ArrowUp");
  assert.equal(
    (await selection(page)).active,
    "mm-alert-body-editor",
    "code Up did not re-enter Alert",
  );
  await caret(page, `:nth-match(${alertBody}, 1)`, 3);
  await page.keyboard.press("ArrowUp");
  await expectBoundary(page, "first Alert row -> paragraph boundary");
  await page.keyboard.press("ArrowUp");
  assert.equal(
    (await selection(page)).text,
    "Previous paragraph with enough text",
    "first displayed Alert row Up did not leave",
  );
  await noEdits(page, before, "vertical boundary navigation");
  await caret(page, `:nth-match(${alertBody}, 1)`, -1);
  await page.keyboard.press("ArrowDown");
  await expectBoundary(page, "final Alert boundary before code typing");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Z");
  await page.waitForFunction(() =>
    window.__markdownMintHarness.document.markdown.includes("Z"),
  );
  assert.match((await saved(page)).markdown, /```ts\n[^`]*Z/);
  await page.setViewportSize({ width: 960, height: 900 });
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
    await expectBoundary(page, "last code row -> boundary");
    const boundaryEvent = await page.evaluate(() =>
      window.__markdownMintVerticalKeys.at(-1),
    );
    assert.deepEqual(boundaryEvent, {
      key: "ArrowDown",
      defaultPrevented: true,
    });
    await page.keyboard.press("ArrowDown");
    state = await selection(page);
    assert.equal(state.parent, "paragraph");
    assert.equal(state.text, "After");

    await page.keyboard.press("ArrowUp");
    await expectBoundary(page, "After -> code boundary");
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
    await expectBoundary(page, "first code row -> boundary");
    const upEvents = await page.evaluate(() =>
      window.__markdownMintVerticalKeys
        .filter((event) => event.key === "ArrowUp")
        .map((event) => event.defaultPrevented),
    );
    assert.deepEqual(
      upEvents,
      [true, true, false, false, false, false, true],
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
    "modified arrow used a boundary jump",
  );
  await noEdits(page, before, "selection and modified arrows");
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
    await expectBoundary(page, "code -> short block boundary");
    await page.keyboard.press("ArrowDown");
    const short = await selection(page);
    if (middle.startsWith(">"))
      assert.equal(short.inputStart, 1, "short Alert must clamp to its end");
    else assert.equal(short.offset, 1, "short paragraph must clamp to its end");
    await page.keyboard.press("ArrowDown");
    await expectBoundary(page, "short block -> code boundary");
    await page.keyboard.press("ArrowDown");
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
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
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
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("ArrowRight");
    await expectBoundary(page, `rendered block ${index} boundary`);
    kinds.push("boundary");
    await page.keyboard.press("ArrowRight");
    const entered = await selection(page);
    kinds.push(entered.nodeKind ?? entered.parent);
    assert.equal(entered.dialogs, 0, "arrow traversal opened a source dialog");
    assert.equal(
      await page
        .locator(".mm-details-node")
        .first()
        .evaluate((element) => element.dataset.mmDetailsOpen === "true"),
      false,
      "traversal expanded Details",
    );
  }
  assert.equal(
    (await selection(page)).text,
    "After",
    `rendered blocks trapped the caret: ${kinds.join(", ")}`,
  );
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("ArrowLeft");
    await expectBoundary(page, `reverse rendered block ${index} boundary`);
    await page.keyboard.press("ArrowLeft");
  }
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

async function testDocumentFixtures(page) {
  const fixtures = [
    ["common-test.md", "commonmark"],
    ["github-test.md", "github"],
    ["github-test-class-B.md", "github"],
    ["gitlab-test.md", "gitlab"],
    ["gitlab-test-class-B.md", "gitlab"],
  ];
  for (const [filename, profile] of fixtures) {
    const source = await readFile(resolve(repository, "md", filename), "utf8");
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
    for (const test of [
      testCodeHeader,
      testDetailsAndCodeBlockSelection,
      testAlertHeaderAndSelection,
      testAlertConflict,
      testHorizontalNavigation,
      testWrappedVerticalNavigation,
      testCodeVerticalNavigation,
      testExpandedCodeVerticalNavigation,
      testSelectionAndModifiers,
      testVerticalGoalAndEmptyEdges,
      testNestedDetailsAndComposition,
      testRenderedTraversal,
      testDetailsHeader,
      testDetailsBetweenEscapedBackticks,
      testDetailsWithUnmatchedBacktickAndRawScript,
      testDetailsWithInlineHtmlAttributeTags,
      testMathAndMermaidHeaders,
      testAllMathSources,
      testDocumentFixtures,
    ]) {
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
