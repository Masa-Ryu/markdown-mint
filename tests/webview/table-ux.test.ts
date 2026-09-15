import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CellSelection, TableMap } from "prosemirror-tables";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import { BlockBoundarySelection } from "../../src/webview/blockBoundary";
import {
  createEditorApp,
  type MarkdownEditorApp,
} from "../../src/webview/editor";

const apps: MarkdownEditorApp[] = [];

function makeApp(
  markdown = "Before",
  profile: "github" | "gitlab" | "commonmark" = "github",
): { app: MarkdownEditorApp; root: HTMLElement; messages: unknown[] } {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const app = createEditorApp({
    root,
    vscode: { postMessage: (message) => messages.push(message) },
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: { markdown, version: 1, profile },
  });
  apps.push(app);
  return { app, root, messages };
}

function messageType(messages: unknown[], type: string): unknown[] {
  return messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === type,
  );
}

function latestEdit(messages: unknown[]): Record<string, unknown> | undefined {
  return messageType(messages, "edit").at(-1) as
    Record<string, unknown> | undefined;
}

function dispatchCellText(app: MarkdownEditorApp, cell: Element): void {
  const cellPos = app.view.posAtDOM(cell, 0);
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.near(app.view.state.doc.resolve(cellPos + 1)),
    ),
  );
}

function dispatchCellSelection(
  app: MarkdownEditorApp,
  anchorCell: Element,
  headCell = anchorCell,
): void {
  app.view.dispatch(
    app.view.state.tr.setSelection(
      CellSelection.create(
        app.view.state.doc,
        app.view.posAtDOM(anchorCell, 0) - 1,
        app.view.posAtDOM(headCell, 0) - 1,
      ),
    ),
  );
}

interface TestRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function setTestRect(element: Element, rect: TestRect): void {
  const measured = {
    ...rect,
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    toJSON: () => measured,
  } as DOMRect;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => measured,
  });
}

function tableNodeAndStart(app: MarkdownEditorApp): {
  table: PMNode;
  tableStart: number;
} {
  let table: PMNode | null = null;
  let tablePosition = -1;
  app.view.state.doc.descendants((node, position) => {
    if (node.type.spec.tableRole === "table") {
      table = node;
      tablePosition = position;
      return false;
    }
    return true;
  });
  if (!table) throw new Error("Missing table node");
  return { table, tableStart: tablePosition + 1 };
}

function mockTableGeometry(app: MarkdownEditorApp, root: HTMLElement): void {
  const { table, tableStart } = tableNodeAndStart(app);
  const map = TableMap.get(table);
  const tableElement = root.querySelector<HTMLTableElement>("table");
  if (!tableElement) throw new Error("Missing table element");
  const columnBoundaries = Array.from(
    { length: map.width + 1 },
    (_, column) => 10 + column * 100,
  );
  const rowBoundaries = Array.from(
    { length: map.height + 1 },
    (_, row) => 20 + row * 30,
  );
  setTestRect(tableElement, {
    top: rowBoundaries[0]!,
    left: columnBoundaries[0]!,
    bottom: rowBoundaries.at(-1)!,
    right: columnBoundaries.at(-1)!,
  });
  setTestRect(root.querySelector<HTMLElement>(".mm-stage")!, {
    top: 0,
    left: 0,
    bottom: 1000,
    right: 1000,
  });
  const rows = tableElement.querySelectorAll<HTMLTableRowElement>("tr");
  for (let row = 0; row < map.height; row += 1)
    setTestRect(rows[row]!, {
      top: rowBoundaries[row]!,
      left: columnBoundaries[0]!,
      bottom: rowBoundaries[row + 1]!,
      right: columnBoundaries.at(-1)!,
    });
  for (const cellPosition of new Set(map.map)) {
    const cell = app.view.nodeDOM(tableStart + cellPosition);
    if (!(cell instanceof HTMLElement))
      throw new Error(`Missing DOM cell for position ${cellPosition}`);
    const rect = map.findCell(cellPosition);
    setTestRect(cell, {
      top: rowBoundaries[rect.top]!,
      left: columnBoundaries[rect.left]!,
      bottom: rowBoundaries[rect.bottom]!,
      right: columnBoundaries[rect.right]!,
    });
  }
}

function tableCell(
  type: "table_cell" | "table_header",
  text: string,
  attrs: { colspan?: number; rowspan?: number } = {},
): PMNode {
  const cellType = schema.nodes[type];
  const paragraphType = schema.nodes.paragraph;
  if (!cellType || !paragraphType) throw new Error("Missing table schema");
  return cellType.create(
    {
      colspan: 1,
      rowspan: 1,
      colwidth: null,
      alignment: null,
      ...attrs,
    },
    paragraphType.create(null, text ? schema.text(text) : null),
  );
}

function replaceWithTable(app: MarkdownEditorApp, table: PMNode): void {
  app.view.dispatch(
    app.view.state.tr.replaceWith(0, app.view.state.doc.content.size, table),
  );
}

function selectTableCell(
  app: MarkdownEditorApp,
  root: HTMLElement,
  row: number,
  column: number,
  textOffset = 0,
): void {
  const cell =
    root.querySelectorAll<HTMLTableRowElement>("tr")[row]?.children[column];
  if (!(cell instanceof HTMLElement))
    throw new Error(`Missing table cell at ${row},${column}`);
  const cellPos = app.view.posAtDOM(cell, 0);
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.near(
        app.view.state.doc.resolve(cellPos + 1 + textOffset),
        1,
      ),
    ),
  );
}

function selectTextblock(
  app: MarkdownEditorApp,
  text: string,
  edge: "start" | "end",
): void {
  let position = -1;
  app.view.state.doc.descendants((node, offset) => {
    if (node.isTextblock && node.textContent === text)
      position = offset + 1 + (edge === "end" ? node.content.size : 0);
  });
  expect(position).toBeGreaterThanOrEqual(0);
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.create(app.view.state.doc, position),
    ),
  );
  app.view.focus();
}

function dispatchEditorKey(
  app: MarkdownEditorApp,
  key: string,
  options: {
    shiftKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  } = {},
): KeyboardEvent {
  const { isComposing, keyCode, ...keyboardOptions } = options;
  const event = new KeyboardEvent("keydown", {
    key,
    ...keyboardOptions,
    bubbles: true,
    cancelable: true,
  });
  if (isComposing !== undefined)
    Object.defineProperty(event, "isComposing", { value: isComposing });
  if (keyCode !== undefined)
    Object.defineProperty(event, "keyCode", { value: keyCode });
  app.view.dom.dispatchEvent(event);
  return event;
}

function activeTableCell(app: MarkdownEditorApp): {
  row: number;
  column: number;
} {
  const selection = app.view.state.selection;
  const resolved =
    selection instanceof CellSelection ? selection.$headCell : selection.$head;
  let cellDepth = -1;
  let tableDepth = -1;
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const role = resolved.node(depth).type.spec.tableRole;
    if (cellDepth < 0 && (role === "cell" || role === "header_cell"))
      cellDepth = depth;
    if (role === "table") {
      tableDepth = depth;
      break;
    }
  }
  if (cellDepth < 0 || tableDepth < 0)
    throw new Error("Selection is not inside a table cell");
  const table = resolved.node(tableDepth);
  const tableStart = resolved.start(tableDepth);
  const cellPos =
    selection instanceof CellSelection
      ? selection.$headCell.pos
      : resolved.before(cellDepth);
  const map = TableMap.get(table);
  const rect = map.findCell(cellPos - tableStart);
  return { row: rect.top, column: rect.left };
}

