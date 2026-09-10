import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  goToNextCell,
  isInTable,
  tableEditing,
  TableMap,
} from "prosemirror-tables";
import { baseKeymap, chainCommands, exitCode } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { DOMSerializer, Fragment, Node as PMNode } from "prosemirror-model";
import type { Schema } from "prosemirror-model";
import {
  EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { ViewMutationRecord } from "prosemirror-view";
import {
  liftListItem,
  sinkListItem,
  splitListItem,
  wrapInList,
} from "prosemirror-schema-list";
import {
  isHostMessage,
  PROTOCOL_VERSION,
  type PreviewMessage as HostPreviewMessage,
  type PreviewTypography,
  type SaveResultMessage,
} from "../shared/protocol";

export type DocumentProfile = "github" | "gitlab" | "commonmark";
export type EditorMode = "rich" | "preview" | "source";

export interface VSCodeApiLike {
  postMessage(message: unknown): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

export interface ParseResult {
  doc: PMNode;
  source?: unknown;
  snapshot?: unknown;
}

export interface CompatibilityIssue {
  message: string;
  level?: "warning" | "error" | "info";
  line?: number;
  feature?: string;
}

export interface CoreBridge {
  schema: Schema;
  parseMarkdown(source: string, profile: DocumentProfile): ParseResult;
  serializeMarkdown(doc: PMNode, previousSnapshot?: unknown): string;
  renderMarkdown(source: string, profile: DocumentProfile): string;
  inspectCompatibility?(
    source: string,
    profile: DocumentProfile,
  ): CompatibilityIssue[] | { issues?: CompatibilityIssue[] };
  formatMarkdown?(
    source: string,
    options?: Record<string, unknown>,
  ):
    | string
    | Promise<string>
    | { markdown?: string; source?: string }
    | Promise<{ markdown?: string; source?: string }>;
}

export interface EditorInitialDocument {
  markdown: string;
  version: number;
  profile: DocumentProfile;
  operationId?: string;
  reason?: string;
  resourceBaseUrl?: string;
  typography?: PreviewTypography;
  mode?: "editor" | "preview";
}

export interface DocumentMessage extends EditorInitialDocument {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: "document";
  typography?: PreviewTypography;
}

export interface SyncMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: "edit";
  baseVersion: number;
  operationId: string;
  markdown: string;
}

export interface EditorAppOptions {
  root: HTMLElement;
  vscode?: VSCodeApiLike;
  core: CoreBridge;
  initialDocument?: EditorInitialDocument;
  initialMode?: EditorMode;
  /** Set to false only for tiny embedders which already provide host undo. */
  hostUndo?: boolean;
}

interface RecoveryState {
  recoveryDraft?: string;
  recoveryVersion?: number;
  recoveryProfile?: DocumentProfile;
  recoveryTimestamp?: number;
}

export interface PendingEdit {
  operationId: string;
  baseVersion: number;
  markdown: string;
}

export interface TableMatrix {
  values: string[][];
  rows: number;
  columns: number;
  /** ProseMirror JSON is used only for our bounded internal clipboard MIME. */
  cellJson?: unknown[][];
}

interface SavedSelection {
  from: number;
  to: number;
}

const TABLE_CLIPBOARD_MIME = "application/x-markdown-weaver-table";
const MAX_CLIPBOARD_CELLS = 10_000;

const editorPluginKey = new PluginKey("markdown-weaver-editor");

function newOperationId(): string {
  const cryptoApi = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `mw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isMac(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolveDisplayUrl(source: string, base: string | undefined): string {
  if (!base || !source || source.startsWith("#")) return source;
  try {
    return new URL(source, base).toString();
  } catch {
    // The host supplies the base URI, but a malformed URI must never prevent
    // the document itself from being displayed.
    return source;
  }
}

function normalizeIssues(
  value: CompatibilityIssue[] | { issues?: CompatibilityIssue[] } | undefined,
): CompatibilityIssue[] {
  if (!value) return [];
  return Array.isArray(value) ? value : (value.issues ?? []);
}

function getCellSelection(selection: Selection): CellSelection | null {
  return selection instanceof CellSelection ? selection : null;
}

function selectedTableRect(selection: CellSelection): {
  table: PMNode;
  map: TableMap;
  tableStart: number;
  rect: { top: number; left: number; bottom: number; right: number };
} | null {
  const $anchorCell = selection.$anchorCell;
  const table = $anchorCell.node(-1);
  if (!table || table.type.spec.tableRole !== "table") return null;
  const tableStart = $anchorCell.start(-1);
  const map = TableMap.get(table);
  const anchor = map.findCell(selection.$anchorCell.pos - tableStart);
  const head = map.findCell(selection.$headCell.pos - tableStart);
  return {
    table,
    map,
    tableStart,
    rect: {
      top: Math.min(anchor.top, head.top),
      left: Math.min(anchor.left, head.left),
      bottom: Math.max(anchor.bottom, head.bottom),
      right: Math.max(anchor.right, head.right),
    },
  };
}

interface TableContext {
  table: PMNode;
  map: TableMap;
  tableStart: number;
  rect: { top: number; left: number; bottom: number; right: number };
  cellSelection: boolean;
}

/** Resolve both a CellSelection and an ordinary text cursor inside a cell. */
function tableContext(selection: Selection): TableContext | null {
  if (selection instanceof CellSelection) {
    const selected = selectedTableRect(selection);
    return selected ? { ...selected, cellSelection: true } : null;
  }
  const $from = selection.$from;
  let cellDepth = -1;
  let tableDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    const role = node.type.spec.tableRole;
    if (cellDepth < 0 && (role === "cell" || role === "header_cell"))
      cellDepth = depth;
    if (role === "table") {
      tableDepth = depth;
      break;
    }
  }
  if (cellDepth < 0 || tableDepth < 0) return null;
  const table = $from.node(tableDepth);
  const tableStart = $from.start(tableDepth);
  const map = TableMap.get(table);
  const cellPos = $from.before(cellDepth);
  const cellRect = map.findCell(cellPos - tableStart);
  return {
    table,
    map,
    tableStart,
    rect: {
      top: cellRect.top,
      left: cellRect.left,
      bottom: cellRect.bottom,
      right: cellRect.right,
    },
    cellSelection: false,
  };
}

function selectionForDocument(selection: Selection, doc: PMNode): Selection {
  if (selection instanceof CellSelection) {
    try {
      return CellSelection.create(
        doc,
        selection.$anchorCell.pos,
        selection.$headCell.pos,
      );
    } catch {
      // The table may have changed shape. Fall back to the nearest text cursor
      // rather than resetting the user to the beginning of the document.
    }
  }
  const max = Math.max(1, doc.content.size - 1);
  const from = Math.max(0, Math.min(selection.from, doc.content.size));
  const to = Math.max(0, Math.min(selection.to, doc.content.size));
  try {
    // `TextSelection.create` accepts positions resolved directly inside a
    // changed block structure. `between` walks to the nearest valid inline
    // content position, which prevents Enter from trying to split a list node
    // itself after an external reparse.
    return TextSelection.between(doc.resolve(from), doc.resolve(to), 1);
  } catch {
    return Selection.near(doc.resolve(Math.min(from, max)), 1);
  }
}

function cellText(cell: PMNode): string {
  // textBetween keeps hard breaks as newlines while still returning a useful
  // plain-text representation for the system clipboard.
  return cell
    .textBetween(0, cell.content.size, "\n", "\n")
    .replace(/\u00a0/g, " ");
}

function tableSelectionMatrix(selection: CellSelection): TableMatrix | null {
  const selected = selectedTableRect(selection);
  if (!selected) return null;
  const { table, map, rect, tableStart } = selected;
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
  // Keep the values even when the selected table is empty. `tableStart` is
  // intentionally read above to make this helper fail early for malformed
  // selections in a way that is easy to diagnose in browser tests.
  void tableStart;
  return {
    values,
    rows: values.length,
    columns: values[0]?.length ?? 0,
    cellJson,
  };
}

function matrixToTsv(matrix: TableMatrix): string {
  const quote = (cell: string) =>
    /[\t\n\r"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  return matrix.values.map((row) => row.map(quote).join("\t")).join("\n");
}

function matrixToHtml(matrix: TableMatrix, schema: Schema): string {
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
            return `<td>${escapeHtml(cell).replace(/\n/g, "<br>")}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

function parseTsv(value: string): TableMatrix | null {
  if (!value.includes("\t") && !value.includes("\n") && !value.includes("\r"))
    return null;
  const values: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === "\t") {
      row.push(field);
      field = "";
    } else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      row.push(field);
      values.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field);
  // Clipboard implementations append a final newline. It does not represent
  // an additional row, while an intentionally blank middle row does.
  if (!(row.length === 1 && row[0] === "" && values.length > 0))
    values.push(row);
  const columns = Math.max(0, ...values.map((row) => row.length));
  for (const row of values) while (row.length < columns) row.push("");
  return { values, rows: values.length, columns };
}

function parseClipboardHtml(value: string): TableMatrix | null {
  if (!value || typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(value, "text/html");
  const table = parsed.querySelector("table");
  if (!table) return null;
  const extractText = (cell: Element): string => {
    const walker = parsed.createTreeWalker(cell, NodeFilter.SHOW_ALL);
    let output = "";
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) output += node.textContent ?? "";
      else if (
        node.nodeType === Node.ELEMENT_NODE &&
        (node as Element).tagName === "BR"
      )
        output += "\n";
    }
    return output;
  };
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.querySelectorAll(":scope > th, :scope > td")).map((cell) =>
      extractText(cell),
    ),
  );
  if (!rows.length) return null;
  const columns = Math.max(0, ...rows.map((row) => row.length));
  for (const row of rows) while (row.length < columns) row.push("");
  return { values: rows, rows: rows.length, columns };
}

