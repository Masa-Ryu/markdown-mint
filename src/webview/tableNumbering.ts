import type {
  Node as PMNode,
  NodeType,
  ResolvedPos,
  Schema,
} from "prosemirror-model";
import {
  AllSelection,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { Mapping } from "prosemirror-transform";
import { CellSelection, TableMap } from "prosemirror-tables";

/** Plugin key used by the optional row-renumbering plugin. */
export const tableNumberingPluginKey = new PluginKey(
  "markdown-mint-table-numbering",
);

interface CellPoint {
  row: number;
  col: number;
  pos: number;
  node: PMNode;
}

interface TableContext {
  table: PMNode;
  tablePos: number;
  tableStart: number;
  anchor: CellPoint;
  head: CellPoint;
}

interface RowCells {
  row: PMNode;
  rowPos: number;
  cells: Array<{ node: PMNode; pos: number }>;
}

interface TableEntry {
  node: PMNode;
  pos: number;
}

function isTableNode(node: PMNode | null | undefined): node is PMNode {
  return node?.type.spec.tableRole === "table";
}

function isCellNode(node: PMNode): boolean {
  const role = node.type.spec.tableRole;
  return role === "cell" || role === "header_cell";
}

function isPlainCellText(cell: PMNode): string | null {
  if (!isCellNode(cell) || cell.childCount !== 1) return null;
  const block = cell.firstChild;
  if (!block || block.type.name !== "paragraph") return null;
  let value = "";
  let valid = true;
  block.forEach((child) => {
    if (!child.isText || child.marks.length > 0) valid = false;
    else value += child.text ?? "";
  });
  return valid ? value : null;
}

function isUnitCell(cell: PMNode): boolean {
  return cell.attrs.colspan === 1 && cell.attrs.rowspan === 1;
}

function isNumberCell(cell: PMNode, expected: string): boolean {
  return isUnitCell(cell) && isPlainCellText(cell) === expected;
}

/** Strictly recognize the numbering mode without consuming arbitrary data. */
export function isNumberedTable(table: PMNode): boolean {
  if (!isTableNode(table) || table.childCount === 0) return false;
  if (table.childCount > 0 && table.child(0).childCount < 2) return false;

  const header = table.child(0).firstChild;
  if (
    !header ||
    header.type.name !== "table_header" ||
    !isNumberCell(header, "#")
  )
    return false;

  for (let rowIndex = 1; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    const first = row.firstChild;
    if (
      !first ||
      first.type.name !== "table_cell" ||
      row.childCount < 2 ||
      !isNumberCell(first, String(rowIndex))
    )
      return false;
  }
  return true;
}

function tableAncestor(
  $pos: ResolvedPos,
): { node: PMNode; depth: number; pos: number; start: number } | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (isTableNode(node)) {
      return {
        node,
        depth,
        pos: $pos.before(depth),
        start: $pos.start(depth),
      };
    }
  }
  return null;
}

function cellPoint(
  $pos: ResolvedPos,
  table: PMNode,
  tableStart: number,
): CellPoint | null {
  const map = TableMap.get(table);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (!isCellNode(node)) continue;
    const pos = $pos.before(depth);
    const rect = map.findCell(pos - tableStart);
    return { row: rect.top, col: rect.left, pos, node };
  }
  return null;
}

/** Resolve a CellSelection endpoint, whose position is immediately before a cell. */
function cellSelectionPoint(
  $cell: ResolvedPos,
  table: PMNode,
  tableStart: number,
): CellPoint | null {
  const map = TableMap.get(table);
  const relative = $cell.pos - tableStart;
  let rect: ReturnType<TableMap["findCell"]>;
  try {
    rect = map.findCell(relative);
  } catch {
    return null;
  }
  const node = $cell.nodeAfter ?? table.nodeAt(relative);
  if (!node || !isCellNode(node)) return null;
  return { row: rect.top, col: rect.left, pos: $cell.pos, node };
}

