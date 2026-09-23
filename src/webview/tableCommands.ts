import { Fragment, type Node as PMNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import {
  measureEditorPerformance,
  recordEditorPerformanceCount,
} from "../shared/performanceBenchmark";
import { isNumberedTable, renumberTableAt } from "./tableNumbering";

export type TableOperationAxis = "row" | "column";

/** Metadata used only while a direct table operation is being dispatched. */
export const tableOperationMetaKey = "markdown-mint-table-operation";

export interface TableOperationMeta {
  axis: TableOperationAxis;
  kind: "insert" | "move" | "delete";
  tablePos: number;
  index?: number;
  boundary?: number;
}

function isTable(node: PMNode | null | undefined): node is PMNode {
  return node?.type.spec.tableRole === "table";
}

function isCell(node: PMNode | null | undefined): node is PMNode {
  const role = node?.type.spec.tableRole;
  return role === "cell" || role === "header_cell";
}

function isUnitCell(node: PMNode): boolean {
  return node.attrs.colspan === 1 && node.attrs.rowspan === 1;
}

/** Resolve a table only at the explicit document position supplied by a UI. */
export function tableAt(doc: PMNode, tablePos: number): PMNode | null {
  if (!Number.isInteger(tablePos) || tablePos < 0) return null;
  const table = doc.nodeAt(tablePos);
  return isTable(table) ? table : null;
}

/**
 * Direct manipulation intentionally handles rectangular, unmerged tables.
 * Existing ProseMirror table commands remain available for other structures;
 * the new handles simply refuse a shape whose coordinates are ambiguous.
 */
export function supportsDirectTableOperations(table: PMNode): boolean {
  if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
    let cellsVisited = 0;
    const supported = measureEditorPerformance(
      "tableCommands.supportsDirectTableOperations",
      () =>
        supportsDirectTableOperationsInstrumented(table, () => {
          cellsVisited += 1;
        }),
    );
    recordEditorPerformanceCount(
      "tableCommands.supportsDirectTableOperations.cellsVisited",
      cellsVisited,
    );
    benchmarkTableNodeScanCounts ??= new WeakMap<PMNode, number>();
    const scanOrdinal = (benchmarkTableNodeScanCounts.get(table) ?? 0) + 1;
    benchmarkTableNodeScanCounts.set(table, scanOrdinal);
    recordEditorPerformanceCount(
      "tableCommands.supportsDirectTableOperations.sameNodeScanOrdinal",
      scanOrdinal,
    );
    return supported;
  }
  if (!isTable(table) || table.childCount === 0) return false;
  const firstRow = table.child(0);
  if (
    firstRow.type.spec.tableRole !== "row" ||
    firstRow.childCount === 0 ||
    firstRow.firstChild?.type.spec.tableRole !== "header_cell"
  )
    return false;
  const width = firstRow.childCount;
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    if (row.type.spec.tableRole !== "row" || row.childCount !== width)
      return false;
    for (let column = 0; column < row.childCount; column += 1) {
      const cell = row.child(column);
      if (!isCell(cell) || !isUnitCell(cell)) return false;
      if (rowIndex === 0 && cell.type.spec.tableRole !== "header_cell")
        return false;
      if (rowIndex > 0 && cell.type.spec.tableRole !== "cell") return false;
    }
  }
  return true;
}

let benchmarkTableNodeScanCounts: WeakMap<PMNode, number> | undefined;

function supportsDirectTableOperationsInstrumented(
  table: PMNode,
  onCellVisited: () => void,
): boolean {
  if (!isTable(table) || table.childCount === 0) return false;
  const firstRow = table.child(0);
  if (
    firstRow.type.spec.tableRole !== "row" ||
    firstRow.childCount === 0 ||
    firstRow.firstChild?.type.spec.tableRole !== "header_cell"
  )
    return false;
  const width = firstRow.childCount;
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    if (row.type.spec.tableRole !== "row" || row.childCount !== width)
      return false;
    for (let column = 0; column < row.childCount; column += 1) {
      const cell = row.child(column);
      onCellVisited();
      if (!isCell(cell) || !isUnitCell(cell)) return false;
      if (rowIndex === 0 && cell.type.spec.tableRole !== "header_cell")
        return false;
      if (rowIndex > 0 && cell.type.spec.tableRole !== "cell") return false;
    }
  }
  return true;
}