function tableRowCount(app: MarkdownEditorApp): number {
  return app.view.state.doc.firstChild?.childCount ?? 0;
}

beforeEach(() => {
  document.body.replaceChildren();
  if (typeof Range !== "undefined" && !Range.prototype.getClientRects)
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
      }),
    });
});

afterEach(() => {
  for (const app of apps) app.destroy();
  apps.length = 0;
  document.body.replaceChildren();
});

describe("table insertion dialog", () => {
  it("opens on the grid, selects a size before one explicit insert, and places the caret in the header", () => {
    const { app, root, messages } = makeApp();
    const originalSelection = app.view.state.selection;
    root
      .querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]')!
      .click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const grid = dialog.querySelector<HTMLElement>(".mm-table-grid")!;
    const fields = dialog.querySelector<HTMLElement>(
      ".mm-table-dialog-fields",
    )!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.querySelector("h2")?.textContent).toBe("Insert table");
    expect(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Columns"]'),
    ).toBeNull();
    expect(
      grid.compareDocumentPosition(fields) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.activeElement).toBe(grid);
    expect(dialog.querySelector(".mm-table-grid-label")?.textContent).toContain(
      "double-click",
    );
    const inputs = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="number"]',
    );
    expect(inputs[0]?.value).toBe("3");
    expect(inputs[1]?.value).toBe("3");
    expect(dialog.querySelectorAll(".mm-table-grid-cell")).toHaveLength(48);
    expect(messageType(messages, "edit")).toHaveLength(0);

    const target = dialog.querySelector<HTMLButtonElement>(
      '[data-grid-row="5"][data-grid-column="4"]',
    )!;
    target.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(dialog.querySelector(".mm-table-size")?.textContent).toBe("4 × 5");
    expect(
      dialog.querySelectorAll(".mm-table-grid-cell.is-preview"),
    ).toHaveLength(20);
    expect(
      dialog.querySelectorAll(".mm-table-grid-cell.is-selected"),
    ).toHaveLength(0);
    target.click();
    expect(inputs[0]?.value).toBe("4");
    expect(inputs[1]?.value).toBe("5");
    expect(dialog.querySelector(".mm-table-size")?.textContent).toBe("4 × 5");
    expect(messageType(messages, "edit")).toHaveLength(0);

    dialog.querySelector<HTMLButtonElement>(".mm-dialog-primary")!.click();
    expect(messageType(messages, "edit")).toHaveLength(1);
    const insertedTable = app.view.state.doc.firstChild!;
    expect(insertedTable.type.name).toBe("table");
    expect(app.view.state.doc.textContent).toContain("Before");
    expect(insertedTable.childCount).toBe(5);
    expect(insertedTable.child(0).childCount).toBe(4);
    expect(insertedTable.child(0).child(0).type.name).toBe("table_header");
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(originalSelection.from).toBeLessThan(app.view.state.selection.from);
  });

  it("cancels without a document transaction and validates numeric fields", () => {
    const { app, root, messages } = makeApp();
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-table"]',
    )!;
    const original = app.view.state.doc.toJSON();
    button.click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const columns = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="number"]',
    )[0]!;
    const insert =
      dialog.querySelector<HTMLButtonElement>(".mm-dialog-primary")!;
    columns.value = "";
    columns.dispatchEvent(new Event("input", { bubbles: true }));
    expect(insert.disabled).toBe(true);
    expect(
      dialog.querySelector(".mm-table-dialog-error")?.textContent,
    ).toContain("Columns is required");
    Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent === "Cancel")!
      .click();
    expect(messageType(messages, "edit")).toHaveLength(0);
    expect(app.view.state.doc.toJSON()).toEqual(original);
    expect(document.activeElement).toBe(button);
  });

  it("refuses a modal commit after the document changes", () => {
    const { app, root, messages } = makeApp();
    root
      .querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]')!
      .click();
    app.view.dispatch(app.view.state.tr.insertText(" changed"));
    const before = messageType(messages, "edit").length;
    root.querySelector<HTMLButtonElement>(".mm-dialog-primary")!.click();
    expect(messageType(messages, "edit")).toHaveLength(before);
    expect(root.querySelector(".mm-status")).toBeNull();
  });

  it("grows and shrinks one preview rectangle without leaving a selected corner or restoring through a grid gap", () => {
    const { root } = makeApp();
    root
      .querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]')!
      .click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const grid = dialog.querySelector<HTMLElement>(".mm-table-grid")!;
    const grow = dialog.querySelector<HTMLButtonElement>(
      '[data-grid-row="4"][data-grid-column="5"]',
    )!;
    grow.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(
      dialog.querySelectorAll(".mm-table-grid-cell.is-preview"),
    ).toHaveLength(20);
    expect(
      dialog.querySelectorAll(".mm-table-grid-cell.is-selected"),
    ).toHaveLength(0);
    expect(dialog.querySelector(".mm-table-size")?.textContent).toBe("5 × 4");

    const shrink = dialog.querySelector<HTMLButtonElement>(
      '[data-grid-row="1"][data-grid-column="1"]',
    )!;
    shrink.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(
      dialog.querySelectorAll(".mm-table-grid-cell.is-preview"),
    ).toHaveLength(1);
    expect(dialog.querySelector(".mm-table-size")?.textContent).toBe("1 × 1");
    grid.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(
      dialog.querySelectorAll(".mm-table-grid-cell.is-preview"),
    ).toHaveLength(1);
    grid.dispatchEvent(new Event("pointerleave", { bubbles: true }));
    expect(
      dialog.querySelectorAll(".mm-table-grid-cell.is-preview"),
    ).toHaveLength(9);
    expect(dialog.querySelector(".mm-table-size")?.textContent).toBe("3 × 3");
  });

  it("does not rerender repeatedly while the pointer remains in one cell", () => {
    const { app, root } = makeApp();
    root
      .querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]')!
      .click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const target = dialog.querySelector<HTMLButtonElement>(
      '[data-grid-row="5"][data-grid-column="4"]',
    )!;
    const picker = app as unknown as { renderTableGrid: () => void };
    const render = vi.spyOn(picker, "renderTableGrid");
    target.dispatchEvent(new Event("pointermove", { bubbles: true }));
    target.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(render).toHaveBeenCalledTimes(1);
    render.mockRestore();
  });

  it("double-clicks a grid size into one edit and leaves the caret in the header", () => {
    const { app, root, messages } = makeApp();
    root
      .querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]')!
      .click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const target = dialog.querySelector<HTMLButtonElement>(
      '[data-grid-row="5"][data-grid-column="4"]',
    )!;
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(messageType(messages, "edit")).toHaveLength(1);
    expect(app.view.state.doc.firstChild?.childCount).toBe(5);
    expect(app.view.state.doc.firstChild?.firstChild?.childCount).toBe(4);
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("does not commit a cancelled grid double-click", () => {
    const { root, messages } = makeApp();
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-table"]',
    )!;
    button.click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const target = dialog.querySelector<HTMLButtonElement>(
      '[data-grid-row="2"][data-grid-column="2"]',
    )!;
    Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent === "Cancel")!
      .click();
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("does not commit a stale grid double-click after the document changes", () => {
    const { app, root, messages } = makeApp();
    root
      .querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]')!
      .click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const target = dialog.querySelector<HTMLButtonElement>(
      '[data-grid-row="2"][data-grid-column="2"]',
    )!;
    app.view.dispatch(app.view.state.tr.insertText(" changed"));
    const before = messageType(messages, "edit").length;
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(messageType(messages, "edit")).toHaveLength(before);
    expect(root.querySelector(".mm-status")).toBeNull();
  });

  it("keeps numeric dimensions at 20×50 while the visual grid remains 8×6", () => {
    const { root } = makeApp();
    root
      .querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]')!
      .click();
    const dialog = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="number"]',
    );
    inputs[0]!.value = "20";
    inputs[1]!.value = "50";
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(inputs[0]?.value).toBe("20");
    expect(inputs[1]?.value).toBe("50");
    expect(dialog.querySelector(".mm-table-size")?.textContent).toBe("20 × 50");
    expect(
      dialog.querySelectorAll(".mm-table-grid-cell.is-preview"),
    ).toHaveLength(48);
  });

  it("clears invalid input state when a cancelled dialog is reopened", () => {
    const { app, root, messages } = makeApp();
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-table"]',
    )!;
    button.click();
    const firstDialog =
      root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const columns = firstDialog.querySelectorAll<HTMLInputElement>(
      'input[type="number"]',
    )[0]!;
    columns.value = "21";
    columns.dispatchEvent(new Event("input", { bubbles: true }));
    expect(
      firstDialog.querySelector<HTMLButtonElement>(".mm-dialog-primary")!
        .disabled,
    ).toBe(true);
    Array.from(firstDialog.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent === "Cancel")!
      .click();

    button.click();
    const reopened = root.querySelector<HTMLDialogElement>(".mm-table-dialog")!;
    const target = reopened.querySelector<HTMLButtonElement>(
      '[data-grid-row="3"][data-grid-column="4"]',
    )!;
    target.click();
    expect(
      reopened.querySelector<HTMLButtonElement>(".mm-dialog-primary")!.disabled,
    ).toBe(false);
    expect(
      reopened.querySelector<HTMLInputElement>('input[type="number"]')!
        .validationMessage,
    ).toBe("");
    reopened.querySelector<HTMLButtonElement>(".mm-dialog-primary")!.click();
    expect(messageType(messages, "edit")).toHaveLength(1);
    expect(app.view.state.doc.firstChild?.childCount).toBe(3);
    expect(app.view.state.doc.firstChild?.firstChild?.childCount).toBe(4);
  });
});

