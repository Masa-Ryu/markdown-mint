import { describe, expect, it } from "vitest";
import {
  CellSelection,
  addRowAfter,
  addRowBefore,
  deleteRow,
} from "prosemirror-tables";
import {
  EditorState,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import {
  createTableNumberingPlugin,
  isNumberedTable,
  isTableNumbered,
  toggleTableNumbering,
} from "../../src/webview/tableNumbering";
import { parseMarkdown, schema, serializeMarkdown } from "../../src/core/index";

function paragraph(text: string, strong = false): PMNode {
  const marks = strong ? [schema.marks.strong!.create()] : undefined;
  return text
    ? schema.nodes.paragraph!.create(null, schema.text(text, marks))
    : schema.nodes.paragraph!.create();
}

function cell(
  text: string,
  typeName: "table_cell" | "table_header" = "table_cell",
  attrs: Record<string, unknown> | null = null,
  strong = false,
): PMNode {
  return schema.nodes[typeName]!.create(attrs, paragraph(text, strong));
}

function row(cells: PMNode[]): PMNode {
  return schema.nodes.table_row!.create(null, cells);
}

function makeTable(rows: PMNode[][]): PMNode {
  return schema.nodes.table!.create(
    null,
    rows.map((cells) => row(cells)),
  );
}

function makeNumberedTable(): PMNode {
  return makeTable([
    [cell("#", "table_header"), cell("Name", "table_header")],
    [cell("1"), cell("Alpha", "table_cell", { alignment: "right" }, true)],
    [cell("2"), cell("Beta")],
  ]);
}

function documentOf(...nodes: PMNode[]): PMNode {
  return schema.topNodeType.create(null, nodes);
}

function stateOf(doc: PMNode, withNumberingPlugin = false): EditorState {
  return EditorState.create({
    schema,
    doc,
    plugins: withNumberingPlugin ? [createTableNumberingPlugin()] : [],
  });
}

function textPosition(doc: PMNode, text: string, occurrence = 0): number {
  let seen = 0;
  let result: number | undefined;
  doc.descendants((node, pos) => {
    if (result !== undefined || !node.isText || !node.text) return;
    const offset = node.text.indexOf(text);
    if (offset < 0) return;
    if (seen === occurrence) result = pos + offset;
    seen += 1;
  });
  if (result === undefined) throw new Error(`text not found: ${text}`);
  return result;
}

function selectText(state: EditorState, text: string): EditorState {
  const from = textPosition(state.doc, text);
  return state.apply(
    state.tr.setSelection(
      TextSelection.create(state.doc, from, from + text.length),
    ),
  );
}

function run(state: EditorState): EditorState {
  let dispatched: Transaction | undefined;
  expect(toggleTableNumbering(state, (tr) => (dispatched = tr))).toBe(true);
  if (!dispatched) throw new Error("numbering command did not dispatch");
  return state.apply(dispatched);
}

function runTableCommand(
  state: EditorState,
  command: (
    state: EditorState,
    dispatch?: (tr: Transaction) => void,
  ) => boolean,
): EditorState {
  let dispatched: Transaction | undefined;
  expect(command(state, (tr) => (dispatched = tr))).toBe(true);
  if (!dispatched) throw new Error("table command did not dispatch");
  return state.applyTransaction(dispatched).state;
}

function cellPosition(
  tablePos: number,
  table: PMNode,
  rowIndex: number,
  cellIndex: number,
): number {
  let rowPos = tablePos + 1;
  for (let index = 0; index < rowIndex; index += 1)
    rowPos += table.child(index).nodeSize;
  let pos = rowPos + 1;
  for (let index = 0; index < cellIndex; index += 1)
    pos += table.child(rowIndex).child(index).nodeSize;
  return pos;
}

describe("table numbering mode", () => {
  it("prepends #/sequential cells and removes only that column", () => {
    const originalTable = makeTable([
      [cell("Name", "table_header"), cell("Value", "table_header")],
      [cell("Alpha", "table_cell", { alignment: "right" }, true), cell("A")],
      [cell("Beta"), cell("B")],
    ]);
    const original = documentOf(originalTable);
    let state = selectText(stateOf(original), "Alpha");
    state = run(state);

    const numbered = state.doc.firstChild!;
    expect(numbered.childCount).toBe(3);
    expect(numbered.child(0).child(0).textContent).toBe("#");
    expect(numbered.child(1).child(0).textContent).toBe("1");
    expect(numbered.child(2).child(0).textContent).toBe("2");
    expect(numbered.child(1).child(1).eq(originalTable.child(1).child(0))).toBe(
      true,
    );
    expect(numbered.child(1).child(1).attrs.alignment).toBe("right");
    expect(
      numbered.child(1).child(1).firstChild?.firstChild?.marks[0]?.type.name,
    ).toBe("strong");
    expect(isNumberedTable(numbered)).toBe(true);
    expect(isTableNumbered(state)).toBe(true);

    state = run(state);
    expect(state.doc.eq(original)).toBe(true);
    expect(isTableNumbered(state)).toBe(false);
  });

  it("recognizes the mode after Markdown serialization and reopening", () => {
    const source =
      "| Name | Value |\n| --- | --- |\n| Alpha | A |\n| Beta | B |\n";
    let state = selectText(stateOf(parseMarkdown(source).doc), "Alpha");
    state = run(state);
    const markdown = serializeMarkdown(state.doc);
    const reopened = parseMarkdown(markdown).doc;
    const reopenedState = selectText(stateOf(reopened), "Alpha");
    expect(markdown).toContain("| \\# | Name | Value |");
    expect(isNumberedTable(reopened.firstChild!)).toBe(true);
    expect(isTableNumbered(reopenedState)).toBe(true);
    expect(isNumberedTable(reopenedState.doc.firstChild!)).toBe(
      isNumberedTable(state.doc.firstChild!),
    );
  });

  it("does not discard an edited arbitrary first-column value", () => {
    let state = selectText(
      stateOf(
        documentOf(
          makeTable([
            [cell("Name", "table_header"), cell("Value", "table_header")],
            [cell("Alpha"), cell("A")],
          ]),
        ),
      ),
      "Alpha",
    );
    state = run(state);
    const numberPos = textPosition(state.doc, "1");
    state = state.apply(
      state.tr.insertText("custom", numberPos, numberPos + 1),
    );
    expect(isTableNumbered(state)).toBe(false);

    state = run(state);
    const table = state.doc.firstChild!;
    expect(table.child(0).child(0).textContent).toBe("#");
    expect(table.child(1).child(0).textContent).toBe("1");
    expect(table.child(1).child(1).textContent).toBe("custom");
    expect(table.child(1).child(2).textContent).toBe("Alpha");
    expect(table.child(1).child(3).textContent).toBe("A");
  });

  it("preserves a backward text selection on its logical data cells", () => {
    const table = makeTable([
      [cell("Name", "table_header"), cell("Value", "table_header")],
      [cell("Alpha"), cell("A")],
    ]);
    let state = stateOf(documentOf(table));
    const alphaStart = textPosition(state.doc, "Alpha");
    const valueStart = textPosition(state.doc, "A", 1);
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, valueStart + 1, alphaStart),
      ),
    );
    state = run(state);
    expect(state.selection).toBeInstanceOf(TextSelection);
    expect(state.selection.anchor).toBeGreaterThan(state.selection.head);
    expect(state.selection.$anchor.parent.textContent).toBe("A");
    expect(state.selection.$head.parent.textContent).toBe("Alpha");
  });

  it("keeps a CellSelection on the same data cells", () => {
    const table = makeTable([
      [cell("Name", "table_header"), cell("Value", "table_header")],
      [cell("Alpha"), cell("A")],
    ]);
    let state = stateOf(documentOf(table));
    const anchor = cellPosition(0, table, 1, 0);
    const head = cellPosition(0, table, 1, 1);
    state = state.apply(
      state.tr.setSelection(CellSelection.create(state.doc, anchor, head)),
    );
    state = run(state);
    expect(state.selection).toBeInstanceOf(CellSelection);
    const after = state.selection as CellSelection;
    expect(after.$anchorCell.nodeAfter?.textContent).toBe("Alpha");
    expect(after.$headCell.nodeAfter?.textContent).toBe("A");

    state = run(state);
    expect(state.selection).toBeInstanceOf(CellSelection);
    const restored = state.selection as CellSelection;
    expect(restored.$anchorCell.nodeAfter?.textContent).toBe("Alpha");
    expect(restored.$headCell.nodeAfter?.textContent).toBe("A");
  });

  it("numbers only the table containing the selection", () => {
    const first = makeTable([
      [cell("One", "table_header"), cell("Value", "table_header")],
      [cell("A"), cell("1")],
    ]);
    const second = makeTable([
      [cell("Two", "table_header"), cell("Value", "table_header")],
      [cell("B"), cell("2")],
    ]);
    let state = selectText(stateOf(documentOf(first, second)), "B");
    state = run(state);
    expect(state.doc.child(0).child(0).childCount).toBe(2);
    expect(state.doc.child(1).child(0).child(0).textContent).toBe("#");
    expect(state.doc.child(1).child(1).child(0).textContent).toBe("1");
  });

  it("does not remove a standalone one-column # data table", () => {
    const table = makeTable([[cell("#", "table_header")], [cell("1")]]);
    expect(isNumberedTable(table)).toBe(false);
    let state = selectText(stateOf(documentOf(table)), "1");
    state = run(state);
    expect(state.doc.firstChild!.child(0).childCount).toBe(2);
    expect(state.doc.firstChild!.child(1).child(1).textContent).toBe("1");
  });

  it("returns false without a table selection", () => {
    const state = selectText(
      stateOf(
        documentOf(schema.nodes.paragraph!.create(null, schema.text("text"))),
      ),
      "text",
    );
    expect(toggleTableNumbering(state)).toBe(false);
    expect(isTableNumbered(state)).toBe(false);
  });
});