function validBoundary(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validIndex(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < max;
}

function tableWidth(table: PMNode): number {
  return table.firstChild?.childCount ?? 0;
}

function numberedColumnMinimum(table: PMNode): number {
  return isNumberedTable(table) ? 1 : 0;
}

export function canInsertTableRowAt(table: PMNode, boundary: number): boolean {
  return (
    supportsDirectTableOperations(table) &&
    validBoundary(boundary, 1, table.childCount)
  );
}

export function canInsertTableColumnAt(
  table: PMNode,
  boundary: number,
): boolean {
  const width = tableWidth(table);
  return (
    supportsDirectTableOperations(table) &&
    validBoundary(boundary, numberedColumnMinimum(table), width)
  );
}

export function canMoveTableRowToBoundary(
  table: PMNode,
  rowIndex: number,
  boundary: number,
): boolean {
  if (!supportsDirectTableOperations(table)) return false;
  if (!validIndex(rowIndex, table.childCount) || rowIndex < 1) return false;
  if (!validBoundary(boundary, 1, table.childCount)) return false;
  // Boundaries are measured in the original table. Dropping immediately
  // before or after the source does not change the order.
  return boundary !== rowIndex && boundary !== rowIndex + 1;
}

export function canMoveTableColumnToBoundary(
  table: PMNode,
  columnIndex: number,
  boundary: number,
): boolean {
  const width = tableWidth(table);
  if (!supportsDirectTableOperations(table)) return false;
  if (!validIndex(columnIndex, width)) return false;
  if (isNumberedTable(table) && columnIndex === 0) return false;
  if (!validBoundary(boundary, numberedColumnMinimum(table), width))
    return false;
  return boundary !== columnIndex && boundary !== columnIndex + 1;
}

export function canDeleteTableRowAt(table: PMNode, rowIndex: number): boolean {
  return (
    supportsDirectTableOperations(table) &&
    validIndex(rowIndex, table.childCount) &&
    rowIndex >= 1
  );
}

export function canDeleteTableColumnAt(
  table: PMNode,
  columnIndex: number,
): boolean {
  const width = tableWidth(table);
  if (!supportsDirectTableOperations(table)) return false;
  if (!validIndex(columnIndex, width)) return false;
  if (width <= 1) return false;
  if (isNumberedTable(table)) return columnIndex >= 1 && width > 2;
  return true;
}

function emptyCell(
  table: PMNode,
  typeName: "table_cell" | "table_header",
  attrs?: Record<string, unknown> | null,
): PMNode | null {
  const type = table.type.schema.nodes[typeName];
  const paragraph = table.type.schema.nodes.paragraph;
  if (!type || !paragraph) return null;
  try {
    return type.create(attrs ?? null, paragraph.create());
  } catch {
    return null;
  }
}

function replaceTable(
  state: EditorState,
  tablePos: number,
  original: PMNode,
  replacement: PMNode,
  meta: TableOperationMeta,
  renumber: boolean,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  if (!dispatch) return true;
  try {
    const transaction = state.tr
      .replaceWith(tablePos, tablePos + original.nodeSize, replacement)
      .setMeta(tableOperationMetaKey, meta);
    if (renumber) renumberTableAt(transaction, tablePos);
    // The table stays at the same document position. Avoid forcing a native
    // selection scroll here: the editor restores the user's text/CellSelection
    // separately, and the controls must not steal focus from the editing view.
    dispatch(transaction);
    return true;
  } catch {
    return false;
  }
}

function rowsWithInsertedRow(table: PMNode, boundary: number): PMNode[] | null {
  const rowType = table.type.schema.nodes.table_row;
  if (!rowType) return null;
  // Body cells carry the column alignment used by newly-created body rows.
  // Header-only tables fall back to their header cells, whose attrs still
  // describe the table's current column defaults.
  const reference = table.child(Math.min(1, table.childCount - 1));
  const cells: PMNode[] = [];
  for (let column = 0; column < reference.childCount; column += 1) {
    const source = reference.child(column);
    const newCell = emptyCell(table, "table_cell", source.attrs);
    if (!newCell) return null;
    cells.push(newCell);
  }
  const newRow = rowType.create(null, Fragment.fromArray(cells));
  const rows = Array.from({ length: table.childCount }, (_, index) =>
    table.child(index),
  );
  rows.splice(boundary, 0, newRow);
  return rows;
}

function rowsWithInsertedColumn(
  table: PMNode,
  boundary: number,
): PMNode[] | null {
  const rowType = table.type.schema.nodes.table_row;
  if (!rowType) return null;
  const rows: PMNode[] = [];
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    const typeName = rowIndex === 0 ? "table_header" : "table_cell";
    const inserted = emptyCell(table, typeName);
    if (!inserted) return null;
    const cells = Array.from({ length: row.childCount }, (_, column) =>
      row.child(column),
    );
    cells.splice(boundary, 0, inserted);
    rows.push(row.type === rowType ? rowType.create(row.attrs, cells) : row);
  }
  return rows;
}