function parseInternalMatrix(value: string): TableMatrix | null {
  if (!value || value.length > 2_000_000) return null;
  try {
    const parsed = JSON.parse(value) as {
      values?: unknown;
      cellJson?: unknown;
    };
    if (
      !Array.isArray(parsed.values) ||
      parsed.values.length === 0 ||
      parsed.values.length > MAX_CLIPBOARD_CELLS
    )
      return null;
    const values = parsed.values.map((row) =>
      Array.isArray(row)
        ? row.map((cell) => (typeof cell === "string" ? cell : ""))
        : null,
    );
    if (
      values.some(
        (row) => !row || row.length === 0 || row.length > MAX_CLIPBOARD_CELLS,
      )
    )
      return null;
    const rows = values as string[][];
    const columns = Math.max(...rows.map((row) => row.length));
    if (rows.length * columns > MAX_CLIPBOARD_CELLS) return null;
    for (const row of rows) while (row.length < columns) row.push("");
    const result: TableMatrix = { values: rows, rows: rows.length, columns };
    if (Array.isArray(parsed.cellJson))
      result.cellJson = parsed.cellJson as unknown[][];
    return result;
  } catch {
    return null;
  }
}

function safeCellContent(schema: Schema, cell: PMNode, text: string): PMNode {
  const paragraphType = schema.nodes.paragraph;
  if (!paragraphType) return cell;
  const paragraph = paragraphType.create(
    null,
    text ? schema.text(text) : undefined,
  );
  return cell.type.create(cell.attrs, paragraph);
}

function cellFromClipboard(
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

function replaceTableCells(
  table: PMNode,
  schema: Schema,
  top: number,
  left: number,
  values: string[][],
  cellJson?: unknown[][],
): PMNode {
  const rowType = table.type.schema.nodes.table_row;
  const paragraphType = table.type.schema.nodes.paragraph;
  const defaultCellType = table.type.schema.nodes.table_cell;
  const headerCellType =
    table.type.schema.nodes.table_header ?? defaultCellType;
  if (!rowType || !paragraphType || !defaultCellType || !headerCellType)
    return table;
  const requiredRows = top + values.length;
  const requiredColumns =
    left + Math.max(0, ...values.map((row) => row.length));
  const rows: PMNode[] = [];
  const newCell = (rowIndex: number): PMNode =>
    (rowIndex === 0 ? headerCellType : defaultCellType).create(
      null,
      paragraphType.create(),
    );
  const normalizeCell = (
    cell: PMNode | undefined,
    rowIndex: number,
  ): PMNode => {
    const type = rowIndex === 0 ? headerCellType : defaultCellType;
    return cell && cell.type === type
      ? cell
      : type.create(
          cell?.attrs ?? null,
          cell?.content ?? paragraphType.create(),
        );
  };
  for (
    let rowIndex = 0;
    rowIndex < Math.max(table.childCount, requiredRows);
    rowIndex += 1
  ) {
    const current =
      rowIndex < table.childCount
        ? table.child(rowIndex)
        : rowType.create(
            null,
            Array.from({ length: Math.max(requiredColumns, 1) }, () =>
              newCell(rowIndex),
            ),
          );
    const cells: PMNode[] = [];
    for (
      let columnIndex = 0;
      columnIndex < Math.max(current.childCount, requiredColumns);
      columnIndex += 1
    )
      cells.push(
        normalizeCell(
          columnIndex < current.childCount
            ? current.child(columnIndex)
            : undefined,
          rowIndex,
        ),
      );
    const valuesRow = values[rowIndex - top];
    if (valuesRow) {
      for (
        let columnIndex = 0;
        columnIndex < valuesRow.length;
        columnIndex += 1
      ) {
        const target = cells[left + columnIndex] ?? newCell(rowIndex);
        cells[left + columnIndex] = cellFromClipboard(
          schema,
          target,
          valuesRow[columnIndex] ?? "",
          cellJson?.[rowIndex - top]?.[columnIndex],
        );
      }
    }
    const rowNode = current.type.create(
      current.attrs,
      Fragment.fromArray(cells),
    );
    rows.push(rowNode);
  }
  return table.copy(Fragment.fromArray(rows));
}

function commandForMark(markName: string, schema: Schema) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const mark = schema.marks[markName];
    if (!mark) return false;
    const { from, to, empty } = state.selection;
    const active = empty
      ? Boolean(
          mark.isInSet(state.storedMarks || state.doc.resolve(from).marks()),
        )
      : state.doc.rangeHasMark(from, to, mark.create());
    if (dispatch) {
      if (active) dispatch(state.tr.removeMark(from, to, mark));
      else dispatch(state.tr.addMark(from, to, mark.create()));
    }
    return true;
  };
}

function insertHardBreak(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const hardBreak = state.schema.nodes.hard_break;
  if (!hardBreak) return false;
  if (dispatch)
    dispatch(
      state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView(),
    );
  return true;
}

function commandForBlock(typeName: string, attrs?: Record<string, unknown>) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const type = state.schema.nodes[typeName];
    if (!type) return false;
    if (dispatch)
      dispatch(
        state.tr.setBlockType(
          state.selection.from,
          state.selection.to,
          type,
          attrs,
        ),
      );
    return true;
  };
}

function makeElement(
  tag: string,
  attrs: Record<string, string> = {},
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs))
    element.setAttribute(name, value);
  return element;
}

class TaskItemNodeView {
  readonly dom: HTMLLIElement;
  readonly contentDOM: HTMLElement;
  private readonly checkbox: HTMLInputElement;
  private readonly control: HTMLElement;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ) {
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement("li");
    this.dom.className = "mw-task-item";
    const control = document.createElement("span");
    this.control = control;
    control.className = "mw-task-control";
    this.checkbox = document.createElement("input");
    this.checkbox.type = "checkbox";
    this.checkbox.className = "mw-task-checkbox";
    this.checkbox.checked = node.attrs.checked === true;
    const isTask = node.attrs.checked != null;
    this.dom.classList.toggle("mw-task-task", isTask);
    if (!isTask) {
      control.hidden = true;
      this.dom.classList.add("mw-plain-list-item");
    }
    this.checkbox.setAttribute(
      "aria-label",
      this.checkbox.checked ? "Mark task incomplete" : "Mark task complete",
    );
    this.checkbox.addEventListener("mousedown", (event) =>
      event.stopPropagation(),
    );
    this.checkbox.addEventListener("change", () => {
      const position = this.getPos();
      if (position === undefined) return;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(position, undefined, {
          ...node.attrs,
          checked: this.checkbox.checked,
        }),
      );
    });
    control.append(this.checkbox);
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "mw-task-content";
    this.dom.append(control, this.contentDOM);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "list_item") return false;
    this.checkbox.checked = node.attrs.checked === true;
    const isTask = node.attrs.checked != null;
    this.dom.classList.toggle("mw-task-task", isTask);
    this.dom.classList.toggle("mw-plain-list-item", !isTask);
    this.control.hidden = !isTask;
    this.checkbox.setAttribute(
      "aria-label",
      this.checkbox.checked ? "Mark task incomplete" : "Mark task complete",
    );
    return true;
  }
}

class ImageNodeView {
  readonly dom: HTMLImageElement;
  private readonly resolveBase: () => string | undefined;

  constructor(node: PMNode, resolveBase: () => string | undefined) {
    this.dom = document.createElement("img");
    this.dom.draggable = true;
    this.resolveBase = resolveBase;
    this.update(node);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "image") return false;
    const source = String(node.attrs.src ?? "");
    const displaySource = safeImageSource(source)
      ? resolveDisplayUrl(source, this.resolveBase())
      : "";
    if (displaySource) this.dom.setAttribute("src", displaySource);
    else this.dom.removeAttribute("src");
    this.dom.alt = String(node.attrs.alt ?? "");
    if (node.attrs.title) this.dom.title = String(node.attrs.title);
    else this.dom.removeAttribute("title");
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type === "attributes" && mutation.attributeName === "src";
  }
}

function safeImageSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/)?.[1];
  if (!scheme) return true;
  if (scheme === "http" || scheme === "https") return true;
  if (scheme === "vscode-resource" || scheme === "vscode-webview-resource")
    return true;
  return /^data:image\/(?:gif|png|jpeg|jpg|webp);base64,[a-z0-9+/=]+$/i.test(
    source,
  );
}

export class SyncController {
  private baseVersion: number;
  private pending: PendingEdit | null = null;
  private queued: PendingEdit | null = null;
  private readonly vscode: VSCodeApiLike | undefined;
  private readonly onStatus: (status: "saved" | "pending" | "conflict") => void;
  private readonly onConflict: (message: string) => void;

  constructor(
    version: number,
    vscode: VSCodeApiLike | undefined,
    onStatus: SyncController["onStatus"],
    onConflict: SyncController["onConflict"],
  ) {
    this.baseVersion = version;
    this.vscode = vscode;
    this.onStatus = onStatus;
    this.onConflict = onConflict;
  }

  get version(): number {
    return this.baseVersion;
  }

  get inflight(): PendingEdit | null {
    return this.pending;
  }

  get queuedEdit(): PendingEdit | null {
    return this.queued;
  }

  get hasPending(): boolean {
    return this.pending !== null || this.queued !== null;
  }

  setVersion(version: number): void {
    this.baseVersion = version;
  }

  enqueue(markdown: string): PendingEdit {
    const edit: PendingEdit = {
      markdown,
      baseVersion: this.baseVersion,
      operationId: newOperationId(),
    };
    if (this.pending) {
      this.queued = edit;
      this.onStatus("pending");
      return edit;
    }
    this.pending = edit;
    this.post(edit);
    return edit;
  }

