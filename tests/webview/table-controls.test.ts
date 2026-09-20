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
import {
  createEditorApp,
  type MarkdownEditorApp,
} from "../../src/webview/editor";

const apps: MarkdownEditorApp[] = [];

function makeApp(markdown: string): {
  app: MarkdownEditorApp;
  root: HTMLElement;
  messages: unknown[];
} {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const app = createEditorApp({
    root,
    vscode: { postMessage: (message) => messages.push(message) },
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: { markdown, version: 1, profile: "github" },
  });
  apps.push(app);
  return { app, root, messages };
}

function setRect(
  element: Element,
  top: number,
  left: number,
  bottom: number,
  right: number,
): void {
  const measured = {
    top,
    left,
    bottom,
    right,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => measured,
  } as DOMRect;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => measured,
  });
}

function tableInfo(app: MarkdownEditorApp): {
  table: PMNode;
  tablePos: number;
} {
  let table: PMNode | null = null;
  let tablePos = -1;
  app.view.state.doc.descendants((node, position) => {
    if (node.type.spec.tableRole !== "table") return true;
    table = node;
    tablePos = position;
    return false;
  });
  if (!table) throw new Error("Missing table");
  return { table, tablePos };
}

function mockTableGeometry(
  app: MarkdownEditorApp,
  root: HTMLElement,
  options: {
    outerRight?: number;
    outerBottom?: number;
    columnWidths?: number[];
    rowHeights?: number[];
  } = {},
): void {
  const { table, tablePos } = tableInfo(app);
  const map = TableMap.get(table);
  const tableElement = root.querySelector<HTMLTableElement>("table");
  const stage = root.querySelector<HTMLElement>(".mm-stage");
  if (!tableElement || !stage) throw new Error("Missing table DOM");
  const rowHeights = options.rowHeights ?? Array(map.height).fill(40);
  const rowBoundaries = [20];
  for (let index = 0; index < map.height; index += 1)
    rowBoundaries.push(rowBoundaries[index]! + (rowHeights[index] ?? 40));
  const columnWidths = options.columnWidths ?? Array(map.width).fill(110);
  const columnBoundaries = [30];
  for (let index = 0; index < map.width; index += 1)
    columnBoundaries.push(
      columnBoundaries[index]! + (columnWidths[index] ?? 110),
    );
  setRect(
    tableElement,
    rowBoundaries[0]!,
    columnBoundaries[0]!,
    options.outerBottom ?? rowBoundaries.at(-1)!,
    options.outerRight ?? columnBoundaries.at(-1)!,
  );
  setRect(stage, 0, 0, 800, 1000);
  const rows = tableElement.querySelectorAll<HTMLTableRowElement>("tr");
  for (let row = 0; row < map.height; row += 1)
    setRect(
      rows[row]!,
      rowBoundaries[row]!,
      columnBoundaries[0]!,
      rowBoundaries[row + 1]!,
      columnBoundaries.at(-1)!,
    );
  for (const relative of new Set(map.map)) {
    const cell = app.view.nodeDOM(tablePos + 1 + relative);
    if (!(cell instanceof HTMLElement)) continue;
    const rect = map.findCell(relative);
    setRect(
      cell,
      rowBoundaries[rect.top]!,
      columnBoundaries[rect.left]!,
      rowBoundaries[rect.bottom]!,
      columnBoundaries[rect.right]!,
    );
  }
}

function selectText(app: MarkdownEditorApp, cell: Element): void {
  const position = app.view.posAtDOM(cell, 0);
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.near(app.view.state.doc.resolve(position + 1)),
    ),
  );
}

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  });
}

function editMessages(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "edit",
  );
}