function tableWithRows(table: PMNode, rows: PMNode[]): PMNode | null {
  try {
    return table.copy(Fragment.fromArray(rows));
  } catch {
    return null;
  }
}

export function insertTableRowAt(
  state: EditorState,
  tablePos: number,
  boundary: number,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const table = tableAt(state.doc, tablePos);
  if (!table || !canInsertTableRowAt(table, boundary)) return false;
  const rows = rowsWithInsertedRow(table, boundary);
  const replacement = rows && tableWithRows(table, rows);
  if (!replacement) return false;
  return replaceTable(
    state,
    tablePos,
    table,
    replacement,
    { axis: "row", kind: "insert", tablePos, boundary },
    isNumberedTable(table),
    dispatch,
  );
}

export function insertTableColumnAt(
  state: EditorState,
  tablePos: number,
  boundary: number,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const table = tableAt(state.doc, tablePos);
  if (!table || !canInsertTableColumnAt(table, boundary)) return false;
  const rows = rowsWithInsertedColumn(table, boundary);
  const replacement = rows && tableWithRows(table, rows);
  if (!replacement) return false;
  return replaceTable(
    state,
    tablePos,
    table,
    replacement,
    { axis: "column", kind: "insert", tablePos, boundary },
    isNumberedTable(table),
    dispatch,
  );
}

export function moveTableRowToBoundary(
  state: EditorState,
  tablePos: number,
  rowIndex: number,
  boundary: number,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const table = tableAt(state.doc, tablePos);
  if (!table || !canMoveTableRowToBoundary(table, rowIndex, boundary))
    return false;
  const rows = Array.from({ length: table.childCount }, (_, index) =>
    table.child(index),
  );
  const [moved] = rows.splice(rowIndex, 1);
  if (!moved) return false;
  rows.splice(boundary > rowIndex ? boundary - 1 : boundary, 0, moved);
  const replacement = tableWithRows(table, rows);
  if (!replacement) return false;
  return replaceTable(
    state,
    tablePos,
    table,
    replacement,
    { axis: "row", kind: "move", tablePos, index: rowIndex, boundary },
    isNumberedTable(table),
    dispatch,
  );
}

export function moveTableColumnToBoundary(
  state: EditorState,
  tablePos: number,
  columnIndex: number,
  boundary: number,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const table = tableAt(state.doc, tablePos);
  if (!table || !canMoveTableColumnToBoundary(table, columnIndex, boundary))
    return false;
  const target = boundary > columnIndex ? boundary - 1 : boundary;
  const rows: PMNode[] = [];
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    const cells = Array.from({ length: row.childCount }, (_, column) =>
      row.child(column),
    );
    const [moved] = cells.splice(columnIndex, 1);
    if (!moved) return false;
    cells.splice(target, 0, moved);
    rows.push(row.type.create(row.attrs, cells));
  }
  const replacement = tableWithRows(table, rows);
  if (!replacement) return false;
  return replaceTable(
    state,
    tablePos,
    table,
    replacement,
    { axis: "column", kind: "move", tablePos, index: columnIndex, boundary },
    isNumberedTable(table),
    dispatch,
  );
}

export function deleteTableRowAt(
  state: EditorState,
  tablePos: number,
  rowIndex: number,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const table = tableAt(state.doc, tablePos);
  if (!table || !canDeleteTableRowAt(table, rowIndex)) return false;
  const rows = Array.from({ length: table.childCount }, (_, index) =>
    table.child(index),
  );
  rows.splice(rowIndex, 1);
  const replacement = tableWithRows(table, rows);
  if (!replacement) return false;
  return replaceTable(
    state,
    tablePos,
    table,
    replacement,
    { axis: "row", kind: "delete", tablePos, index: rowIndex },
    isNumberedTable(table),
    dispatch,
  );
}

export function deleteTableColumnAt(
  state: EditorState,
  tablePos: number,
  columnIndex: number,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const table = tableAt(state.doc, tablePos);
  if (!table || !canDeleteTableColumnAt(table, columnIndex)) return false;
  const rows: PMNode[] = [];
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    const cells = Array.from({ length: row.childCount }, (_, column) =>
      row.child(column),
    );
    cells.splice(columnIndex, 1);
    rows.push(row.type.create(row.attrs, cells));
  }
  const replacement = tableWithRows(table, rows);
  if (!replacement) return false;
  return replaceTable(
    state,
    tablePos,
    table,
    replacement,
    { axis: "column", kind: "delete", tablePos, index: columnIndex },
    isNumberedTable(table),
    dispatch,
  );
}