describe("table Enter navigation", () => {
  it("moves to the next row in the same column without changing the document", () => {
    const source =
      "| H1 | H2 |\n| --- | --- |\n| A1 | A2 |\n| B1 | B2 |\n| C1 | C2 |";
    const { app, root, messages } = makeApp(source);
    const before = app.view.state.doc.toJSON();

    selectTableCell(app, root, 1, 0);
    dispatchEditorKey(app, "Enter");
    expect(activeTableCell(app)).toEqual({ row: 2, column: 0 });
    expect(app.view.state.doc.toJSON()).toEqual(before);
    expect(messageType(messages, "edit")).toHaveLength(0);

    selectTableCell(app, root, 1, 1);
    dispatchEditorKey(app, "Enter");
    expect(activeTableCell(app)).toEqual({ row: 2, column: 1 });

    selectTableCell(app, root, 2, 1);
    dispatchEditorKey(app, "Enter");
    expect(activeTableCell(app)).toEqual({ row: 3, column: 1 });
    expect(app.view.state.doc.toJSON()).toEqual(before);
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("does not split text when Enter is pressed in the middle of a cell", () => {
    const source = "| H1 | H2 |\n| --- | --- |\n| Alpha | A2 |\n| Beta | B2 |";
    const { app, root, messages } = makeApp(source);
    const before = app.view.state.doc.toJSON();

    selectTableCell(app, root, 1, 0, 2);
    dispatchEditorKey(app, "Enter");

    expect(activeTableCell(app)).toEqual({ row: 2, column: 0 });
    expect(app.view.state.doc.toJSON()).toEqual(before);
    expect(app.view.state.doc.firstChild?.child(1).child(0).textContent).toBe(
      "Alpha",
    );
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("adds one row at a time on the final row and preserves the column", () => {
    const { app, root, messages } = makeApp(
      "| H1 | H2 |\n| --- | --- |\n| A1 | A2 |",
    );

    selectTableCell(app, root, 1, 0);
    dispatchEditorKey(app, "Enter");
    expect(tableRowCount(app)).toBe(3);
    expect(activeTableCell(app)).toEqual({ row: 2, column: 0 });
    expect(messageType(messages, "edit")).toHaveLength(1);

    const firstEdit = latestEdit(messages)!;
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: String(firstEdit.markdown),
      version: 2,
      profile: "github",
      operationId: String(firstEdit.operationId),
      reason: "ack",
    });
    dispatchEditorKey(app, "Enter");
    expect(tableRowCount(app)).toBe(4);
    expect(activeTableCell(app)).toEqual({ row: 3, column: 0 });
    expect(messageType(messages, "edit")).toHaveLength(2);
  });

  it("adds the final row cell at the same non-first column", () => {
    const { app, root } = makeApp(
      "| H1 | H2 | H3 |\n| --- | --- | --- |\n| A1 | A2 | A3 |",
    );

    selectTableCell(app, root, 1, 2);
    dispatchEditorKey(app, "Enter");

    expect(tableRowCount(app)).toBe(3);
    expect(app.view.state.doc.firstChild?.lastChild?.childCount).toBe(3);
    expect(activeTableCell(app)).toEqual({ row: 2, column: 2 });
  });

  it("keeps Shift+Enter as a hard break and restores it after serialization", () => {
    const { app, root, messages } = makeApp(
      "| H1 |\n| --- |\n| one |\n| two |",
    );

    selectTableCell(app, root, 1, 0, 3);
    dispatchEditorKey(app, "Enter", { shiftKey: true });

    expect(activeTableCell(app)).toEqual({ row: 1, column: 0 });
    const cell = app.view.state.doc.firstChild?.child(1).child(0);
    expect(cell?.firstChild?.childCount).toBe(2);
    expect(cell?.firstChild?.lastChild?.type.name).toBe("hard_break");
    const markdown = String(latestEdit(messages)?.markdown ?? "");
    expect(markdown).toContain("<br>");

    const reloaded = makeApp(markdown);
    const reloadedCell = reloaded.app.view.state.doc.firstChild
      ?.child(1)
      .child(0);
    expect(reloadedCell?.firstChild?.childCount).toBe(2);
    expect(reloadedCell?.firstChild?.lastChild?.type.name).toBe("hard_break");
  });

  it("ignores composition Enter, including keyCode 229, until composition ends", () => {
    const { app, root } = makeApp("| H1 |\n| --- |\n| final |");
    selectTableCell(app, root, 1, 0);
    const before = app.view.state.doc.toJSON();

    app.view.dom.dispatchEvent(
      new Event("compositionstart", { bubbles: true }),
    );
    app.view.dom.dispatchEvent(
      new Event("compositionupdate", { bubbles: true }),
    );
    dispatchEditorKey(app, "Enter", { isComposing: true, keyCode: 229 });
    expect(tableRowCount(app)).toBe(2);
    expect(app.view.state.doc.toJSON()).toEqual(before);
    expect(activeTableCell(app)).toEqual({ row: 1, column: 0 });

    app.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true }));
    dispatchEditorKey(app, "Enter", { keyCode: 229 });
    expect(tableRowCount(app)).toBe(2);
    dispatchEditorKey(app, "Enter");
    expect(tableRowCount(app)).toBe(3);
    expect(activeTableCell(app)).toEqual({ row: 2, column: 0 });
  });

  it("clears a CellSelection without changing the table", () => {
    const source = "| H1 | H2 |\n| --- | --- |\n| A1 | A2 |\n| B1 | B2 |";
    const { app, root, messages } = makeApp(source);
    const rows = root.querySelectorAll<HTMLTableRowElement>("tr");
    const anchor = app.view.posAtDOM(rows[1]!.children[0]!, 0) - 1;
    const head = app.view.posAtDOM(rows[1]!.children[1]!, 0) - 1;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        CellSelection.create(app.view.state.doc, anchor, head),
      ),
    );
    const before = app.view.state.doc.toJSON();

    dispatchEditorKey(app, "Enter");

    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    expect(activeTableCell(app)).toEqual({ row: 1, column: 1 });
    expect(app.view.state.doc.toJSON()).toEqual(before);
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("keeps ordinary paragraph Enter behavior outside tables", () => {
    const { app } = makeApp("one\n\ntwo");
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 4),
      ),
    );

    dispatchEditorKey(app, "Enter");

    expect(app.view.state.doc.childCount).toBe(3);
    expect(app.view.state.doc.child(0).textContent).toBe("one");
    expect(app.view.state.doc.child(1).textContent).toBe("");
  });

  it("keeps Tab and Shift+Tab table navigation unchanged", () => {
    const { app, root, messages } = makeApp(
      "| H1 | H2 | H3 |\n| --- | --- | --- |\n| A1 | A2 | A3 |",
    );
    const before = app.view.state.doc.toJSON();

    selectTableCell(app, root, 1, 1);
    dispatchEditorKey(app, "Tab");
    expect(activeTableCell(app)).toEqual({ row: 1, column: 2 });
    dispatchEditorKey(app, "Tab", { shiftKey: true });
    expect(activeTableCell(app)).toEqual({ row: 1, column: 1 });
    expect(app.view.state.doc.toJSON()).toEqual(before);
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("makes final-row insertion one undoable edit that can be restored by redo", () => {
    const source = "| H1 |\n| --- |\n| final |";
    const { app, root, messages } = makeApp(source);
    selectTableCell(app, root, 1, 0);
    dispatchEditorKey(app, "Enter");
    const added = String(latestEdit(messages)?.markdown ?? "");
    const edit = latestEdit(messages)!;
    expect(tableRowCount(app)).toBe(3);
    expect(messageType(messages, "edit")).toHaveLength(1);

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: added,
      version: 2,
      profile: "github",
      operationId: String(edit.operationId),
      reason: "ack",
    });

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: source,
      version: 3,
      profile: "github",
      reason: "undo",
    });
    expect(tableRowCount(app)).toBe(2);

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: added,
      version: 4,
      profile: "github",
      reason: "redo",
    });
    expect(tableRowCount(app)).toBe(3);
  });
});

