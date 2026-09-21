import { TableMap, type CellSelection } from "prosemirror-tables";
import { DOMSerializer, Fragment, Node as PMNode } from "prosemirror-model";
import type { Schema } from "prosemirror-model";
import { MAX_CLIPBOARD_TEXT_LENGTH } from "../shared/protocol";

export const TABLE_CLIPBOARD_MIME = "application/x-markdown-mint-table";
export const MAX_CLIPBOARD_CELLS = 10_000;

const MAX_CLIPBOARD_DIMENSION = MAX_CLIPBOARD_CELLS;

export interface TableMatrix {
  values: string[][];
  rows: number;
  columns: number;
  /** ProseMirror JSON is used only for our bounded internal clipboard MIME. */
  cellJson?: unknown[][];
}

export type ClipboardMatrixFailure = "not-a-matrix" | "malformed" | "too-large";

export interface ClipboardMatrixValidation {
  matrix: TableMatrix | null;
  failure: ClipboardMatrixFailure | null;
}

export type ClipboardMatrixParseResult = ClipboardMatrixValidation;

export interface ClipboardPayload {
  internal: string;
  text: string;
  html: string;
}

export type SpreadsheetPasteDetection =
  | {
      kind: "matrix";
      source: "internal" | "tsv" | "html";
      matrix: TableMatrix;
    }
  | {
      kind: "too-large";
      source: "internal" | "tsv" | "html";
    }
  | {
      kind: "single-cell";
      source: "internal" | "html";
      matrix: TableMatrix;
    }
  | { kind: "none" };

function failure(failure: ClipboardMatrixFailure): ClipboardMatrixValidation {
  return { matrix: null, failure };
}

/** Validate and normalize every matrix before it reaches a ProseMirror node. */
export function validateClipboardMatrix(
  input: unknown,
): ClipboardMatrixValidation {
  if (!Array.isArray(input) || input.length === 0) return failure("malformed");
  if (input.length > MAX_CLIPBOARD_DIMENSION) return failure("too-large");

  const values: string[][] = [];
  let columns = 0;
  for (const row of input) {
    if (!Array.isArray(row) || row.length === 0) return failure("malformed");
    if (row.length > MAX_CLIPBOARD_DIMENSION) return failure("too-large");
    if (row.some((cell) => typeof cell !== "string"))
      return failure("malformed");
    const strings = row as string[];
    values.push([...strings]);
    columns = Math.max(columns, strings.length);
  }
  if (columns === 0) return failure("malformed");
  if (values.length > Math.floor(MAX_CLIPBOARD_CELLS / columns))
    return failure("too-large");

  for (const row of values) while (row.length < columns) row.push("");
  return {
    matrix: {
      values,
      rows: values.length,
      columns,
    },
    failure: null,
  };
}

function withCellJson(
  result: ClipboardMatrixValidation,
  value: unknown,
): ClipboardMatrixParseResult {
  if (!result.matrix) return result;
  const cellJson =
    typeof value === "object" && value !== null && "cellJson" in value
      ? (value as { cellJson?: unknown }).cellJson
      : undefined;
  return {
    matrix: {
      ...result.matrix,
      ...(Array.isArray(cellJson) ? { cellJson: cellJson as unknown[][] } : {}),
    },
    failure: null,
  };
}