function contextForSelection(state: EditorState): TableContext | null {
  const selection = state.selection;
  if (selection instanceof AllSelection) return null;

  if (selection instanceof CellSelection) {
    const table = selection.$anchorCell.node(-1);
    const headTable = selection.$headCell.node(-1);
    if (!isTableNode(table) || table !== headTable) return null;
    const tableStart = selection.$anchorCell.start(-1);
    const anchor = cellSelectionPoint(selection.$anchorCell, table, tableStart);
    const head = cellSelectionPoint(selection.$headCell, table, tableStart);
    if (!anchor || !head) return null;
    return {
      table,
      tablePos: tableStart - 1,
      tableStart,
      anchor,
      head,
    };
  }

  if (selection instanceof NodeSelection && isTableNode(selection.node)) {
    const table = selection.node;
    const tablePos = selection.from;
    const tableStart = tablePos + 1;
    const map = TableMap.get(table);
    const firstRelative = map.map[0];
    const lastRelative = map.map[map.map.length - 1];
    if (firstRelative === undefined || lastRelative === undefined) return null;
    const first = cellPoint(
      state.doc.resolve(tableStart + firstRelative + 1),
      table,
      tableStart,
    );
    const last = cellPoint(
      state.doc.resolve(tableStart + lastRelative + 1),
      table,
      tableStart,
    );
    if (!first || !last) return null;
    return { table, tablePos, tableStart, anchor: first, head: last };
  }

  const anchorTable = tableAncestor(selection.$anchor);
  const headTable = tableAncestor(selection.$head);
  if (!anchorTable || !headTable || anchorTable.node !== headTable.node)
    return null;
  const anchor = cellPoint(
    selection.$anchor,
    anchorTable.node,
    anchorTable.start,
  );
  const head = cellPoint(selection.$head, anchorTable.node, anchorTable.start);
  if (!anchor || !head) return null;
  return {
    table: anchorTable.node,
    tablePos: anchorTable.pos,
    tableStart: anchorTable.start,
    anchor,
    head,
  };
}

function rowCells(tablePos: number, table: PMNode): RowCells[] {
  const rows: RowCells[] = [];
  let rowPos = tablePos + 1;
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    const cells: Array<{ node: PMNode; pos: number }> = [];
    let cellPos = rowPos + 1;
    for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
      const node = row.child(cellIndex);
      cells.push({ node, pos: cellPos });
      cellPos += node.nodeSize;
    }
    rows.push({ row, rowPos, cells });
    rowPos += row.nodeSize;
  }
  return rows;
}

function paragraphWithText(schema: Schema, text: string): PMNode | null {
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) return null;
  return paragraph.create(null, schema.text(text));
}

function numberCell(
  schema: Schema,
  type: NodeType,
  value: string,
  attrs?: Record<string, unknown> | null,
): PMNode | null {
  const paragraph = paragraphWithText(schema, value);
  return paragraph ? type.create(attrs ?? null, paragraph) : null;
}

function tableAt(doc: PMNode, pos: number): PMNode | null {
  const node = doc.nodeAt(pos);
  return isTableNode(node) ? node : null;
}

function cellPositionAt(
  tablePos: number,
  table: PMNode,
  row: number,
  col: number,
): { pos: number; node: PMNode } | null {
  const rowInfo = rowCells(tablePos, table)[row];
  if (!rowInfo) return null;
  const map = TableMap.get(table);
  const width = map.width;
  const safeCol = Math.max(0, Math.min(col, width - 1));
  const relative = map.positionAt(row, safeCol, table);
  const pos = tablePos + 1 + relative;
  const node = table.nodeAt(relative);
  return node && isCellNode(node) ? { pos, node } : null;
}

function restoreTextSelection(
  state: EditorState,
  tr: Transaction,
  context: TableContext,
  adding: boolean,
  tablePos: number,
  table: PMNode,
): void {
  if (!(state.selection instanceof TextSelection)) return;
  const target = (point: CellPoint, position: number): number | null => {
    const col = adding ? point.col + 1 : Math.max(0, point.col - 1);
    const cell = cellPositionAt(tablePos, table, point.row, col);
    if (!cell) return null;
    const offset = Math.max(
      1,
      Math.min(point.node.nodeSize - 1, position - point.pos),
    );
    return cell.pos + Math.min(cell.node.nodeSize - 1, offset);
  };
  const anchor = target(context.anchor, state.selection.$anchor.pos);
  const head = target(context.head, state.selection.$head.pos);
  if (anchor === null || head === null) return;
  try {
    const selection = TextSelection.between(
      tr.doc.resolve(anchor),
      tr.doc.resolve(head),
      anchor <= head ? 1 : -1,
    );
    tr.setSelection(selection);
  } catch {
    // ProseMirror's normal mapping remains valid for unusual custom cells.
  }
}