describe("table arrow navigation", () => {
  it("enters and exits a table without exposing a block boundary", () => {
    const source = "Before\n\n| H1 | H2 |\n| --- | --- |\n| A1 | A2 |\n\nAfter";
    const { app, root, messages } = makeApp(source);
    const before = app.view.state.doc;
    app.view.endOfTextblock = () => true;

    selectTableCell(app, root, 1, 0, 2);
    const down = dispatchEditorKey(app, "ArrowDown");
    expect(down.defaultPrevented).toBe(true);
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(app.view.state.doc).toBe(before);
    expect(messageType(messages, "edit")).toHaveLength(0);

    const up = dispatchEditorKey(app, "ArrowUp");
    expect(up.defaultPrevented).toBe(true);
    expect(activeTableCell(app)).toEqual({ row: 1, column: 1 });
    expect(app.view.state.doc).toBe(before);
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("uses the first table cell when moving down from a paragraph", () => {
    const source = "Before\n\n| H1 | H2 |\n| --- | --- |\n| A1 | A2 |\n\nAfter";
    const { app } = makeApp(source);
    app.view.endOfTextblock = () => true;
    const before = app.view.state.doc;

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1 + "Before".length),
      ),
    );
    dispatchEditorKey(app, "ArrowDown");
    expect(activeTableCell(app)).toEqual({ row: 0, column: 0 });
    expect(app.view.state.doc).toBe(before);
  });

  it("crosses horizontal table edges directly at any container depth", () => {
    const cases = [
      {
        source: "Before\n\n| H1 | H2 |\n| --- | --- |\n| A1 | A2 |\n\nAfter",
        before: "Before",
        after: "After",
      },
      {
        source: [
          "> Before",
          ">",
          "> | H1 | H2 |",
          "> | --- | --- |",
          "> | A1 | A2 |",
          ">",
          "> After",
        ].join("\n"),
        before: "Before",
        after: "After",
      },
    ];

    for (const { source, before, after } of cases) {
      const { app, root, messages } = makeApp(source);
      const original = app.view.state.doc;

      selectTableCell(app, root, 0, 0);
      const left = dispatchEditorKey(app, "ArrowLeft");
      expect(left.defaultPrevented).toBe(true);
      expect(app.view.state.selection.$from.parent.textContent).toBe(before);
      expect(app.view.state.selection.$from.parentOffset).toBe(before.length);
      expect(app.view.state.selection).not.toBeInstanceOf(
        BlockBoundarySelection,
      );

      selectTableCell(app, root, 1, 1, 2);
      const right = dispatchEditorKey(app, "ArrowRight");
      expect(right.defaultPrevented).toBe(true);
      expect(app.view.state.selection.$from.parent.textContent).toBe(after);
      expect(app.view.state.selection.$from.parentOffset).toBe(0);
      expect(app.view.state.selection).not.toBeInstanceOf(
        BlockBoundarySelection,
      );
      expect(app.view.state.doc).toBe(original);
      expect(messageType(messages, "edit")).toHaveLength(0);
    }
  });

  it("moves through a table nested in a blockquote without leaving its container", () => {
    const source = [
      "> Before",
      ">",
      "> | H1 | H2 |",
      "> | --- | --- |",
      "> | A1 | A2 |",
      ">",
      "> After",
      "",
      "Root after",
    ].join("\n");
    const { app, root, messages } = makeApp(source);
    const before = app.view.state.doc;
    app.view.endOfTextblock = () => true;

    selectTextblock(app, "Before", "end");
    const intoTable = dispatchEditorKey(app, "ArrowDown");
    expect(intoTable.defaultPrevented).toBe(true);
    expect(activeTableCell(app)).toEqual({ row: 0, column: 0 });
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);

    selectTableCell(app, root, 1, 0, 2);
    const outOfTable = dispatchEditorKey(app, "ArrowDown");
    expect(outOfTable.defaultPrevented).toBe(true);
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    expect(app.view.state.selection.$from.node(-1).type.spec.tableRole).toBe(
      undefined,
    );

    selectTextblock(app, "After", "start");
    const backToTable = dispatchEditorKey(app, "ArrowUp");
    expect(backToTable.defaultPrevented).toBe(true);
    expect(activeTableCell(app).row).toBe(1);
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);

    selectTextblock(app, "After", "end");
    dispatchEditorKey(app, "ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe(
      "Root after",
    );
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);
    expect(app.view.state.doc).toBe(before);
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("moves through a table nested in a list item without escaping the list", () => {
    const source = [
      "- Before",
      "",
      "  | H1 | H2 |",
      "  | --- | --- |",
      "  | A1 | A2 |",
      "",
      "  After",
      "",
      "- Next item",
    ].join("\n");
    const { app, root, messages } = makeApp(source);
    const before = app.view.state.doc;
    app.view.endOfTextblock = () => true;

    selectTextblock(app, "Before", "end");
    dispatchEditorKey(app, "ArrowDown");
    expect(activeTableCell(app)).toEqual({ row: 0, column: 0 });

    selectTableCell(app, root, 1, 0, 2);
    dispatchEditorKey(app, "ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);

    selectTextblock(app, "After", "end");
    dispatchEditorKey(app, "ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Next item");
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);
    expect(app.view.state.doc).toBe(before);
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("moves through a table nested in expanded Details", () => {
    const source = [
      "<details open>",
      "<summary>Details</summary>",
      "",
      "Before",
      "",
      "| H1 | H2 |",
      "| --- | --- |",
      "| A1 | A2 |",
      "",
      "After",
      "",
      "</details>",
      "",
      "Root after",
    ].join("\n");
    const { app, root, messages } = makeApp(source);
    const before = app.view.state.doc;
    app.view.endOfTextblock = () => true;

    selectTextblock(app, "Before", "end");
    dispatchEditorKey(app, "ArrowDown");
    expect(activeTableCell(app)).toEqual({ row: 0, column: 0 });

    selectTableCell(app, root, 1, 0, 2);
    dispatchEditorKey(app, "ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");

    selectTextblock(app, "After", "start");
    dispatchEditorKey(app, "ArrowUp");
    expect(activeTableCell(app).row).toBe(1);
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);

    selectTextblock(app, "After", "end");
    dispatchEditorKey(app, "ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe(
      "Root after",
    );
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);
    expect(app.view.state.doc).toBe(before);
    expect(messageType(messages, "edit")).toHaveLength(0);
  });
});