function parseTsvResult(value: string): ClipboardMatrixParseResult {
  if (
    typeof value !== "string" ||
    (!value.includes("\t") && !value.includes("\n") && !value.includes("\r"))
  )
    return failure("not-a-matrix");
  if (value.length > MAX_CLIPBOARD_TEXT_LENGTH) return failure("too-large");

  const values: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  let fieldStart = true;

  // Keep the parser's intermediate matrix bounded. A new wide row also pads
  // every earlier row, so the prospective rectangular dimensions must be
  // checked before the next field is appended.
  let maxColumns = 0;
  const exceedsCellLimit = (nextColumns: number): boolean => {
    if (nextColumns > MAX_CLIPBOARD_DIMENSION) return true;
    const nextMaxColumns = Math.max(maxColumns, nextColumns);
    const prospectiveRows = values.length + 1;
    return prospectiveRows > Math.floor(MAX_CLIPBOARD_CELLS / nextMaxColumns);
  };

  const pushField = (): ClipboardMatrixParseResult | null => {
    if (exceedsCellLimit(row.length + 1)) return failure("too-large");
    row.push(field);
    return null;
  };

  const pushRow = (): ClipboardMatrixParseResult | null => {
    if (row.length > MAX_CLIPBOARD_DIMENSION) return failure("too-large");
    if (values.length >= MAX_CLIPBOARD_DIMENSION) return failure("too-large");
    maxColumns = Math.max(maxColumns, row.length);
    if (values.length + 1 > Math.floor(MAX_CLIPBOARD_CELLS / maxColumns))
      return failure("too-large");
    values.push(row);
    row = [];
    return null;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (character === '"') {
        if (value[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else field += character;
      continue;
    }

    if (character === '"' && fieldStart) {
      quoted = true;
      quoteClosed = false;
      fieldStart = false;
    } else if (character === "\t") {
      const pushedField = pushField();
      if (pushedField) return pushedField;
      field = "";
      fieldStart = true;
      quoteClosed = false;
    } else if (character === "\n" || character === "\r") {
      const pushedField = pushField();
      if (pushedField) return pushedField;
      const pushed = pushRow();
      if (pushed) return pushed;
      field = "";
      fieldStart = true;
      quoteClosed = false;
      if (character === "\r" && value[index + 1] === "\n") index += 1;
    } else {
      if (quoteClosed) return failure("malformed");
      field += character;
      fieldStart = false;
    }
  }
  if (quoted) return failure("malformed");

  // A final line break already closed the last row. Do not count that
  // terminator as another empty cell or row.
  if (!(row.length === 0 && field === "" && values.length > 0)) {
    const pushedField = pushField();
    if (pushedField) return pushedField;
    const pushed = pushRow();
    if (pushed) return pushed;
  }
  return validateClipboardMatrix(values);
}

export function parseTsvWithStatus(value: string): ClipboardMatrixParseResult {
  return parseTsvResult(value);
}

export function parseTsv(value: string): TableMatrix | null {
  return parseTsvResult(value).matrix;
}

export function hasClipboardTableMarkup(value: string): boolean {
  return /<table(?=[\s/>])/i.test(value);
}

/** Reject obviously oversized HTML before handing it to a DOM parser. */
function hasOversizedHtmlTable(value: string): boolean {
  if (value.length > MAX_CLIPBOARD_TEXT_LENGTH) return true;
  const tags = /<(td|th|tr)\b/gi;
  let rows = 0;
  let cells = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(value))) {
    if (match[1]?.toLowerCase() === "tr") rows += 1;
    else cells += 1;
    if (rows > MAX_CLIPBOARD_CELLS || cells > MAX_CLIPBOARD_CELLS) return true;
  }
  const spans =
    /<(?:td|th)\b[^>]*\s(?:rowspan|colspan)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let span: RegExpExecArray | null;
  while ((span = spans.exec(value))) {
    const raw = (span[1] ?? span[2] ?? span[3] ?? "").trim();
    if (/^\d+$/.test(raw)) {
      const numeric = Number(raw);
      if (!Number.isSafeInteger(numeric) || numeric > MAX_CLIPBOARD_DIMENSION)
        return true;
    }
  }
  return false;
}

type HtmlSpanResult =
  | { span: number; failure: null }
  | { span: null; failure: "malformed" | "too-large" };

function readHtmlSpan(
  cell: Element,
  attribute: "rowspan" | "colspan",
): HtmlSpanResult {
  const raw = cell.getAttribute(attribute);
  if (raw === null) return { span: 1, failure: null };
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) === 0)
    return { span: null, failure: "malformed" };
  const span = Number(normalized);
  if (!Number.isSafeInteger(span) || span > MAX_CLIPBOARD_DIMENSION)
    return { span: null, failure: "too-large" };
  return { span, failure: null };
}