function restoreCellSelection(
  state: EditorState,
  tr: Transaction,
  context: TableContext,
  adding: boolean,
  tablePos: number,
  table: PMNode,
): void {
  if (!(state.selection instanceof CellSelection)) return;
  const target = (point: CellPoint): number | null => {
    const col = adding ? point.col + 1 : Math.max(0, point.col - 1);
    return cellPositionAt(tablePos, table, point.row, col)?.pos ?? null;
  };
  const anchor = target(context.anchor);
  const head = target(context.head);
  if (anchor === null || head === null) return;
  try {
    tr.setSelection(CellSelection.create(tr.doc, anchor, head));
  } catch {
    // Leave the mapped CellSelection when a malformed table cannot be reset.
  }
}

function applyNumbering(
  state: EditorState,
  context: TableContext,
  adding: boolean,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const rows = rowCells(context.tablePos, context.table);
  if (rows.length === 0 || rows.some((row) => row.cells.length === 0))
    return false;
  const schema = state.schema;
  const headerType = schema.nodes.table_header;
  const bodyType = schema.nodes.table_cell;
  if (!headerType || !bodyType) return false;

  if (!dispatch) return true;
  const tr = state.tr;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const first = rows[index]!.cells[0]!;
    if (adding) {
      const type = index === 0 ? headerType : bodyType;
      const cell = numberCell(schema, type, index === 0 ? "#" : String(index));
      if (!cell) return false;
      tr.insert(first.pos, cell);
    } else {
      tr.delete(first.pos, first.pos + first.node.nodeSize);
    }
  }

  const mappedTablePos = tr.mapping.map(context.tablePos, 1);
  const mappedTable = tableAt(tr.doc, mappedTablePos);
  if (mappedTable) {
    restoreTextSelection(
      state,
      tr,
      context,
      adding,
      mappedTablePos,
      mappedTable,
    );
    restoreCellSelection(
      state,
      tr,
      context,
      adding,
      mappedTablePos,
      mappedTable,
    );
  }
  dispatch(tr.scrollIntoView());
  return true;
}

/** Toggle the strict Markdown table numbering column for the selected table. */
export const toggleTableNumbering: Command = (state, dispatch) => {
  const context = contextForSelection(state);
  if (!context) return false;
  const numbered = isNumberedTable(context.table);
  return applyNumbering(state, context, !numbered, dispatch);
};

/** Factory alias for hosts that keep commands schema-bound. */
export function createTableNumberingCommand(_schema?: Schema): Command {
  return toggleTableNumbering;
}

/** Whether the current text or cell selection is inside a numbered table. */
export function isTableNumbered(state: EditorState): boolean {
  const context = contextForSelection(state);
  return context ? isNumberedTable(context.table) : false;
}

function collectTables(doc: PMNode): TableEntry[] {
  const entries: TableEntry[] = [];
  doc.descendants((node, pos) => {
    if (isTableNode(node)) entries.push({ node, pos });
  });
  return entries;
}

function safeNumberColumn(table: PMNode): boolean {
  if (!isTableNode(table) || table.childCount === 0) return false;
  if (table.child(0).childCount < 2) return false;
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    if (row.childCount < 2) return false;
    const first = row.firstChild;
    const value = first ? isPlainCellText(first) : null;
    // A row command can move the former header row or promote a body row.
    // Keep the guard narrow so an edited arbitrary first column is untouched.
    if (
      !first ||
      !isUnitCell(first) ||
      value === null ||
      (value !== "" && value !== "#" && !/^\d+$/.test(value))
    )
      return false;
  }
  return true;
}

