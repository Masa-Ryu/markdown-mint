import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { parseMarkdown, schema } from "../../src/core";
import {
  canDeleteTableColumnAt,
  canDeleteTableRowAt,
  canInsertTableColumnAt,
  canInsertTableRowAt,
  canMoveTableColumnToBoundary,
  canMoveTableRowToBoundary,
  deleteTableColumnAt,
  deleteTableRowAt,
  insertTableColumnAt,
  insertTableRowAt,
  moveTableColumnToBoundary,
  moveTableRowToBoundary,
  supportsDirectTableOperations,
  tableOperationMetaKey,
} from "../../src/webview/tableCommands";
import { isNumberedTable } from "../../src/webview/tableNumbering";

function directTable(source: string): PMNode {
  const parsed = parseMarkdown(source, "github").doc.firstChild;
  if (!parsed || parsed.type.spec.tableRole !== "table")
    throw new Error("Expected a table fixture");
  return parsed;
}

function stateOf(table: PMNode): EditorState {
  return EditorState.create({
    schema,
    doc: schema.topNodeType.create(null, table),
  });
}

function applyCommand(
  state: EditorState,
  command: (
    state: EditorState,
    tablePos: number,
    index: number,
    boundary: number,
    dispatch?: (transaction: Transaction) => void,
  ) => boolean,
  index: number,
  boundary: number,
): EditorState {
  let dispatched: Transaction | undefined;
  expect(
    command(state, 0, index, boundary, (transaction) => {
      dispatched = transaction;
    }),
  ).toBe(true);
  if (!dispatched) throw new Error("Table command did not dispatch");
  return state.apply(dispatched);
}

function applyInsert(
  state: EditorState,
  command: (
    state: EditorState,
    tablePos: number,
    boundary: number,
    dispatch?: (transaction: Transaction) => void,
  ) => boolean,
  boundary: number,
): EditorState {
  let dispatched: Transaction | undefined;
  expect(
    command(state, 0, boundary, (transaction) => {
      dispatched = transaction;
    }),
  ).toBe(true);
  if (!dispatched) throw new Error("Table command did not dispatch");
  return state.apply(dispatched);
}