function parseClipboardHtmlResult(value: string): ClipboardMatrixParseResult {
  if (
    typeof value !== "string" ||
    !value ||
    !hasClipboardTableMarkup(value) ||
    typeof DOMParser === "undefined"
  )
    return failure("not-a-matrix");
  if (hasOversizedHtmlTable(value)) return failure("too-large");

  try {
    const parsed = new DOMParser().parseFromString(value, "text/html");
    const table = parsed.querySelector("table");
    if (!table) return failure("not-a-matrix");
    if (table.querySelector("table")) return failure("malformed");
    const extractText = (cell: Element): string => {
      const walker = parsed.createTreeWalker(cell, NodeFilter.SHOW_ALL);
      let output = "";
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (
          node.nodeType === Node.TEXT_NODE &&
          !node.parentElement?.closest("script,style,template")
        )
          output += node.textContent ?? "";
        else if (
          node.nodeType === Node.ELEMENT_NODE &&
          (node as Element).tagName === "BR"
        )
          output += "\n";
      }
      return output;
    };
    const htmlRows = Array.from(table.querySelectorAll("tr")).filter(
      (row) => row.closest("table") === table,
    );
    if (!htmlRows.length) return failure("malformed");
    if (htmlRows.length > MAX_CLIPBOARD_DIMENSION) return failure("too-large");

    // HTML tables are laid out on a logical grid. Keep the occupied positions
    // explicit so a later cell cannot slide left through a rowspan/colspan.
    const grid: Array<Array<string | undefined>> = Array.from(
      { length: htmlRows.length },
      () => [],
    );
    let columns = 0;
    for (const [rowIndex, row] of htmlRows.entries()) {
      const cells = Array.from(row.children).filter(
        (child): child is HTMLTableCellElement =>
          child.tagName === "TH" || child.tagName === "TD",
      );
      if (!cells.length) return failure("malformed");

      const currentRow = grid[rowIndex];
      if (!currentRow) return failure("malformed");
      let column = 0;
      for (const cell of cells) {
        const rowSpan = readHtmlSpan(cell, "rowspan");
        if (rowSpan.failure) return failure(rowSpan.failure);
        const columnSpan = readHtmlSpan(cell, "colspan");
        if (columnSpan.failure) return failure(columnSpan.failure);

        const spanColumns = columnSpan.span;
        const spanRows = rowSpan.span;
        if (!spanColumns || !spanRows) return failure("malformed");

        // Find the first contiguous range that is free in this row. Existing
        // entries here are reservations created by rowspans from earlier rows.
        while (true) {
          while (currentRow[column] !== undefined) column += 1;
          const endColumn = column + spanColumns;
          if (endColumn > MAX_CLIPBOARD_DIMENSION) return failure("too-large");
          const occupied = currentRow.findIndex(
            (entry, index) =>
              index >= column && index < endColumn && entry !== undefined,
          );
          if (occupied < 0) break;
          column = occupied + 1;
        }

        const endColumn = column + spanColumns;
        columns = Math.max(columns, endColumn);
        if (htmlRows.length > Math.floor(MAX_CLIPBOARD_CELLS / columns))
          return failure("too-large");

        const endRow = Math.min(htmlRows.length, rowIndex + spanRows);
        const text = extractText(cell);
        for (let targetRow = rowIndex; targetRow < endRow; targetRow += 1) {
          for (
            let targetColumn = column;
            targetColumn < endColumn;
            targetColumn += 1
          ) {
            const target = grid[targetRow];
            if (!target) return failure("malformed");
            target[targetColumn] =
              targetRow === rowIndex && targetColumn === column ? text : "";
          }
        }
        column = endColumn;
      }
    }

    const values = grid.map((row) =>
      Array.from({ length: columns }, (_, column) => row[column] ?? ""),
    );
    return validateClipboardMatrix(values);
  } catch {
    return failure("malformed");
  }
}

export function parseClipboardHtmlWithStatus(
  value: string,
): ClipboardMatrixParseResult {
  return parseClipboardHtmlResult(value);
}

export function parseClipboardHtml(value: string): TableMatrix | null {
  return parseClipboardHtmlResult(value).matrix;
}