describe("contextual table toolbar", () => {
  it("keeps the main Table button active across cells and CellSelection only", () => {
    const { app, root } = makeApp(
      "Before\n\n| Name | Value |\n| --- | --- |\n| A | 100 |\n| B | 200 |\n\nAfter",
    );
    const tableButton = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-table"]',
    )!;
    expect(tableButton.getAttribute("aria-pressed")).toBe("false");

    selectTableCell(app, root, 1, 0);
    expect(tableButton.getAttribute("aria-pressed")).toBe("true");

    selectTableCell(app, root, 2, 1);
    expect(tableButton.getAttribute("aria-pressed")).toBe("true");

    const cells = root.querySelectorAll("tbody td");
    dispatchCellSelection(app, cells[0]!, cells[1]!);
    expect(tableButton.getAttribute("aria-pressed")).toBe("true");

    const doc = app.view.state.doc;
    const afterStart = doc.child(doc.childCount - 1);
    let afterPosition = 0;
    for (let index = 0; index < doc.childCount - 1; index += 1)
      afterPosition += doc.child(index).nodeSize;
    expect(afterStart.type.name).toBe("paragraph");
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(doc, afterPosition + 2),
      ),
    );
    expect(tableButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("appears for a text cursor and keeps a logical cell selected after row and alignment operations", () => {
    const source = "| A | B |\n| --- | --- |\n| C | D |";
    const { app, root, messages } = makeApp(source);
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    expect(toolbar.hidden).toBe(true);
    expect(
      Array.from(
        toolbar.querySelectorAll<HTMLButtonElement>(".mm-table-toolbar-button"),
      ).every((button) => button.disabled),
    ).toBe(true);
    dispatchCellText(app, root.querySelector("tbody td")!);
    expect(toolbar.hidden).toBe(false);
    const rowAbove = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="row-above"]',
    )!;
    expect(rowAbove.textContent?.trim()).toBe("Above");
    expect(rowAbove.getAttribute("aria-label")).toBe("Add row above");
    expect(
      rowAbove.querySelector<SVGSVGElement>(".mm-table-toolbar-icon"),
    ).toBeTruthy();
    expect(
      rowAbove
        .querySelector<SVGSVGElement>(".mm-table-toolbar-icon [stroke]")
        ?.getAttribute("stroke"),
    ).toBe("currentColor");
    const tableIcons = {
      "row-above": "table-row-above",
      "row-below": "table-row-below",
      "row-delete": "table-row-delete",
      "col-left": "table-column-left",
      "col-right": "table-column-right",
      "col-delete": "table-column-delete",
      "align-left": "table-align-left",
      "align-center": "table-align-center",
      "align-right": "table-align-right",
      "table-numbering": "table-numbering",
      "table-delete": "table-delete",
    } as const;
    for (const [action, iconName] of Object.entries(tableIcons)) {
      const icon = toolbar.querySelector<SVGSVGElement>(
        `[data-action="${action}"] .mm-table-toolbar-icon`,
      );
      expect(icon).not.toBeNull();
      expect(icon?.dataset.icon).toBe(iconName);
      expect(icon?.getAttribute("width")).toBe("14");
      expect(icon?.getAttribute("height")).toBe("14");
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.getAttribute("focusable")).toBe("false");
    }
    expect(
      Array.from(
        toolbar.querySelectorAll<HTMLElement>(".mm-table-toolbar-group-label"),
      ).map((label) => label.textContent),
    ).toEqual(["Row", "Column", "Align", "Rows", "Table"]);
    expect(toolbar.querySelectorAll(".mm-table-toolbar-group")).toHaveLength(5);
    expect(toolbar.querySelectorAll(".mm-table-toolbar-button")).toHaveLength(
      11,
    );
    expect(toolbar.closest(".mm-toolbar")).toBeTruthy();
    expect(toolbar.closest(".mm-stage")).toBeNull();
    expect(toolbar.style.position).toBe("");
    expect(toolbar.style.paddingTop).toBe("");
    expect(toolbar.querySelector('[data-action="row-below"]')).toBeTruthy();
    expect(toolbar.querySelector('[data-action="col-left"]')).toBeTruthy();
    expect(toolbar.querySelector('[data-action="align-center"]')).toBeTruthy();
    expect(
      toolbar
        .querySelector<HTMLButtonElement>('[data-action="align-left"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      toolbar
        .querySelector<HTMLButtonElement>('[data-action="align-center"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    toolbar
      .querySelector<HTMLButtonElement>('[data-action="row-above"]')!
      .click();
    expect(messageType(messages, "edit")).toHaveLength(1);
    expect(app.view.state.doc.firstChild?.childCount).toBe(3);
    expect(app.view.state.selection.$from.node(-3).type.name).toBe("table");
    const firstEdit = latestEdit(messages)!;
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: String(firstEdit.markdown),
      version: 2,
      profile: "github",
      operationId: String(firstEdit.operationId),
      reason: "ack",
    });

    const align = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="align-center"]',
    )!;
    expect(align.disabled).toBe(false);
    align.click();
    expect(messageType(messages, "edit")).toHaveLength(2);
    expect(align.getAttribute("aria-pressed")).toBe("true");
    expect(
      toolbar
        .querySelector<HTMLButtonElement>('[data-action="align-left"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    const current = serializeMarkdown(
      app.view.state.doc,
      parseMarkdown(String(latestEdit(messages)?.markdown ?? ""), "github"),
    );
    expect(current).toContain(":---:");
  });

  it("previews the logical row, column, and table targets without changing editor state", () => {
    const source =
      "| A | B | C |\n| --- | --- | --- |\n| D | E | F |\n| G | H | I |";
    const { app, root } = makeApp(source);
    const rows = root.querySelectorAll<HTMLTableRowElement>("tr");
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const rowDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="row-delete"]',
    )!;
    const columnDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="col-delete"]',
    )!;
    const tableDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="table-delete"]',
    )!;
    dispatchCellText(app, rows[1]!.children[1]!);
    mockTableGeometry(app, root);
    const beforeDoc = app.view.state.doc;
    const beforeSelection = app.view.state.selection;

    rowDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    const rowPreview = root.querySelector<HTMLElement>(
      ".mm-table-delete-preview-rect",
    );
    expect(rowPreview).not.toBeNull();
    expect(rowPreview?.style.cssText).toContain("left: 10px");
    expect(rowPreview?.style.cssText).toContain("top: 50px");
    expect(rowPreview?.style.cssText).toContain("width: 300px");
    expect(rowPreview?.style.cssText).toContain("height: 30px");
    expect(app.view.state.doc).toBe(beforeDoc);
    expect(app.view.state.selection).toBe(beforeSelection);

    rowDelete.dispatchEvent(new Event("pointerleave", { bubbles: true }));
    expect(root.querySelector(".mm-table-delete-preview-overlay")).toBeNull();

    columnDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    const columnPreview = root.querySelector<HTMLElement>(
      ".mm-table-delete-preview-rect",
    );
    expect(columnPreview).not.toBeNull();
    expect(columnPreview?.style.cssText).toContain("left: 110px");
    expect(columnPreview?.style.cssText).toContain("top: 20px");
    expect(columnPreview?.style.cssText).toContain("width: 100px");
    expect(columnPreview?.style.cssText).toContain("height: 90px");
    expect(app.view.state.doc).toBe(beforeDoc);
    expect(app.view.state.selection).toBe(beforeSelection);

    columnDelete.dispatchEvent(new Event("pointerleave", { bubbles: true }));
    tableDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    expect(root.querySelectorAll(".mm-table-delete-preview")).toHaveLength(9);
    expect(root.querySelector(".mm-table-delete-preview-overlay")).toBeNull();
    expect(app.view.state.doc).toBe(beforeDoc);
    expect(app.view.state.selection).toBe(beforeSelection);
    tableDelete.dispatchEvent(new Event("pointerleave", { bubbles: true }));
    expect(root.querySelector(".mm-table-delete-preview")).toBeNull();
  });

  it("disables row or column deletion for full-axis CellSelections", () => {
    const { app, root } = makeApp(
      "| A | B | C |\n| --- | --- | --- |\n| D | E | F |\n| G | H | I |",
    );
    const cells = root.querySelectorAll<HTMLTableCellElement>("td, th");
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const rowDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="row-delete"]',
    )!;
    const columnDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="col-delete"]',
    )!;
    const tableDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="table-delete"]',
    )!;

    dispatchCellSelection(app, cells[0]!, cells[6]!);
    expect(rowDelete.disabled).toBe(true);
    expect(columnDelete.disabled).toBe(false);
    expect(tableDelete.disabled).toBe(false);
    rowDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    expect(root.querySelector(".mm-table-delete-preview-overlay")).toBeNull();

    dispatchCellSelection(app, cells[0]!, cells[2]!);
    expect(rowDelete.disabled).toBe(false);
    expect(columnDelete.disabled).toBe(true);
    expect(tableDelete.disabled).toBe(false);
    columnDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    expect(root.querySelector(".mm-table-delete-preview-overlay")).toBeNull();

    dispatchCellText(app, cells[4]!);
    expect(rowDelete.disabled).toBe(false);
    expect(columnDelete.disabled).toBe(false);
    expect(tableDelete.disabled).toBe(false);
  });

  it("previews only the deleted logical row across a rowspan cell", () => {
    const { app, root } = makeApp();
    replaceWithTable(
      app,
      schema.nodes.table!.create(null, [
        schema.nodes.table_row!.create(null, [
          tableCell("table_header", "A", { rowspan: 3 }),
          tableCell("table_header", "B"),
          tableCell("table_header", "C"),
        ]),
        schema.nodes.table_row!.create(null, [
          tableCell("table_cell", "D"),
          tableCell("table_cell", "E"),
        ]),
        schema.nodes.table_row!.create(null, [
          tableCell("table_cell", "F"),
          tableCell("table_cell", "G"),
        ]),
      ]),
    );
    const rows = root.querySelectorAll<HTMLTableRowElement>("tr");
    dispatchCellText(app, rows[1]!.children[0]!);
    mockTableGeometry(app, root);
    const beforeDoc = app.view.state.doc;
    const beforeSelection = app.view.state.selection;
    const rowDelete = root.querySelector<HTMLButtonElement>(
      '[data-action="row-delete"]',
    )!;

    rowDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    const preview = root.querySelector<HTMLElement>(
      ".mm-table-delete-preview-rect",
    );
    expect(preview?.style.cssText).toContain("top: 50px");
    expect(preview?.style.cssText).toContain("height: 30px");
    expect(preview?.style.cssText).toContain("left: 10px");
    expect(preview?.style.cssText).toContain("width: 300px");
    expect(root.querySelector(".mm-table-delete-preview")).toBeNull();
    expect(app.view.state.doc).toBe(beforeDoc);
    expect(app.view.state.selection).toBe(beforeSelection);

    rowDelete.dispatchEvent(new Event("pointerleave", { bubbles: true }));
    expect(root.querySelector(".mm-table-delete-preview-overlay")).toBeNull();
    expect(app.view.state.doc).toBe(beforeDoc);
    expect(app.view.state.selection).toBe(beforeSelection);
  });

  it("previews only the deleted logical column across a colspan cell", () => {
    const { app, root } = makeApp();
    replaceWithTable(
      app,
      schema.nodes.table!.create(null, [
        schema.nodes.table_row!.create(null, [
          tableCell("table_header", "A"),
          tableCell("table_header", "B"),
          tableCell("table_header", "C"),
        ]),
        schema.nodes.table_row!.create(null, [
          tableCell("table_cell", "AB", { colspan: 2 }),
          tableCell("table_cell", "C"),
        ]),
        schema.nodes.table_row!.create(null, [
          tableCell("table_cell", "D"),
          tableCell("table_cell", "E"),
          tableCell("table_cell", "F"),
        ]),
      ]),
    );
    const rows = root.querySelectorAll<HTMLTableRowElement>("tr");
    dispatchCellText(app, rows[2]!.children[1]!);
    mockTableGeometry(app, root);
    const beforeDoc = app.view.state.doc;
    const beforeSelection = app.view.state.selection;
    const columnDelete = root.querySelector<HTMLButtonElement>(
      '[data-action="col-delete"]',
    )!;

    columnDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    const preview = root.querySelector<HTMLElement>(
      ".mm-table-delete-preview-rect",
    );
    expect(preview?.style.cssText).toContain("left: 110px");
    expect(preview?.style.cssText).toContain("width: 100px");
    expect(preview?.style.cssText).toContain("top: 20px");
    expect(preview?.style.cssText).toContain("height: 90px");
    expect(root.querySelector(".mm-table-delete-preview")).toBeNull();
    expect(app.view.state.doc).toBe(beforeDoc);
    expect(app.view.state.selection).toBe(beforeSelection);

    columnDelete.dispatchEvent(new Event("pointerleave", { bubbles: true }));
    expect(root.querySelector(".mm-table-delete-preview-overlay")).toBeNull();
    expect(app.view.state.doc).toBe(beforeDoc);
    expect(app.view.state.selection).toBe(beforeSelection);
  });

  it("updates previews when keyboard focus moves between delete actions", () => {
    const { app, root } = makeApp(
      "| A | B | C |\n| --- | --- | --- |\n| D | E | F |\n| G | H | I |",
    );
    const rows = root.querySelectorAll<HTMLTableRowElement>("tr");
    dispatchCellText(app, rows[1]!.children[1]!);
    mockTableGeometry(app, root);
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const rowDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="row-delete"]',
    )!;
    const columnDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="col-delete"]',
    )!;
    const tableDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="table-delete"]',
    )!;

    rowDelete.focus();
    expect(root.querySelectorAll(".mm-table-delete-preview-rect")).toHaveLength(
      1,
    );
    columnDelete.focus();
    expect(root.querySelectorAll(".mm-table-delete-preview-rect")).toHaveLength(
      1,
    );
    expect(
      root.querySelector<HTMLElement>(".mm-table-delete-preview-rect")?.style
        .left,
    ).toBe("110px");
    tableDelete.focus();
    expect(root.querySelectorAll(".mm-table-delete-preview")).toHaveLength(9);
    tableDelete.blur();
    expect(root.querySelector(".mm-table-delete-preview")).toBeNull();
    expect(root.querySelector(".mm-table-delete-preview-overlay")).toBeNull();
  });

  it("previews all rows and columns covered by a CellSelection", () => {
    const { app, root } = makeApp(
      "| A | B | C | D |\n| --- | --- | --- | --- |\n| E | F | G | H |\n| I | J | K | L |\n| M | N | O | P |",
    );
    const cells = root.querySelectorAll<HTMLTableCellElement>("td, th");
    dispatchCellSelection(app, cells[5]!, cells[10]!);
    mockTableGeometry(app, root);
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const rowDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="row-delete"]',
    )!;
    const columnDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="col-delete"]',
    )!;

    rowDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    expect(root.querySelectorAll(".mm-table-delete-preview-rect")).toHaveLength(
      2,
    );
    expect(
      Array.from(
        root.querySelectorAll<HTMLElement>(".mm-table-delete-preview-rect"),
        (preview) => preview.style.top,
      ),
    ).toEqual(["50px", "80px"]);

    columnDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    expect(root.querySelectorAll(".mm-table-delete-preview-rect")).toHaveLength(
      2,
    );
    expect(
      Array.from(
        root.querySelectorAll<HTMLElement>(".mm-table-delete-preview-rect"),
        (preview) => preview.style.left,
      ),
    ).toEqual(["110px", "210px"]);
  });

  it("clears the preview before deleting a row and leaves no stale class", () => {
    const { app, root, messages } = makeApp(
      "| A | B | C |\n| --- | --- | --- |\n| D | E | F |\n| G | H | I |",
    );
    const rows = root.querySelectorAll<HTMLTableRowElement>("tr");
    dispatchCellText(app, rows[1]!.children[1]!);
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const rowDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="row-delete"]',
    )!;
    mockTableGeometry(app, root);
    rowDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    expect(root.querySelectorAll(".mm-table-delete-preview-rect")).toHaveLength(
      1,
    );

    rowDelete.click();
    expect(app.view.state.doc.firstChild?.childCount).toBe(2);
    expect(root.querySelector(".mm-table-delete-preview")).toBeNull();
    expect(root.querySelector(".mm-table-delete-preview-overlay")).toBeNull();
    expect(messageType(messages, "edit")).toHaveLength(1);
  });

  it("keeps one toolbar visible and disables its actions outside a table", () => {
    const source = "Before\n\n| A | B |\n| --- | --- |\n| C | D |\n\nAfter";
    const { app, root, messages } = makeApp(source);
    const mainToolbar = root.querySelector<HTMLElement>(".mm-toolbar")!;
    const tableToolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const sourceButton = mainToolbar.querySelector<HTMLButtonElement>(
      ".mm-toolbar-primary > .mm-source-button",
    )!;

    expect(mainToolbar.contains(tableToolbar)).toBe(true);
    expect(root.querySelector(".mm-stage .mm-table-toolbar")).toBeNull();
    expect(sourceButton.dataset.mode).toBe("source");
    expect(tableToolbar.hidden).toBe(true);
    expect(tableToolbar.style.position).toBe("");

    dispatchCellText(app, root.querySelector("tbody td")!);
    expect(tableToolbar.hidden).toBe(false);
    expect(
      tableToolbar.querySelectorAll(".mm-table-toolbar-button"),
    ).toHaveLength(11);
    expect(
      tableToolbar.querySelector('[data-action="table-numbering"]'),
    ).toBeTruthy();
    expect(app.view.dom.style.paddingTop).toBe("");
    expect(tableToolbar.style.top).toBe("");
    expect(tableToolbar.style.left).toBe("");
    expect(messageType(messages, "edit")).toHaveLength(0);

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.near(app.view.state.doc.resolve(1)),
      ),
    );
    expect(tableToolbar.hidden).toBe(false);
    expect(
      Array.from(
        tableToolbar.querySelectorAll<HTMLButtonElement>(
          ".mm-table-toolbar-button",
        ),
      ).every((button) => button.disabled),
    ).toBe(true);
    expect(tableToolbar.hasAttribute("data-table-pos")).toBe(false);
    tableToolbar
      .querySelector<HTMLButtonElement>('[data-action="row-above"]')!
      .click();
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("appears for a CellSelection and re-enables the same toolbar when re-entering a table", () => {
    const source = "Before\n\n| A | B |\n| --- | --- |\n| C | D |\n\nAfter";
    const { app, root } = makeApp(source);
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const cells = root.querySelectorAll("tbody td");
    dispatchCellSelection(app, cells[0]!, cells[1]!);
    expect(toolbar.hidden).toBe(false);
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-action="row-delete"]')!
        .disabled,
    ).toBe(false);
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-action="col-delete"]')!
        .disabled,
    ).toBe(true);
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-action="table-delete"]')!
        .disabled,
    ).toBe(false);

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.near(app.view.state.doc.resolve(1)),
      ),
    );
    expect(toolbar.hidden).toBe(false);
    expect(
      Array.from(
        toolbar.querySelectorAll<HTMLButtonElement>(".mm-table-toolbar-button"),
      ).every((button) => button.disabled),
    ).toBe(true);

    dispatchCellText(app, cells[0]!);
    expect(root.querySelector(".mm-table-toolbar")).toBe(toolbar);
    expect(
      Array.from(
        toolbar.querySelectorAll<HTMLButtonElement>(".mm-table-toolbar-button"),
      ).every((button) => !button.disabled),
    ).toBe(true);
  });

  it("targets the currently selected table when moving between tables", () => {
    const source =
      "Before\n\n| A | B |\n| --- | --- |\n| C | D |\n\nMiddle\n\n| E | F |\n| --- | --- |\n| G | H |\n\nAfter";
    const { app, root } = makeApp(source);
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const cells = root.querySelectorAll("tbody td");
    dispatchCellText(app, cells[0]!);
    const firstTablePosition = toolbar.dataset.tablePos;
    dispatchCellText(app, cells[2]!);
    expect(toolbar.dataset.tablePos).not.toBe(firstTablePosition);
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-action="row-above"]')!
        .disabled,
    ).toBe(false);
  });

  it("leaves the revealed toolbar disabled after deleting the last table", () => {
    const { app, root, messages } = makeApp(
      "Before\n\n| A | B |\n| --- | --- |\n| C | D |\n\nAfter",
    );
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    dispatchCellText(app, root.querySelector("tbody td")!);
    const tableDelete = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="table-delete"]',
    )!;
    tableDelete.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    expect(root.querySelectorAll(".mm-table-delete-preview")).toHaveLength(4);
    tableDelete.click();
    expect(root.querySelector("table")).toBeNull();
    expect(root.querySelector(".mm-table-delete-preview")).toBeNull();
    expect(toolbar.hidden).toBe(false);
    expect(
      Array.from(
        toolbar.querySelectorAll<HTMLButtonElement>(".mm-table-toolbar-button"),
      ).every((button) => button.disabled),
    ).toBe(true);
    expect(messageType(messages, "edit")).toHaveLength(1);
  });

  it("preserves the selected cell and source while scrolling a long table", () => {
    const rows = Array.from(
      { length: 80 },
      (_, index) => "| Row " + String(index + 1) + " | Ready |",
    ).join("\n");
    const source = "| Feature | Status |\n| --- | --- |\n" + rows;
    const { app, root, messages } = makeApp(source);
    const stage = root.querySelector<HTMLElement>(".mm-stage")!;
    const tableToolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const cell = root.querySelector<HTMLTableCellElement>("tbody td")!;
    let scrollTop = 0;
    Object.defineProperty(stage, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    dispatchCellText(app, cell);
    const before = app.view.state.doc.toJSON();
    const selection = app.view.state.selection;
    expect(tableToolbar.hidden).toBe(false);
    expect(app.view.dom.style.paddingTop).toBe("");

    scrollTop = 650;
    stage.dispatchEvent(new Event("scroll"));
    expect(scrollTop).toBe(650);
    expect(tableToolbar.hidden).toBe(false);
    expect(app.view.state.selection.from).toBe(selection.from);
    expect(app.view.state.doc.toJSON()).toEqual(before);

    scrollTop = 2000;
    stage.dispatchEvent(new Event("scroll"));
    expect(scrollTop).toBe(2000);
    expect(tableToolbar.hidden).toBe(false);
    expect(app.view.state.selection.from).toBe(selection.from);
    expect(app.view.state.doc.toJSON()).toEqual(before);
    expect(messageType(messages, "edit")).toHaveLength(0);
  });

  it("toggles sequential row numbering without losing the selected cell", () => {
    const { app, root } = makeApp(
      "| Name | Value |\n| --- | --- |\n| Alpha | A |\n| Beta | B |",
    );
    const cell = root.querySelector<HTMLTableCellElement>("tbody td")!;
    dispatchCellText(app, cell);
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const numbering = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="table-numbering"]',
    )!;
    expect(numbering.getAttribute("aria-label")).toBe("Number table rows");
    expect(numbering.getAttribute("data-tooltip")).toBe("Number table rows");
    expect(numbering.getAttribute("aria-pressed")).toBe("false");

    numbering.click();
    let table = app.view.state.doc.firstChild!;
    expect(table.firstChild?.firstChild?.textContent).toBe("#");
    expect(table.child(1).firstChild?.textContent).toBe("1");
    expect(table.child(2).firstChild?.textContent).toBe("2");
    expect(numbering.getAttribute("aria-pressed")).toBe("true");
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);

    numbering.click();
    table = app.view.state.doc.firstChild!;
    expect(table.firstChild?.firstChild?.textContent).toBe("Name");
    expect(table.child(1).firstChild?.textContent).toBe("Alpha");
    expect(table.child(2).firstChild?.textContent).toBe("Beta");
    expect(numbering.getAttribute("aria-pressed")).toBe("false");
  });

  it("disables actions for a selection extending outside the table", () => {
    const { app, root } = makeApp(
      "| A | B |\n| --- | --- |\n| C | D |\n\nAfter",
    );
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    dispatchCellText(app, root.querySelector("tbody td")!);
    expect(toolbar.hidden).toBe(false);
    const doc = app.view.state.doc;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.between(
          doc.resolve(4),
          doc.resolve(doc.content.size - 2),
        ),
      ),
    );
    expect(toolbar.hidden).toBe(false);
    expect(
      Array.from(
        toolbar.querySelectorAll<HTMLButtonElement>(".mm-table-toolbar-button"),
      ).every((button) => button.disabled),
    ).toBe(true);
  });

  it("does not reveal the toolbar for hover alone", () => {
    const { root } = makeApp(
      "Before\n\n| A | B |\n| --- | --- |\n| C | D |\n\nAfter",
    );
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const cell = root.querySelector<HTMLTableCellElement>("tbody td")!;
    cell.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    cell.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(toolbar.hidden).toBe(true);
  });

  it("runs the reveal animation only once", () => {
    const { app, root } = makeApp(
      "Before\n\n| A | B |\n| --- | --- |\n| C | D |\n\nAfter",
    );
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const add = vi.spyOn(toolbar.classList, "add");
    const revealCalls = (): unknown[][] =>
      add.mock.calls.filter((tokens) => tokens.includes("is-revealing"));
    const cell = root.querySelector<HTMLTableCellElement>("tbody td")!;
    dispatchCellText(app, cell);
    expect(revealCalls()).toHaveLength(1);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.near(app.view.state.doc.resolve(1)),
      ),
    );
    dispatchCellText(app, cell);
    expect(revealCalls()).toHaveLength(1);
  });

  it("does not expose table actions in Preview or CommonMark", () => {
    const preview = makeApp("| A |\n| --- |\n| B |");
    dispatchCellText(preview.app, preview.root.querySelector("tbody td")!);
    preview.app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "| A |\n| --- |\n| B |",
      version: 2,
      profile: "github",
      mode: "preview",
      reason: "external",
    });
    expect(
      preview.root.querySelector<HTMLElement>(".mm-table-toolbar")!.hidden,
    ).toBe(true);

    const commonmark = makeApp("| A |\n| --- |\n| B |", "commonmark");
    expect(
      commonmark.root.querySelector<HTMLElement>(".mm-table-toolbar")!.hidden,
    ).toBe(true);
    expect(
      commonmark.root.querySelector<HTMLButtonElement>(
        '[data-testid="toolbar-table"]',
      )!.disabled,
    ).toBe(true);
  });

  it("preserves a CellSelection through alignment", () => {
    const { app, root } = makeApp("| A | B |\n| --- | --- |\n| C | D |");
    const table = app.view.state.doc.firstChild!;
    const map = TableMap.get(table);
    const selection = CellSelection.create(
      app.view.state.doc,
      map.map[0]! + 1,
      map.map[3]! + 1,
    );
    app.view.dispatch(app.view.state.tr.setSelection(selection));
    const before = app.view.state.selection as CellSelection;
    root
      .querySelector<HTMLButtonElement>('[data-action="align-right"]')!
      .click();
    expect(app.view.state.selection).toBeInstanceOf(CellSelection);
    const after = app.view.state.selection as CellSelection;
    expect(after.$anchorCell.pos).toBe(before.$anchorCell.pos);
    expect(after.$headCell.pos).toBe(before.$headCell.pos);
  });
});

describe("starter heading", () => {
  it("starts empty sources with a virtual H1 while preserving the blank source", () => {
    const { app, root, messages } = makeApp("");
    const heading = root.querySelector("h1.mm-starter-title");
    expect(heading?.getAttribute("data-placeholder")).toBe("Title");
    expect(app.view.state.doc.firstChild?.type.name).toBe("heading");
    expect(messageType(messages, "edit")).toHaveLength(0);
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "",
      version: 2,
      profile: "github",
      mode: "preview",
      reason: "external",
    });
    expect(root.querySelector(".mm-preview-panel")?.textContent).toBe("");
  });
});