function rowTexts(table: PMNode): string[] {
  return Array.from(
    { length: table.childCount },
    (_, row) =>
      table
        .child(row)
        .child(0)
        ?.textContent.replace(/^#$/, "header")
        .replace(/^\d+$/, "number") ?? "",
  );
}

describe("direct table commands", () => {
  it("inserts at explicit row and column boundaries without rebuilding existing cells", () => {
    const original = directTable(
      [
        "| Name | Value |",
        "| --- | --- |",
        "| Alpha | A |",
        "| Beta | B |",
      ].join("\n"),
    );
    const originalCell = original.child(1).child(0);
    let state = stateOf(original);

    state = applyInsert(state, insertTableRowAt, 2);
    let table = state.doc.firstChild!;
    expect(table.childCount).toBe(4);
    expect(table.child(1).child(0)).toBe(originalCell);
    expect(table.child(2).child(0).type.spec.tableRole).toBe("cell");
    expect(table.child(2).childCount).toBe(2);
    expect(table.child(3).child(0).textContent).toBe("Beta");

    const headerBeforeColumn = table.child(0).child(0);
    state = applyInsert(state, insertTableColumnAt, 1);
    table = state.doc.firstChild!;
    expect(table.child(0).child(0)).toBe(headerBeforeColumn);
    expect(table.child(0).child(1).type.spec.tableRole).toBe("header_cell");
    expect(table.child(1).child(0).textContent).toBe("Alpha");
    expect(table.child(1).child(1).textContent).toBe("");
    expect(table.child(1).child(2).textContent).toBe("A");
  });

  it("moves numbered rows as one transaction and renumbers the same table", () => {
    const table = directTable(
      [
        "| # | Name |",
        "| --- | --- |",
        "| 1 | Alpha |",
        "| 2 | Beta |",
        "| 3 | Gamma |",
      ].join("\n"),
    );
    let state = stateOf(table);
    let dispatched: Transaction | undefined;
    expect(
      moveTableRowToBoundary(state, 0, 3, 1, (transaction) => {
        dispatched = transaction;
      }),
    ).toBe(true);
    if (!dispatched) throw new Error("Row move did not dispatch");
    expect(dispatched.getMeta(tableOperationMetaKey)).toEqual({
      axis: "row",
      kind: "move",
      tablePos: 0,
      index: 3,
      boundary: 1,
    });
    state = state.apply(dispatched);

    const moved = state.doc.firstChild!;
    expect(rowTexts(moved)).toEqual(["header", "number", "number", "number"]);
    expect(moved.child(1).child(1).textContent).toBe("Gamma");
    expect(moved.child(2).child(1).textContent).toBe("Alpha");
    expect(moved.child(3).child(1).textContent).toBe("Beta");
    expect(moved.child(1).child(0).textContent).toBe("1");
    expect(moved.child(2).child(0).textContent).toBe("2");
    expect(moved.child(3).child(0).textContent).toBe("3");
    expect(isNumberedTable(moved)).toBe(true);
  });

  it("moves non-number columns while preserving their cell content and attrs", () => {
    const table = directTable(
      [
        "| Name | Value | Note |",
        "| --- | --- | --- |",
        "| Alpha | A | first |",
      ].join("\n"),
    );
    let state = stateOf(table);
    const originalValue = table.child(1).child(1);
    state = applyCommand(state, moveTableColumnToBoundary, 1, 3);
    const moved = state.doc.firstChild!;
    expect(moved.child(0).textContent).toBe("NameNoteValue");
    expect(moved.child(1).textContent).toBe("AlphafirstA");
    expect(moved.child(1).child(2)).toBe(originalValue);
  });

  it("copies only column alignment into new rows and preserves rich cells on moves", () => {
    const table = directTable(
      [
        "| Name | Value | Note |",
        "| :--- | :---: | ---: |",
        "| **Alpha** | [A](https://example.com) | `note` |",
      ].join("\n"),
    );
    const originalRow = table.child(1);
    const originalRichCell = originalRow.child(1);
    let state = stateOf(table);
    state = applyInsert(state, insertTableRowAt, 2);
    const insertedRow = state.doc.firstChild!.child(2);
    expect(insertedRow.child(0).attrs).toEqual(originalRow.child(0).attrs);
    expect(insertedRow.child(1).attrs).toEqual(originalRow.child(1).attrs);
    expect(insertedRow.child(2).attrs).toEqual(originalRow.child(2).attrs);
    expect(insertedRow.textContent).toBe("");

    state = applyCommand(state, moveTableColumnToBoundary, 1, 3);
    const moved = state.doc.firstChild!;
    expect(moved.child(1).child(2)).toBe(originalRichCell);
    expect(moved.child(1).child(2).textContent).toBe("A");
  });

  it("protects the numbered column and keeps one data column available", () => {
    const numbered = directTable(
      ["| # | Name | Value |", "| --- | --- | --- |", "| 1 | A | B |"].join(
        "\n",
      ),
    );
    expect(canInsertTableColumnAt(numbered, 0)).toBe(false);
    expect(canInsertTableColumnAt(numbered, 1)).toBe(true);
    expect(canMoveTableColumnToBoundary(numbered, 0, 2)).toBe(false);
    expect(canDeleteTableColumnAt(numbered, 0)).toBe(false);
    expect(canDeleteTableColumnAt(numbered, 1)).toBe(true);

    const onlyData = directTable(
      ["| # | Name |", "| --- | --- |", "| 1 | A |"].join("\n"),
    );
    expect(canDeleteTableColumnAt(onlyData, 1)).toBe(false);
    expect(canInsertTableRowAt(onlyData, 1)).toBe(true);
    expect(canMoveTableRowToBoundary(onlyData, 1, 1)).toBe(false);
    expect(canDeleteTableRowAt(onlyData, 1)).toBe(true);
  });

  it("does not auto-renumber a manually edited first column", () => {
    const table = directTable(
      [
        "| # | Name |",
        "| --- | --- |",
        "| custom | Alpha |",
        "| 2 | Beta |",
      ].join("\n"),
    );
    expect(isNumberedTable(table)).toBe(false);
    let state = stateOf(table);
    state = applyCommand(state, moveTableRowToBoundary, 2, 1);
    const moved = state.doc.firstChild!;
    expect(moved.child(1).child(0).textContent).toBe("2");
    expect(moved.child(2).child(0).textContent).toBe("custom");
  });

  it("refuses stale positions, merged tables, and no-op or invalid boundaries", () => {
    const merged = directTable(
      ["| A | B |", "| --- | --- |", "| [x](#) | C |"].join("\n"),
    );
    const colspan = schema.nodes.table_cell!.create(
      { colspan: 2, rowspan: 1, colwidth: null, alignment: null },
      schema.nodes.paragraph!.create(),
    );
    const mergedTable = schema.nodes.table!.create(null, [
      schema.nodes.table_row!.create(null, [
        schema.nodes.table_header!.create(
          null,
          schema.nodes.paragraph!.create(null, schema.text("A")),
        ),
        schema.nodes.table_header!.create(
          null,
          schema.nodes.paragraph!.create(null, schema.text("B")),
        ),
      ]),
      schema.nodes.table_row!.create(null, [colspan]),
    ]);
    expect(supportsDirectTableOperations(merged)).toBe(true);
    expect(supportsDirectTableOperations(mergedTable)).toBe(false);
    expect(canInsertTableRowAt(mergedTable, 1)).toBe(false);

    const state = stateOf(merged);
    expect(insertTableRowAt(state, 1, 1)).toBe(false);
    expect(moveTableRowToBoundary(state, 0, 1, 1)).toBe(false);
    expect(moveTableRowToBoundary(state, 0, 1, 3)).toBe(false);
    expect(deleteTableRowAt(state, 0, 0)).toBe(false);
    expect(deleteTableColumnAt(state, 0, 4)).toBe(false);
  });
});