function acknowledgeLatestEdit(
  app: MarkdownEditorApp,
  messages: unknown[],
  version: number,
): void {
  const edit = editMessages(messages).at(-1);
  if (!edit) throw new Error("Missing edit message");
  app.receiveDocument({
    protocolVersion: PROTOCOL_VERSION,
    type: "document",
    markdown: String(edit.markdown),
    version,
    profile: "github",
    operationId: String(edit.operationId),
    reason: "ack",
  });
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const app of apps) app.destroy();
  apps.length = 0;
  document.body.replaceChildren();
});

describe("direct table controls", () => {
  it("uses the direct cell grid instead of a wide table outer box", () => {
    const source = [
      "|   |   |   |   |   |",
      "| --- | --- | --- | --- | --- |",
      "| a | b | c | d | e |",
      "| f | g | h | i | j |",
      "| k | l | m | n | o |",
    ].join("\n");
    const { app, root, messages } = makeApp(source);
    mockTableGeometry(app, root, {
      outerRight: 1000,
      outerBottom: 300,
      columnWidths: [70, 160, 90, 120, 55],
    });
    selectText(app, root.querySelector("tbody td")!);

    const controls = root.querySelector<HTMLElement>(".mm-table-controls")!;
    const stage = root.querySelector<HTMLElement>(".mm-stage")!;
    const table = root.querySelector<HTMLTableElement>("table")!;
    const beforeTableRect = table.getBoundingClientRect();

    stage.dispatchEvent(pointer("pointermove", 305, 2));
    const columnHighlight = controls.querySelector<HTMLElement>(
      ".mm-table-column-highlight",
    )!;
    expect(columnHighlight.hidden).toBe(false);
    expect(columnHighlight.style.left).toBe("260px");
    expect(columnHighlight.style.width).toBe("90px");

    stage.dispatchEvent(pointer("pointermove", 260, 2));
    const columnInsertLine = controls.querySelector<HTMLElement>(
      ".mm-table-column-insert-line",
    )!;
    expect(columnInsertLine.hidden).toBe(false);
    expect(columnInsertLine.style.height).toBe("160px");

    stage.dispatchEvent(pointer("pointermove", 533, 80));
    const columnAppend = controls.querySelector<HTMLButtonElement>(
      '[data-table-control="column-append"]',
    )!;
    expect(columnAppend.hidden).toBe(false);
    expect(columnAppend.style.left).toBe("528px");
    expect(table.getBoundingClientRect()).toEqual(beforeTableRect);

    const columnHandle = controls.querySelector<HTMLButtonElement>(
      '[data-table-control="column-handle"][data-index="4"]',
    )!;
    const before = app.view.state.doc;
    columnHandle.dispatchEvent(pointer("pointerdown", 470, 10));
    stage.dispatchEvent(pointer("pointermove", 260, 80));
    expect(
      controls.querySelector<HTMLElement>(".mm-table-drag-preview")
        ?.textContent,
    ).toContain("e");
    expect(
      controls.querySelector<HTMLElement>(".mm-table-drag-preview")
        ?.textContent,
    ).toContain("Move to position 3");
    expect(
      controls.querySelector<HTMLElement>(".mm-table-move-indicator")!.hidden,
    ).toBe(false);
    expect(columnInsertLine.hidden).toBe(true);
    expect(columnAppend.hidden).toBe(true);
    expect(app.view.state.doc).toBe(before);
    columnHandle.dispatchEvent(pointer("pointerup", 260, 80));
    expect(editMessages(messages)).toHaveLength(1);
  });

  it("integrates toolbar controls by axis and keeps hidden moves out of Tab order", () => {
    const source = [
      "| Name | Value |",
      "| - | - |",
      "| Alpha | A |",
      "| Beta | B |",
    ].join("\n");
    const { app, root } = makeApp(source);
    mockTableGeometry(app, root);
    selectText(app, root.querySelector("tbody td")!);

    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const grip = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="table-controls"]',
    )!;
    const rowUp = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="row-move-up"]',
    )!;
    const rowDown = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="row-move-down"]',
    )!;
    const columnLeft = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="col-move-left"]',
    )!;
    const columnRight = toolbar.querySelector<HTMLButtonElement>(
      '[data-action="col-move-right"]',
    )!;
    expect(
      toolbar.querySelector(".mm-table-controls-toolbar-group"),
    ).toBeNull();
    expect(toolbar.textContent).not.toContain("Direct");
    expect(toolbar.textContent).not.toContain("Handles");
    expect(grip.querySelector('svg[data-icon="table-grip"]')).not.toBeNull();
    expect(grip.textContent).toBe("");
    expect(grip.hidden).toBe(false);
    expect(grip.getAttribute("aria-label")).toBe("Table controls");
    expect(rowUp.hidden).toBe(true);
    expect(rowDown.hidden).toBe(true);
    expect(columnLeft.hidden).toBe(true);
    expect(columnRight.hidden).toBe(true);
    expect(rowUp.tabIndex).toBe(-1);
    expect(columnLeft.tabIndex).toBe(-1);

    const rowHandle = root.querySelector<HTMLButtonElement>(
      '[data-table-control="row-handle"][data-index="1"]',
    )!;
    rowHandle.click();
    expect(grip.hidden).toBe(false);
    expect(rowUp.hidden).toBe(false);
    expect(rowDown.hidden).toBe(false);
    expect(columnLeft.hidden).toBe(true);
    expect(columnRight.hidden).toBe(true);
    expect(rowUp.disabled).toBe(true);
    expect(rowDown.disabled).toBe(false);
    expect(rowUp.tabIndex).toBe(0);
    expect(columnLeft.tabIndex).toBe(-1);
    expect(
      rowUp.querySelector('svg[data-icon="table-move-up"]'),
    ).not.toBeNull();
    expect(rowUp.querySelector('svg[data-icon="table-row-above"]')).toBeNull();
    expect(
      rowDown.querySelector('svg[data-icon="table-move-down"]'),
    ).not.toBeNull();
    expect(
      rowDown.querySelector('svg[data-icon="table-row-below"]'),
    ).toBeNull();

    const lastRowHandle = root.querySelector<HTMLButtonElement>(
      '[data-table-control="row-handle"][data-index="2"]',
    )!;
    lastRowHandle.click();
    expect(rowUp.disabled).toBe(false);
    expect(rowDown.disabled).toBe(true);

    const columnHandle = root.querySelector<HTMLButtonElement>(
      '[data-table-control="column-handle"][data-index="0"]',
    )!;
    columnHandle.click();
    expect(rowUp.hidden).toBe(true);
    expect(rowDown.hidden).toBe(true);
    expect(columnLeft.hidden).toBe(false);
    expect(columnRight.hidden).toBe(false);
    expect(columnLeft.disabled).toBe(true);
    expect(columnRight.disabled).toBe(false);
    expect(rowUp.tabIndex).toBe(-1);
    expect(columnLeft.tabIndex).toBe(0);
    expect(
      columnLeft.querySelector('svg[data-icon="table-move-left"]'),
    ).not.toBeNull();
    expect(
      columnLeft.querySelector('svg[data-icon="table-column-left"]'),
    ).toBeNull();
    expect(
      columnRight.querySelector('svg[data-icon="table-move-right"]'),
    ).not.toBeNull();
    expect(
      columnRight.querySelector('svg[data-icon="table-column-right"]'),
    ).toBeNull();

    const lastColumnHandle = root.querySelector<HTMLButtonElement>(
      '[data-table-control="column-handle"][data-index="1"]',
    )!;
    lastColumnHandle.click();
    expect(columnLeft.disabled).toBe(false);
    expect(columnRight.disabled).toBe(true);

    lastColumnHandle.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(columnLeft.hidden).toBe(true);
    expect(columnRight.hidden).toBe(true);
    expect(columnLeft.tabIndex).toBe(-1);
    expect(columnRight.tabIndex).toBe(-1);
    expect(grip.hidden).toBe(false);

    columnHandle.click();
    columnLeft.focus();
    expect(document.activeElement).toBe(columnLeft);
    selectText(app, root.querySelector("tbody td")!);
    expect(columnLeft.hidden).toBe(true);
    expect(document.activeElement).toBe(grip);
  });

  it("shows the row destination as a body-row number and flashes the drop before selected", () => {
    vi.useFakeTimers();
    try {
      const source = [
        "|   |   |   |   |   |",
        "| - | - | - | - | - |",
        "| a | b | c | d | e |",
        "| f | g | h | i | j |",
        "| k | l | m | n | o |",
      ].join("\n");
      const { app, root, messages } = makeApp(source);
      mockTableGeometry(app, root);
      selectText(app, root.querySelector("tbody td")!);

      const controls = root.querySelector<HTMLElement>(".mm-table-controls")!;
      const stage = root.querySelector<HTMLElement>(".mm-stage")!;
      const rowHandle = controls.querySelector<HTMLButtonElement>(
        '[data-table-control="row-handle"][data-index="3"]',
      )!;
      rowHandle.dispatchEvent(pointer("pointerdown", 10, 160));
      stage.dispatchEvent(pointer("pointermove", 30, 60));
      expect(
        controls.querySelector<HTMLElement>(".mm-table-drag-preview")
          ?.textContent,
      ).toContain("Move to position 1");
      expect(
        controls.querySelector<HTMLElement>(".mm-table-drag-preview")?.dataset
          .axis,
      ).toBe("row");
      rowHandle.dispatchEvent(pointer("pointerup", 30, 60));

      expect(editMessages(messages)).toHaveLength(1);
      const highlight = controls.querySelector<HTMLElement>(
        ".mm-table-row-highlight",
      )!;
      expect(highlight.hidden).toBe(false);
      expect(highlight.dataset.state).toBe("drop-flash");
      vi.runOnlyPendingTimers();
      expect(highlight.hidden).toBe(false);
      expect(highlight.dataset.state).toBe("selected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects a row without editing and moves it through a real pointer path", () => {
    const source = [
      "| # | Name | Value |",
      "| --- | --- | --- |",
      "| 1 | Alpha | A |",
      "| 2 | Beta | B |",
      "| 3 | Gamma | C |",
    ].join("\n");
    const { app, root, messages } = makeApp(source);
    mockTableGeometry(app, root);
    selectText(app, root.querySelector("tbody td:nth-child(2)")!);

    const controls = root.querySelector<HTMLElement>(".mm-table-controls")!;
    const rowHandle = controls.querySelector<HTMLButtonElement>(
      '[data-table-control="row-handle"][data-index="3"]',
    )!;
    expect(controls.hidden).toBe(false);
    expect(controls.querySelectorAll(".mm-table-row-handle")).toHaveLength(3);
    expect(controls.querySelectorAll(".mm-table-column-handle")).toHaveLength(
      2,
    );
    expect(editMessages(messages)).toHaveLength(0);

    const before = app.view.state.doc;
    const beforeSelection = app.view.state.selection;
    rowHandle.dispatchEvent(pointer("pointerdown", 10, 160));
    rowHandle.dispatchEvent(pointer("pointerup", 10, 160));
    expect(app.view.state.doc).toBe(before);
    expect(app.view.state.selection).toBe(beforeSelection);
    expect(rowHandle.classList.contains("is-selected")).toBe(true);
    expect(editMessages(messages)).toHaveLength(0);

    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    const legacyActions = [
      "row-above",
      "row-below",
      "row-delete",
      "col-left",
      "col-right",
      "col-delete",
      "align-left",
      "align-center",
      "align-right",
      "table-numbering",
      "table-delete",
    ];
    for (const action of legacyActions) {
      expect(
        toolbar.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
          .disabled,
      ).toBe(true);
    }
    const beforeLegacyActions = app.view.state.doc;
    for (const action of legacyActions)
      toolbar
        .querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
        .dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
    expect(app.view.state.doc).toBe(beforeLegacyActions);
    expect(editMessages(messages)).toHaveLength(0);

    rowHandle.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-action="row-delete"]')!
        .disabled,
    ).toBe(false);

    rowHandle.dispatchEvent(pointer("pointerdown", 10, 160));
    root
      .querySelector<HTMLElement>(".mm-stage")!
      .dispatchEvent(pointer("pointermove", 30, 62));
    rowHandle.dispatchEvent(pointer("pointerup", 30, 62));

    expect(editMessages(messages)).toHaveLength(1);
    const movedSource = String(editMessages(messages)[0]!.markdown);
    expect(movedSource.indexOf("| 1 | Gamma | C |")).toBeGreaterThanOrEqual(0);
    expect(movedSource.indexOf("| 2 | Alpha | A |")).toBeGreaterThanOrEqual(0);
    expect(movedSource.indexOf("| 3 | Beta | B |")).toBeGreaterThanOrEqual(0);
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
  });

  it("adds at the append rails, deletes only after structural selection, and restores on Escape", () => {
    const source = [
      "| Name | Value |",
      "| --- | --- |",
      "| Alpha | A |",
      "| Beta | B |",
    ].join("\n");
    const { app, root, messages } = makeApp(source);
    mockTableGeometry(app, root);
    const cell = root.querySelector("tbody td")!;
    selectText(app, cell);
    const controls = root.querySelector<HTMLElement>(".mm-table-controls")!;
    const rowHandle = controls.querySelector<HTMLButtonElement>(
      '[data-table-control="row-handle"][data-index="1"]',
    )!;
    rowHandle.click();
    rowHandle.focus();
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);

    const appendRow = controls.querySelector<HTMLButtonElement>(
      '[data-table-control="row-append"]',
    )!;
    appendRow.click();
    expect(app.view.state.doc.firstChild?.childCount).toBe(4);
    acknowledgeLatestEdit(app, messages, 2);

    mockTableGeometry(app, root);
    const nextControls = root.querySelector<HTMLElement>(".mm-table-controls")!;
    nextControls
      .querySelector<HTMLButtonElement>('[data-table-control="column-append"]')!
      .click();
    expect(app.view.state.doc.firstChild?.firstChild?.childCount).toBe(3);
    acknowledgeLatestEdit(app, messages, 3);

    mockTableGeometry(app, root);
    const refreshed = root.querySelector<HTMLElement>(".mm-table-controls")!;
    const secondRow = refreshed.querySelector<HTMLButtonElement>(
      '[data-table-control="row-handle"][data-index="2"]',
    )!;
    secondRow.click();
    secondRow.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(app.view.state.doc.firstChild?.childCount).toBe(3);
    acknowledgeLatestEdit(app, messages, 4);

    mockTableGeometry(app, root);
    const lastControls = root.querySelector<HTMLElement>(".mm-table-controls")!;
    const returnPosition = app.view.state.selection.from;
    const firstRow = lastControls.querySelector<HTMLButtonElement>(
      '[data-table-control="row-handle"][data-index="1"]',
    )!;
    firstRow.click();
    firstRow.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    expect(app.view.state.selection.from).toBe(returnPosition);
    expect(editMessages(messages)).toHaveLength(3);
  });

  it("operates on a hovered table when the caret is in another table", () => {
    const source = [
      "Before",
      "",
      "| A | B |",
      "| --- | --- |",
      "| A1 | A2 |",
      "",
      "After",
      "",
      "| C | D |",
      "| --- | --- |",
      "| B1 | B2 |",
    ].join("\n");
    const { app, root, messages } = makeApp(source);
    const tables = root.querySelectorAll<HTMLTableElement>("table");
    expect(tables).toHaveLength(2);
    selectText(app, tables[0]!.querySelector("tbody td")!);

    tables[1]!.dispatchEvent(pointer("pointermove", 220, 220));
    const controls = root.querySelector<HTMLElement>(".mm-table-controls")!;
    const hoveredRow = controls.querySelector<HTMLButtonElement>(
      '[data-table-control="row-handle"][data-index="1"]',
    );
    expect(hoveredRow).not.toBeNull();
    hoveredRow!.click();
    controls
      .querySelector<HTMLButtonElement>('[data-table-control="row-append"]')!
      .click();

    const documentTables: PMNode[] = [];
    app.view.state.doc.descendants((node) => {
      if (node.type.spec.tableRole === "table") documentTables.push(node);
      return true;
    });
    expect(documentTables).toHaveLength(2);
    expect(documentTables[0]!.childCount).toBe(2);
    expect(documentTables[1]!.childCount).toBe(3);
    expect(editMessages(messages)).toHaveLength(1);
  });

  it("cancels an unselected column drag on document Escape without editing", () => {
    const source = [
      "| Name | Value | Notes |",
      "| --- | --- | --- |",
      "| Alpha | A | First |",
      "| Beta | B | Second |",
    ].join("\n");
    const { app, root, messages } = makeApp(source);
    mockTableGeometry(app, root);
    selectText(app, root.querySelector("tbody td")!);

    const controls = root.querySelector<HTMLElement>(".mm-table-controls")!;
    const columnHandle = controls.querySelector<HTMLButtonElement>(
      '[data-table-control="column-handle"][data-index="2"]',
    )!;
    const stage = root.querySelector<HTMLElement>(".mm-stage")!;
    const before = app.view.state.doc;
    columnHandle.dispatchEvent(pointer("pointerdown", 250, 10));
    stage.dispatchEvent(pointer("pointermove", 80, 40));
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escape);
    columnHandle.dispatchEvent(pointer("pointerup", 80, 40));

    expect(escape.defaultPrevented).toBe(true);
    expect(app.view.state.doc).toBe(before);
    expect(editMessages(messages)).toHaveLength(0);
    expect(columnHandle.classList.contains("is-dragging")).toBe(false);
    expect(
      controls.querySelector<HTMLElement>(".mm-table-column-insert-line")!
        .hidden,
    ).toBe(true);
  });

  it("keeps ordinary CellSelection behavior separate from the structural state", () => {
    const source = "| A | B |\n| --- | --- |\n| C | D |";
    const { app, root, messages } = makeApp(source);
    mockTableGeometry(app, root);
    const cells = root.querySelectorAll<HTMLTableCellElement>("tbody td");
    app.view.dispatch(
      app.view.state.tr.setSelection(
        CellSelection.create(
          app.view.state.doc,
          app.view.posAtDOM(cells[0]!, 0) - 1,
          app.view.posAtDOM(cells[1]!, 0) - 1,
        ),
      ),
    );
    expect(
      root
        .querySelector<HTMLElement>(".mm-table-controls")!
        .querySelector(".is-selected"),
    ).toBeNull();
    const beforeRows = app.view.state.doc.firstChild?.childCount;
    app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(app.view.state.doc.firstChild?.childCount).toBe(beforeRows);
    expect(editMessages(messages).length).toBeLessThanOrEqual(1);
  });

  it("disables legacy left insertion and data-column deletion at numbering boundaries", () => {
    const { app, root } = makeApp(
      ["| # | Name | Value |", "| --- | --- | --- |", "| 1 | Alpha | A |"].join(
        "\n",
      ),
    );
    selectText(app, root.querySelector("tbody td:nth-child(2)")!);
    const toolbar = root.querySelector<HTMLElement>(".mm-table-toolbar")!;
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-action="col-left"]')!
        .disabled,
    ).toBe(false);
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-action="col-delete"]')!
        .disabled,
    ).toBe(false);

    selectText(app, root.querySelector("tbody td:first-child")!);
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-action="col-left"]')!
        .disabled,
    ).toBe(true);
    expect(
      toolbar.querySelector<HTMLButtonElement>('[data-action="col-delete"]')!
        .disabled,
    ).toBe(true);
  });
});
