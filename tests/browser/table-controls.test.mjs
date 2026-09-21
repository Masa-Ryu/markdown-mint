import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.MM_TABLE_BROWSER_TEST_PORT ?? "4176");
const baseUrl = `http://127.0.0.1:${port}`;
const output = resolve(repository, "output/playwright/table-controls");
const undoShortcut = process.platform === "darwin" ? "Meta+z" : "Control+z";
const redoShortcut =
  process.platform === "darwin" ? "Meta+Shift+z" : "Control+y";

function numberedSource(bodyRows = 100, columns = 10) {
  const headers = ["#", "Name", "Value"];
  for (let column = 3; column < columns; column += 1)
    headers.push(`Column ${column - 2} with a deliberately wide heading`);
  const separator = headers.map(() => "---");
  const rows = [`| ${headers.join(" | ")} |`, `| ${separator.join(" | ")} |`];
  for (let index = 1; index <= bodyRows; index += 1) {
    const name =
      index === 1
        ? "Alpha"
        : index === 2
          ? "Beta"
          : index === 3
            ? "Gamma"
            : `Row ${index}`;
    const values = [String(index), name, `Value ${index}`];
    for (let column = 3; column < columns; column += 1) {
      const width = 12 + ((index + column) % 4) * 8;
      values.push(`${"x".repeat(width)} ${index}`);
    }
    rows.push(`| ${values.join(" | ")} |`);
  }
  return rows.join("\n");
}

const smallSource = [
  "| # | Name | Value |",
  "| --- | --- | --- |",
  "| 1 | Alpha | A |",
  "| 2 | Beta | B |",
].join("\n");

const emptyHeaderSource = [
  "|   |   |   |   |   |",
  "| - | - | - | - | - |",
  "| a | b | c | d | e |",
  "| f | g | h | i | j |",
  "| k | l | m | n | o |",
].join("\n");