  private post(edit: PendingEdit): void {
    const message: SyncMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "edit",
      baseVersion: edit.baseVersion,
      operationId: edit.operationId,
      markdown: edit.markdown,
    };
    this.vscode?.postMessage(message);
    this.onStatus("pending");
  }

  reject(operationId: string, version?: number): boolean {
    if (!this.pending || this.pending.operationId !== operationId) return false;
    this.pending = null;
    this.queued = null;
    if (typeof version === "number")
      this.baseVersion = Math.max(this.baseVersion, version);
    this.onStatus("conflict");
    return true;
  }

  acknowledge(
    operationId: string | undefined,
    version?: number,
    markdown?: string,
    options: { pauseQueue?: boolean } = {},
  ): boolean {
    if (
      !this.pending ||
      !operationId ||
      operationId !== this.pending.operationId
    )
      return false;
    this.pending = null;
    if (typeof version === "number")
      this.baseVersion = Math.max(this.baseVersion, version);
    if (this.queued && !options.pauseQueue) {
      const queued = this.queued;
      this.queued = null;
      queued.baseVersion = this.baseVersion;
      this.pending = queued;
      this.post(queued);
    } else if (this.queued && options.pauseQueue) {
      this.onStatus("conflict");
    } else {
      this.onStatus("saved");
    }
    void markdown;
    return true;
  }

  markExternalConflict(message: string): void {
    if (!this.pending && !this.queued) return;
    this.onStatus("conflict");
    this.onConflict(message);
  }

  clear(): void {
    this.pending = null;
    this.queued = null;
    this.onStatus("saved");
  }
}

export class MarkdownEditorApp {
  readonly root: HTMLElement;
  readonly vscode: VSCodeApiLike | undefined;
  readonly core: CoreBridge;
  readonly options: EditorAppOptions;
  readonly schema: Schema;
  view: EditorView;
  mode: EditorMode;
  profile: DocumentProfile;
  version: number;
  operationId: string | undefined;
  resourceBaseUrl: string | undefined;
  previousSnapshot?: unknown;
  private pendingExternal: DocumentMessage | null = null;
  private composing = false;
  private conflict = false;
  private dirty = false;
  private parseError: string | null = null;
  private preservedSource: string | null = null;
  private deferredHostCommand:
    "undo" | "redo" | "format" | "preview" | "source" | "save" | null = null;
  private initialized: boolean;
  private previewOnly = false;
  private syncPaused = false;
  private reloadRequested = false;
  private formatting = false;
  private pendingSaveOperationId: string | undefined;
  private lastValidMarkdown = "";
  private readonly compatibilityEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private readonly sourceEl: HTMLTextAreaElement;
  private readonly recoverButton: HTMLButtonElement;
  private readonly modes = new Map<EditorMode, HTMLButtonElement>();
  readonly sync: SyncController;
  private readonly messageHandler: (event: MessageEvent) => void;
  private savedSelection: SavedSelection | null = null;
  private linkDialog!: HTMLDialogElement;
  private linkUrlInput!: HTMLInputElement;
  private linkTextInput!: HTMLInputElement;
  private imageDialog!: HTMLDialogElement;
  private imageUrlInput!: HTMLInputElement;
  private imageAltInput!: HTMLInputElement;
  private codeLanguageInput!: HTMLInputElement;
  private recoveryDialog!: HTMLDialogElement;
  private recoveryText!: HTMLTextAreaElement;
  private pendingRecoveryOperationId: string | undefined;