function replaceNumberCell(
  tr: Transaction,
  cell: { node: PMNode; pos: number },
  type: NodeType,
  value: string,
): boolean {
  const paragraph = paragraphWithText(tr.doc.type.schema, value);
  if (!paragraph) return false;
  const replacement = type.create(cell.node.attrs, paragraph);
  if (replacement.eq(cell.node)) return false;
  tr.replaceWith(cell.pos, cell.pos + cell.node.nodeSize, replacement);
  return true;
}

function replaceCellType(
  tr: Transaction,
  cell: { node: PMNode; pos: number },
  type: NodeType,
): boolean {
  if (cell.node.type === type) return false;
  const replacement = type.create(cell.node.attrs, cell.node.content);
  tr.replaceWith(cell.pos, cell.pos + cell.node.nodeSize, replacement);
  return true;
}

function renumberRows(
  tr: Transaction,
  tablePos: number,
  table: PMNode,
): boolean {
  const schema = tr.doc.type.schema;
  const headerType = schema.nodes.table_header;
  const bodyType = schema.nodes.table_cell;
  if (!headerType || !bodyType) return false;
  let changed = false;
  const rows = rowCells(tablePos, table);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const targetType = index === 0 ? headerType : bodyType;
    const cells = rows[index]!.cells;
    for (let cellIndex = cells.length - 1; cellIndex >= 0; cellIndex -= 1) {
      const cell = cells[cellIndex]!;
      changed = replaceCellType(tr, cell, targetType) || changed;
      if (cellIndex === 0) {
        const value = index === 0 ? "#" : String(index);
        changed = replaceNumberCell(tr, cell, targetType, value) || changed;
      }
    }
  }
  return changed;
}

function mappedTableFor(
  oldEntry: TableEntry,
  mapping: Mapping,
  newTables: TableEntry[],
): TableEntry | null {
  if (newTables.length === 0) return null;
  // Use the mapped replacement span, rather than a nearest boundary. A
  // deleted table collapses to a point and must never cause its neighbour to
  // inherit numbering maintenance.
  const mappedStart = mapping.map(oldEntry.pos, 1);
  const mappedEnd = mapping.map(oldEntry.pos + oldEntry.node.nodeSize, -1);
  if (mappedEnd <= mappedStart) return null;
  const candidates = newTables.filter((entry) => {
    const end = entry.pos + entry.node.nodeSize;
    return entry.pos < mappedEnd && end > mappedStart;
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const overlap = (entry: TableEntry): number =>
    Math.max(
      0,
      Math.min(mappedEnd, entry.pos + entry.node.nodeSize) -
        Math.max(mappedStart, entry.pos),
    );
  candidates.sort((left, right) => overlap(right) - overlap(left));
  return candidates[0]!;
}

/**
 * Keep an already numbered table's body column sequential after row commands.
 * The plugin intentionally runs only when row count changes and leaves a
 * manually changed nonnumeric first column alone.
 */
export function createTableNumberingPlugin(): Plugin {
  return new Plugin({
    key: tableNumberingPluginKey,
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged))
        return null;
      const oldTables = collectTables(oldState.doc);
      const newTables = collectTables(newState.doc);
      if (oldTables.length === 0 || newTables.length === 0) return null;

      const mapping = new Mapping();
      for (const transaction of transactions)
        mapping.appendMapping(transaction.mapping);

      const targets: TableEntry[] = [];
      const targetPositions = new Set<number>();
      for (const oldEntry of oldTables) {
        if (!isNumberedTable(oldEntry.node)) continue;
        const next = mappedTableFor(oldEntry, mapping, newTables);
        if (
          next &&
          !targetPositions.has(next.pos) &&
          next.node.childCount !== oldEntry.node.childCount &&
          safeNumberColumn(next.node)
        ) {
          targets.push(next);
          targetPositions.add(next.pos);
        }
      }
      if (targets.length === 0) return null;

      const transaction = newState.tr;
      targets
        .sort((a, b) => b.pos - a.pos)
        .forEach((entry) => renumberRows(transaction, entry.pos, entry.node));
      return transaction.steps.length > 0 ? transaction : null;
    },
  });
}