async function waitForServer(url, server) {
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The server is still binding.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Browser server failed to start: ${output}`);
}

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
}

async function setTheme(page, theme) {
  const themes = {
    light: {
      "--vscode-editor-background": "#ffffff",
      "--vscode-foreground": "#1f2328",
      "--vscode-editor-foreground": "#1f2328",
      "--vscode-descriptionForeground": "#59636e",
      "--vscode-widget-border": "rgba(31,35,40,.25)",
      "--vscode-focusBorder": "#0969da",
    },
    dark: {
      "--vscode-editor-background": "#1e1e1e",
      "--vscode-foreground": "#d4d4d4",
      "--vscode-editor-foreground": "#d4d4d4",
      "--vscode-descriptionForeground": "#9d9d9d",
      "--vscode-widget-border": "rgba(127,127,127,.45)",
      "--vscode-focusBorder": "#3794ff",
    },
    contrast: {
      "--vscode-editor-background": "#000000",
      "--vscode-foreground": "#ffffff",
      "--vscode-editor-foreground": "#ffffff",
      "--vscode-descriptionForeground": "#ffffff",
      "--vscode-widget-border": "#ffffff",
      "--vscode-focusBorder": "#00ffff",
    },
  };
  await page.emulateMedia({
    colorScheme: theme === "light" ? "light" : "dark",
    forcedColors: theme === "contrast" ? "active" : "none",
  });
  await page.evaluate((variables) => {
    for (const [name, value] of Object.entries(variables))
      document.documentElement.style.setProperty(name, value);
    const contrast = variables["--vscode-editor-background"] === "#000000";
    document.documentElement.classList.toggle("vscode-high-contrast", contrast);
    document.body.classList.toggle("vscode-high-contrast", contrast);
    document.body.style.backgroundColor =
      variables["--vscode-editor-background"];
    document.body.style.color = variables["--vscode-foreground"];
  }, themes[theme]);
  await settle(page);
}

async function load(page, source) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.markdownMint?.view);
  await page.evaluate((markdown) => {
    window.__markdownMintHarness.deliverExternal(markdown, "github");
  }, source);
  await page.waitForFunction(
    (markdown) =>
      window.__markdownMintHarness.document.markdown === markdown &&
      window.markdownMint.sourceEl.value === markdown,
    source,
  );
  await page.waitForSelector(".mm-rich-panel .ProseMirror table");
  await settle(page);
}

async function editCount(page) {
  return page.evaluate(
    () =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length,
  );
}

async function modelSnapshot(page) {
  return page.evaluate(() => {
    const table = window.markdownMint.view.state.doc.firstChild;
    if (!table) throw new Error("table model is missing");
    return {
      rows: Array.from({ length: table.childCount }, (_, row) =>
        Array.from(
          { length: table.child(row).childCount },
          (_, column) => table.child(row).child(column).textContent,
        ),
      ),
      markdown: window.__markdownMintHarness.document.markdown,
    };
  });
}

async function controlTable(page) {
  const table = page.locator(".mm-rich-panel .ProseMirror table");
  await table.hover();
  await page.waitForSelector(".mm-table-controls:not([hidden])");
  return table;
}

async function revealRowHandle(page, table, rowIndex) {
  const tableBox = await table.boundingBox();
  const rowBox = await table.locator("tr").nth(rowIndex).boundingBox();
  assert.ok(tableBox && rowBox, `row ${rowIndex} has no geometry`);
  await page.mouse.move(
    Math.max(8, tableBox.x - 18),
    rowBox.y + rowBox.height / 2,
  );
  const handle = page.locator(
    `[data-table-control="row-handle"][data-index="${rowIndex}"]`,
  );
  await handle.waitFor({ state: "visible" });
  return handle;
}

async function revealColumnHandle(page, table, columnIndex) {
  const header = table.locator("tr").first().locator("th, td").nth(columnIndex);
  const headerBox = await header.boundingBox();
  assert.ok(headerBox, `column ${columnIndex} has no geometry`);
  await page.mouse.move(
    headerBox.x + headerBox.width / 2,
    Math.max(8, headerBox.y - 18),
  );
  const handle = page.locator(
    `[data-table-control="column-handle"][data-index="${columnIndex}"]`,
  );
  await handle.waitFor({ state: "visible" });
  return handle;
}

async function dragPresentationGeometry(page, pointerX, pointerY) {
  return page.evaluate(
    ({ pointerX, pointerY }) => {
      const toRect = (element) => {
        if (!element || element.hidden) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        };
      };
      const overlaps = (first, second) =>
        Boolean(
          first &&
          second &&
          first.right > second.left &&
          first.left < second.right &&
          first.bottom > second.top &&
          first.top < second.bottom,
        );
      const contains = (pointX, pointY, rect) =>
        Boolean(
          rect &&
          pointX >= rect.left &&
          pointX <= rect.right &&
          pointY >= rect.top &&
          pointY <= rect.bottom,
        );
      const preview = toRect(document.querySelector(".mm-table-drag-preview"));
      const line = toRect(document.querySelector(".mm-table-move-indicator"));
      return {
        preview,
        line,
        previewLineOverlap: overlaps(preview, line),
        pointerInsidePreview: contains(pointerX, pointerY, preview),
      };
    },
    { pointerX, pointerY },
  );
}

async function testCellEditPreservesControlDom(page) {
  await load(page, numberedSource(100, 10));
  const table = await controlTable(page);
  const cell = table.locator("tbody td").nth(1);
  await cell.click();
  await page.keyboard.press("End");
  const before = await page.evaluate(() => {
    const rowHandle = document.querySelector(
      '[data-table-control="row-handle"][data-index="1"]',
    );
    const columnHandle = document.querySelector(
      '[data-table-control="column-handle"][data-index="1"]',
    );
    window.__tableControlProbe = { rowHandle, columnHandle };
    return {
      cellText: document.querySelector("tbody tr td:nth-child(2)")?.textContent,
      hasHandles: Boolean(rowHandle && columnHandle),
      markdown: window.__markdownMintHarness.document.markdown,
    };
  });
  assert.ok(before.hasHandles, "control handles missing");

  await page.keyboard.type("!");
  await page.waitForFunction((previous) => {
    const current = document.querySelector(
      "tbody tr td:nth-child(2)",
    )?.textContent;
    return Boolean(current && current !== previous && current.includes("!"));
  }, before.cellText);
  await settle(page);
  const after = await page.evaluate(() => ({
    sameRowHandle:
      window.__tableControlProbe?.rowHandle ===
      document.querySelector(
        '[data-table-control="row-handle"][data-index="1"]',
      ),
    sameColumnHandle:
      window.__tableControlProbe?.columnHandle ===
      document.querySelector(
        '[data-table-control="column-handle"][data-index="1"]',
      ),
    markdown: window.__markdownMintHarness.document.markdown,
  }));
  assert.equal(
    after.sameRowHandle,
    true,
    "ordinary cell typing replaced the row handle DOM",
  );
  assert.equal(
    after.sameColumnHandle,
    true,
    "ordinary cell typing replaced the column handle DOM",
  );
  assert.notEqual(
    after.markdown,
    before.markdown,
    "ordinary cell typing did not change Markdown output",
  );
}

async function testTablePresentation(page) {
  await page.setViewportSize({ width: 960, height: 720 });
  await load(page, emptyHeaderSource);
  await setTheme(page, "light");
  let table = await controlTable(page);
  const idleGeometry = await page.evaluate(() => {
    const table = document.querySelector(".mm-rich-panel .ProseMirror table");
    const cells = table
      ? Array.from(table.rows).flatMap((row) => Array.from(row.cells))
      : [];
    const rects = cells.map((cell) => cell.getBoundingClientRect());
    const grid = {
      left: Math.min(...rects.map((rect) => rect.left)),
      right: Math.max(...rects.map((rect) => rect.right)),
      top: Math.min(...rects.map((rect) => rect.top)),
      bottom: Math.max(...rects.map((rect) => rect.bottom)),
    };
    const outer = table?.getBoundingClientRect();
    return { outer, grid };
  });
  assert.ok(
    idleGeometry.outer && idleGeometry.grid,
    "idle table geometry is unavailable",
  );
  assert.ok(
    idleGeometry.outer.right - idleGeometry.grid.right > 24,
    "the fixture must retain visible whitespace after the actual cell grid",
  );
  await page.mouse.move(
    (idleGeometry.grid.left + idleGeometry.grid.right) / 2,
    (idleGeometry.grid.top + idleGeometry.grid.bottom) / 2,
  );
  await settle(page);
  assert.equal(
    await page.locator(".mm-table-row-handle:visible").count(),
    0,
    "idle presentation exposed every row handle",
  );
  assert.equal(
    await page.locator(".mm-table-column-handle:visible").count(),
    0,
    "idle presentation exposed every column handle",
  );
  await page.screenshot({
    path: resolve(output, "table-controls-idle-light.png"),
    fullPage: false,
  });

  const fifthHeader = table.locator("tr").first().locator("th, td").nth(4);
  const fifthHeaderBox = await fifthHeader.boundingBox();
  assert.ok(fifthHeaderBox, "fifth column geometry is unavailable");
  const fifthHandle = await revealColumnHandle(page, table, 4);
  assert.equal(
    await page.locator(".mm-table-column-handle:visible").count(),
    1,
    "column rail did not expose one matching candidate",
  );
  const hoverHighlights = await page
    .locator(".mm-table-column-highlight:not([hidden])")
    .count();
  assert.equal(
    hoverHighlights,
    1,
    "column hover did not highlight the full grid range",
  );
  await page.screenshot({
    path: resolve(output, "table-controls-column-hover.png"),
    fullPage: false,
  });

  const secondHeader = table.locator("tr").first().locator("th, td").nth(1);
  const secondHeaderBox = await secondHeader.boundingBox();
  assert.ok(secondHeaderBox, "column two geometry is unavailable");
  const handleBox = await fifthHandle.boundingBox();
  assert.ok(handleBox, "fifth column handle geometry is unavailable");
  const beforeDragEdits = await editCount(page);
  const dragY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(handleBox.x + handleBox.width / 2, dragY);
  await page.mouse.down();
  await page.mouse.move(secondHeaderBox.x + secondHeaderBox.width, dragY, {
    steps: 12,
  });
  await page.waitForSelector(".mm-table-drag-preview:visible");
  const previewText = await page
    .locator(".mm-table-drag-preview")
    .textContent();
  assert.match(previewText ?? "", /e/);
  assert.match(previewText ?? "", /j/);
  assert.match(previewText ?? "", /o/);
  assert.match(previewText ?? "", /Move to position 3/);
  assert.equal(
    await page.locator(".mm-table-move-label").count(),
    0,
    "column drag retained the independent move label",
  );
  assert.equal(
    await page
      .locator(
        ".mm-table-row-insert:visible, .mm-table-column-insert:visible, .mm-table-row-append:visible, .mm-table-column-append:visible",
      )
      .count(),
    0,
    "drag presentation exposed an insertion or append control",
  );
  const dragGeometry = await page.evaluate(() => {
    const table = document.querySelector(".mm-rich-panel .ProseMirror table");
    const cells = table
      ? Array.from(table.rows).flatMap((row) => Array.from(row.cells))
      : [];
    const rects = cells.map((cell) => cell.getBoundingClientRect());
    const line = document
      .querySelector(".mm-table-move-indicator")
      ?.getBoundingClientRect();
    return {
      gridRight: Math.max(...rects.map((rect) => rect.right)),
      gridTop: Math.min(...rects.map((rect) => rect.top)),
      gridBottom: Math.max(...rects.map((rect) => rect.bottom)),
      line,
    };
  });
  assert.ok(dragGeometry.line, "valid column drag did not show a move line");
  assert.ok(
    dragGeometry.line.height >=
      dragGeometry.gridBottom - dragGeometry.gridTop - 3,
  );
  assert.ok(dragGeometry.line.x < dragGeometry.gridRight);
  const columnPresentation = await dragPresentationGeometry(
    page,
    secondHeaderBox.x + secondHeaderBox.width,
    dragY,
  );
  assert.ok(columnPresentation.preview, "column drag preview has no rectangle");
  assert.equal(
    columnPresentation.previewLineOverlap,
    false,
    "column drag preview covered the move line",
  );
  assert.equal(
    columnPresentation.pointerInsidePreview,
    false,
    "column drag preview covered the pointer",
  );
  assert.equal(
    await editCount(page),
    beforeDragEdits,
    "column preview edited the document",
  );
  await page.screenshot({
    path: resolve(output, "table-controls-column-drag.png"),
    fullPage: false,
  });
  await page.mouse.up();
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    beforeDragEdits,
  );
  const moved = await modelSnapshot(page);
  assert.deepEqual(moved.rows[1], ["a", "b", "e", "c", "d"]);
  assert.deepEqual(moved.rows[2], ["f", "g", "j", "h", "i"]);
  assert.deepEqual(moved.rows[3], ["k", "l", "o", "m", "n"]);
  await page.screenshot({
    path: resolve(output, "table-controls-column-drop.png"),
    fullPage: false,
  });

  await load(page, emptyHeaderSource);
  await setTheme(page, "light");
  table = await controlTable(page);
  const rowHandle = await revealRowHandle(page, table, 3);
  const rowHandleBox = await rowHandle.boundingBox();
  const firstBodyRow = await table.locator("tr").nth(1).boundingBox();
  assert.ok(rowHandleBox && firstBodyRow, "row drag geometry is unavailable");
  const rowDragX = rowHandleBox.x + rowHandleBox.width / 2;
  const rowDragStartY = rowHandleBox.y + rowHandleBox.height / 2;
  const rowDropY = firstBodyRow.y;
  const beforeRowDragEdits = await editCount(page);
  await page.mouse.move(rowDragX, rowDragStartY);
  await page.mouse.down();
  await page.mouse.move(rowDragX, rowDropY, { steps: 10 });
  await page.waitForSelector(".mm-table-drag-preview:visible");
  const rowPreviewText = await page
    .locator(".mm-table-drag-preview")
    .textContent();
  assert.match(rowPreviewText ?? "", /Move to position 1/);
  assert.equal(
    await page.locator(".mm-table-drag-preview").evaluate((element) => {
      const values = element.querySelector(".mm-table-drag-preview-values");
      return values ? getComputedStyle(values).display : "";
    }),
    "flex",
    "row drag preview was not laid out horizontally",
  );
  assert.equal(
    await page.locator(".mm-table-move-label").count(),
    0,
    "row drag retained the independent move label",
  );
  const rowPresentation = await dragPresentationGeometry(
    page,
    rowDragX,
    rowDropY,
  );
  assert.equal(
    rowPresentation.previewLineOverlap,
    false,
    "row drag preview covered the move line",
  );
  assert.equal(
    rowPresentation.pointerInsidePreview,
    false,
    "row drag preview covered the pointer",
  );
  assert.equal(
    await page
      .locator(
        ".mm-table-row-insert:visible, .mm-table-column-insert:visible, .mm-table-row-append:visible, .mm-table-column-append:visible",
      )
      .count(),
    0,
    "row drag presentation exposed an insertion or append control",
  );
  assert.equal(
    await editCount(page),
    beforeRowDragEdits,
    "row preview edited the document",
  );
  await page.screenshot({
    path: resolve(output, "table-controls-row-drag.png"),
    fullPage: false,
  });
  await setTheme(page, "contrast");
  await page.screenshot({
    path: resolve(output, "table-controls-row-drag-forced-colors.png"),
    fullPage: false,
  });
  const forcedRowPresentation = await page.evaluate(() => {
    const indicator = document.querySelector(".mm-table-move-indicator");
    const highlight = document.querySelector(
      ".mm-table-drag-origin-highlight:not([hidden])",
    );
    if (!indicator || !highlight) return null;
    const indicatorStyle = getComputedStyle(indicator);
    const highlightStyle = getComputedStyle(highlight);
    return {
      indicatorBackground: indicatorStyle.backgroundColor,
      indicatorBorder: indicatorStyle.borderColor,
      highlightBorder: highlightStyle.borderColor,
      highlightBackground: highlightStyle.backgroundColor,
    };
  });
  assert.ok(
    forcedRowPresentation,
    "forced-colors drag presentation is missing",
  );
  assert.notEqual(
    forcedRowPresentation.indicatorBackground,
    "rgba(0, 0, 0, 0)",
    "forced-colors move line had no visible color",
  );
  assert.notEqual(
    forcedRowPresentation.highlightBorder,
    "rgba(0, 0, 0, 0)",
    "forced-colors move target had no visible border",
  );
  assert.match(
    (await page.locator(".mm-table-drag-preview").textContent()) ?? "",
    /Move to position 1/,
    "forced-colors preview clipped the destination text",
  );
  await page.mouse.up();
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    beforeRowDragEdits,
  );
  const flashState = await page
    .locator(".mm-table-row-highlight:not([hidden])")
    .getAttribute("data-state");
  assert.equal(
    flashState,
    "drop-flash",
    "row drop did not show the drop flash immediately",
  );
  await page.screenshot({
    path: resolve(output, "table-controls-row-drop-flash.png"),
    fullPage: false,
  });
  const movedRows = await modelSnapshot(page);
  assert.deepEqual(movedRows.rows[1], ["k", "l", "m", "n", "o"]);
  assert.deepEqual(movedRows.rows[2], ["a", "b", "c", "d", "e"]);
  assert.deepEqual(movedRows.rows[3], ["f", "g", "h", "i", "j"]);
  await page.waitForTimeout(560);
  assert.equal(
    await page
      .locator(".mm-table-row-highlight:not([hidden])")
      .getAttribute("data-state"),
    "selected",
    "selected row highlight did not return after the drop flash",
  );

  await page.setViewportSize({ width: 640, height: 720 });
  await load(page, numberedSource(3, 10));
  await setTheme(page, "light");
  table = await controlTable(page);
  const tableOverflow = await table.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  assert.ok(
    tableOverflow.scrollWidth > tableOverflow.clientWidth,
    "wide fixture did not create an actual horizontal scroll area",
  );
  const tableBox = await table.boundingBox();
  assert.ok(tableBox, "wide table geometry is unavailable");
  await page.mouse.move(tableBox.x + tableBox.width / 2, tableBox.y + 40);
  await page.mouse.wheel(10000, 0);
  await page.waitForFunction(
    () => document.querySelector(".mm-rich-panel table")?.scrollLeft > 0,
  );
  await revealRowHandle(page, table, 1);
  await page.screenshot({
    path: resolve(output, "table-controls-wide-horizontal-scroll.png"),
    fullPage: false,
  });
  await setTheme(page, "dark");
  await revealRowHandle(page, table, 1);
  await page.screenshot({
    path: resolve(output, "table-controls-dark.png"),
    fullPage: false,
  });
  await setTheme(page, "contrast");
  await revealRowHandle(page, table, 1);
  await page.screenshot({
    path: resolve(output, "table-controls-high-contrast.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 960, height: 720 });
}

async function testToolbarPresentation(page) {
  const toolbarState = async (page) =>
    page.evaluate(() => {
      const toolbar = document.querySelector(".mm-table-toolbar");
      if (!toolbar) return null;
      const actions = [
        "table-controls",
        "row-move-up",
        "row-move-down",
        "col-move-left",
        "col-move-right",
      ];
      return {
        toolbarHidden: toolbar.hidden,
        toolbarText: toolbar.textContent ?? "",
        movementGroup: toolbar.querySelector(
          '[role="group"][aria-label="Table movement"]',
        )
          ? getComputedStyle(
              toolbar.querySelector(
                '[role="group"][aria-label="Table movement"]',
              ),
            ).borderStyle
          : null,
        actions: Object.fromEntries(
          actions.map((action) => {
            const button = toolbar.querySelector(`[data-action="${action}"]`);
            return [
              action,
              button
                ? {
                    hidden: button.hidden,
                    disabled: button.disabled,
                    tabIndex: button.tabIndex,
                    icon: button.querySelector("svg")?.dataset.icon ?? null,
                    text: button.textContent ?? "",
                    ariaLabel: button.getAttribute("aria-label"),
                  }
                : null,
            ];
          }),
        ),
      };
    });

  const setup = async (theme = "light") => {
    await page.setViewportSize({ width: 960, height: 720 });
    await load(page, numberedSource(3, 3));
    await setTheme(page, theme);
    const table = await controlTable(page);
    await table.locator("tbody td").first().click();
    await page.waitForSelector(
      '.mm-table-toolbar [data-action="table-controls"]:visible',
    );
    return {
      table,
      toolbar: page.locator(".mm-table-toolbar"),
      state: await toolbarState(page),
    };
  };

  const defaultPresentation = await setup();
  assert.ok(defaultPresentation.state, "default toolbar state is missing");
  assert.equal(
    defaultPresentation.state.toolbarHidden,
    false,
    "default table toolbar was hidden",
  );
  assert.equal(
    defaultPresentation.state.actions["table-controls"].hidden,
    false,
  );
  for (const action of [
    "row-move-up",
    "row-move-down",
    "col-move-left",
    "col-move-right",
  ]) {
    assert.equal(
      defaultPresentation.state.actions[action].hidden,
      true,
      `${action} was visible without a structural selection`,
    );
    assert.equal(
      defaultPresentation.state.actions[action].tabIndex,
      -1,
      `${action} remained in the Tab order while hidden`,
    );
  }
  assert.equal(
    defaultPresentation.state.actions["table-controls"].icon,
    "table-grip",
  );
  assert.doesNotMatch(
    defaultPresentation.state.toolbarText,
    /Direct|Handles|[↑↓←→]/,
  );
  assert.equal(defaultPresentation.state.movementGroup, "solid");
  const defaultToolbarBox = await defaultPresentation.toolbar.boundingBox();
  const defaultTableBox = await defaultPresentation.table.boundingBox();
  assert.ok(
    defaultToolbarBox && defaultTableBox,
    "default toolbar geometry is unavailable",
  );
  await page.screenshot({
    path: resolve(output, "table-toolbar-default.png"),
    fullPage: false,
  });

  const rowHandle = await revealRowHandle(page, defaultPresentation.table, 1);
  await rowHandle.click();
  await page.waitForSelector(
    '[data-table-control="row-handle"][data-index="1"].is-selected',
  );
  const rowState = await toolbarState(page);
  assert.ok(rowState, "row toolbar state is missing");
  assert.equal(rowState.actions["table-controls"].hidden, false);
  assert.equal(rowState.actions["row-move-up"].hidden, false);
  assert.equal(rowState.actions["row-move-down"].hidden, false);
  assert.equal(rowState.actions["col-move-left"].hidden, true);
  assert.equal(rowState.actions["col-move-right"].hidden, true);
  assert.equal(rowState.actions["row-move-up"].disabled, true);
  assert.equal(rowState.actions["row-move-down"].disabled, false);
  assert.deepEqual(
    {
      grip: rowState.actions["table-controls"].icon,
      up: rowState.actions["row-move-up"].icon,
      down: rowState.actions["row-move-down"].icon,
    },
    { grip: "table-grip", up: "table-move-up", down: "table-move-down" },
  );
  assert.deepEqual(
    {
      grip: rowState.actions["table-controls"].ariaLabel,
      up: rowState.actions["row-move-up"].ariaLabel,
      down: rowState.actions["row-move-down"].ariaLabel,
    },
    {
      grip: "Table controls",
      up: "Move selected row up",
      down: "Move selected row down",
    },
  );
  const lastRowHandle = await revealRowHandle(
    page,
    defaultPresentation.table,
    3,
  );
  await lastRowHandle.click();
  await page.waitForSelector(
    '[data-table-control="row-handle"][data-index="3"].is-selected',
  );
  const lastRowState = await toolbarState(page);
  assert.ok(lastRowState, "last-row toolbar state is missing");
  assert.equal(lastRowState.actions["row-move-up"].disabled, false);
  assert.equal(lastRowState.actions["row-move-down"].disabled, true);
  const rowToolbarBox = await defaultPresentation.toolbar.boundingBox();
  const rowTableBox = await defaultPresentation.table.boundingBox();
  assert.ok(
    rowToolbarBox && rowTableBox,
    "row toolbar geometry is unavailable",
  );
  assert.ok(Math.abs(rowToolbarBox.height - defaultToolbarBox.height) < 1);
  assert.ok(Math.abs(rowTableBox.y - defaultTableBox.y) < 1);
  await page.screenshot({
    path: resolve(output, "table-toolbar-row-selected.png"),
    fullPage: false,
  });

  const columnPresentation = await setup();
  const columnHandle = await revealColumnHandle(
    page,
    columnPresentation.table,
    1,
  );
  await columnHandle.click();
  await page.waitForSelector(
    '[data-table-control="column-handle"][data-index="1"].is-selected',
  );
  const columnState = await toolbarState(page);
  assert.ok(columnState, "column toolbar state is missing");
  assert.equal(columnState.actions["row-move-up"].hidden, true);
  assert.equal(columnState.actions["row-move-down"].hidden, true);
  assert.equal(columnState.actions["col-move-left"].hidden, false);
  assert.equal(columnState.actions["col-move-right"].hidden, false);
  assert.equal(columnState.actions["col-move-left"].disabled, true);
  assert.equal(columnState.actions["col-move-right"].disabled, false);
  assert.deepEqual(
    {
      left: columnState.actions["col-move-left"].icon,
      right: columnState.actions["col-move-right"].icon,
    },
    { left: "table-move-left", right: "table-move-right" },
  );
  assert.deepEqual(
    {
      left: columnState.actions["col-move-left"].ariaLabel,
      right: columnState.actions["col-move-right"].ariaLabel,
    },
    {
      left: "Move selected column left",
      right: "Move selected column right",
    },
  );
  const lastColumnHandle = await revealColumnHandle(
    page,
    columnPresentation.table,
    2,
  );
  await lastColumnHandle.click();
  await page.waitForSelector(
    '[data-table-control="column-handle"][data-index="2"].is-selected',
  );
  const lastColumnState = await toolbarState(page);
  assert.ok(lastColumnState, "last-column toolbar state is missing");
  assert.equal(lastColumnState.actions["col-move-left"].disabled, false);
  assert.equal(lastColumnState.actions["col-move-right"].disabled, true);
  const columnToolbarBox = await columnPresentation.toolbar.boundingBox();
  const columnTableBox = await columnPresentation.table.boundingBox();
  assert.ok(
    columnToolbarBox && columnTableBox,
    "column toolbar geometry is unavailable",
  );
  assert.ok(Math.abs(columnToolbarBox.height - defaultToolbarBox.height) < 1);
  assert.ok(Math.abs(columnTableBox.y - defaultTableBox.y) < 1);
  await page.screenshot({
    path: resolve(output, "table-toolbar-column-selected.png"),
    fullPage: false,
  });

  const darkPresentation = await setup("dark");
  const darkRowHandle = await revealRowHandle(page, darkPresentation.table, 2);
  await darkRowHandle.click();
  await page.waitForSelector(
    '[data-table-control="row-handle"][data-index="2"].is-selected',
  );
  await page.screenshot({
    path: resolve(output, "table-toolbar-dark.png"),
    fullPage: false,
  });

  const contrastPresentation = await setup("contrast");
  const contrastColumnHandle = await revealColumnHandle(
    page,
    contrastPresentation.table,
    1,
  );
  await contrastColumnHandle.click();
  await page.waitForSelector(
    '[data-table-control="column-handle"][data-index="1"].is-selected',
  );
  await page.screenshot({
    path: resolve(output, "table-toolbar-high-contrast.png"),
    fullPage: false,
  });
}

async function testDestinationPositionLabels(page) {
  const check = async (axis, sourceIndex, destinationFor, expected) => {
    await page.setViewportSize({ width: 960, height: 720 });
    await load(page, emptyHeaderSource);
    await setTheme(page, "light");
    const table = await controlTable(page);
    const handle =
      axis === "column"
        ? await revealColumnHandle(page, table, sourceIndex)
        : await revealRowHandle(page, table, sourceIndex);
    const handleBox = await handle.boundingBox();
    assert.ok(handleBox, `${axis} label source has no handle geometry`);
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    const destination = await destinationFor(table, startX, startY);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(destination.x, destination.y, { steps: 8 });
    await page.waitForSelector(".mm-table-drag-preview:visible");
    assert.match(
      (await page.locator(".mm-table-drag-preview").textContent()) ?? "",
      new RegExp(`Move to position ${expected}`),
      `${axis} destination label used the wrong post-removal position`,
    );
    assert.equal(
      await page.locator(".mm-table-move-label").count(),
      0,
      `${axis} destination retained the independent move label`,
    );
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        window.__markdownMintHarness.messages.filter(
          (message) => message.type === "edit",
        ).length === 1,
    );
  };

  await check(
    "column",
    4,
    async (table) => {
      const firstHeader = await table
        .locator("tr")
        .first()
        .locator("th, td")
        .first()
        .boundingBox();
      assert.ok(firstHeader, "column start label geometry is unavailable");
      const handle = await revealColumnHandle(page, table, 4);
      const handleBox = await handle.boundingBox();
      assert.ok(handleBox, "column start label handle has no geometry");
      return {
        x: firstHeader.x,
        y: handleBox.y + handleBox.height / 2,
      };
    },
    1,
  );

  await check(
    "column",
    0,
    async (table, _startX, startY) => {
      const lastHeader = await table
        .locator("tr")
        .first()
        .locator("th, td")
        .last()
        .boundingBox();
      assert.ok(lastHeader, "column end label geometry is unavailable");
      return { x: lastHeader.x + lastHeader.width, y: startY };
    },
    5,
  );

  await check(
    "row",
    3,
    async (table, startX) => {
      const firstBody = await table.locator("tr").nth(1).boundingBox();
      assert.ok(firstBody, "row start label geometry is unavailable");
      return { x: startX, y: firstBody.y };
    },
    1,
  );

  await check(
    "row",
    1,
    async (table, startX) => {
      const lastBody = await table.locator("tr").last().boundingBox();
      assert.ok(lastBody, "row end label geometry is unavailable");
      return { x: startX, y: lastBody.y + lastBody.height };
    },
    3,
  );
}

async function testNumberedDragAndHistory(page) {
  await page.setViewportSize({ width: 960, height: 720 });
  const source = numberedSource();
  await load(page, source);
  const table = await controlTable(page);
  const tableBefore = await table.boundingBox();
  assert.ok(tableBefore, "numbered table has no geometry");

  const handle = await revealRowHandle(page, table, 3);
  await handle.click();
  await page.waitForSelector(
    '[data-table-control="row-handle"][data-index="3"].is-selected',
  );
  assert.equal(
    await editCount(page),
    0,
    "handle selection edited the document",
  );

  const handleBox = await handle.boundingBox();
  const firstBodyRow = await table.locator("tr").nth(1).boundingBox();
  assert.ok(handleBox && firstBodyRow, "row drag geometry is unavailable");
  const beforeDragEdits = await editCount(page);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, firstBodyRow.y + 1, {
    steps: 12,
  });
  await page.waitForSelector(".mm-table-drag-preview:visible");
  await page.screenshot({
    path: resolve(output, "table-controls-numbered-row-drag.png"),
    fullPage: false,
  });
  assert.equal(
    await editCount(page),
    beforeDragEdits,
    "drag preview emitted a host edit",
  );
  await page.mouse.up();
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    beforeDragEdits,
  );
  await page.waitForFunction(
    () =>
      window.markdownMint.view.state.doc.firstChild.child(1).child(1)
        .textContent === "Gamma",
  );

  const moved = await modelSnapshot(page);
  assert.equal(moved.rows[1][0], "1");
  assert.equal(moved.rows[1][1], "Gamma");
  assert.equal(moved.rows[2][0], "2");
  assert.equal(moved.rows[2][1], "Alpha");
  assert.match(moved.markdown, /^\| 1 \| Gamma \|/m);
  assert.match(moved.markdown, /^\| 2 \| Alpha \|/m);
  assert.equal(await editCount(page), 1);

  await table.locator("tr").nth(1).locator("td").nth(1).click();
  await page.keyboard.press(undoShortcut);
  await page.waitForFunction(
    () =>
      window.markdownMint.view.state.doc.firstChild.child(1).child(1)
        .textContent === "Alpha",
  );
  let undone = await modelSnapshot(page);
  assert.equal(undone.rows[1][0], "1");
  assert.equal(undone.rows[1][1], "Alpha");
  assert.equal(undone.rows[3][1], "Gamma");

  await page.keyboard.press(redoShortcut);
  await page.waitForFunction(
    () =>
      window.markdownMint.view.state.doc.firstChild.child(1).child(1)
        .textContent === "Gamma",
  );
  undone = await modelSnapshot(page);
  assert.equal(undone.rows[1][0], "1");
  assert.equal(undone.rows[1][1], "Gamma");
  assert.equal(await editCount(page), 1, "undo/redo became extra edits");

  const stage = page.locator(".mm-stage");
  const dimensions = await stage.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  assert.ok(
    dimensions.scrollHeight > dimensions.clientHeight,
    "100-row table did not scroll vertically",
  );
  await stage.hover();
  await page.mouse.wheel(0, 10000);
  await page.waitForFunction(
    () => document.querySelector(".mm-stage").scrollTop > 0,
  );
  const lastRow = table.locator("tr").last();
  await lastRow.scrollIntoViewIfNeeded();
  const lastHandle = await revealRowHandle(page, table, 100);
  const lastHandleBox = await lastHandle.boundingBox();
  const lastRowBox = await lastRow.boundingBox();
  assert.ok(
    lastHandleBox && lastRowBox,
    "scrolling lost the last row geometry",
  );
  assert.ok(
    Math.abs(
      lastHandleBox.y +
        lastHandleBox.height / 2 -
        (lastRowBox.y + lastRowBox.height / 2),
    ) < 4,
    "row handle did not follow the scrolled row",
  );
  if (dimensions.scrollWidth > dimensions.clientWidth) {
    await page.mouse.wheel(10000, 0);
    await page.waitForFunction(
      () => document.querySelector(".mm-stage").scrollLeft > 0,
    );
  }

  const tableAfter = await table.boundingBox();
  assert.ok(tableAfter, "table disappeared after scrolling");
  assert.equal(
    tableAfter.width,
    tableBefore.width,
    "controls changed table layout width",
  );
  await page.screenshot({
    path: resolve(output, "numbered-table-controls.png"),
    fullPage: false,
  });
}

async function testRailsAndKeyboard(page) {
  await load(page, smallSource);
  const table = await controlTable(page);
  const initialEdits = await editCount(page);
  const tableBox = await table.boundingBox();
  const bodyRows = table.locator("tr");
  const secondRow = await bodyRows.nth(1).boundingBox();
  assert.ok(tableBox && secondRow, "row insertion geometry is unavailable");
  await page.mouse.move(Math.max(8, tableBox.x - 18), secondRow.y);
  const rowInsert = page.locator('[data-table-control="row-insert"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-table-control="row-insert"]').hidden,
  );
  await rowInsert.click();
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    initialEdits,
  );

  const afterRowInsert = await modelSnapshot(page);
  assert.equal(
    afterRowInsert.rows.length,
    4,
    "row boundary plus inserted the wrong number of rows",
  );
  assert.equal(afterRowInsert.rows[2][0], "2");

  await controlTable(page);
  const headerCells = table.locator("tr").first().locator("th, td");
  const firstHeader = await headerCells.first().boundingBox();
  const secondHeader = await headerCells.nth(1).boundingBox();
  assert.ok(
    firstHeader && secondHeader,
    "column insertion geometry is unavailable",
  );
  await page.mouse.move(secondHeader.x, Math.max(8, firstHeader.y - 18));
  const columnInsert = page.locator('[data-table-control="column-insert"]');
  await page.waitForFunction(
    () =>
      !document.querySelector('[data-table-control="column-insert"]').hidden,
  );
  await columnInsert.click();
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    initialEdits + 1,
  );
  let afterColumnInsert = await modelSnapshot(page);
  assert.equal(
    afterColumnInsert.rows[0].length,
    4,
    "column boundary plus inserted the wrong number of columns",
  );
  assert.equal(
    afterColumnInsert.rows[0][0],
    "#",
    "number column moved during insertion",
  );

  await controlTable(page);
  const rowAppend = page.locator('[data-table-control="row-append"]');
  const appendLastRow = await table.locator("tr").last().boundingBox();
  const appendFirstCell = await table
    .locator("tr")
    .last()
    .locator("th, td")
    .first()
    .boundingBox();
  const appendLastCell = await table
    .locator("tr")
    .last()
    .locator("th, td")
    .last()
    .boundingBox();
  assert.ok(
    appendFirstCell && appendLastCell && appendLastRow,
    "row append geometry is unavailable",
  );
  await page.mouse.move(
    (appendFirstCell.x + appendLastCell.x + appendLastCell.width) / 2,
    appendLastRow.y + appendLastRow.height + 12,
  );
  await rowAppend.waitFor({ state: "visible" });
  await rowAppend.click();
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    initialEdits + 2,
  );
  afterColumnInsert = await modelSnapshot(page);
  assert.equal(
    afterColumnInsert.rows.length,
    5,
    "row append did not add exactly one row",
  );
  assert.equal(
    afterColumnInsert.rows.at(-1)[1],
    "",
    "row append did not focus an empty data row",
  );

  await controlTable(page);
  const columnAppend = page.locator('[data-table-control="column-append"]');
  const appendHeader = await table
    .locator("tr")
    .first()
    .locator("th, td")
    .last()
    .boundingBox();
  const appendTableAfter = await table.boundingBox();
  assert.ok(
    appendHeader && appendTableAfter,
    "column append geometry is unavailable",
  );
  await page.mouse.move(
    appendHeader.x + appendHeader.width + 12,
    appendHeader.y + appendHeader.height / 2,
  );
  await columnAppend.waitFor({ state: "visible" });
  await columnAppend.click();
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    initialEdits + 3,
  );
  const afterAppend = await modelSnapshot(page);
  assert.equal(
    afterAppend.rows[0].length,
    5,
    "column append did not add exactly one column",
  );
  assert.equal(
    afterAppend.rows[0].at(-1),
    "",
    "column append did not create an empty header",
  );

  await controlTable(page);
  const rowHandle = await revealRowHandle(page, table, 1);
  await rowHandle.click();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    initialEdits + 4,
  );
  assert.equal(
    await page.locator(".mm-table-row-handle.is-selected").count(),
    1,
    "keyboard move lost the structural selection",
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator(".mm-table-row-handle.is-selected").count(),
    0,
    "Escape did not clear structural selection",
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.classList.contains("ProseMirror"),
    ),
    true,
    "Escape did not return focus to the editor",
  );

  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() =>
    document.body.classList.add("vscode-high-contrast"),
  );
  await controlTable(page);
  await revealRowHandle(page, table, 1);
  assert.equal(
    await page.locator(".mm-table-controls button").first().isVisible(),
    true,
    "controls disappeared under dark/high-contrast theme variables",
  );
  await page.screenshot({
    path: resolve(output, "table-controls-dark-contrast.png"),
    fullPage: false,
  });
}

async function testColumnDrag(page) {
  await load(page, smallSource);
  const table = await controlTable(page);
  const handle = await revealColumnHandle(page, table, 2);
  await handle.click();
  const handleBox = await handle.boundingBox();
  const firstHeader = await table
    .locator("tr")
    .first()
    .locator("th, td")
    .first()
    .boundingBox();
  assert.ok(handleBox && firstHeader, "column drag geometry is unavailable");
  const beforeDragEdits = await editCount(page);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    firstHeader.x + firstHeader.width + 1,
    handleBox.y + handleBox.height / 2,
    { steps: 8 },
  );
  assert.equal(
    await editCount(page),
    beforeDragEdits,
    "column drag preview emitted a host edit",
  );
  await page.mouse.up();
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    beforeDragEdits,
  );
  const moved = await modelSnapshot(page);
  assert.deepEqual(moved.rows[0], ["#", "Value", "Name"]);
  assert.deepEqual(moved.rows[1], ["1", "A", "Alpha"]);
}

async function testEscapeDuringUnselectedDrag(page) {
  await load(page, numberedSource(3, 3));
  const rowTable = await controlTable(page);
  const rowHandle = await revealRowHandle(page, rowTable, 3);
  const rowHandleBox = await rowHandle.boundingBox();
  const firstBodyRow = await rowTable.locator("tr").nth(1).boundingBox();
  assert.ok(rowHandleBox && firstBodyRow, "row escape geometry is unavailable");
  const beforeRowDrag = await modelSnapshot(page);
  await page.mouse.move(
    rowHandleBox.x + rowHandleBox.width / 2,
    rowHandleBox.y + rowHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    rowHandleBox.x + rowHandleBox.width / 2,
    firstBodyRow.y + 1,
    { steps: 8 },
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await settle(page);
  assert.equal(await editCount(page), 0, "row Escape committed an edit");
  assert.deepEqual(await modelSnapshot(page), beforeRowDrag);
  assert.equal(
    await page.locator(".mm-table-row-handle.is-dragging").count(),
    0,
    "row Escape left the handle dragging",
  );

  await load(page, smallSource);
  const columnTable = await controlTable(page);
  const columnHandle = await revealColumnHandle(page, columnTable, 2);
  const columnHandleBox = await columnHandle.boundingBox();
  const firstHeader = await columnTable
    .locator("tr")
    .first()
    .locator("th, td")
    .first()
    .boundingBox();
  assert.ok(
    columnHandleBox && firstHeader,
    "column escape geometry is unavailable",
  );
  const beforeColumnDrag = await modelSnapshot(page);
  await page.mouse.move(
    columnHandleBox.x + columnHandleBox.width / 2,
    columnHandleBox.y + columnHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    firstHeader.x + firstHeader.width + 1,
    columnHandleBox.y + columnHandleBox.height / 2,
    { steps: 8 },
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await settle(page);
  assert.equal(await editCount(page), 0, "column Escape committed an edit");
  assert.deepEqual(await modelSnapshot(page), beforeColumnDrag);
  assert.equal(
    await page.locator(".mm-table-column-handle.is-dragging").count(),
    0,
    "column Escape left the handle dragging",
  );
}

async function testKeyboardHandleNavigation(page) {
  await load(page, numberedSource(3, 3));
  const table = await controlTable(page);
  await table.locator("tbody td").first().click();
  const handlesButton = page.locator(
    '.mm-table-toolbar [data-action="table-controls"]',
  );
  await handlesButton.waitFor({ state: "visible" });
  await handlesButton.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.activeElement?.dataset.tableControl === "row-handle",
  );

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset.index),
    "3",
    "row arrows did not reach the third row handle",
  );
  assert.equal(
    await editCount(page),
    0,
    "row focus navigation edited the document",
  );
  await page.keyboard.press("Enter");
  await page.waitForSelector(
    '[data-table-control="row-handle"][data-index="3"].is-selected',
  );
  assert.equal(
    await editCount(page),
    0,
    "row keyboard selection edited the document",
  );

  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    0,
  );
  assert.equal(
    await page
      .locator(".mm-table-row-handle.is-selected")
      .getAttribute("data-index"),
    "2",
    "selected row arrow did not move the row",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("ProseMirror"),
  );

  await handlesButton.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.activeElement?.dataset.tableControl === "row-handle",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset.tableControl),
    "column-handle",
    "Tab did not enter the column handle group",
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset.index),
    "2",
    "column arrows did not reach the second data column handle",
  );
  await page.keyboard.press("Enter");
  await page.waitForSelector(
    '[data-table-control="column-handle"][data-index="2"].is-selected',
  );
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    (expected) =>
      window.__markdownMintHarness.messages.filter(
        (message) => message.type === "edit",
      ).length ===
      expected + 1,
    1,
  );
  const moved = await modelSnapshot(page);
  assert.deepEqual(moved.rows[0], ["#", "Value", "Name"]);
  await page.keyboard.press("Escape");
}

async function main() {
  const server = spawn(process.execPath, ["tests/browser/server.mjs"], {
    cwd: repository,
    env: { ...process.env, MM_BROWSER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  let page;
  try {
    await mkdir(output, { recursive: true });
    await rm(resolve(output, "failure.png"), { force: true });
    await waitForServer(`${baseUrl}/`, server);
    const executablePath =
      process.env.MM_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      `Missing Chromium: ${executablePath}. Run npx playwright install chromium or set MM_BROWSER_EXECUTABLE_PATH.`,
    );
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({
      viewport: { width: 960, height: 720 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(10000);
    await testCellEditPreservesControlDom(page);
    await testTablePresentation(page);
    await testToolbarPresentation(page);
    await testDestinationPositionLabels(page);
    await testNumberedDragAndHistory(page);
    await testColumnDrag(page);
    await testEscapeDuringUnselectedDrag(page);
    await testKeyboardHandleNavigation(page);
    await testRailsAndKeyboard(page);
    console.log(
      "Table controls browser checks passed: real row/column handle click/drag, unselected drag Escape cancellation, keyboard handle navigation, boundary and append rails, 100x10 scrolling, numbering, and host undo/redo.",
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
