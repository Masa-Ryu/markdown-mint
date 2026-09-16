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

async function testNumberedDragAndHistory(page) {
  const source = numberedSource();
  await load(page, source);
  const table = await controlTable(page);
  const tableBefore = await table.boundingBox();
  assert.ok(tableBefore, "numbered table has no geometry");

  const handle = page.locator(
    '[data-table-control="row-handle"][data-index="3"]',
  );
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
  const lastHandle = page.locator(
    '[data-table-control="row-handle"][data-index="100"]',
  );
  const lastRow = table.locator("tr").last();
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
  await rowAppend.scrollIntoViewIfNeeded();
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
  await columnAppend.scrollIntoViewIfNeeded();
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
  const rowHandle = page.locator(
    '[data-table-control="row-handle"][data-index="1"]',
  );
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
  const handle = page.locator(
    '[data-table-control="column-handle"][data-index="2"]',
  );
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
  const rowHandle = page.locator(
    '[data-table-control="row-handle"][data-index="3"]',
  );
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
  const columnHandle = page.locator(
    '[data-table-control="column-handle"][data-index="2"]',
  );
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