function parseInternalMatrixResult(value: string): ClipboardMatrixParseResult {
  if (typeof value !== "string" || !value) return failure("not-a-matrix");
  if (value.length > MAX_CLIPBOARD_TEXT_LENGTH) return failure("too-large");
  try {
    const parsed = JSON.parse(value) as {
      values?: unknown;
      cellJson?: unknown;
    };
    const result = validateClipboardMatrix(parsed.values);
    return withCellJson(result, parsed);
  } catch {
    return failure("malformed");
  }
}

export function parseInternalMatrixWithStatus(
  value: string,
): ClipboardMatrixParseResult {
  return parseInternalMatrixResult(value);
}

export function parseInternalMatrix(value: string): TableMatrix | null {
  return parseInternalMatrixResult(value).matrix;
}

function hasAtLeastTwoCells(matrix: TableMatrix): boolean {
  return matrix.rows * matrix.columns >= 2;
}

/** Select table-shaped clipboard data in the outside-table priority order. */
export function detectSpreadsheetPaste(
  payload: ClipboardPayload,
): SpreadsheetPasteDetection {
  let singleCell: Extract<
    SpreadsheetPasteDetection,
    { kind: "single-cell" }
  > | null = null;
  const internal = parseInternalMatrixResult(payload.internal);
  if (internal.failure === "too-large")
    return { kind: "too-large", source: "internal" };
  if (internal.matrix && hasAtLeastTwoCells(internal.matrix))
    return { kind: "matrix", source: "internal", matrix: internal.matrix };
  if (internal.matrix)
    singleCell = {
      kind: "single-cell",
      source: "internal",
      matrix: internal.matrix,
    };

  const tsv = payload.text.includes("\t")
    ? parseTsvResult(payload.text)
    : failure("not-a-matrix");
  if (tsv.failure === "too-large") return { kind: "too-large", source: "tsv" };
  if (tsv.matrix && hasAtLeastTwoCells(tsv.matrix))
    return { kind: "matrix", source: "tsv", matrix: tsv.matrix };

  const html = hasClipboardTableMarkup(payload.html)
    ? parseClipboardHtmlResult(payload.html)
    : failure("not-a-matrix");
  if (html.failure === "too-large")
    return { kind: "too-large", source: "html" };
  if (html.matrix && hasAtLeastTwoCells(html.matrix))
    return { kind: "matrix", source: "html", matrix: html.matrix };
  if (html.matrix && !singleCell)
    singleCell = { kind: "single-cell", source: "html", matrix: html.matrix };

  return singleCell ?? { kind: "none" };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function matrixToTsv(matrix: TableMatrix): string {
  const quote = (cell: string) =>
    /[\t\n\r"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  return matrix.values.map((row) => row.map(quote).join("\t")).join("\n");
}

export function matrixToHtml(matrix: TableMatrix, schema: Schema): string {
  const serializer = DOMSerializer.fromSchema(schema);
  return `<table><tbody>${matrix.values
    .map(
      (row, rowIndex) =>
        `<tr>${row
          .map((cell, columnIndex) => {
            const json = matrix.cellJson?.[rowIndex]?.[columnIndex];
            try {
              if (json) {
                const cellNode: PMNode = PMNode.fromJSON(schema, json);
                const holder = document.createElement("div");
                holder.appendChild(
                  serializer.serializeFragment(cellNode.content),
                );
                return `<td>${holder.innerHTML}</td>`;
              }
            } catch {
              // The plain text fallback below is the safe behavior for stale data.
            }
            return `<td>${escapeHtml(cell).replace(/\r\n|\r|\n/g, "<br>")}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

function safeCellContent(schema: Schema, cell: PMNode, text: string): PMNode {
  const paragraphType = schema.nodes.paragraph;
  if (!paragraphType) return cell;
  try {
    const hardBreak = schema.nodes.hard_break;
    const normalized = text.replace(/\r\n?/g, "\n");
    const inlineNodes: PMNode[] = [];
    normalized.split("\n").forEach((line, index, lines) => {
      if (line) inlineNodes.push(schema.text(line));
      if (index < lines.length - 1 && hardBreak)
        inlineNodes.push(hardBreak.create());
    });
    const paragraph = paragraphType.create(
      null,
      inlineNodes.length ? Fragment.fromArray(inlineNodes) : undefined,
    );
    return cell.type.create(cell.attrs, paragraph);
  } catch {
    return cell.type.create(cell.attrs, paragraphType.create());
  }
}

export function cellFromClipboard(
  schema: Schema,
  target: PMNode,
  text: string,
  json: unknown,
): PMNode {
  try {
    if (json && typeof json === "object") {
      const candidate = PMNode.fromJSON(schema, json);
      const role = candidate.type.spec.tableRole;
      if (role === "cell" || role === "header_cell")
        return target.type.create(target.attrs, candidate.content);
    }
  } catch {
    // Clipboard data is untrusted. Fall through to a text-only cell.
  }
  return safeCellContent(schema, target, text);
}

/** Create an empty table; callers apply any UI-specific dimension policy. */
export function createEmptyTableNode(
  schema: Schema,
  columns: number,
  rows: number,
): PMNode | null {
  const table = schema.nodes.table;
  const row = schema.nodes.table_row;
  const cell = schema.nodes.table_cell;
  const header = schema.nodes.table_header ?? cell;
  const paragraph = schema.nodes.paragraph;
  if (!table || !row || !cell || !header || !paragraph) return null;
  const makeCells = (type: typeof cell): PMNode[] =>
    Array.from({ length: columns }, () =>
      type.create(null, paragraph.create()),
    );
  return table.create(null, [
    row.create(null, makeCells(header)),
    ...Array.from({ length: rows - 1 }, () =>
      row.create(null, makeCells(cell)),
    ),
  ]);
}

/** Convert a validated clipboard matrix into a header-first Markdown table. */
export function createTableNodeFromMatrix(
  schema: Schema,
  input: TableMatrix,
): PMNode | null {
  const validated = validateClipboardMatrix(input.values).matrix;
  if (!validated) return null;
  const table = schema.nodes.table;
  const row = schema.nodes.table_row;
  const cell = schema.nodes.table_cell;
  const header = schema.nodes.table_header ?? cell;
  const paragraph = schema.nodes.paragraph;
  if (!table || !row || !cell || !header || !paragraph) return null;

  try {
    const rows = validated.values.map((values, rowIndex) => {
      const cellType = rowIndex === 0 ? header : cell;
      const cells = values.map((text, columnIndex) => {
        const target = cellType.create(null, paragraph.create());
        return cellFromClipboard(
          schema,
          target,
          text,
          input.cellJson?.[rowIndex]?.[columnIndex],
        );
      });
      return row.create(null, Fragment.fromArray(cells));
    });
    return table.create(null, Fragment.fromArray(rows));
  } catch {
    return null;
  }
}

/** Return only the text and cell JSON for a rectangular table selection. */
export function tableSelectionMatrix(
  selection: CellSelection,
): TableMatrix | null {
  const $anchorCell = selection.$anchorCell;
  const table = $anchorCell.node(-1);
  if (!table || table.type.spec.tableRole !== "table") return null;
  const tableStart = $anchorCell.start(-1);
  const map = TableMap.get(table);
  const anchor = map.findCell(selection.$anchorCell.pos - tableStart);
  const head = map.findCell(selection.$headCell.pos - tableStart);
  const rect = {
    top: Math.min(anchor.top, head.top),
    left: Math.min(anchor.left, head.left),
    bottom: Math.max(anchor.bottom, head.bottom),
    right: Math.max(anchor.right, head.right),
  };
  const cellText = (cell: PMNode): string =>
    cell.textBetween(0, cell.content.size, "\n", "\n").replace(/\u00a0/g, " ");
  const values: string[][] = [];
  const cellJson: unknown[][] = [];
  for (let row = rect.top; row < rect.bottom; row += 1) {
    const line: string[] = [];
    const jsonLine: unknown[] = [];
    for (let column = rect.left; column < rect.right; column += 1) {
      const pos = map.positionAt(row, column, table);
      const cell = table.nodeAt(pos);
      line.push(cell ? cellText(cell) : "");
      jsonLine.push(cell?.toJSON() ?? null);
    }
    values.push(line);
    cellJson.push(jsonLine);
  }
  return {
    values,
    rows: values.length,
    columns: values[0]?.length ?? 0,
    cellJson,
  };
}