  constructor(options: EditorAppOptions) {
    this.root = options.root;
    this.vscode = options.vscode;
    this.core = options.core;
    this.options = { ...options, hostUndo: options.hostUndo ?? true };
    this.schema = options.core.schema;
    this.initialized = Boolean(options.initialDocument);
    const initial = options.initialDocument ?? {
      markdown: "",
      version: 1,
      profile: "github" as DocumentProfile,
    };
    this.mode =
      options.initialMode ?? (initial.mode === "preview" ? "preview" : "rich");
    this.profile = initial.profile;
    this.lastValidMarkdown = initial.markdown;
    this.version = initial.version;
    this.operationId = initial.operationId;
    this.resourceBaseUrl = initial.resourceBaseUrl;
    this.applyTypography(initial.typography);
    this.root.replaceChildren();
    this.root.classList.add("markdown-weaver-app");
    const toolbar = this.buildToolbar();
    this.root.append(toolbar);
    const stage = makeElement("main", { class: "mw-stage" });
    const richPanel = makeElement("section", {
      class: "mw-panel mw-rich-panel",
      "data-panel": "rich",
      "aria-label": "Rich editor",
    });
    const editorMount = makeElement("div", {
      class: "mw-editor-mount",
      "data-testid": "editor-mount",
    });
    richPanel.append(editorMount);
    const previewPanel = makeElement("section", {
      class: "mw-panel mw-preview-panel",
      "data-panel": "preview",
      "aria-label": "Markdown preview",
      hidden: "true",
    });
    this.previewEl = makeElement("article", {
      class: "markdown-body mw-document-content",
      "data-testid": "preview-content",
    });
    previewPanel.append(this.previewEl);
    const sourcePanel = makeElement("section", {
      class: "mw-panel mw-source-panel",
      "data-panel": "source",
      "aria-label": "Markdown source",
      hidden: "true",
    });
    this.sourceEl = document.createElement("textarea");
    this.sourceEl.className = "mw-source-textarea";
    this.sourceEl.setAttribute("spellcheck", "false");
    this.sourceEl.readOnly = true;
    this.sourceEl.setAttribute("aria-label", "Markdown source");
    sourcePanel.append(this.sourceEl);
    stage.append(richPanel, previewPanel, sourcePanel);
    this.root.append(stage);
    const footer = makeElement("footer", { class: "mw-statusbar" });
    this.statusEl = makeElement("span", {
      class: "mw-status",
      role: "status",
      "data-testid": "status",
    });
    this.compatibilityEl = makeElement("span", {
      class: "mw-compatibility",
      role: "status",
      "data-testid": "compatibility",
    });
    this.recoverButton = makeElement("button", {
      type: "button",
      class: "mw-recover",
      hidden: "true",
    }) as HTMLButtonElement;
    this.recoverButton.textContent = "Recover draft";
    this.recoverButton.addEventListener("click", () =>
      this.openRecoveryDialog(),
    );
    footer.append(this.statusEl, this.compatibilityEl, this.recoverButton);
    this.root.append(footer);
    this.buildRecoveryDialog();

    this.view = new EditorView(editorMount, {
      state: this.createState(initial.markdown),
      dispatchTransaction: (tr) => this.dispatchTransaction(tr),
      attributes: {
        class: "ProseMirror mw-document-content",
        spellcheck: "true",
        "data-testid": "rich-editor",
      },
      nodeViews: {
        list_item: (node, view, getPos) =>
          new TaskItemNodeView(node, view, getPos),
        image: (node) => new ImageNodeView(node, () => this.resourceBaseUrl),
      },
      handleDOMEvents: {
        compositionstart: () => {
          this.composing = true;
          return false;
        },
        compositionend: () => {
          this.composing = false;
          this.flushExternalAfterComposition();
          this.flushDeferredHostCommand();
          return false;
        },
        copy: (view, event) => this.handleCopy(view, event as ClipboardEvent),
        cut: (view, event) => this.handleCut(view, event as ClipboardEvent),
        paste: (view, event) => this.handlePaste(view, event as ClipboardEvent),
      },
    });
    if (this.parseError || !this.initialized) {
      this.view.setProps({ editable: () => false });
      this.statusEl.textContent = this.parseError
        ? `Read-only: ${this.parseError}`
        : "Loading document…";
    }
    this.sync = new SyncController(
      this.version,
      this.vscode,
      (status) => this.setSyncStatus(status),
      (message) => this.setConflict(message),
    );
    this.messageHandler = (event) => this.handleMessage(event.data);
    window.addEventListener("message", this.messageHandler);
    this.sourceEl.addEventListener("input", () => {
      // Source is intentionally owned by the host. Keep this event for test
      // embedders and send a request rather than silently creating a second
      // source of truth inside the webview.
      this.vscode?.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "source",
        operationId: newOperationId(),
      });
    });
    this.restoreRecoveryState();
    this.setInitialized(this.initialized);
    this.setMode(this.mode, false);
    this.refreshDerivedViews(initial.markdown);
    this.postReady();
  }

  destroy(): void {
    window.removeEventListener("message", this.messageHandler);
    this.view.destroy();
  }

  private createState(markdown: string): EditorState {
    let doc: PMNode;
    try {
      const parsed = this.core.parseMarkdown(markdown, this.profile);
      doc = parsed.doc;
      this.previousSnapshot = parsed.snapshot ?? parsed;
    } catch (error) {
      this.parseError =
        error instanceof Error
          ? error.message
          : "Markdown could not be parsed.";
      this.preservedSource = markdown;
      doc = this.schema.topNodeType.createAndFill() as PMNode;
    }
    const plugins: Plugin[] = [
      tableEditing(),
      keymap(this.createKeymap()),
      keymap(baseKeymap),
      new Plugin({
        key: editorPluginKey,
        props: {
          decorations: () => null,
          handleKeyDown: (_view, event) => this.handleAppKeyDown(event),
        },
      }),
    ];
    return EditorState.create({ schema: this.schema, doc, plugins });
  }

  private createKeymap(): Record<
    string,
    (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean
  > {
    const mod = "Mod";
    const listItem = this.schema.nodes.list_item;
    const enter =
      listItem && baseKeymap.Enter
        ? chainCommands(splitListItem(listItem), baseKeymap.Enter)
        : (baseKeymap.Enter ?? (() => false));
    const shiftEnter = this.schema.nodes.hard_break
      ? chainCommands(exitCode, insertHardBreak)
      : exitCode;
    const map: Record<
      string,
      (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean
    > = {
      [`${mod}-b`]: commandForMark("strong", this.schema),
      [`${mod}-i`]: commandForMark("em", this.schema),
      [`${mod}-Shift-x`]: (state, dispatch) =>
        this.profile === "commonmark"
          ? this.gfmUnavailable(dispatch)
          : commandForMark("strike", this.schema)(state, dispatch),
      "Mod-`": commandForMark("code", this.schema),
      Enter: enter,
      "Shift-Enter": shiftEnter,
      "Mod-z": () => this.sendHostCommand("undo"),
      "Mod-y": () => this.sendHostCommand("redo"),
      "Mod-Shift-z": () => this.sendHostCommand("redo"),
      "Mod-s": () => this.sendSaveCommand(),
      Tab: (state, dispatch) =>
        isInTable(state)
          ? goToNextCell(1)(state, dispatch)
          : listItem
            ? sinkListItem(listItem)(state, dispatch)
            : false,
      "Shift-Tab": (state, dispatch) =>
        isInTable(state)
          ? goToNextCell(-1)(state, dispatch)
          : listItem
            ? liftListItem(listItem)(state, dispatch)
            : false,
    };
    return map;
  }

  private handleAppKeyDown(event: KeyboardEvent): boolean {
    // ProseMirror's `Mod` keymap covers the normal path. Keep an explicit
    // platform-aware fallback for hosts that stop the keymap event while a
    // webview command is pending (and for embedded test hosts).
    const modifier = isMac() ? event.metaKey : event.ctrlKey;
    if (!modifier || event.altKey) return false;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      return this.sendHostCommand(event.shiftKey ? "redo" : "undo");
    }
    if (key === "y" && !isMac()) {
      event.preventDefault();
      return this.sendHostCommand("redo");
    }
    if (key === "s") {
      event.preventDefault();
      return this.sendSaveCommand();
    }
    return false;
  }

  private gfmUnavailable(dispatch?: (tr: Transaction) => void): boolean {
    if (dispatch)
      this.setNotice("This GFM feature is unavailable in CommonMark.");
    return false;
  }

  private dispatchTransaction(tr: Transaction): void {
    const oldSelection = this.view.state.selection;
    this.view.updateState(this.view.state.apply(tr));
    if (tr.docChanged) {
      this.dirty = true;
      const markdown = this.serializeCurrent();
      this.persistRecovery(markdown ?? this.lastValidMarkdown);
      if (markdown !== null) {
        this.refreshDerivedViews(markdown);
        if (!this.syncPaused && this.initialized && !this.previewOnly)
          this.sync.enqueue(markdown);
      }
    }
    if (tr.selectionSet || tr.docChanged)
      this.updateToolbarState(oldSelection, this.view.state.selection);
  }

  private currentMarkdown(): string {
    return this.serializeCurrent() ?? this.lastValidMarkdown;
  }

  private serializeCurrent(): string | null {
    if (this.parseError && this.preservedSource !== null)
      return this.preservedSource;
    try {
      const markdown = this.core.serializeMarkdown(
        this.view.state.doc,
        this.previousSnapshot,
      );
      this.lastValidMarkdown = markdown;
      return markdown;
    } catch (error) {
      this.parseError =
        error instanceof Error
          ? error.message
          : "Markdown could not be serialized.";
      this.preservedSource = this.lastValidMarkdown;
      this.syncPaused = true;
      this.view?.setProps({ editable: () => false });
      this.statusEl.textContent = `Read-only: ${this.parseError}`;
      this.persistRecovery(this.lastValidMarkdown);
      return null;
    }
  }

  private refreshDerivedViews(markdown: string, fallbackHtml?: string): void {
    const freshMarkdown = (() => {
      if (this.parseError && this.preservedSource !== null)
        return this.preservedSource;
      try {
        return this.core.serializeMarkdown(
          this.view.state.doc,
          this.previousSnapshot,
        );
      } catch {
        return markdown;
      }
    })();
    this.sourceEl.value = freshMarkdown;
    try {
      // Rendering deliberately receives freshly serialized Markdown on every
      // update. This keeps dedicated preview behavior aligned with VS Code's
      // native Markdown preview after formatting and conflict resolution.
      this.previewEl.innerHTML = this.core.renderMarkdown(
        freshMarkdown,
        this.profile,
      );
    } catch {
      if (fallbackHtml !== undefined) this.previewEl.innerHTML = fallbackHtml;
      else this.previewEl.textContent = freshMarkdown;
    }
    this.resolveDisplayImages(this.previewEl);
    // ImageNodeView ignores this display-only attribute mutation so the
    // absolute webview URI never leaks into the ProseMirror document.
    this.resolveDisplayImages(this.view.dom);
    this.refreshCompatibility(freshMarkdown);
  }

  /** Resolve local image references for the webview display only. */
  private resolveDisplayImages(container: ParentNode): void {
    const base = this.resourceBaseUrl;
    if (!base) return;
    for (const image of Array.from(container.querySelectorAll("img[src]"))) {
      const source = image.getAttribute("src");
      if (!source) continue;
      const resolved = resolveDisplayUrl(source, base);
      if (resolved !== source) image.setAttribute("src", resolved);
    }
  }

  private refreshCompatibility(markdown: string): void {
    let issues: CompatibilityIssue[] = [];
    try {
      issues = normalizeIssues(
        this.core.inspectCompatibility?.(markdown, this.profile),
      );
    } catch {
      issues = [
        { level: "warning", message: "Compatibility inspection failed." },
      ];
    }
    this.compatibilityEl.replaceChildren();
    if (!issues.length) {
      this.compatibilityEl.textContent = "";
      this.root.removeAttribute("data-compatibility-level");
      return;
    }
    const level = issues.some((issue) => issue.level === "error")
      ? "error"
      : "warning";
    this.root.setAttribute("data-compatibility-level", level);
    const icon = makeElement("span", {
      class: "mw-compatibility-icon",
      "aria-hidden": "true",
    });
    icon.textContent = level === "error" ? "!" : "⚠";
    const text = makeElement("span");
    text.textContent = issues
      .map((issue) =>
        issue.line ? `L${issue.line}: ${issue.message}` : issue.message,
      )
      .join(" · ");
    this.compatibilityEl.append(icon, text);
    this.compatibilityEl.title = issues
      .map((issue) => issue.message)
      .join("\n");
  }

  private applyTypography(typography: PreviewTypography | undefined): void {
    if (!typography) return;
    const fontFamily = typography.fontFamily.replace(/[{};]/g, "").trim();
    if (fontFamily)
      this.root.style.setProperty("--markdown-font-family", fontFamily);
    if (
      Number.isFinite(typography.fontSize) &&
      typography.fontSize > 0 &&
      typography.fontSize < 100
    )
      this.root.style.setProperty(
        "--markdown-font-size",
        `${typography.fontSize}px`,
      );
    if (
      Number.isFinite(typography.lineHeight) &&
      typography.lineHeight > 0 &&
      typography.lineHeight < 10
    )
      this.root.style.setProperty(
        "--markdown-line-height",
        String(typography.lineHeight),
      );
  }

  private setSyncStatus(status: "saved" | "pending" | "conflict"): void {
    this.statusEl.dataset.state = status;
    this.statusEl.textContent =
      status === "saved"
        ? "Synced"
        : status === "pending"
          ? "Syncing…"
          : "Conflict — local draft preserved";
  }

  private setInitialized(value: boolean): void {
    this.initialized = value;
    this.root.toggleAttribute("data-loading", !value);
    this.updateEditingControlState();
  }

  private updateEditingControlState(): void {
    const editingDisabled =
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      Boolean(this.parseError);
    for (const element of Array.from(
      this.root.querySelectorAll<
        HTMLButtonElement | HTMLSelectElement | HTMLInputElement
      >(".mw-tool-button, .mw-heading-select, .mw-code-language"),
    )) {
      element.disabled =
        editingDisabled ||
        (element.dataset.gfmOnly === "true" && this.profile === "commonmark") ||
        (element === this.codeLanguageInput && element.hidden);
    }
    for (const button of Array.from(
      this.root.querySelectorAll<HTMLButtonElement>(".mw-mode-button"),
    )) {
      button.disabled =
        !this.initialized ||
        (this.previewOnly && button.dataset.mode !== "preview");
    }
    const inTable =
      this.initialized &&
      !this.parseError &&
      this.mode === "rich" &&
      isInTable(this.view.state);
    for (const button of Array.from(
      this.root.querySelectorAll<HTMLButtonElement>(".mw-table-menu button"),
    ))
      button.disabled =
        !inTable ||
        (button.dataset.gfmOnly === "true" && this.profile === "commonmark");
  }

  private setConflict(message: string): void {
    this.conflict = true;
    this.syncPaused = true;
    this.statusEl.title = message;
    this.statusEl.dataset.state = "conflict";
    this.statusEl.textContent = message;
    this.persistRecovery(this.currentMarkdown());
    this.recoverButton.hidden = false;
  }

  /** Report an actionable editor hint without freezing local synchronization. */
  private setNotice(message: string, state: "info" | "error" = "info"): void {
    this.statusEl.title = message;
    this.statusEl.dataset.state = state;
    this.statusEl.textContent = message;
  }

  private buildRecoveryDialog(): void {
    const dialog = document.createElement("dialog");
    dialog.className = "mw-input-dialog mw-recovery-dialog";
    const form = document.createElement("form");
    form.className = "mw-dialog-form";
    const title = document.createElement("h2");
    title.textContent = "Review recovered draft";
    const help = document.createElement("p");
    help.textContent =
      "The draft is kept separately until you choose an action.";
    this.recoveryText = document.createElement("textarea");
    this.recoveryText.readOnly = true;
    this.recoveryText.className = "mw-recovery-text";
    this.recoveryText.setAttribute("aria-label", "Recovered Markdown draft");
    const actions = document.createElement("div");
    actions.className = "mw-dialog-actions";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => this.closeDialog(dialog));
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload authoritative";
    reload.addEventListener("click", () => {
      this.closeDialog(dialog);
      this.reloadRequested = true;
      this.pendingExternal = null;
      this.statusEl.textContent = "Reloading authoritative document…";
      this.vscode?.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "ready",
        requestId: newOperationId(),
      });
    });
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "Apply draft";
    apply.addEventListener("click", () => {
      this.closeDialog(dialog);
      this.applyRecoveryDraft();
    });
    actions.append(close, reload, apply);
    form.append(title, help, this.recoveryText, actions);
    dialog.append(form);
    this.root.append(dialog);
    this.recoveryDialog = dialog;
  }

  private openRecoveryDialog(): void {
    const saved = this.vscode?.getState?.() as RecoveryState | undefined;
    const draft = saved?.recoveryDraft ?? this.currentMarkdown();
    this.recoveryText.value = draft;
    this.openDialog(this.recoveryDialog);
  }

  private buildToolbar(): HTMLElement {
    const toolbar = makeElement("div", {
      class: "mw-toolbar",
      role: "toolbar",
      "aria-label": "Markdown formatting",
    });
    const modeGroup = makeElement("div", {
      class: "mw-mode-group",
      role: "tablist",
      "aria-label": "View",
    });
    for (const [mode, label, shortcut] of [
      ["rich", "Rich", ""],
      ["preview", "Preview", ""],
      ["source", "Source", ""],
    ] as const) {
      const button = makeElement("button", {
        type: "button",
        class: "mw-mode-button",
        role: "tab",
        "data-mode": mode,
        "aria-label": `${label} view`,
      }) as HTMLButtonElement;
      button.textContent = label;
      if (shortcut) button.title = shortcut;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.setMode(mode));
      modeGroup.append(button);
      this.modes.set(mode, button);
    }
    toolbar.append(modeGroup);
    const separator = () =>
      toolbar.append(
        makeElement("span", {
          class: "mw-toolbar-separator",
          "aria-hidden": "true",
        }),
      );
    const addButton = (
      label: string,
      title: string,
      command: () => void,
      testId?: string,
    ) => {
      const button = makeElement("button", {
        type: "button",
        class: "mw-tool-button",
        title,
        "aria-label": title,
        ...(testId ? { "data-testid": testId } : {}),
      }) as HTMLButtonElement;
      button.textContent = label;
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.view.focus();
      });
      button.addEventListener("click", command);
      toolbar.append(button);
      return button;
    };
    const headingSelect = document.createElement("select");
    headingSelect.className = "mw-heading-select";
    headingSelect.setAttribute("aria-label", "Heading level");
    for (const [value, label] of [
      ["p", "Text"],
      ["1", "H1"],
      ["2", "H2"],
      ["3", "H3"],
      ["4", "H4"],
      ["5", "H5"],
      ["6", "H6"],
    ] as Array<[string, string]>) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      headingSelect.append(option);
    }
    headingSelect.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.view.focus();
    });
    headingSelect.addEventListener("change", () => {
      this.view.focus();
      const value = headingSelect.value;
      const command =
        value === "p"
          ? commandForBlock("paragraph")
          : commandForBlock("heading", { level: Number(value) });
      command(this.view.state, (tr) => this.dispatchTransaction(tr));
    });
    toolbar.append(headingSelect);
    separator();
    addButton(
      "B",
      "Bold",
      () => this.runCommand(commandForMark("strong", this.schema)),
      "toolbar-bold",
    );
    addButton(
      "I",
      "Italic",
      () => this.runCommand(commandForMark("em", this.schema)),
      "toolbar-italic",
    );
    const strikeButton = addButton(
      "S",
      "Strikethrough",
      () => {
        if (this.profile === "commonmark") {
          this.setNotice("Strikethrough is unavailable in CommonMark.");
          return;
        }
        this.runCommand(commandForMark("strike", this.schema));
      },
      "toolbar-strike",
    );
    strikeButton.dataset.gfmOnly = "true";
    addButton(
      "`",
      "Inline code",
      () => this.runCommand(commandForMark("code", this.schema)),
      "toolbar-code",
    );
    addButton("Link", "Insert link", () => this.insertLink());
    addButton("Image", "Insert image", () => this.insertImage());
    separator();
    addButton("• List", "Bullet list", () =>
      this.runListCommand("bullet_list"),
    );
    addButton("1. List", "Ordered list", () =>
      this.runListCommand("ordered_list"),
    );
    const taskButton = addButton("☑ Task", "Task list", () =>
      this.runTaskList(),
    );
    taskButton.dataset.gfmOnly = "true";
    addButton("Quote", "Block quote", () =>
      this.runCommand(commandForBlock("blockquote")),
    );
    addButton("Code", "Code block", () =>
      this.runCommand(commandForBlock("code_block", { params: "" })),
    );
    const insertTableButton = addButton("Table", "Insert table", () =>
      this.insertTable(),
    );
    insertTableButton.dataset.gfmOnly = "true";
    separator();
    addButton("↶", "Undo", () => this.sendHostCommand("undo"), "toolbar-undo");
    addButton("↷", "Redo", () => this.sendHostCommand("redo"), "toolbar-redo");
    addButton("Format", "Format Markdown", () => this.formatDocument());
    const tableMenu = makeElement("details", { class: "mw-table-menu" });
    const summary = makeElement("summary");
    summary.textContent = "Table";
    tableMenu.append(summary);
    const menuItems: Array<[string, () => boolean]> = [
      ["Add row above", () => this.runTableCommand(addRowBefore)],
      ["Add row below", () => this.runTableCommand(addRowAfter)],
      ["Delete row", () => this.runTableCommand(deleteRow)],
      ["Add column left", () => this.runTableCommand(addColumnBefore)],
      ["Add column right", () => this.runTableCommand(addColumnAfter)],
      ["Delete column", () => this.runTableCommand(deleteColumn)],
      ["Align left", () => this.runAlignment("left")],
      ["Align center", () => this.runAlignment("center")],
      ["Align right", () => this.runAlignment("right")],
    ];
    const menu = makeElement("div", {
      class: "mw-table-menu-items",
      role: "menu",
    });
    for (const [label, command] of menuItems) {
      const item = makeElement("button", {
        type: "button",
        role: "menuitem",
      }) as HTMLButtonElement;
      item.textContent = label;
      item.dataset.gfmOnly = "true";
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => command());
      menu.append(item);
    }
    tableMenu.append(menu);
    toolbar.append(tableMenu);

    const makeField = (
      labelText: string,
      type: string,
      placeholder: string,
    ): HTMLInputElement => {
      const label = document.createElement("label");
      label.className = "mw-dialog-field";
      const caption = document.createElement("span");
      caption.textContent = labelText;
      const input = document.createElement("input");
      input.type = type;
      input.placeholder = placeholder;
      label.append(caption, input);
      return input;
    };
    const link = document.createElement("dialog");
    link.className = "mw-input-dialog";
    link.setAttribute("aria-labelledby", "mw-link-dialog-title");
    const linkForm = document.createElement("form");
    linkForm.className = "mw-dialog-form";
    const linkTitle = document.createElement("h2");
    linkTitle.id = "mw-link-dialog-title";
    linkTitle.textContent = "Insert link";
    this.linkUrlInput = makeField("URL", "url", "https://example.com");
    this.linkTextInput = makeField("Text", "text", "Selected text");
    const linkActions = document.createElement("div");
    linkActions.className = "mw-dialog-actions";
    const linkCancel = document.createElement("button");
    linkCancel.type = "button";
    linkCancel.textContent = "Cancel";
    linkCancel.addEventListener("click", () => this.closeDialog(link));
    const unlink = document.createElement("button");
    unlink.type = "button";
    unlink.textContent = "Unlink";
    unlink.dataset.action = "unlink";
    unlink.addEventListener("click", () => {
      const selection = this.restoreSavedSelection();
      const mark = this.schema.marks.link;
      if (selection && mark)
        this.dispatchTransaction(
          this.view.state.tr.removeMark(selection.from, selection.to, mark),
        );
      this.closeDialog(link);
    });
    const linkApply = document.createElement("button");
    linkApply.type = "submit";
    linkApply.textContent = "Apply";
    linkActions.append(linkCancel, unlink, linkApply);
    linkForm.append(
      linkTitle,
      this.linkUrlInput.parentElement as HTMLElement,
      this.linkTextInput.parentElement as HTMLElement,
      linkActions,
    );
    linkForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.applyLink(this.linkUrlInput.value.trim(), this.linkTextInput.value);
      this.closeDialog(link);
    });
    link.append(linkForm);
    toolbar.append(link);
    this.linkDialog = link;

    const image = document.createElement("dialog");
    image.className = "mw-input-dialog";
    image.setAttribute("aria-labelledby", "mw-image-dialog-title");
    const imageForm = document.createElement("form");
    imageForm.className = "mw-dialog-form";
    const imageTitle = document.createElement("h2");
    imageTitle.id = "mw-image-dialog-title";
    imageTitle.textContent = "Insert image";
    this.imageUrlInput = makeField(
      "Image URL",
      "url",
      "https://example.com/image.png",
    );
    this.imageAltInput = makeField("Alt text", "text", "Description");
    const imageActions = document.createElement("div");
    imageActions.className = "mw-dialog-actions";
    const imageCancel = document.createElement("button");
    imageCancel.type = "button";
    imageCancel.textContent = "Cancel";
    imageCancel.addEventListener("click", () => this.closeDialog(image));
    const imageApply = document.createElement("button");
    imageApply.type = "submit";
    imageApply.textContent = "Apply";
    imageActions.append(imageCancel, imageApply);
    imageForm.append(
      imageTitle,
      this.imageUrlInput.parentElement as HTMLElement,
      this.imageAltInput.parentElement as HTMLElement,
      imageActions,
    );
    imageForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.applyImage(
        this.imageUrlInput.value.trim(),
        this.imageAltInput.value,
      );
      this.closeDialog(image);
    });
    image.append(imageForm);
    toolbar.append(image);
    this.imageDialog = image;

    this.codeLanguageInput = document.createElement("input");
    this.codeLanguageInput.className = "mw-code-language";
    this.codeLanguageInput.type = "text";
    this.codeLanguageInput.placeholder = "lang";
    this.codeLanguageInput.title = "Code block language";
    this.codeLanguageInput.setAttribute("aria-label", "Code block language");
    this.codeLanguageInput.addEventListener("mousedown", () => {
      const { from, to } = this.view.state.selection;
      this.savedSelection = { from, to };
    });
    this.codeLanguageInput.addEventListener("change", () =>
      this.setCodeLanguage(this.codeLanguageInput.value.trim()),
    );
    toolbar.append(this.codeLanguageInput);
    return toolbar;
  }

  private openDialog(dialog: HTMLDialogElement): void {
    try {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "true");
    } catch {
      dialog.setAttribute("open", "true");
    }
  }

  private closeDialog(dialog: HTMLDialogElement): void {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  private restoreSavedSelection(): SavedSelection | null {
    if (!this.savedSelection) return null;
    const from = Math.max(
      0,
      Math.min(this.savedSelection.from, this.view.state.doc.content.size),
    );
    const to = Math.max(
      from,
      Math.min(this.savedSelection.to, this.view.state.doc.content.size),
    );
    this.view.focus();
    const selection = TextSelection.create(this.view.state.doc, from, to);
    this.view.updateState(
      this.view.state.apply(this.view.state.tr.setSelection(selection)),
    );
    return { from, to };
  }

  private insertLink(): void {
    const { from, to } = this.view.state.selection;
    this.savedSelection = { from, to };
    const linkMark = this.schema.marks.link;
    this.linkUrlInput.value = "";
    this.linkTextInput.value = this.view.state.doc.textBetween(
      from,
      to,
      "\n",
      "\n",
    );
    if (linkMark) {
      let href = "";
      this.view.state.doc.nodesBetween(from, to, (node) => {
        const mark = node.marks.find(
          (candidate) => candidate.type === linkMark,
        );
        if (mark?.attrs.href && !href) href = String(mark.attrs.href);
      });
      this.linkUrlInput.value = href;
    }
    this.openDialog(this.linkDialog);
    this.linkUrlInput.focus();
  }

  private applyLink(href: string, text: string): void {
    const selection = this.restoreSavedSelection();
    const mark = this.schema.marks.link;
    if (!selection || !mark || !href) return;
    const link = mark.create({ href });
    if (selection.from === selection.to && text) {
      this.dispatchTransaction(
        this.view.state.tr.replaceSelectionWith(this.schema.text(text, [link])),
      );
    } else {
      this.dispatchTransaction(
        this.view.state.tr.addMark(selection.from, selection.to, link),
      );
    }
  }

  private insertImage(): void {
    this.savedSelection = {
      from: this.view.state.selection.from,
      to: this.view.state.selection.to,
    };
    this.imageUrlInput.value = "";
    this.imageAltInput.value = "";
    this.openDialog(this.imageDialog);
    this.imageUrlInput.focus();
  }

  private applyImage(src: string, alt: string): void {
    if (!src || !this.schema.nodes.image) return;
    this.restoreSavedSelection();
    const image = this.schema.nodes.image.create({ src, alt, title: null });
    this.dispatchTransaction(this.view.state.tr.replaceSelectionWith(image));
  }

  private setCodeLanguage(language: string): void {
    const { $from } = this.view.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);
      if (node.type.name !== "code_block") continue;
      this.dispatchTransaction(
        this.view.state.tr.setNodeMarkup($from.before(depth), undefined, {
          ...node.attrs,
          params: language,
        }),
      );
      return;
    }
  }

  private runCommand(
    command: (
      state: EditorState,
      dispatch?: (tr: Transaction) => void,
    ) => boolean,
  ): boolean {
    this.view.focus();
    return command(this.view.state, (tr) => this.dispatchTransaction(tr));
  }

  private runListCommand(typeName: string): void {
    const listType = this.schema.nodes[typeName];
    if (!listType) return;
    this.runCommand(wrapInList(listType));
  }

  private runTaskList(): void {
    if (this.profile === "commonmark") {
      this.setNotice("Task lists are unavailable in CommonMark.");
      return;
    }
    const taskList =
      this.schema.nodes.task_list || this.schema.nodes.bullet_list;
    if (!taskList) return;
    this.view.focus();
    wrapInList(taskList)(this.view.state, (tr) => {
      const { from, to } = tr.selection;
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === "list_item" && node.attrs.checked == null)
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
      });
      this.dispatchTransaction(tr);
    });
  }

  private runTableCommand(
    command: (
      state: EditorState,
      dispatch?: (tr: Transaction) => void,
    ) => boolean,
  ): boolean {
    if (this.profile === "commonmark") {
      this.setNotice("Tables are unavailable in CommonMark.");
      return false;
    }
    if (!isInTable(this.view.state)) {
      this.setNotice("Place the cursor inside a table to use table commands.");
      return false;
    }
    this.view.focus();
    return command(this.view.state, (tr) =>
      this.dispatchTransaction(this.normalizeTableTransaction(tr)),
    );
  }

  private normalizeTableTransaction(tr: Transaction): Transaction {
    const context = tableContext(tr.selection);
    if (!context) return tr;
    const headerType = this.schema.nodes.table_header;
    const cellType = this.schema.nodes.table_cell;
    if (!headerType || !cellType) return tr;
    const rows: PMNode[] = [];
    for (let rowIndex = 0; rowIndex < context.table.childCount; rowIndex += 1) {
      const row = context.table.child(rowIndex);
      const cells = Array.from({ length: row.childCount }, (_, columnIndex) => {
        const cell = row.child(columnIndex);
        const type = rowIndex === 0 ? headerType : cellType;
        return cell.type === type
          ? cell
          : type.create(cell.attrs, cell.content);
      });
      rows.push(row.type.create(row.attrs, Fragment.fromArray(cells)));
    }
    const normalized = context.table.copy(Fragment.fromArray(rows));
    if (normalized.eq(context.table)) return tr;
    return tr.replaceWith(
      context.tableStart - 1,
      context.tableStart - 1 + context.table.nodeSize,
      normalized,
    );
  }

  private runAlignment(alignment: "left" | "center" | "right"): boolean {
    if (this.profile === "commonmark") {
      this.setNotice("Table alignment is unavailable in CommonMark.");
      return false;
    }
    const context = tableContext(this.view.state.selection);
    if (!context) {
      this.setNotice("Place the cursor inside a table to align a column.");
      return false;
    }
    const rows: PMNode[] = [];
    for (let rowIndex = 0; rowIndex < context.table.childCount; rowIndex += 1) {
      const row = context.table.child(rowIndex);
      const cells = Array.from({ length: row.childCount }, (_, columnIndex) => {
        const cell = row.child(columnIndex);
        if (
          columnIndex < context.rect.left ||
          columnIndex >= context.rect.right
        )
          return cell;
        return cell.type.create({ ...cell.attrs, alignment }, cell.content);
      });
      rows.push(row.type.create(row.attrs, Fragment.fromArray(cells)));
    }
    const aligned = context.table.copy(Fragment.fromArray(rows));
    this.dispatchTransaction(
      this.view.state.tr.replaceWith(
        context.tableStart - 1,
        context.tableStart - 1 + context.table.nodeSize,
        aligned,
      ),
    );
    return true;
  }

  private insertTable(): void {
    if (this.profile === "commonmark") {
      this.setNotice("Tables are unavailable in CommonMark.");
      return;
    }
    const table = this.schema.nodes.table;
    const row = this.schema.nodes.table_row;
    const cell = this.schema.nodes.table_cell;
    const header = this.schema.nodes.table_header ?? cell;
    const paragraph = this.schema.nodes.paragraph;
    if (!table || !row || !cell || !header || !paragraph) return;
    const cells = Array.from({ length: 3 }, () =>
      cell.create(null, paragraph.create()),
    );
    const headerCells = Array.from({ length: 3 }, () =>
      header.create(null, paragraph.create()),
    );
    const rows = [row.create(null, headerCells), row.create(null, cells)];
    const node = table.create(null, rows);
    const { from, to } = this.view.state.selection;
    this.dispatchTransaction(
      this.view.state.tr.replaceRangeWith(from, to, node),
    );
  }

  private async formatDocument(): Promise<void> {
    if (this.formatting) return;
    if (this.syncPaused) {
      this.setNotice(
        "Resolve the document conflict before formatting.",
        "error",
      );
      return;
    }
    const current = this.currentMarkdown();
    if (this.vscode) {
      if (this.composing || this.sync.hasPending) {
        this.deferredHostCommand = "format";
        this.setNotice("Waiting to format until the latest edit is synced.");
        return;
      }
      this.vscode.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "format",
        baseVersion: this.version,
        operationId: newOperationId(),
      });
      this.setNotice("Formatting…");
      return;
    }
    const startingDoc = this.view.state.doc;
    const startingVersion = this.version;
    this.formatting = true;
    try {
      let formatted = current;
      try {
        const result = await this.core.formatMarkdown?.(current, {
          markdownProfile: this.profile,
        });
        if (typeof result === "string") formatted = result;
        else if (result?.markdown || result?.source)
          formatted = result.markdown ?? result.source ?? current;
      } catch {
        this.setNotice(
          "Formatting failed; the current draft was kept.",
          "error",
        );
        return;
      }
      // The formatter may be asynchronous. A typing transaction that lands
      // while it is running owns the latest draft and must never be replaced
      // by an older formatted snapshot.
      if (
        this.view.state.doc !== startingDoc ||
        this.version !== startingVersion ||
        this.currentMarkdown() !== current
      ) {
        this.setNotice(
          "Formatting skipped because the document changed while it ran.",
        );
        return;
      }
      if (formatted === current) return;
      let parsed: ParseResult;
      try {
        parsed = this.core.parseMarkdown(formatted, this.profile);
      } catch {
        this.setNotice(
          "Formatting produced invalid Markdown; the draft was kept.",
          "error",
        );
        return;
      }
      this.previousSnapshot = parsed.snapshot ?? parsed;
      if (parsed.doc.eq(this.view.state.doc)) {
        // Formatting can change separators or reference spelling while
        // leaving the PM structure untouched. Keep the existing state object
        // so CellSelection and the scroll position survive unchanged.
        this.lastValidMarkdown = formatted;
        this.refreshDerivedViews(formatted);
      } else {
        const selection = this.view.state.selection;
        const transaction = this.view.state.tr.replaceWith(
          0,
          this.view.state.doc.content.size,
          parsed.doc.content,
        );
        transaction.setSelection(
          selectionForDocument(selection, transaction.doc),
        );
        this.dispatchTransaction(transaction);
      }
    } finally {
      this.formatting = false;
    }
  }

  private setMode(mode: EditorMode, requestHost = true): void {
    if (this.previewOnly && mode !== "preview") return;
    this.mode = mode;
    for (const [candidate, button] of this.modes) {
      button.setAttribute("aria-selected", String(candidate === mode));
      button.classList.toggle("is-active", candidate === mode);
    }
    for (const panel of Array.from(
      this.root.querySelectorAll<HTMLElement>("[data-panel]"),
    ))
      panel.hidden = panel.dataset.panel !== mode;
    this.updateEditingControlState();
    this.updateToolbarState(
      this.view.state.selection,
      this.view.state.selection,
    );
    if (mode === "preview") {
      this.refreshDerivedViews(this.currentMarkdown());
      if (requestHost && this.sync.hasPending)
        this.deferredHostCommand = "preview";
      else if (requestHost)
        this.vscode?.postMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: "preview",
          baseVersion: this.version,
          operationId: newOperationId(),
        });
    }
    if (mode === "source") {
      this.sourceEl.value = this.currentMarkdown();
      if (requestHost && this.sync.hasPending)
        this.deferredHostCommand = "source";
      else if (requestHost)
        this.vscode?.postMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: "source",
          operationId: newOperationId(),
        });
    }
    if (mode === "rich") this.view.focus();
  }

  private updateToolbarState(
    _oldSelection: Selection,
    selection: Selection,
  ): void {
    const inTable = isInTable(this.view.state);
    const editingDisabled =
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      Boolean(this.parseError);
    for (const button of Array.from(
      this.root.querySelectorAll<HTMLButtonElement>(".mw-table-menu button"),
    ))
      button.disabled = editingDisabled || !inTable;
    const heading =
      this.root.querySelector<HTMLSelectElement>(".mw-heading-select");
    if (heading) {
      const { $from } = selection;
      const node = $from.parent;
      heading.value =
        node.type.name === "heading" ? String(node.attrs.level) : "p";
    }
    let language = "";
    let inCode = false;
    const { $from } = selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);
      if (node.type.name === "code_block") {
        inCode = true;
        language = String(node.attrs.params ?? "");
        break;
      }
    }
    this.codeLanguageInput.value = language;
    this.codeLanguageInput.hidden = !inCode;
    this.codeLanguageInput.disabled = editingDisabled || !inCode;
    this.updateEditingControlState();
  }

  private postReady(): void {
    this.vscode?.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "ready",
      requestId: newOperationId(),
    });
  }

  private sendHostCommand(type: "undo" | "redo"): boolean {
    if (!this.options.hostUndo && type === "undo") return false;
    if (this.syncPaused) {
      this.setNotice(
        "Resolve the document conflict before using undo or redo.",
        "error",
      );
      return false;
    }
    if (this.composing || this.sync.hasPending) {
      this.deferredHostCommand = type;
      this.setNotice(`Waiting to ${type} until the latest edit is synced…`);
      return true;
    }
    this.vscode?.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type,
      baseVersion: this.version,
      operationId: newOperationId(),
    });
    return true;
  }

  private sendSaveCommand(): boolean {
    if (!this.vscode || !this.initialized || this.previewOnly) return false;
    if (this.syncPaused) {
      this.setNotice("Resolve the document conflict before saving.", "error");
      return false;
    }
    if (this.composing || this.sync.hasPending) {
      this.deferredHostCommand = "save";
      this.setNotice("Waiting to save until the latest edit is synced.");
      return true;
    }
    const operationId = newOperationId();
    this.pendingSaveOperationId = operationId;
    this.vscode.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "save",
      baseVersion: this.version,
      operationId,
    });
    this.setNotice("Saving…");
    return true;
  }

  private flushDeferredHostCommand(): void {
    if (
      !this.deferredHostCommand ||
      this.composing ||
      this.sync.hasPending ||
      this.syncPaused
    )
      return;
    const command = this.deferredHostCommand;
    this.deferredHostCommand = null;
    if (command === "save") {
      this.sendSaveCommand();
      return;
    }
    if (command === "undo" || command === "redo") {
      this.sendHostCommand(command);
      return;
    }
    const operationId = newOperationId();
    if (command === "source")
      this.vscode?.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "source",
        operationId,
      });
    else if (command === "preview")
      this.vscode?.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "preview",
        baseVersion: this.version,
        operationId,
      });
    else
      this.vscode?.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "format",
        baseVersion: this.version,
        operationId,
      });
  }

  private handleMessage(message: unknown): void {
    if (!isHostMessage(message)) return;
    if (message.type === "document") {
      this.receiveDocument(message);
    } else if (message.type === "preview") {
      this.receivePreview(message);
    } else if (message.type === "edit-rejected") {
      this.sync.reject(message.operationId, message.currentVersion);
      this.version = Math.max(this.version, message.currentVersion);
      this.persistRecovery(message.draftMarkdown ?? this.currentMarkdown());
      this.setConflict(message.message);
      this.pendingExternal = {
        protocolVersion: PROTOCOL_VERSION,
        type: "document",
        markdown: message.currentMarkdown,
        version: message.currentVersion,
        profile: this.profile,
        reason: "external",
      };
    } else if (message.type === "format-rejected") {
      this.setNotice(message.message, "error");
    } else if (message.type === "save-result") {
      this.handleSaveResult(message);
    } else if (message.type === "recovery-opened") {
      if (message.operationId === this.pendingRecoveryOperationId) {
        this.reloadRequested = true;
        this.statusEl.textContent =
          "Draft opened separately; reloading the authoritative document…";
      }
    } else if (message.type === "error") {
      this.setNotice(message.message, "error");
    }
  }

  private receivePreview(message: HostPreviewMessage): void {
    if (message.version < this.version) return;
    if (this.sync.hasPending || this.dirty) {
      this.setNotice("Preview update waiting for the local draft to sync.");
      return;
    }
    this.profile = message.profile;
    this.version = Math.max(this.version, message.version);
    this.resourceBaseUrl = message.resourceBaseUrl;
    this.applyTypography(message.typography);
    this.lastValidMarkdown = message.markdown;
    this.refreshDerivedViews(message.markdown, message.html);
  }

  private handleSaveResult(message: SaveResultMessage): void {
    if (
      this.pendingSaveOperationId &&
      message.operationId !== this.pendingSaveOperationId
    )
      return;
    this.pendingSaveOperationId = undefined;
    if (message.saved) {
      this.statusEl.dataset.state = "saved";
      this.statusEl.textContent = message.isDirty
        ? "Synced (unsaved)"
        : "Saved";
      this.version = Math.max(this.version, message.version);
    } else {
      this.setNotice(
        message.message ?? "The document could not be saved.",
        "error",
      );
    }
  }

  receiveDocument(message: DocumentMessage): void {
    // A host acknowledgement must be processed even during IME composition;
    // otherwise it would be mistaken for an external edit and leave the local
    // draft in a permanent conflict state.
    if (
      this.pendingRecoveryOperationId &&
      (message.operationId === this.pendingRecoveryOperationId ||
        message.reason === "recovery")
    ) {
      this.pendingRecoveryOperationId = undefined;
      this.reloadRequested = true;
      this.applyDocument(message);
      return;
    }
    if (
      !message.operationId &&
      message.version < this.version &&
      !this.reloadRequested
    )
      return;
    const hadPendingExternal = this.pendingExternal !== null;
    const isAck = Boolean(
      message.operationId &&
      this.sync.acknowledge(
        message.operationId,
        message.version,
        message.markdown,
        { pauseQueue: hadPendingExternal || this.syncPaused },
      ),
    );
    if (isAck) {
      // A delayed acknowledgement can arrive after a newer external
      // snapshot. Never move the base version backwards.
      this.version = Math.max(this.version, message.version);
      this.operationId = message.operationId;
      if (hadPendingExternal) {
        this.conflict = true;
        this.syncPaused = true;
        this.setConflict(
          "A newer external update is waiting; the local draft was preserved.",
        );
        return;
      }
      this.conflict = false;
      this.dirty = Boolean(this.sync.inflight || this.sync.queuedEdit);
      if (!this.sync.hasPending && message.markdown === this.currentMarkdown())
        this.clearRecoveryIfSaved();
      this.flushDeferredHostCommand();
      return;
    }
    if (this.composing) {
      this.pendingExternal = message;
      this.statusEl.textContent = "External update waiting for IME composition";
      return;
    }
    if (this.reloadRequested) {
      this.reloadRequested = false;
      this.applyDocument(message);
      return;
    }
    if (this.sync.inflight || this.sync.queuedEdit || this.dirty) {
      this.pendingExternal = message;
      // A profile/configuration broadcast can arrive with the same text while
      // a local edit is in flight. Keep the local document, but retain the
      // newer parsing metadata so the eventual conflict/reload does not
      // silently revert the profile.
      this.profile = message.profile;
      this.resourceBaseUrl = message.resourceBaseUrl;
      this.applyTypography(message.typography);
      this.version = Math.max(this.version, message.version);
      this.sync.setVersion(Math.max(this.sync.version, message.version));
      this.sync.markExternalConflict(
        "A document changed externally while this draft was being edited.",
      );
      return;
    }
    this.applyDocument(message);
  }

  private applyDocument(message: DocumentMessage): void {
    if (this.composing) {
      this.pendingExternal = message;
      return;
    }
    const previousState = this.view.state;
    const previousDoc = previousState.doc;
    const stage = this.root.querySelector<HTMLElement>(".mw-stage");
    const scrollTop = stage?.scrollTop ?? 0;
    this.profile = message.profile;
    this.previewOnly = message.mode === "preview";
    this.setInitialized(true);
    this.applyTypography(message.typography);
    this.version = Math.max(this.version, message.version);
    this.operationId = message.operationId;
    this.resourceBaseUrl = message.resourceBaseUrl;
    if (message.mode === "preview") this.mode = "preview";
    let parsed: ParseResult;
    try {
      parsed = this.core.parseMarkdown(message.markdown, this.profile);
      this.parseError = null;
      this.preservedSource = null;
    } catch (error) {
      this.parseError =
        error instanceof Error
          ? error.message
          : "Markdown could not be parsed.";
      this.preservedSource = message.markdown;
      this.view.setProps({ editable: () => false });
      this.syncPaused = true;
      this.sourceEl.value = message.markdown;
      this.previewEl.textContent = message.markdown;
      this.setNotice(`Read-only: ${this.parseError}`, "error");
      this.persistRecovery(this.lastValidMarkdown);
      return;
    }
    this.view.setProps({ editable: () => !this.previewOnly });
    this.previousSnapshot = parsed.snapshot ?? parsed;
    if (!parsed.doc.eq(previousDoc)) {
      let nextState = EditorState.create({
        schema: this.schema,
        doc: parsed.doc,
        plugins: previousState.plugins,
      });
      nextState = nextState.apply(
        nextState.tr.setSelection(
          selectionForDocument(previousState.selection, parsed.doc),
        ),
      );
      this.view.updateState(nextState);
    }
    this.dirty = false;
    this.conflict = false;
    this.syncPaused = false;
    this.reloadRequested = false;
    this.lastValidMarkdown = message.markdown;
    this.pendingExternal = null;
    this.sync.setVersion(this.version);
    this.sync.clear();
    this.refreshDerivedViews(message.markdown);
    if (message.mode === "preview") this.setMode("preview", false);
    else
      this.updateToolbarState(
        this.view.state.selection,
        this.view.state.selection,
      );
    if (stage) stage.scrollTop = scrollTop;
    this.clearRecoveryIfSaved();
    this.restoreRecoveryState();
  }

  private flushExternalAfterComposition(): void {
    if (!this.pendingExternal) return;
    const external = this.pendingExternal;
    this.pendingExternal = null;
    if (this.sync.inflight || this.sync.queuedEdit || this.dirty) {
      this.sync.markExternalConflict(
        "External update was kept pending so local IME input is not lost.",
      );
      this.pendingExternal = external;
      return;
    }
    this.applyDocument(external);
  }

  private persistRecovery(markdown: string): void {
    this.vscode?.setState?.({
      recoveryDraft: markdown,
      recoveryVersion: this.version,
      recoveryProfile: this.profile,
      recoveryTimestamp: Date.now(),
    } satisfies RecoveryState);
  }

  private restoreRecoveryState(): void {
    const saved = this.vscode?.getState?.() as RecoveryState | undefined;
    if (!saved?.recoveryDraft || saved.recoveryDraft === this.currentMarkdown())
      return;
    this.recoverButton.hidden = false;
    this.recoverButton.title = `Draft from ${saved.recoveryTimestamp ? new Date(saved.recoveryTimestamp).toLocaleString() : "an earlier session"}`;
    this.statusEl.textContent = "A recoverable local draft is available";
  }

  private applyRecoveryDraft(): void {
    const saved = this.vscode?.getState?.() as RecoveryState | undefined;
    if (!saved?.recoveryDraft) return;
    const profile = saved.recoveryProfile ?? this.profile;
    let parsed: ParseResult;
    try {
      parsed = this.core.parseMarkdown(saved.recoveryDraft, profile);
    } catch (error) {
      this.setConflict(
        error instanceof Error
          ? error.message
          : "Recovered draft could not be parsed.",
      );
      return;
    }
    this.profile = profile;
    this.previousSnapshot = parsed.snapshot ?? parsed;
    this.view.updateState(
      EditorState.create({
        schema: this.schema,
        doc: parsed.doc,
        plugins: this.view.state.plugins,
      }),
    );
    this.parseError = null;
    this.preservedSource = null;
    this.lastValidMarkdown = saved.recoveryDraft;
    this.syncPaused = true;
    this.conflict = true;
    this.view.setProps({ editable: () => !this.previewOnly });
    const operationId = newOperationId();
    this.pendingRecoveryOperationId = operationId;
    this.vscode?.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "recoverDraft",
      baseVersion: this.version,
      operationId,
      markdown: saved.recoveryDraft,
    });
    this.recoverButton.hidden = true;
    this.statusEl.textContent = this.vscode
      ? "Applying recovered draft…"
      : "Recovered draft loaded locally.";
    this.refreshDerivedViews(saved.recoveryDraft);
  }

  private clearRecoveryIfSaved(): void {
    const saved = this.vscode?.getState?.() as RecoveryState | undefined;
    if (!saved?.recoveryDraft || saved.recoveryDraft !== this.currentMarkdown())
      return;
    this.vscode?.setState?.({});
    this.recoverButton.hidden = true;
  }

  private handleCopy(view: EditorView, event: ClipboardEvent): boolean {
    const selection = getCellSelection(view.state.selection);
    if (!selection || !event.clipboardData) return false;
    const matrix = tableSelectionMatrix(selection);
    if (!matrix) return false;
    event.clipboardData.setData("text/plain", matrixToTsv(matrix));
    event.clipboardData.setData("text/html", matrixToHtml(matrix, this.schema));
    event.clipboardData.setData(
      TABLE_CLIPBOARD_MIME,
      JSON.stringify({ values: matrix.values, cellJson: matrix.cellJson }),
    );
    event.preventDefault();
    return true;
  }

  private handleCut(view: EditorView, event: ClipboardEvent): boolean {
    if (!this.handleCopy(view, event)) return false;
    const selection = getCellSelection(view.state.selection);
    if (!selection) return true;
    const selected = selectedTableRect(selection);
    if (!selected) return true;
    const rows = Array.from(
      { length: selected.rect.bottom - selected.rect.top },
      () =>
        Array.from(
          { length: selected.rect.right - selected.rect.left },
          () => "",
        ),
    );
    const tableNode = replaceTableCells(
      selected.table,
      this.schema,
      selected.rect.top,
      selected.rect.left,
      rows,
    );
    this.dispatchTransaction(
      view.state.tr.replaceWith(
        selected.tableStart - 1,
        selected.tableStart - 1 + selected.table.nodeSize,
        tableNode,
      ),
    );
    return true;
  }

  private handlePaste(view: EditorView, event: ClipboardEvent): boolean {
    if (!event.clipboardData) return false;
    const context = tableContext(view.state.selection);
    if (!context) return false;
    if (this.profile === "commonmark") {
      this.setNotice("Table paste is unavailable in CommonMark.");
      event.preventDefault();
      return true;
    }
    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    const internal = parseInternalMatrix(
      event.clipboardData.getData(TABLE_CLIPBOARD_MIME),
    );
    const matrix =
      internal ??
      parseClipboardHtml(html) ??
      parseTsv(text) ??
      (text ? { values: [[text]], rows: 1, columns: 1 } : null);
    if (!matrix) return false;
    const selectedRows = context.rect.bottom - context.rect.top;
    const selectedColumns = context.rect.right - context.rect.left;
    if (
      (selectedRows > 1 || selectedColumns > 1) &&
      (matrix.rows !== selectedRows || matrix.columns !== selectedColumns)
    ) {
      this.setNotice(
        `Cannot paste ${matrix.rows}×${matrix.columns} cells into a ${selectedRows}×${selectedColumns} selection. Select one cell to expand the table or match the dimensions.`,
      );
      event.preventDefault();
      return true;
    }
    const tableNode = replaceTableCells(
      context.table,
      this.schema,
      context.rect.top,
      context.rect.left,
      matrix.values,
      matrix.cellJson,
    );
    this.dispatchTransaction(
      view.state.tr.replaceWith(
        context.tableStart - 1,
        context.tableStart - 1 + context.table.nodeSize,
        tableNode,
      ),
    );
    event.preventDefault();
    return true;
  }
}

export function createEditorApp(options: EditorAppOptions): MarkdownEditorApp {
  return new MarkdownEditorApp(options);
}

export {
  matrixToHtml,
  matrixToTsv,
  parseClipboardHtml,
  parseInternalMatrix,
  parseTsv,
  tableSelectionMatrix,
};