describe("numbered table row maintenance", () => {
  it("normalizes header insertion and deletion without losing the mode", () => {
    const original = makeNumberedTable();
    let state = selectText(stateOf(documentOf(original), true), "Name");
    state = runTableCommand(state, addRowBefore);
    let table = state.doc.firstChild!;
    expect(isNumberedTable(table)).toBe(true);
    expect(table.child(0).child(0).textContent).toBe("#");
    expect(table.child(1).child(0).textContent).toBe("1");
    expect(table.child(1).child(1).textContent).toBe("Name");
    expect(table.child(2).child(0).textContent).toBe("2");
    expect(table.child(3).child(0).textContent).toBe("3");

    const firstCell = cellPosition(0, table, 0, 0);
    state = state.apply(
      state.tr.setSelection(
        CellSelection.create(state.doc, firstCell, firstCell),
      ),
    );
    state = runTableCommand(state, deleteRow);
    table = state.doc.firstChild!;
    expect(table.eq(original)).toBe(true);
    expect(isNumberedTable(table)).toBe(true);
  });

  it("does not renumber an adjacent table when a numbered table is deleted", () => {
    const numbered = makeNumberedTable();
    const adjacent = makeTable([
      [cell("2024", "table_header"), cell("Code", "table_header")],
      [cell("99"), cell("x")],
      [cell("88"), cell("y")],
      [cell("77"), cell("z")],
    ]);
    let state = stateOf(documentOf(numbered, adjacent), true);
    state = state.apply(
      state.tr.replaceWith(
        0,
        numbered.nodeSize,
        schema.nodes.paragraph!.create(),
      ),
    );
    expect(state.doc.childCount).toBe(2);
    expect(state.doc.child(1).eq(adjacent)).toBe(true);
  });

  it("maintains numbering through a whole-table replacement", () => {
    const original = makeNumberedTable();
    const replacement = makeTable([
      [cell("", "table_cell"), cell("", "table_cell")],
      [cell("#", "table_header"), cell("Name", "table_header")],
      [cell("1"), cell("Alpha")],
      [cell("2"), cell("Beta")],
    ]);
    let state = stateOf(documentOf(original), true);
    state = state.apply(
      state.tr.replaceWith(0, original.nodeSize, replacement),
    );
    const table = state.doc.firstChild!;
    expect(isNumberedTable(table)).toBe(true);
    expect(table.child(0).child(0).textContent).toBe("#");
    expect(table.child(1).child(0).textContent).toBe("1");
    expect(table.child(2).child(0).textContent).toBe("2");
    expect(table.child(3).child(0).textContent).toBe("3");
  });

  it("renumbers only the numbered table whose row changed", () => {
    const first = makeNumberedTable();
    const second = makeNumberedTable();
    const secondBefore = second;
    let state = selectText(stateOf(documentOf(first, second), true), "Alpha");
    state = runTableCommand(state, addRowAfter);
    expect(state.doc.child(0).childCount).toBe(4);
    expect(state.doc.child(0).child(3).child(0).textContent).toBe("3");
    expect(state.doc.child(1).eq(secondBefore)).toBe(true);
  });

  it("renumbers rows after insert and delete while preserving other cells", () => {
    const table = makeNumberedTable();
    let state = selectText(stateOf(documentOf(table), true), "Alpha");
    state = runTableCommand(state, addRowAfter);
    let numbered = state.doc.firstChild!;
    expect(numbered.childCount).toBe(4);
    expect(numbered.child(1).child(0).textContent).toBe("1");
    expect(numbered.child(2).child(0).textContent).toBe("2");
    expect(numbered.child(3).child(0).textContent).toBe("3");
    expect(numbered.child(1).child(1).textContent).toBe("Alpha");

    const insertedTable = state.doc.firstChild!;
    const insertedRowCell = cellPosition(0, insertedTable, 2, 0);
    state = state.apply(
      state.tr.setSelection(
        CellSelection.create(state.doc, insertedRowCell, insertedRowCell),
      ),
    );
    state = runTableCommand(state, deleteRow);
    numbered = state.doc.firstChild!;
    expect(numbered.childCount).toBe(3);
    expect(numbered.child(1).child(0).textContent).toBe("1");
    expect(numbered.child(2).child(0).textContent).toBe("2");
    expect(numbered.child(1).child(1).textContent).toBe("Alpha");
    expect(numbered.child(2).child(1).textContent).toBe("Beta");
  });

  it("leaves a modified first column untouched during a later row change", () => {
    const table = makeNumberedTable();
    let state = selectText(stateOf(documentOf(table), true), "1");
    const numberPos = textPosition(state.doc, "1");
    state = state.apply(
      state.tr.insertText("custom", numberPos, numberPos + 1),
    );
    expect(isNumberedTable(state.doc.firstChild!)).toBe(false);
    state = runTableCommand(state, addRowAfter);
    expect(state.doc.firstChild!.child(1).child(0).textContent).toBe("custom");
  });
});
