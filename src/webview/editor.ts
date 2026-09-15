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
import {
  baseKeymap,
  chainCommands,
  exitCode,
  wrapIn,
} from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Fragment, type ResolvedPos, Node as PMNode } from "prosemirror-model";
import type { Schema } from "prosemirror-model";
import {
  EditorState,
  NodeSelection,
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
} from "prosemirror-schema-list";
import { liftTarget } from "prosemirror-transform";
import {
  isHostMessage,
  MAX_CLIPBOARD_TEXT_LENGTH,
  MAX_MARKDOWN_LENGTH,
  PROTOCOL_VERSION,
  type ClipboardResultMessage,
  type EditRejectedMessage,
  type PreviewMessage as HostPreviewMessage,
  type PreviewTypography,
  type SaveResultMessage,
} from "../shared/protocol";
import {
  createStarterPlugin,
  getStarterState,
  prepareStarterDocument,
  serializeStarterSource,
  setStarterMeta,
  type StarterPluginState,
} from "./starter";
import { createWritingInputRules } from "./input-rules";
import { BodyNavigation } from "./bodyNavigation";
import {
  BlockBoundarySelection,
  createBlockBoundaryPlugin,
  isBlockBoundary,
} from "./blockBoundary";
import { blockSourceEditor } from "./blockSourceEditing";
import { createDetailsNodeView } from "./detailsNodeView";
import {
  createAlertNodeView,
  createRenderedNodeView,
  createRenderingPlugin,
  setAlertBodyReadOnly,
  enhanceRenderedContent,
  ALERT_LOCAL_INPUT_META,
  type AlertBoundaryDirection,
  type AlertEditRequest,
  type AlertHistoryCommand,
  type RenderingEnhancer,
} from "./rendering";
import {
  ALERT_TYPES,
  alertSourceWithBody,
  alertSourceWithType,
  parseAlertSource,
  type AlertType,
} from "../core/alerts";
import { appendToolbarIcon, type ToolbarIconName } from "./icons";
import { createListCommand, type ListKind } from "./listCommands";
import {
  getToolbarActiveState,
  isToolbarMarkActive,
  type ToolbarActiveKey,
} from "./toolbarState";
import {
  createTableNumberingCommand,
  createTableNumberingPlugin,
  isTableNumbered,
} from "./tableNumbering";
import {
  PROFILE_FEATURES,
  createProfileFeatureCommand,
  getProfileFeatures,
  type ProfileFeatureDefinition,
  type ProfileFeatureId,
  type ProfileFeatureValues,
} from "./profileFeatures";
import {
  humanizeMermaidDiagramType,
  mermaidRuntimeVersionFromGlobal,
  MermaidValidationController,
  type MermaidValidationSnapshot,
} from "./mermaidValidation";
import {
  copyCodeText as copyClipboardText,
  enhanceCodeBlockControls,
  scheduleCodeLineNumberSync,
  type CodeBlockControlBinding,
  type CodeBlockControlOptions,
} from "./codeBlockControls";
import {
  codeControlIcon,
  codeLanguageIdentifier,
  codeLanguageIcon,
  codeLanguageMetadata,
  codeLanguageOptions,
  codeLanguageSuffix,
  isValidCodeLanguageIdentifier,
  replaceCodeLanguageIdentifier,
} from "../core/visualRendering";
import { isBlankSpacingNode } from "../core";
import { mergeMarkdownSnapshots } from "../shared/threeWayMerge";
import {
  createEmptyTableNode,
  createTableNodeFromMatrix,
  detectSpreadsheetPaste,
  cellFromClipboard,
  hasClipboardTableMarkup,
  matrixToHtml,
  matrixToTsv,
  MAX_CLIPBOARD_CELLS,
  parseClipboardHtml,
  parseClipboardHtmlWithStatus,
  parseInternalMatrix,
  parseInternalMatrixWithStatus,
  parseTsv,
  parseTsvWithStatus,
  TABLE_CLIPBOARD_MIME,
  tableSelectionMatrix,
} from "./tableClipboard";
import {
  ImageImportController,
  type ImageImportControllerOptions,
} from "./imageImport";

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
  documentId?: string;
  operationId?: string;
  reason?: string;
  resourceBaseUrl?: string;
  typography?: PreviewTypography;
  mode?: "editor" | "preview";
  clipboardAvailable?: boolean;
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
  documentId?: string;
  recoveryDraft?: string;
  recoveryBaseMarkdown?: string;
  recoveryBaseVersion?: number;
  recoveryVersion?: number;
  recoveryProfile?: DocumentProfile;
  recoveryTimestamp?: number;
  recoveryDocument?: unknown;
}

interface DerivedViewsOptions {
  renderPreview?: boolean;
  refreshCompatibility?: boolean;
}

interface PendingDerivedViews {
  markdown: string;
  profile: DocumentProfile;
  resourceBaseUrl: string | undefined;
  document: PMNode;
  revision: number;
}

export interface PendingEdit {
  operationId: string;
  baseVersion: number;
  baseMarkdown: string;
  markdown: string;
}

interface SavedSelection {
  from: number;
  to: number;
}

interface TransientBlankRange {
  /** Positions in the current document covering only generated paragraphs. */
  from: number;
  to: number;
  count: number;
}

interface BlockGapLayout {
  position: number;
  previousRect: DOMRect;
  nextRect: DOMRect;
}

interface TransientBlankTransactionMeta {
  kind: "append" | "discard";
  from?: number;
  to?: number;
  count?: number;
  /** The transaction also made a meaningful edit (for example, a table). */
  meaningful?: boolean;
}

type WritingPopupCloseReason = "discard" | "consume" | "cancel";
type PopupInputModality = "pointer" | "keyboard";

type LanguageInputModality = "pointer" | "keyboard";

interface SlashTrigger {
  selection: Selection;
  documentGeneration: number;
  profile: DocumentProfile;
}

interface TableDialogSelection {
  selection: Selection;
  doc: PMNode;
  version: number;
  profile: DocumentProfile;
  documentGeneration: number;
}

interface TableInsertionOptions {
  spreadsheetPaste?: boolean;
  onRejected?: () => void;
}

interface ProfileFeatureEditTarget {
  position: number;
  node: PMNode;
  document: PMNode;
  documentGeneration: number;
  profile: DocumentProfile;
  source: string;
  returnFocus: HTMLElement | null;
  bodySelection?: [number, number, "forward" | "backward" | "none"] | undefined;
}

type TableToolbarAction =
  | "row-above"
  | "row-below"
  | "row-delete"
  | "col-left"
  | "col-right"
  | "col-delete"
  | "align-left"
  | "align-center"
  | "align-right"
  | "table-numbering"
  | "table-delete";

const TRANSIENT_BLANK_META = "markdown-mint-transient-blank";
const SPREADSHEET_TABLE_PASTE_META = "markdown-mint-spreadsheet-table-paste";

const COMMON_EMOJI: ReadonlyArray<{
  emoji: string;
  name: string;
  keywords: string;
}> = [
  { emoji: "😀", name: "grinning face", keywords: "smile happy" },
  { emoji: "😃", name: "grinning face with big eyes", keywords: "smile happy" },
  {
    emoji: "😄",
    name: "grinning face with smiling eyes",
    keywords: "smile happy",
  },
  { emoji: "😁", name: "beaming face", keywords: "smile happy" },
  { emoji: "😂", name: "face with tears of joy", keywords: "laugh funny" },
  { emoji: "🙂", name: "slightly smiling face", keywords: "smile" },
  { emoji: "😉", name: "winking face", keywords: "smile" },
  { emoji: "😍", name: "smiling face with heart eyes", keywords: "love" },
  { emoji: "🤔", name: "thinking face", keywords: "consider" },
  { emoji: "😎", name: "smiling face with sunglasses", keywords: "cool" },
  { emoji: "😭", name: "loudly crying face", keywords: "sad" },
  { emoji: "😡", name: "enraged face", keywords: "angry" },
  { emoji: "👍", name: "thumbs up", keywords: "approve yes" },
  { emoji: "👎", name: "thumbs down", keywords: "disapprove no" },
  { emoji: "👏", name: "clapping hands", keywords: "applause" },
  { emoji: "🙏", name: "folded hands", keywords: "please thanks" },
  { emoji: "💡", name: "light bulb", keywords: "idea" },
  { emoji: "✅", name: "check mark button", keywords: "done yes" },
  { emoji: "❌", name: "cross mark", keywords: "no delete" },
  { emoji: "⭐", name: "star", keywords: "favorite" },
  { emoji: "🔥", name: "fire", keywords: "hot" },
  { emoji: "🎉", name: "party popper", keywords: "celebrate" },
  { emoji: "🚀", name: "rocket", keywords: "launch" },
  { emoji: "❤️", name: "red heart", keywords: "love" },
  { emoji: "💔", name: "broken heart", keywords: "sad love" },
  { emoji: "✨", name: "sparkles", keywords: "magic" },
  { emoji: "🎯", name: "bullseye", keywords: "target" },
  { emoji: "📌", name: "pushpin", keywords: "pin" },
  { emoji: "📎", name: "paperclip", keywords: "attachment" },
  { emoji: "💬", name: "speech balloon", keywords: "comment" },
];

const editorPluginKey = new PluginKey("markdown-mint-editor");
let nextCodeLanguagePickerId = 0;

function newOperationId(): string {
  const cryptoApi = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `mm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isMac(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
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

function derivedStateKey(
  markdown: string,
  profile: DocumentProfile,
  resourceBaseUrl?: string,
): string {
  return JSON.stringify([markdown, profile, resourceBaseUrl ?? ""]);
}

function compatibilityStateKey(
  markdown: string,
  profile: DocumentProfile,
): string {
  return JSON.stringify([markdown, profile]);
}

function getCellSelection(selection: Selection): CellSelection | null {
  return selection instanceof CellSelection ? selection : null;
}

function selectedTableRect(selection: CellSelection): {
  table: PMNode;
  map: TableMap;
  tableStart: number;
  cellPos: number;
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
    cellPos: selection.$anchorCell.pos,
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
  cellPos: number;
  rect: { top: number; left: number; bottom: number; right: number };
  cellSelection?: boolean;
}

type TableSelectionBookmark =
  | {
      kind: "cells";
      anchor: { row: number; column: number };
      head: { row: number; column: number };
    }
  | {
      kind: "text";
      row: number;
      column: number;
      anchorOffset: number;
      headOffset: number;
    };

/** Resolve both a CellSelection and an ordinary text cursor inside a cell. */
function tableContext(selection: Selection): TableContext | null {
  if (selection instanceof CellSelection) {
    const selected = selectedTableRect(selection);
    return selected ? { ...selected, cellSelection: true } : null;
  }
  const { $from, $to } = selection;
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
  if (!selection.empty) {
    let toTableDepth = -1;
    for (let depth = $to.depth; depth > 0; depth -= 1) {
      if ($to.node(depth).type.spec.tableRole === "table") {
        toTableDepth = depth;
        break;
      }
    }
    if (toTableDepth < 0 || $to.node(toTableDepth) !== table) return null;
  }
  const tableStart = $from.start(tableDepth);
  const map = TableMap.get(table);
  const cellPos = $from.before(cellDepth);
  const cellRect = map.findCell(cellPos - tableStart);
  return {
    table,
    map,
    tableStart,
    cellPos,
    rect: {
      top: cellRect.top,
      left: cellRect.left,
      bottom: cellRect.bottom,
      right: cellRect.right,
    },
    cellSelection: false,
  };
}

function activeTableCell(
  selection: Selection,
  context: TableContext,
): ReturnType<TableMap["findCell"]> {
  const cellPos =
    selection instanceof CellSelection
      ? selection.$headCell.pos
      : context.cellPos;
  return context.map.findCell(cellPos - context.tableStart);
}

function textSelectionInTableCell(
  doc: PMNode,
  tableStart: number,
  map: TableMap,
  table: PMNode,
  row: number,
  column: number,
): Selection {
  const safeRow = Math.max(0, Math.min(map.height - 1, row));
  const safeColumn = Math.max(0, Math.min(map.width - 1, column));
  const cellPos = tableStart + map.positionAt(safeRow, safeColumn, table);
  return TextSelection.near(doc.resolve(cellPos + 1), 1);
}

function selectionTouchesTable(selection: Selection): boolean {
  if (tableContext(selection)) return true;
  for (let depth = selection.$to.depth; depth > 0; depth -= 1) {
    if (selection.$to.node(depth).type.spec.tableRole === "table") return true;
  }
  if (selection.empty) return false;
  let touches = false;
  selection.$from.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.spec.tableRole === "table") touches = true;
    return !touches;
  });
  return touches;
}

function selectionForDocument(selection: Selection, doc: PMNode): Selection {
  if (selection instanceof BlockBoundarySelection) {
    const position = Math.max(0, Math.min(selection.head, doc.content.size));
    if (isBlockBoundary(doc, position))
      return new BlockBoundarySelection(doc.resolve(position));
  }
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

function isTextOrientedPasteTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "textarea, input, .mm-source-textarea, .mm-alert-body-editor, .mm-code-block-pre, .mm-code-block-view, .mm-rendered-node, .mm-diagram-source, .mm-math-block",
    ),
  );
}

function isTextOrientedPasteSelection(selection: Selection): boolean {
  if (
    selection instanceof NodeSelection &&
    ["code_block", "raw_block", "raw_inline"].includes(selection.node.type.name)
  )
    return true;
  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    if (
      ["code_block", "raw_block", "raw_inline"].includes(
        selection.$from.node(depth).type.name,
      )
    )
      return true;
  }
  return false;
}

function readClipboardData(clipboard: DataTransfer, type: string): string {
  try {
    const value = clipboard.getData(type);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
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
    const { from, to } = state.selection;
    const active = isToolbarMarkActive(state, state.selection, markName);
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

    if (typeName === "blockquote") {
      const sharedBlockquoteDepth = (
        from: ResolvedPos,
        to: ResolvedPos,
      ): number | null => {
        const maxDepth = Math.min(from.depth, to.depth);
        for (let depth = maxDepth; depth > 0; depth -= 1) {
          if (from.node(depth).type.name !== "blockquote") continue;
          if (from.node(depth) !== to.node(depth)) continue;
          return depth;
        }
        return null;
      };

      const quoteDepth = sharedBlockquoteDepth(
        state.selection.$from,
        state.selection.$to,
      );
      if (quoteDepth !== null) {
        if (!dispatch) return true;
        const quoteNode = state.selection.$from.node(quoteDepth);
        const quoteRange = state.selection.$from.blockRange(
          state.selection.$to,
          (node) => node === quoteNode,
        );
        const target = quoteRange ? liftTarget(quoteRange) : null;
        if (!quoteRange || target === null) return false;
        dispatch(state.tr.lift(quoteRange, target).scrollIntoView());
        return true;
      }

      return dispatch
        ? wrapIn(type)(state, (tr) => dispatch(tr.scrollIntoView()))
        : wrapIn(type)(state);
    }

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

function movePopupFocusIndex(
  items: readonly HTMLButtonElement[],
  currentIndex: number,
  delta: number,
): number {
  if (!items.length || delta === 0) return -1;
  const count = items.length;
  const current = currentIndex >= 0 && currentIndex < count ? currentIndex : 0;
  for (let attempt = 0; attempt < count; attempt += 1) {
    const candidate =
      (((current + delta * (attempt + 1)) % count) + count) % count;
    if (!items[candidate]?.disabled) return candidate;
  }
  return -1;
}

function topLevelRangeNodes(
  doc: PMNode,
  range: TransientBlankRange,
): Array<{ node: PMNode; from: number; to: number }> {
  const result: Array<{ node: PMNode; from: number; to: number }> = [];
  let position = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const node = doc.child(index);
    const end = position + node.nodeSize;
    if (end > range.from && position < range.to)
      result.push({ node, from: position, to: end });
    position = end;
  }
  return result;
}

function removeTopLevelRange(doc: PMNode, range: TransientBlankRange): PMNode {
  const children: PMNode[] = [];
  let position = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const node = doc.child(index);
    const end = position + node.nodeSize;
    if (!(end > range.from && position < range.to)) children.push(node);
    position = end;
  }
  return doc.copy(Fragment.fromArray(children));
}

class TaskItemNodeView {
  readonly dom: HTMLLIElement;
  readonly contentDOM: HTMLElement;
  private readonly checkbox: HTMLInputElement;
  private checkedState: unknown;
  private taskAttrs: Record<string, unknown>;
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
    this.dom.className = "mm-task-item";
    const control = document.createElement("span");
    this.control = control;
    control.className = "mm-task-control";
    this.checkbox = document.createElement("input");
    this.checkbox.type = "checkbox";
    this.checkbox.className = "mm-task-checkbox";
    this.taskAttrs = { ...node.attrs };
    this.updateCheckboxState(node.attrs.checked);
    const isTask = node.attrs.checked != null;
    this.dom.classList.toggle("mm-task-task", isTask);
    if (!isTask) {
      control.hidden = true;
      this.dom.classList.add("mm-plain-list-item");
    }
    this.checkbox.addEventListener("mousedown", (event) =>
      event.stopPropagation(),
    );
    this.checkbox.addEventListener("change", () => {
      const position = this.getPos();
      if (position === undefined) return;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(position, undefined, {
          ...this.taskAttrs,
          checked: this.checkedState === "mixed" ? true : this.checkbox.checked,
        }),
      );
    });
    control.append(this.checkbox);
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "mm-task-content";
    this.dom.append(control, this.contentDOM);
  }

  private updateCheckboxState(value: unknown): void {
    this.checkedState = value;
    const mixed = value === "mixed";
    const checked = value === true;
    this.checkbox.checked = checked;
    this.checkbox.indeterminate = mixed;
    if (mixed) this.checkbox.dataset.taskState = "mixed";
    else delete this.checkbox.dataset.taskState;
    this.checkbox.setAttribute(
      "aria-checked",
      mixed ? "mixed" : String(checked),
    );
    this.checkbox.setAttribute(
      "aria-label",
      mixed
        ? "Resolve mixed task state"
        : checked
          ? "Mark task incomplete"
          : "Mark task complete",
    );
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "list_item") return false;
    this.taskAttrs = { ...node.attrs };
    this.updateCheckboxState(node.attrs.checked);
    const isTask = node.attrs.checked != null;
    this.dom.classList.toggle("mm-task-task", isTask);
    this.dom.classList.toggle("mm-plain-list-item", !isTask);
    this.control.hidden = !isTask;
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === "selection") return false;
    return !this.contentDOM.contains(mutation.target);
  }
}

class CodeBlockNodeView {
  readonly dom: HTMLDivElement;
  readonly contentDOM: HTMLElement;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly card: HTMLDivElement;
  private readonly languageInput: HTMLInputElement;
  private readonly languageIcon: HTMLSpanElement;
  private readonly languageLabel: HTMLSpanElement;
  private readonly languageTrigger: HTMLButtonElement;
  private readonly languageMenu: HTMLDivElement;
  private readonly languageOutsideHandler: (event: MouseEvent) => void;
  private readonly lineNumbers: HTMLDivElement;
  private readonly controls: CodeBlockControlBinding;
  private languageRemovalDialog: HTMLDialogElement | null = null;
  private languagePickerOpen = false;
  private languageActiveIndex = -1;
  private languageInputModality: LanguageInputModality = "pointer";
  private languageQuery = "";
  private destroyed = false;
  private languageStartInfo: string | null = null;
  private languageStartNode: PMNode | null = null;
  private languageComposing = false;
  private languageCompositionEndedAt = -Infinity;
  private readonly canEdit: () => boolean;
  private readonly handleBlockClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Code text and its preformatted surface retain native caret, drag, and
    // word selection. Controls own their events and stop them before this
    // listener; the closest check also covers menu/input descendants.
    if (
      target.closest(
        ".mm-code-block-pre, .mm-code-language-control, .mm-code-block-actions, .mm-code-menu, button, a, input, select, textarea, dialog",
      )
    )
      return;
    const position = this.positionOf();
    if (position === undefined) return;
    const node = this.view.state.doc.nodeAt(position);
    if (!node || node.type.name !== "code_block") return;
    let selection: NodeSelection;
    try {
      selection = NodeSelection.create(this.view.state.doc, position);
    } catch {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (
      this.view.state.selection instanceof NodeSelection &&
      this.view.state.selection.from === selection.from &&
      this.view.state.selection.to === selection.to
    )
      return;
    this.view.dispatch(
      this.view.state.tr.setSelection(selection).setMeta("addToHistory", false),
    );
  };

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    controlOptions: CodeBlockControlOptions = {},
    canEdit: () => boolean = () => view.editable,
    private readonly preserveDraft: (
      draft: string,
      message: string,
    ) => void = () => undefined,
  ) {
    this.view = view;
    this.getPos = getPos;
    this.canEdit = canEdit;
    this.dom = document.createElement("div");
    this.dom.className = "mm-code-block-view";
    this.card = document.createElement("div");
    this.card.className = "mm-code-block";
    this.dom.append(this.card);

    const header = document.createElement("div");
    header.className = "mm-code-block-header";
    const languageControl = document.createElement("div");
    languageControl.className = "mm-code-language-control";
    languageControl.setAttribute("data-mm-code-language-control", "true");
    this.languageIcon = document.createElement("span");
    this.languageIcon.className = "mm-code-language-icon";
    this.languageIcon.setAttribute("aria-hidden", "true");
    this.languageLabel = document.createElement("span");
    this.languageLabel.className = "mm-code-language-label";
    this.languageLabel.setAttribute("aria-hidden", "true");
    this.languageTrigger = document.createElement("button");
    this.languageTrigger.type = "button";
    this.languageTrigger.className = "mm-code-language-trigger";
    this.languageTrigger.setAttribute("aria-haspopup", "listbox");
    this.languageTrigger.setAttribute("aria-expanded", "false");
    this.languageTrigger.append(this.languageIcon, this.languageLabel);
    const languageChevron = document.createElement("span");
    languageChevron.className = "mm-code-language-chevron";
    languageChevron.append(
      document
        .createRange()
        .createContextualFragment(codeControlIcon("chevron")),
    );
    languageChevron.setAttribute("aria-hidden", "true");
    this.languageTrigger.append(languageChevron);
    this.languageMenu = document.createElement("div");
    this.languageMenu.className = "mm-code-language-menu";
    this.languageMenu.id = `mm-code-language-${++nextCodeLanguagePickerId}`;
    this.languageMenu.hidden = true;
    this.languageMenu.setAttribute("role", "listbox");
    this.languageMenu.setAttribute("aria-label", "Code block languages");
    this.languageInput = document.createElement("input");
    this.languageInput.className = "mm-code-language mm-code-language-inline";
    this.languageInput.type = "text";
    this.languageInput.placeholder = "Search or enter language";
    this.languageInput.spellcheck = false;
    this.languageInput.autocomplete = "off";
    this.languageInput.setAttribute("role", "combobox");
    this.languageInput.setAttribute("aria-autocomplete", "list");
    this.languageTrigger.setAttribute("aria-controls", this.languageMenu.id);
    this.languageInput.setAttribute(
      "aria-controls",
      `${this.languageMenu.id}-options`,
    );
    this.languageInput.setAttribute("aria-expanded", "false");
    this.languageMenu.append(this.languageInput);
    this.languageTrigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleLanguagePicker();
    });
    this.languageTrigger.addEventListener("mousedown", (event) =>
      event.stopPropagation(),
    );
    this.languageInput.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      if (!this.languagePickerOpen) this.openLanguagePicker();
    });
    this.languageInput.addEventListener("input", () => {
      this.setLanguageInputModality("keyboard");
      this.languageQuery = this.languageInput.value;
      this.languageActiveIndex = this.languageQuery.trim() ? 0 : -1;
      this.renderLanguageOptions();
    });
    this.languageInput.addEventListener("keydown", (event) =>
      this.handleLanguageKeyDown(event),
    );
    this.languageInput.addEventListener("compositionstart", () => {
      this.languageComposing = true;
    });
    this.languageInput.addEventListener("compositionend", () => {
      this.languageComposing = false;
      this.languageCompositionEndedAt = Date.now();
    });
    this.languageMenu.addEventListener("pointermove", () => {
      this.setLanguageInputModality("pointer");
    });
    this.languageMenu.addEventListener("pointerdown", () => {
      this.setLanguageInputModality("pointer");
    });
    this.languageMenu.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const option = target.closest<HTMLButtonElement>(
        "[data-mm-language-option]",
      );
      if (!option) return;
      event.preventDefault();
      this.commitLanguageInput(option.dataset.mmLanguageOption ?? "");
    });
    this.languageOutsideHandler = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Node && languageControl.contains(target)) return;
      this.closeLanguagePicker(false);
    };
    document.addEventListener("pointerdown", this.languageOutsideHandler);
    languageControl.append(this.languageTrigger, this.languageMenu);

    const actions = document.createElement("div");
    actions.className = "mm-code-block-actions";
    const copy = this.createActionButton("copy", "Copy");
    const separator = document.createElement("span");
    separator.className = "mm-code-action-separator";
    separator.setAttribute("aria-hidden", "true");
    const expand = this.createActionButton("expand", "Expand");
    const more = this.createActionButton("more", "");
    more.classList.add("mm-code-action-more");
    actions.append(copy, separator, expand, more);
    header.append(languageControl, actions);
    this.card.append(header);

    const body = document.createElement("div");
    body.className = "mm-code-block-body";
    this.lineNumbers = document.createElement("div");
    this.lineNumbers.className = "mm-code-line-numbers";
    this.lineNumbers.setAttribute("aria-hidden", "true");
    const pre = document.createElement("pre");
    pre.className = "mm-code-block-pre";
    const code = document.createElement("code");
    this.contentDOM = code;
    pre.append(code);
    body.append(this.lineNumbers, pre);
    this.card.append(body);

    this.update(node);
    this.controls = enhanceCodeBlockControls(this.card, {
      ...controlOptions,
      getCodeText: () => this.currentCodeText(),
    });
    this.dom.addEventListener("click", this.handleBlockClick);
  }

  private createActionButton(
    action: "copy" | "expand" | "more",
    label: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mm-code-action";
    button.dataset.mmCodeAction = action;
    button.setAttribute(
      "aria-label",
      label ? `${label} code` : "More code block actions",
    );
    button.title = label ? label : "More code block actions";
    const icon = document.createElement("span");
    icon.className = "mm-code-action-icon";
    icon.append(
      document
        .createRange()
        .createContextualFragment(
          codeControlIcon(action === "more" ? "more" : action),
        ),
    );
    button.append(icon);
    if (label) {
      const text = document.createElement("span");
      text.className = "mm-code-action-label";
      text.textContent = label;
      button.append(text);
    }
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    return button;
  }

  private currentCodeText(): string {
    const position = this.positionOf();
    if (position === undefined) return this.contentDOM.textContent ?? "";
    const node = this.view.state.doc.nodeAt(position);
    return node?.type.name === "code_block"
      ? node.textContent
      : (this.contentDOM.textContent ?? "");
  }

  private positionOf(): number | undefined {
    try {
      return this.getPos();
    } catch {
      return undefined;
    }
  }

  private toggleLanguagePicker(): void {
    if (this.languagePickerOpen) this.closeLanguagePicker(false);
    else this.openLanguagePicker();
  }

  private openLanguagePicker(): void {
    if (this.destroyed || !this.canEdit()) return;
    const position = this.positionOf();
    this.languageStartInfo =
      position === undefined
        ? null
        : String(this.view.state.doc.nodeAt(position)?.attrs.params ?? "");
    this.languageStartNode =
      position === undefined ? null : this.view.state.doc.nodeAt(position);
    this.languagePickerOpen = true;
    this.languageQuery = "";
    this.languageActiveIndex = -1;
    this.setLanguageInputModality("pointer");
    this.languageInput.value = "";
    this.languageMenu.hidden = false;
    const control = this.languageTrigger.parentElement;
    const viewportHeight = this.dom.ownerDocument.defaultView?.innerHeight ?? 0;
    const controlRect = control?.getBoundingClientRect();
    const shouldOpenUp =
      Boolean(controlRect) &&
      viewportHeight > 0 &&
      controlRect!.bottom + Math.min(420, viewportHeight - 40) >
        viewportHeight &&
      controlRect!.top > Math.min(420, viewportHeight - 40);
    this.languageMenu.classList.toggle(
      "mm-code-language-menu-up",
      shouldOpenUp,
    );
    this.languageTrigger.setAttribute("aria-expanded", "true");
    this.languageInput.setAttribute("aria-expanded", "true");
    this.renderLanguageOptions();
    this.languageInput.focus();
  }

  private closeLanguagePicker(restoreFocus: boolean): void {
    if (!this.languagePickerOpen) return;
    this.languagePickerOpen = false;
    this.languageQuery = "";
    this.languageActiveIndex = -1;
    this.setLanguageInputModality("pointer");
    this.languageMenu.hidden = true;
    this.languageMenu.removeAttribute("data-input-modality");
    this.languageTrigger.setAttribute("aria-expanded", "false");
    this.languageInput.setAttribute("aria-expanded", "false");
    const position = this.positionOf();
    const node =
      position === undefined ? undefined : this.view.state.doc.nodeAt(position);
    this.languageInput.value = String(node?.attrs.params ?? "");
    this.languageInput.removeAttribute("aria-activedescendant");
    this.languageInput.removeAttribute("data-mm-language-error");
    if (restoreFocus) this.languageTrigger.focus();
  }

  private filteredLanguageOptions(): Array<
    ReturnType<typeof codeLanguageMetadata>
  > {
    const query = this.languageQuery.trim().toLowerCase();
    const options = [...codeLanguageOptions()];
    if (!query) return options;
    return options
      .map((option, index) => {
        const values = [option.identifier, option.label, ...option.aliases]
          .join(" ")
          .toLowerCase();
        const exactName = [option.identifier, option.label].some(
          (value) => value.toLowerCase() === query,
        );
        const exactAlias = option.aliases.some(
          (value) => value.toLowerCase() === query,
        );
        const starts = values.startsWith(query);
        const includes = values.includes(query);
        return {
          option,
          index,
          score: exactName ? 0 : exactAlias ? 1 : starts ? 2 : includes ? 3 : 9,
        };
      })
      .filter((entry) => entry.score < 9)
      .sort(
        (left, right) => left.score - right.score || left.index - right.index,
      )
      .map((entry) => entry.option);
  }

  private renderLanguageOptions(): void {
    const previous = this.languageMenu.querySelector(
      ".mm-code-language-options",
    );
    previous?.remove();
    const list = document.createElement("div");
    list.className = "mm-code-language-options";
    list.id = `${this.languageMenu.id}-options`;
    const currentPosition = this.positionOf();
    const currentInfo =
      currentPosition === undefined
        ? ""
        : String(
            this.view.state.doc.nodeAt(currentPosition)?.attrs.params ?? "",
          );
    const currentIdentifier = codeLanguageIdentifier(currentInfo).toLowerCase();
    const options = this.filteredLanguageOptions().slice();
    const query = this.languageQuery.trim();
    const currentMetadata = codeLanguageMetadata(currentInfo);
    const hasCurrentIdentifier = options.some(
      (option) => option.identifier.toLowerCase() === currentIdentifier,
    );
    if (
      currentMetadata.kind === "custom" &&
      !options.some(
        (option) =>
          option.identifier.toLowerCase() ===
          currentMetadata.identifier.toLowerCase(),
      ) &&
      (!query ||
        currentMetadata.identifier.toLowerCase().includes(query.toLowerCase()))
    ) {
      options.unshift(currentMetadata);
    }
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mm-code-language-option";
      if (option.kind === "custom")
        button.classList.add("mm-code-language-custom");
      const queryIdentifier = query.toLowerCase();
      const queryAlias =
        query &&
        isValidCodeLanguageIdentifier(query) &&
        option.identifier.toLowerCase() !== queryIdentifier &&
        option.aliases.includes(queryIdentifier)
          ? query
          : undefined;
      const selectedIdentifier = option.aliases.includes(currentIdentifier)
        ? codeLanguageIdentifier(currentInfo)
        : (queryAlias ?? option.identifier);
      button.dataset.mmLanguageOption = selectedIdentifier;
      button.setAttribute("role", "option");
      button.setAttribute(
        "aria-selected",
        String(
          option.identifier.toLowerCase() === currentIdentifier ||
            (!hasCurrentIdentifier &&
              option.aliases.some((alias) => alias === currentIdentifier)),
        ),
      );
      const text = document.createElement("span");
      text.className = "mm-code-language-option-text";
      text.textContent =
        option.kind === "unspecified"
          ? "Language not specified"
          : option.kind === "custom"
            ? `Use “${option.identifier}”`
            : option.label;
      if (option.kind === "custom") {
        const help = document.createElement("small");
        help.className = "mm-code-language-option-help";
        help.textContent =
          "Highlighting is unavailable; the language name will be preserved.";
        button.append(text, help);
      } else {
        button.append(text);
      }
      list.append(button);
    }
    const hasExact = options.some((option) =>
      [option.identifier, option.label, ...option.aliases].some(
        (value) => value.toLowerCase() === query.toLowerCase(),
      ),
    );
    if (query && isValidCodeLanguageIdentifier(query) && !hasExact) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mm-code-language-option mm-code-language-custom";
      button.dataset.mmLanguageOption = query;
      button.setAttribute("role", "option");
      const text = document.createElement("span");
      text.className = "mm-code-language-option-text";
      text.textContent = `Use “${query}”`;
      const detail = document.createElement("small");
      detail.className = "mm-code-language-option-help";
      detail.textContent =
        "Highlighting is unavailable; the language name will be preserved.";
      button.append(text, detail);
      list.prepend(button);
    }
    this.languageMenu.append(list);
    const buttons = list.querySelectorAll<HTMLButtonElement>(
      "[data-mm-language-option]",
    );
    if (buttons.length === 0 || this.languageActiveIndex < 0)
      this.languageActiveIndex = -1;
    else
      this.languageActiveIndex = Math.min(
        this.languageActiveIndex,
        buttons.length - 1,
      );
    buttons.forEach((button, index) => {
      const id = `${this.languageMenu.id}-option-${index}`;
      button.id = id;
      button.classList.toggle("is-active", index === this.languageActiveIndex);
    });
    const active = buttons[this.languageActiveIndex];
    if (active)
      this.languageInput.setAttribute("aria-activedescendant", active.id);
    else this.languageInput.removeAttribute("aria-activedescendant");
  }

  private commitLanguageInput(identifier?: string): void {
    if (this.languageInput.matches(":disabled")) return;
    const value = (identifier ?? this.languageInput.value).trim();
    if (value && !isValidCodeLanguageIdentifier(value)) {
      this.languageInput.setAttribute(
        "data-mm-language-error",
        "Language identifiers cannot contain whitespace, controls, or fences.",
      );
      return;
    }
    const result = this.setCodeLanguage(value);
    if (result === "conflict") return;
    this.closeLanguagePicker(result === "confirmation" ? false : true);
  }

  private handleLanguageKeyDown(event: KeyboardEvent): void {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      this.languageComposing ||
      (event.key === "Enter" &&
        Date.now() - this.languageCompositionEndedAt < 50)
    )
      return;
    const buttons = Array.from(
      this.languageMenu.querySelectorAll<HTMLButtonElement>(
        "[data-mm-language-option]",
      ),
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.setLanguageInputModality("keyboard");
      this.languageActiveIndex = Math.min(
        buttons.length - 1,
        this.languageActiveIndex + 1,
      );
      this.renderLanguageOptions();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.setLanguageInputModality("keyboard");
      this.languageActiveIndex = Math.max(0, this.languageActiveIndex - 1);
      this.renderLanguageOptions();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = buttons[this.languageActiveIndex];
      if (!active && !this.languageInput.value.trim()) {
        this.closeLanguagePicker(true);
        return;
      }
      this.commitLanguageInput(active?.dataset.mmLanguageOption);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.closeLanguagePicker(true);
    } else if (event.key === "Tab") {
      this.closeLanguagePicker(false);
    }
  }

  private setLanguageInputModality(modality: LanguageInputModality): void {
    this.languageInputModality = modality;
    this.languageMenu.dataset.inputModality = modality;
    if (modality !== "pointer") return;
    this.languageActiveIndex = -1;
    this.languageMenu
      .querySelectorAll<HTMLElement>(".mm-code-language-option.is-active")
      .forEach((option) => option.classList.remove("is-active"));
    this.languageInput.removeAttribute("aria-activedescendant");
  }

  private updateLanguagePresentation(language: string): void {
    const metadata = codeLanguageMetadata(language);
    const label = metadata.label;
    this.languageIcon.textContent = codeLanguageIcon(language);
    this.languageLabel.textContent = label;
    this.card.dataset.mmCodeLanguage = label;
    this.card.dataset.mmCodeLanguageKind = metadata.kind;
    this.languageTrigger.setAttribute(
      "aria-label",
      `Code block language: ${label}`,
    );
    this.languageInput.setAttribute(
      "aria-label",
      `Code block language: ${label}`,
    );
  }

  private updateLineNumbers(source: string): void {
    const count = Math.max(1, source.split(/\r\n|\r|\n/).length);
    const boundedCount = Math.min(count, 10_000);
    const fragment = this.dom.ownerDocument.createDocumentFragment();
    for (let index = 0; index < boundedCount; index += 1) {
      const line = this.dom.ownerDocument.createElement("span");
      line.textContent = String(index + 1);
      fragment.append(line);
    }
    this.lineNumbers.replaceChildren(fragment);
  }

  private setCodeLanguage(
    language: string,
  ): "applied" | "unchanged" | "confirmation" | "conflict" {
    if (!this.canEdit()) return "unchanged";
    const position = this.positionOf();
    if (position === undefined) return "unchanged";
    const current = this.view.state.doc.nodeAt(position);
    if (!current || current.type.name !== "code_block") return "unchanged";
    if (language && !isValidCodeLanguageIdentifier(language))
      return "unchanged";
    const currentInfo = String(current.attrs.params ?? "");
    if (
      this.languageStartNode &&
      (current !== this.languageStartNode ||
        currentInfo !== this.languageStartInfo)
    ) {
      this.languageInput.setAttribute(
        "data-mm-language-error",
        "The language changed externally; reopen the picker to edit the current value.",
      );
      this.languageInput.setAttribute("aria-invalid", "true");
      this.languageInput.title =
        "The block changed while the language picker was open. Your input is kept here to copy; reopen the picker to use the current block.";
      return "conflict";
    }
    const nextInfo = language
      ? replaceCodeLanguageIdentifier(currentInfo, language)
      : "";
    if (nextInfo === currentInfo) return "unchanged";
    if (!language && codeLanguageSuffix(currentInfo).trim()) {
      this.openLanguageRemovalConfirmation(currentInfo);
      return "confirmation";
    }
    this.applyCodeLanguage(position, current, nextInfo);
    return "applied";
  }

  private applyCodeLanguage(
    position: number,
    current: PMNode,
    nextInfo: string,
  ): void {
    if (!this.canEdit()) return;
    this.view.focus();
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...current.attrs,
        params: nextInfo,
      }),
    );
  }

  private openLanguageRemovalConfirmation(currentInfo: string): void {
    this.closeLanguageRemovalConfirmation(false);
    const ownerDocument = this.dom.ownerDocument;
    const dialog = ownerDocument.createElement("dialog");
    dialog.className = "mm-input-dialog mm-code-language-confirm-dialog";
    const title = ownerDocument.createElement("h2");
    title.id = `${this.languageMenu.id}-confirm-title`;
    title.textContent = "Remove code block language?";
    dialog.setAttribute("aria-labelledby", title.id);
    const help = ownerDocument.createElement("p");
    help.className = "mm-code-language-confirm-help";
    help.textContent = "This code block also contains additional info:";
    const info = ownerDocument.createElement("div");
    info.className = "mm-code-language-confirm-info";
    info.textContent = codeLanguageSuffix(currentInfo).trim();
    const warning = ownerDocument.createElement("p");
    warning.className = "mm-code-language-confirm-help";
    warning.textContent =
      "Markdown cannot safely preserve this metadata without a language identifier.";
    const actions = ownerDocument.createElement("div");
    actions.className = "mm-dialog-actions";
    const cancel = ownerDocument.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () =>
      this.closeLanguageRemovalConfirmation(true),
    );
    const confirm = ownerDocument.createElement("button");
    confirm.type = "submit";
    confirm.className = "mm-dialog-primary";
    confirm.textContent = "Remove language and metadata";
    actions.append(cancel, confirm);
    const form = ownerDocument.createElement("form");
    form.className = "mm-dialog-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.closeLanguageRemovalConfirmation(false);
      const position = this.positionOf();
      const current =
        position === undefined
          ? undefined
          : this.view.state.doc.nodeAt(position);
      if (
        position === undefined ||
        !current ||
        current.type.name !== "code_block" ||
        String(current.attrs.params ?? "") !== currentInfo
      )
        return;
      this.applyCodeLanguage(position, current, "");
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeLanguageRemovalConfirmation(true);
    });
    form.append(title, help, info, warning, actions);
    dialog.append(form);
    this.dom.append(dialog);
    this.languageRemovalDialog = dialog;
    try {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "true");
    } catch {
      dialog.setAttribute("open", "true");
    }
    cancel.focus();
  }

  private closeLanguageRemovalConfirmation(restoreFocus: boolean): void {
    const dialog = this.languageRemovalDialog;
    if (!dialog) return;
    this.languageRemovalDialog = null;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    dialog.remove();
    if (restoreFocus && !this.destroyed) this.languageTrigger.focus();
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "code_block") return false;
    const language = String(node.attrs.params ?? "");
    if (!this.languagePickerOpen && this.languageInput.value !== language)
      this.languageInput.value = language;
    this.card.dataset.mmCodeInfo = language;
    this.updateLanguagePresentation(language);
    this.updateLineNumbers(node.textContent);
    scheduleCodeLineNumberSync(this.card);
    return true;
  }

  stopEvent(event: Event): boolean {
    return (
      event.target instanceof Element &&
      event.target.closest("input,select,textarea,button") !== null
    );
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === "selection") return false;
    return !this.contentDOM.contains(mutation.target);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.languagePickerOpen && this.languageInput.value)
      this.preserveDraft(
        this.languageInput.value,
        "The code block was removed or reloaded. Your language draft was preserved.",
      );
    this.closeLanguagePicker(false);
    this.closeLanguageRemovalConfirmation(false);
    document.removeEventListener("pointerdown", this.languageOutsideHandler);
    this.dom.removeEventListener("click", this.handleBlockClick);
    this.controls.dispose();
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
    const width = safeImageDimensionValue(node.attrs.width);
    const height = safeImageDimensionValue(node.attrs.height);
    if (width) {
      this.dom.setAttribute("width", width);
      this.dom.style.width = width;
    } else {
      this.dom.removeAttribute("width");
      this.dom.style.removeProperty("width");
    }
    if (height) {
      this.dom.setAttribute("height", height);
      this.dom.style.height = height;
    } else {
      this.dom.removeAttribute("height");
      this.dom.style.removeProperty("height");
    }
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return (
      mutation.type === "attributes" &&
      (mutation.attributeName === "src" ||
        mutation.attributeName === "width" ||
        mutation.attributeName === "height" ||
        mutation.attributeName === "style")
    );
  }
}

function safeImageDimensionValue(value: unknown): string | null {
  const candidate = String(value ?? "").trim();
  return /^\d+(?:\.\d+)?(?:px|%)?$/i.test(candidate) ? candidate : null;
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
  private static readonly maxRebaseAttempts = 3;
  private static readonly maxRebaseWindowMs = 30_000;
  private baseVersion: number;
  private authoritativeVersion: number;
  private authoritativeMarkdown: string;
  private pending: PendingEdit | null = null;
  private queued: PendingEdit | null = null;
  private blockedConflict: {
    baseMarkdown: string;
    localMarkdown: string;
    externalMarkdown: string;
    externalVersion: number;
  } | null = null;
  private lastAcknowledged: PendingEdit | null = null;
  private rebaseAttempts = 0;
  private rebaseStartedAt = 0;
  private readonly vscode: VSCodeApiLike | undefined;

  constructor(
    version: number,
    vscode: VSCodeApiLike | undefined,
    initialMarkdown = "",
  ) {
    this.baseVersion = version;
    this.authoritativeVersion = version;
    this.authoritativeMarkdown = initialMarkdown;
    this.vscode = vscode;
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

  get hasBlockedConflict(): boolean {
    return this.blockedConflict !== null;
  }

  get draftBaseMarkdown(): string {
    return (
      this.pending?.baseMarkdown ??
      this.queued?.baseMarkdown ??
      this.lastAcknowledged?.baseMarkdown ??
      this.blockedConflict?.baseMarkdown ??
      this.authoritativeMarkdown
    );
  }

  get blockedDraft(): string | null {
    return this.blockedConflict?.localMarkdown ?? null;
  }

  isPendingOperation(operationId: string): boolean {
    return (
      this.pending?.operationId === operationId ||
      this.queued?.operationId === operationId
    );
  }

  private resetRebaseBudget(): void {
    this.rebaseAttempts = 0;
    this.rebaseStartedAt = 0;
  }

  setVersion(version: number): void {
    this.baseVersion = Math.max(this.baseVersion, version);
  }

  noteAuthoritative(version: number, markdown: string): void {
    if (version < this.authoritativeVersion) return;
    this.authoritativeVersion = version;
    this.baseVersion = Math.max(this.baseVersion, version);
    this.authoritativeMarkdown = markdown;
  }

  enqueue(markdown: string): PendingEdit {
    this.lastAcknowledged = null;
    const baseMarkdown =
      this.pending?.baseMarkdown ??
      this.queued?.baseMarkdown ??
      this.blockedConflict?.baseMarkdown ??
      this.authoritativeMarkdown;
    const baseVersion =
      this.pending?.baseVersion ??
      this.queued?.baseVersion ??
      this.blockedConflict?.externalVersion ??
      this.baseVersion;
    const edit: PendingEdit = {
      markdown,
      baseVersion,
      baseMarkdown,
      operationId: newOperationId(),
    };
    if (this.blockedConflict) {
      this.blockedConflict.localMarkdown = markdown;
      return edit;
    }
    if (this.pending) {
      this.queued = edit;
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
  }

  reject(operationId: string, version?: number): boolean {
    if (!this.pending || this.pending.operationId !== operationId) return false;
    this.pending = null;
    if (typeof version === "number")
      this.baseVersion = Math.max(this.baseVersion, version);
    return true;
  }

  fail(
    operationId: string,
    version: number,
    currentMarkdown: string,
    localMarkdown?: string,
  ): boolean {
    if (!this.pending || this.pending.operationId !== operationId) return false;
    const pending = this.pending;
    const local = localMarkdown ?? this.queued?.markdown ?? pending.markdown;
    this.pending = null;
    this.queued = null;
    this.lastAcknowledged = null;
    this.noteAuthoritative(version, currentMarkdown);
    this.resetRebaseBudget();
    this.blockedConflict = {
      baseMarkdown: pending.baseMarkdown,
      localMarkdown: local,
      externalMarkdown: currentMarkdown,
      externalVersion: version,
    };
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
    this.lastAcknowledged = this.pending;
    this.pending = null;
    this.resetRebaseBudget();
    if (typeof version === "number") {
      this.baseVersion = Math.max(this.baseVersion, version);
      if (markdown !== undefined) this.noteAuthoritative(version, markdown);
    }
    if (this.queued && !options.pauseQueue && !this.blockedConflict) {
      this.flushQueued();
    }
    return true;
  }

  acknowledgeSnapshot(
    version: number,
    markdown: string,
    options: { pauseQueue?: boolean } = {},
  ): boolean {
    if (
      !this.pending ||
      version <= this.pending.baseVersion ||
      markdown !== this.pending.markdown
    )
      return false;
    return this.acknowledge(
      this.pending.operationId,
      version,
      markdown,
      options,
    );
  }

  flushQueued(): PendingEdit | null {
    if (this.pending || !this.queued || this.blockedConflict) return null;
    const queued = this.queued;
    this.queued = null;
    queued.baseVersion = this.baseVersion;
    queued.baseMarkdown = this.authoritativeMarkdown;
    this.pending = queued;
    this.post(queued);
    return queued;
  }

  rebaseRejected(
    operationId: string,
    externalVersion: number,
    externalMarkdown: string,
    latestLocalMarkdown?: string,
  ): {
    kind: "merged" | "accepted" | "conflict" | "ignored";
    markdown: string;
  } {
    if (!this.pending || this.pending.operationId !== operationId)
      return { kind: "ignored", markdown: externalMarkdown };
    const pending = this.pending;
    const localMarkdown =
      latestLocalMarkdown ?? this.queued?.markdown ?? pending.markdown;
    const now = Date.now();
    if (this.rebaseStartedAt === 0) this.rebaseStartedAt = now;
    if (
      this.rebaseAttempts >= SyncController.maxRebaseAttempts ||
      now - this.rebaseStartedAt > SyncController.maxRebaseWindowMs
    ) {
      this.pending = null;
      this.queued = null;
      this.lastAcknowledged = null;
      this.noteAuthoritative(externalVersion, externalMarkdown);
      this.blockedConflict = {
        baseMarkdown: pending.baseMarkdown,
        localMarkdown,
        externalMarkdown,
        externalVersion,
      };
      return { kind: "conflict", markdown: localMarkdown };
    }
    this.rebaseAttempts += 1;
    return this.reconcile(
      pending.baseMarkdown,
      localMarkdown,
      externalVersion,
      externalMarkdown,
    );
  }

  reconcileExternal(
    externalVersion: number,
    externalMarkdown: string,
    localMarkdown?: string,
  ): {
    kind: "merged" | "accepted" | "conflict" | "ignored";
    markdown: string;
  } {
    if (externalVersion < this.authoritativeVersion)
      return { kind: "ignored", markdown: externalMarkdown };
    const baseMarkdown =
      this.lastAcknowledged?.baseMarkdown ??
      this.pending?.baseMarkdown ??
      this.queued?.baseMarkdown ??
      this.blockedConflict?.baseMarkdown ??
      this.authoritativeMarkdown;
    const local =
      localMarkdown ??
      this.queued?.markdown ??
      this.lastAcknowledged?.markdown ??
      this.pending?.markdown ??
      this.blockedConflict?.localMarkdown ??
      this.authoritativeMarkdown;
    return this.reconcile(
      baseMarkdown,
      local,
      externalVersion,
      externalMarkdown,
    );
  }

  private reconcile(
    baseMarkdown: string,
    localMarkdown: string,
    externalVersion: number,
    externalMarkdown: string,
  ): {
    kind: "merged" | "accepted" | "conflict" | "ignored";
    markdown: string;
  } {
    if (externalVersion < this.authoritativeVersion)
      return { kind: "ignored", markdown: externalMarkdown };
    const merged = mergeMarkdownSnapshots(
      baseMarkdown,
      localMarkdown,
      externalMarkdown,
    );
    this.pending = null;
    this.queued = null;
    this.lastAcknowledged = null;
    this.noteAuthoritative(externalVersion, externalMarkdown);
    if (merged === undefined) {
      this.blockedConflict = {
        baseMarkdown,
        localMarkdown,
        externalMarkdown,
        externalVersion,
      };
      return { kind: "conflict", markdown: localMarkdown };
    }
    this.blockedConflict = null;
    if (merged === externalMarkdown) {
      this.resetRebaseBudget();
      return { kind: "accepted", markdown: merged };
    }
    return { kind: "merged", markdown: merged };
  }

  clear(): void {
    this.pending = null;
    this.queued = null;
    this.lastAcknowledged = null;
    this.blockedConflict = null;
    this.resetRebaseBudget();
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
  private pendingRejectedEdit: EditRejectedMessage | null = null;
  private blockCompositionTimer: ReturnType<typeof setTimeout> | undefined;
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
  private serializationError: string | null = null;
  private lastNotificationKey: string | null = null;
  private reloadRequested = false;
  private formatting = false;
  private pendingSaveOperationId: string | undefined;
  private lastValidMarkdown = "";
  private authoritativeMarkdown: string;
  private authoritativeProfile: DocumentProfile;
  private authoritativeVersion: number;
  private documentId: string | undefined;
  private readonly compatibilityEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private clipboardAvailable = false;
  private readonly pendingClipboard = new Map<
    string,
    { resolve: (success: boolean) => void; timer?: number }
  >();
  private readonly imageImport: ImageImportController;
  private previewEnhancer: RenderingEnhancer | undefined;
  /**
   * The last Markdown snapshot produced for the current PM document.
   *
   * Display-only operations (for example switching to Preview immediately
   * after typing) must not serialize the same document again. The pointer is
   * deliberately bounded to the current document node; any real document
   * replacement or edit naturally invalidates it.
   */
  private serializedDocument: PMNode | null = null;
  private previewRenderKey: string | null = null;
  private previewUsesTextFallback = false;
  private compatibilityKey: string | null = null;
  private previewNeedsRefresh = true;
  private pendingDerivedViews: PendingDerivedViews | null = null;
  private derivedViewsTimer: ReturnType<typeof setTimeout> | undefined;
  private derivedViewsRevision = 0;
  private readonly sourceEl: HTMLTextAreaElement;
  private profileSelect!: HTMLSelectElement;
  private pendingProfile: {
    profile: DocumentProfile;
    operationId?: string;
  } | null = null;
  readonly sync: SyncController;
  private readonly messageHandler: (event: MessageEvent) => void;
  private savedSelection: SavedSelection | null = null;
  private headingSelection: Selection | null = null;
  private documentGeneration = 0;
  private starterOriginalSource: string | undefined;
  private linkDialog!: HTMLDialogElement;
  private linkUrlInput!: HTMLInputElement;
  private linkTextInput!: HTMLInputElement;
  private imageDialog!: HTMLDialogElement;
  private imageUrlInput!: HTMLInputElement;
  private imageAltInput!: HTMLInputElement;
  private emojiDialog!: HTMLDialogElement;
  private emojiSearchInput!: HTMLInputElement;
  private emojiGrid!: HTMLElement;
  private emojiSelection: Selection | null = null;
  private emojiDocumentGeneration = -1;
  private emojiProfile: DocumentProfile | null = null;
  private emojiInvokingButton: HTMLButtonElement | null = null;
  private emojiDialogOpen = false;
  private stage!: HTMLElement;
  private tableToolbar!: HTMLElement;
  private tableToolbarRevealed = false;
  private tableToolbarRevealRequested = false;
  private tableToolbarRevealTimer: ReturnType<typeof setTimeout> | undefined;
  private profileToolbar!: HTMLElement;
  private profileFeatureDialog!: HTMLDialogElement;
  private profileFeatureAlertType!: HTMLSelectElement;
  private profileFeatureTitleInput!: HTMLInputElement;
  private profileFeatureTermInput!: HTMLInputElement;
  private profileFeatureBodyInput!: HTMLTextAreaElement;
  private profileFeatureBodyLabel!: HTMLSpanElement;
  private profileFeatureMermaidMeta!: HTMLElement;
  private profileFeatureMermaidVersion!: HTMLSpanElement;
  private profileFeatureMermaidStatus!: HTMLSpanElement;
  private profileFeatureError!: HTMLElement;
  private profileFeatureApplyButton!: HTMLButtonElement;
  private mermaidValidation!: MermaidValidationController;
  private profileFeatureMermaidSnapshot: MermaidValidationSnapshot | null =
    null;
  private profileFeatureSelection: Selection | null = null;
  private profileFeatureDocumentGeneration = -1;
  private profileFeatureProfile: DocumentProfile | null = null;
  private profileFeatureInvokingButton: HTMLButtonElement | null = null;
  private profileFeatureEditTarget: ProfileFeatureEditTarget | null = null;
  private profileFeatureAlertNodeView: HTMLElement | null = null;
  private profileFeatureId: ProfileFeatureId | null = null;
  private profileFeatureDialogOpen = false;
  private tableDialog!: HTMLDialogElement;
  private tableColumnsInput!: HTMLInputElement;
  private tableRowsInput!: HTMLInputElement;
  private tableGrid!: HTMLElement;
  private tableSizeLabel!: HTMLElement;
  private tableDialogError!: HTMLElement;
  private tableDialogInsertButton!: HTMLButtonElement;
  private tableDialogSelection: TableDialogSelection | null = null;
  private tableDialogInvokingButton: HTMLButtonElement | null = null;
  private tableDialogOpen = false;
  private tableDialogColumns = 3;
  private tableDialogRows = 3;
  private tableDialogPreviewColumns = 3;
  private tableDialogPreviewRows = 3;
  private tableDialogPreviewing = false;
  private tableDialogSelectionLocked = false;
  private tableGridCells: HTMLButtonElement[] = [];
  private insertPopup!: HTMLElement;
  private insertPopupToggle!: HTMLButtonElement;
  private activePopup: HTMLElement | null = null;
  private activePopupToggle: HTMLButtonElement | null = null;
  private popupAnchor: HTMLElement | null = null;
  private popupReturnFocus: HTMLElement | null = null;
  private popupSelection: Selection | null = null;
  private popupDocumentGeneration = -1;
  private popupProfile: DocumentProfile | null = null;
  private slashTrigger: SlashTrigger | null = null;
  private materializingSlash = false;
  private readonly insertPopupProfileItems = new Map<
    ProfileFeatureId,
    HTMLButtonElement
  >();
  private selectionToolbarSelection: Selection | null = null;
  private selectionToolbarDocumentGeneration = -1;
  private selectionToolbarProfile: DocumentProfile | null = null;
  private selectionToolbar!: HTMLElement;
  private emptyLineButton!: HTMLButtonElement;
  private blockGapButton!: HTMLButtonElement;
  private blockGapPosition: number | null = null;
  private blockGapDocument: PMNode | null = null;
  private blockGapDocumentGeneration = -1;
  private blockGapProfile: DocumentProfile | null = null;
  private transientBlanks: TransientBlankRange | null = null;
  private stageBlankClickHandled = false;
  private destroyed = false;
  private tooltip!: HTMLElement;
  private tooltipTarget: HTMLElement | null = null;
  private tooltipPreviousDescribedBy: string | null = null;
  private readonly tooltipPointerOverHandler = (event: PointerEvent): void => {
    const target = this.tooltipTargetFor(event.target);
    if (target) this.showTooltip(target);
    else this.hideTooltip();
  };
  private readonly tooltipPointerOutHandler = (event: PointerEvent): void => {
    const target = this.tooltipTargetFor(event.target);
    const next = this.tooltipTargetFor(event.relatedTarget);
    if (next) {
      this.showTooltip(next);
      return;
    }
    if (!target || target === this.tooltipTarget) this.hideTooltip();
  };
  private readonly tooltipFocusInHandler = (event: FocusEvent): void => {
    const target = this.tooltipTargetFor(event.target);
    if (target) this.showTooltip(target);
  };
  private readonly tooltipFocusOutHandler = (event: FocusEvent): void => {
    const next = this.tooltipTargetFor(event.relatedTarget);
    if (next) this.showTooltip(next);
    else this.hideTooltip();
  };
  private readonly tooltipPointerDownHandler = (): void => {
    this.hideTooltip();
  };
  private readonly tooltipClickHandler = (): void => {
    this.hideTooltip();
  };
  private readonly tooltipKeyDownHandler = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.hideTooltip();
  };
  private readonly tooltipScrollHandler = (): void => {
    this.hideTooltip();
  };
  private readonly tableSelectionChangeHandler = (): void =>
    this.scheduleWritingToolbarUpdate();
  private readonly writingToolbarResizeHandler = (): void =>
    this.updateWritingToolbarState();
  private readonly writingToolbarScrollHandler = (): void =>
    this.updateWritingToolbarState();
  private readonly blockGapPointerMoveHandler = (event: PointerEvent): void =>
    this.updateBlockGapFromPointer(event);
  private readonly blockGapPointerOverHandler = (event: PointerEvent): void =>
    this.updateBlockGapFromPointer(event);
  private readonly blockGapPointerLeaveHandler = (): void => {
    if (
      this.blockGapButton?.matches(":focus") ||
      this.activePopupToggle === this.blockGapButton
    )
      return;
    this.clearBlockGapInsert();
  };
  private readonly writingPointerDownHandler = (event: PointerEvent): void => {
    this.requestTableToolbarReveal(event.target);
    const active = this.activePopup;
    if (!active) return;
    const target = event.target;
    if (
      target instanceof Node &&
      (active.contains(target) || this.activePopupToggle?.contains(target))
    )
      return;
    this.closeWritingPopups("cancel");
  };
  private readonly writingFocusInHandler = (event: FocusEvent): void => {
    if (this.materializingSlash) return;
    const active = this.activePopup;
    if (!active) return;
    const target = event.target;
    if (
      target instanceof Node &&
      (active.contains(target) || this.activePopupToggle?.contains(target))
    )
      return;
    this.closeWritingPopups("cancel");
  };
  private readonly stageBlankPointerDownHandler = (event: MouseEvent): void => {
    if (this.handleBlankDocumentPointer(event)) {
      this.stageBlankClickHandled = true;
    }
  };
  private readonly stageBlankClickHandler = (event: MouseEvent): void => {
    if (this.stageBlankClickHandled) {
      this.stageBlankClickHandled = false;
      return;
    }
    this.handleBlankDocumentPointer(event);
  };
  private readonly writingKeyDownHandler = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.activePopup) return;
    const returnFocus = this.popupReturnFocus ?? this.activePopupToggle;
    const returnToEditor = this.isInsertPopupAnchor(returnFocus);
    this.closeWritingPopups("cancel");
    if (returnToEditor) this.view.focus();
    else returnFocus?.focus();
  };

  constructor(options: EditorAppOptions) {
    this.root = options.root;
    this.vscode = options.vscode;
    this.core = options.core;
    this.options = { ...options, hostUndo: options.hostUndo ?? true };
    this.schema = options.core.schema;
    const imageImportOptions: ImageImportControllerOptions = {
      schema: this.schema,
      ...(this.vscode
        ? { postMessage: (message) => this.vscode?.postMessage(message) }
        : {}),
      canImport: () => this.canEditBlock(),
      notify: (message) => this.notifyHost("error", message),
    };
    this.imageImport = new ImageImportController(imageImportOptions);
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
    this.authoritativeMarkdown = initial.markdown;
    this.authoritativeProfile = initial.profile;
    this.authoritativeVersion = initial.version;
    this.documentId = initial.documentId;
    this.version = initial.version;
    this.operationId = initial.operationId;
    this.resourceBaseUrl = initial.resourceBaseUrl;
    this.clipboardAvailable = initial.clipboardAvailable === true;
    this.mermaidValidation = new MermaidValidationController((snapshot) =>
      this.updateMermaidValidation(snapshot),
    );
    this.applyTypography(initial.typography);
    this.root.replaceChildren();
    this.root.classList.add("markdown-mint-app");
    const toolbar = this.buildToolbar();
    this.root.append(toolbar);
    this.stage = makeElement("main", { class: "mm-stage" });
    const richPanel = makeElement("section", {
      class: "mm-panel mm-rich-panel",
      "data-panel": "rich",
      "aria-label": "Rich editor",
    });
    const editorMount = makeElement("div", {
      class: "mm-editor-mount",
      "data-testid": "editor-mount",
    });
    richPanel.append(editorMount);
    const previewPanel = makeElement("section", {
      class: "mm-panel mm-preview-panel",
      "data-panel": "preview",
      "aria-label": "Markdown preview",
      hidden: "true",
    });
    this.previewEl = makeElement("article", {
      class: "markdown-body mm-document-content",
      "data-testid": "preview-content",
    });
    previewPanel.append(this.previewEl);
    const sourcePanel = makeElement("section", {
      class: "mm-panel mm-source-panel",
      "data-panel": "source",
      "aria-label": "Markdown source",
      hidden: "true",
    });
    this.sourceEl = document.createElement("textarea");
    this.sourceEl.className = "mm-source-textarea";
    this.sourceEl.setAttribute("spellcheck", "false");
    this.sourceEl.readOnly = true;
    this.sourceEl.setAttribute("aria-label", "Markdown source");
    sourcePanel.append(this.sourceEl);
    this.stage.append(richPanel, previewPanel, sourcePanel);
    this.selectionToolbar = this.buildSelectionToolbar();
    this.emptyLineButton = this.buildEmptyLineButton();
    this.blockGapButton = this.buildBlockGapButton();
    this.stage.append(
      this.selectionToolbar,
      this.emptyLineButton,
      this.blockGapButton,
    );
    this.root.append(this.stage);
    this.compatibilityEl = makeElement("span", {
      class: "mm-compatibility",
      role: "status",
      "data-testid": "compatibility",
    });
    const primaryToolbar = toolbar.querySelector<HTMLElement>(
      ".mm-toolbar-primary",
    );
    const sourceButton = primaryToolbar?.querySelector(".mm-source-button");
    if (sourceButton)
      primaryToolbar?.insertBefore(this.compatibilityEl, sourceButton);
    else primaryToolbar?.append(this.compatibilityEl);
    this.tooltip = makeElement("div", {
      class: "mm-tooltip",
      role: "tooltip",
      "aria-hidden": "true",
      hidden: "true",
    });
    this.tooltip.id = "mm-tooltip";
    this.root.append(this.tooltip);
    this.installTooltipHandlers();

    this.view = new EditorView(editorMount, {
      state: this.createState(initial.markdown, {
        prepareStarter: this.initialized,
      }),
      dispatchTransaction: (tr) => this.dispatchTransaction(tr),
      attributes: {
        class: "ProseMirror mm-document-content",
        spellcheck: "true",
        "data-testid": "rich-editor",
      },
      nodeViews: {
        details: (node, view, getPos) =>
          createDetailsNodeView(node, view, getPos, {
            getProfile: () => this.profile,
            canEdit: () => this.canEditBlock(),
            composition: (active) => this.handleBlockComposition(active),
            preserveDraft: (draft, message) =>
              this.preserveHeaderDraft(draft, message),
          }),
        list_item: (node, view, getPos) =>
          new TaskItemNodeView(node, view, getPos),
        code_block: (node, view, getPos) =>
          new CodeBlockNodeView(
            node,
            view,
            getPos,
            this.codeBlockControlOptions(),
            () => this.canEditBlock() && !this.composing,
            (draft, message) => this.preserveHeaderDraft(draft, message),
          ),
        image: (node) => new ImageNodeView(node, () => this.resourceBaseUrl),
        raw_block: (node, view, getPos) =>
          String(node.attrs.kind ?? "") === "alert"
            ? createAlertNodeView(
                node,
                view,
                getPos,
                () => this.profile,
                (direction, position, event) =>
                  this.moveSelectionAroundAlert(direction, position, event),
                (command: AlertHistoryCommand) => this.sendHostCommand(command),
                ((position, returnFocus) =>
                  this.openProfileFeatureAlertEditor(
                    position,
                    returnFocus,
                  )) satisfies AlertEditRequest,
                {
                  canEdit: () => this.canEditBlock(),
                  composition: (active) => this.handleBlockComposition(active),
                  canPreserveLocalInput: () =>
                    this.initialized &&
                    !this.previewOnly &&
                    this.mode === "rich" &&
                    !this.parseError &&
                    !this.pendingProfile &&
                    ((this.syncPaused && this.conflict) ||
                      this.pendingExternal !== null),
                },
              )
            : createRenderedNodeView(
                node,
                view,
                getPos,
                () => this.profile,
                (position, returnFocus) =>
                  this.openRenderedBlockEditor(position, returnFocus),
                { canEdit: () => this.canEditBlock() && !this.composing },
              ),
        raw_inline: (node, view, getPos) =>
          createRenderedNodeView(
            node,
            view,
            getPos,
            () => this.profile,
            (position, returnFocus) =>
              this.openRenderedBlockEditor(position, returnFocus),
            { canEdit: () => this.canEditBlock() && !this.composing },
          ),
      },
      handleDOMEvents: {
        beforeinput: (view, event) =>
          this.handleBoundaryBeforeInput(view, event as InputEvent),
        keydown: (_view, event) => {
          const keyboardEvent = event as KeyboardEvent;
          // Let the browser/IME commit composition text without allowing the
          // editor keymap to interpret the same Enter as table navigation.
          if (
            keyboardEvent.key === "Enter" &&
            (keyboardEvent.isComposing ||
              this.composing ||
              keyboardEvent.keyCode === 229)
          )
            return true;
          // ProseMirror deliberately ignores the first key near compositionend
          // on some browsers. Handle a genuine post-composition table Enter
          // here so it still performs the requested navigation immediately.
          if (
            keyboardEvent.key === "Enter" &&
            !keyboardEvent.shiftKey &&
            !keyboardEvent.ctrlKey &&
            !keyboardEvent.metaKey &&
            !keyboardEvent.altKey &&
            this.handleTableEnterKeyDown()
          ) {
            keyboardEvent.preventDefault();
            return true;
          }
          return false;
        },
        compositionstart: () => {
          this.composing = true;
          this.closeWritingPopups();
          this.closeEmojiPicker();
          this.closeProfileFeatureDialog();
          this.updateProfileToolbar();
          this.updateWritingToolbarState();
          return false;
        },
        compositionupdate: () => {
          this.composing = true;
          return false;
        },
        compositionend: () => {
          this.composing = false;
          if (this.pendingRejectedEdit) {
            this.handleBlockComposition(false);
            return false;
          }
          this.flushExternalAfterComposition();
          this.flushDeferredHostCommand();
          this.updateProfileToolbar();
          this.updateWritingToolbarState();
          return false;
        },
        mousedown: (_view, event) => {
          this.requestTableToolbarReveal(event.target);
          return false;
        },
        copy: (view, event) => this.handleCopy(view, event as ClipboardEvent),
        cut: (view, event) => this.handleCut(view, event as ClipboardEvent),
        paste: (view, event) => this.handlePaste(view, event as ClipboardEvent),
        drop: (view, event) =>
          this.imageImport.handleDrop(view, event as DragEvent),
      },
    });
    // The initial document came from the host, so it is already the current
    // serialized snapshot even when the starter plugin adds a virtual node.
    this.serializedDocument = this.view.state.doc;
    if (this.parseError || !this.initialized) {
      this.view.setProps({ editable: () => false });
    }
    this.sync = new SyncController(this.version, this.vscode, initial.markdown);
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
    this.stage.addEventListener(
      "mousedown",
      this.stageBlankPointerDownHandler,
      true,
    );
    this.stage.addEventListener("click", this.stageBlankClickHandler);
    this.stage.addEventListener("pointermove", this.blockGapPointerMoveHandler);
    this.stage.addEventListener("pointerover", this.blockGapPointerOverHandler);
    this.stage.addEventListener(
      "pointerleave",
      this.blockGapPointerLeaveHandler,
    );
    window.addEventListener("resize", this.writingToolbarResizeHandler);
    this.stage.addEventListener("scroll", this.writingToolbarScrollHandler, {
      passive: true,
    });
    document.addEventListener(
      "selectionchange",
      this.tableSelectionChangeHandler,
    );
    document.addEventListener("pointerdown", this.writingPointerDownHandler);
    document.addEventListener("focusin", this.writingFocusInHandler);
    document.addEventListener("keydown", this.writingKeyDownHandler);
    this.restoreRecoveryState();
    this.setInitialized(this.initialized);
    this.setMode(this.mode, false);
    this.refreshDerivedViews(initial.markdown, undefined, {
      renderPreview: this.mode === "preview",
      refreshCompatibility: this.mode === "preview",
    });
    if (this.mode !== "preview") this.scheduleDerivedViews(initial.markdown);
    this.postReady();
  }

  destroy(): void {
    this.destroyed = true;
    this.derivedViewsRevision += 1;
    this.pendingRejectedEdit = null;
    if (this.blockCompositionTimer !== undefined) {
      clearTimeout(this.blockCompositionTimer);
      this.blockCompositionTimer = undefined;
    }
    this.pendingDerivedViews = null;
    if (this.derivedViewsTimer !== undefined) {
      clearTimeout(this.derivedViewsTimer);
      this.derivedViewsTimer = undefined;
    }
    if (this.tableToolbarRevealTimer !== undefined) {
      clearTimeout(this.tableToolbarRevealTimer);
      this.tableToolbarRevealTimer = undefined;
    }
    for (const pending of this.pendingClipboard.values()) {
      if (pending.timer !== undefined)
        this.root.ownerDocument.defaultView?.clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingClipboard.clear();
    window.removeEventListener("message", this.messageHandler);
    window.removeEventListener("resize", this.writingToolbarResizeHandler);
    this.stage.removeEventListener("scroll", this.writingToolbarScrollHandler);
    this.stage.removeEventListener(
      "mousedown",
      this.stageBlankPointerDownHandler,
      true,
    );
    this.stage.removeEventListener("click", this.stageBlankClickHandler);
    this.stage.removeEventListener(
      "pointermove",
      this.blockGapPointerMoveHandler,
    );
    this.stage.removeEventListener(
      "pointerover",
      this.blockGapPointerOverHandler,
    );
    this.stage.removeEventListener(
      "pointerleave",
      this.blockGapPointerLeaveHandler,
    );
    document.removeEventListener(
      "selectionchange",
      this.tableSelectionChangeHandler,
    );
    document.removeEventListener("pointerdown", this.writingPointerDownHandler);
    document.removeEventListener("focusin", this.writingFocusInHandler);
    document.removeEventListener("keydown", this.writingKeyDownHandler);
    this.closeWritingPopups();
    this.clearBlockGapInsert();
    this.closeEmojiPicker();
    this.closeProfileFeatureDialog();
    this.mermaidValidation.dispose();
    this.transientBlanks = null;
    this.previewEnhancer?.dispose();
    this.previewEnhancer = undefined;
    this.bodyNavigation?.destroy();
    this.imageImport.dispose(this.view);
    this.view.destroy();
  }

  private createState(
    markdown: string,
    options: { prepareStarter?: boolean } = {},
  ): EditorState {
    let doc: PMNode;
    let starterState: StarterPluginState = {
      active: false,
      untouched: false,
    };
    this.starterOriginalSource = markdown;
    try {
      const parsed = this.core.parseMarkdown(markdown, this.profile);
      if (options.prepareStarter === false) {
        // The fallback state only keeps ProseMirror structurally valid while
        // the host's first document message is still outstanding. It is not
        // an authoritative blank source, so the blank-document starter must
        // remain inactive until a real document is received.
        doc = parsed.doc;
      } else {
        const prepared = prepareStarterDocument(
          markdown,
          parsed.doc,
          this.schema,
        );
        doc = prepared.doc;
        starterState = prepared.state;
      }
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
      createStarterPlugin(starterState),
      createWritingInputRules(this.schema),
      createBlockBoundaryPlugin(),
      createRenderingPlugin(() => this.profile),
      this.imageImport.plugin,
      keymap(this.createKeymap()),
      tableEditing(),
      createTableNumberingPlugin(),
      keymap(baseKeymap),
      new Plugin({
        key: editorPluginKey,
        props: {
          decorations: () => null,
          handleKeyDown: (_view, event) => this.handleAppKeyDown(event),
          handleTextInput: (view, from, to, text) =>
            this.handleBoundaryTextInput(view, from, to, text) ||
            this.handleInsertBlockSlash(view, from, to, text),
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
      Enter: (state, dispatch) => {
        if (this.editSelectedInlineMath(state, dispatch)) return true;
        if (this.composing) return false;
        if (state.selection instanceof BlockBoundarySelection) {
          if (dispatch) this.materializeBoundary(state.selection.head);
          return true;
        }
        const context = tableContext(state.selection);
        return context
          ? this.moveToNextTableRow(state, context, dispatch)
          : enter(state, dispatch);
      },
      Space: (state, dispatch) => this.editSelectedInlineMath(state, dispatch),
      "Shift-Enter": shiftEnter,
      "Mod-z": () => this.sendHostCommand("undo"),
      "Mod-y": () => this.sendHostCommand("redo"),
      "Mod-Shift-z": () => this.sendHostCommand("redo"),
      "Mod-s": () => this.sendSaveCommand(),
      Backspace: (state) => state.selection instanceof BlockBoundarySelection,
      Delete: (state) => state.selection instanceof BlockBoundarySelection,
      "Mod-Backspace": (state) =>
        state.selection instanceof BlockBoundarySelection,
      "Mod-Delete": (state) =>
        state.selection instanceof BlockBoundarySelection,
      Tab: (state, dispatch) =>
        this.focusSelectionToolbar(state.selection) ||
        (isInTable(state)
          ? goToNextCell(1)(state, dispatch)
          : listItem
            ? sinkListItem(listItem)(state, dispatch)
            : false),
      "Shift-Tab": (state, dispatch) =>
        isInTable(state)
          ? goToNextCell(-1)(state, dispatch)
          : listItem
            ? liftListItem(listItem)(state, dispatch)
            : false,
      Escape: (state, dispatch) => this.exitTable(state, dispatch),
      ArrowLeft: (state, dispatch) =>
        this.exitTableAtStart(state, dispatch, "horiz"),
      ArrowRight: (state, dispatch) =>
        this.exitTableAtEnd(state, dispatch, "horiz"),
      ArrowUp: (state, dispatch) =>
        this.exitTableAtStart(state, dispatch, "vert"),
      ArrowDown: (state, dispatch) =>
        this.exitTableAtEnd(state, dispatch, "vert"),
    };
    return map;
  }

  private moveToNextTableRow(
    state: EditorState,
    context: TableContext,
    dispatch?: (tr: Transaction) => void,
  ): boolean {
    const rect = activeTableCell(state.selection, context);
    if (!dispatch) return true;

    if (state.selection instanceof CellSelection) {
      dispatch(
        state.tr
          .setSelection(
            textSelectionInTableCell(
              state.doc,
              context.tableStart,
              context.map,
              context.table,
              rect.top,
              rect.left,
            ),
          )
          .scrollIntoView(),
      );
      return true;
    }

    if (rect.bottom < context.map.height) {
      dispatch(
        state.tr
          .setSelection(
            textSelectionInTableCell(
              state.doc,
              context.tableStart,
              context.map,
              context.table,
              rect.bottom,
              rect.left,
            ),
          )
          .scrollIntoView(),
      );
      return true;
    }

    let transaction: Transaction | undefined;
    if (!addRowAfter(state, (tr) => (transaction = tr))) return true;
    if (!transaction) return true;

    const tablePosition = context.tableStart - 1;
    const insertedTable = transaction.doc.nodeAt(tablePosition);
    if (!insertedTable || insertedTable.type.spec.tableRole !== "table") {
      dispatch(transaction.scrollIntoView());
      return true;
    }
    const insertedMap = TableMap.get(insertedTable);
    dispatch(
      transaction
        .setSelection(
          textSelectionInTableCell(
            transaction.doc,
            context.tableStart,
            insertedMap,
            insertedTable,
            insertedMap.height - 1,
            rect.left,
          ),
        )
        .scrollIntoView(),
    );
    return true;
  }

  private handleTableEnterKeyDown(): boolean {
    const state = this.view.state;
    const context = tableContext(state.selection);
    if (!context) return false;
    const handled = this.moveToNextTableRow(state, context, (transaction) =>
      this.view.dispatch(transaction),
    );
    return handled;
  }

  private editSelectedInlineMath(
    state: EditorState,
    dispatch?: (tr: Transaction) => void,
  ): boolean {
    const selection = state.selection;
    if (
      !(selection instanceof NodeSelection) ||
      selection.node.type.name !== "raw_inline" ||
      blockSourceEditor(selection.node)?.kind !== "math" ||
      !this.canEditBlock() ||
      this.composing ||
      this.profileFeatureDialogOpen
    )
      return false;
    if (dispatch) {
      const dom = this.view.nodeDOM(selection.from);
      this.openRenderedBlockEditor(
        selection.from,
        dom instanceof HTMLElement ? dom : undefined,
      );
    }
    return true;
  }

  private handleInsertBlockSlash(
    view: EditorView,
    from: number,
    to: number,
    text: string,
  ): boolean {
    const selection = view.state.selection;
    if (
      text !== "/" ||
      from !== to ||
      !selection.empty ||
      selection.from !== from ||
      selection.to !== to ||
      this.activePopup ||
      !this.canUseEmptyLineInsert(selection)
    )
      return false;

    // Keep the same affordance position and DOM anchor used by the + button.
    // This also makes a missing or disconnected paragraph view a normal text
    // input fallback instead of opening an unanchored popup.
    this.updateEmptyLineInsert(selection);
    if (this.emptyLineButton.hidden) return false;
    if (!this.captureWritingPopupSelection()) return false;
    const savedSelection = this.popupSelection;
    if (!savedSelection) return false;

    this.slashTrigger = {
      selection: savedSelection,
      documentGeneration: this.popupDocumentGeneration,
      profile: this.profile,
    };
    if (
      !this.openWritingPopup(
        this.insertPopup,
        this.insertPopupToggle,
        this.emptyLineButton,
        "keyboard",
      )
    ) {
      this.slashTrigger = null;
      this.closeWritingPopups("discard");
      return false;
    }
    return true;
  }

  private handleBoundaryTextInput(
    view: EditorView,
    from: number,
    to: number,
    text: string,
  ): boolean {
    const selection = view.state.selection;
    if (
      !(selection instanceof BlockBoundarySelection) ||
      selection.from !== from ||
      selection.to !== to ||
      !text
    )
      return false;
    if (text === "/") {
      const transaction = this.createTransientBlockGapTransaction(
        selection.head,
      );
      if (!transaction) return false;
      this.view.focus();
      this.dispatchTransaction(transaction);
      const paragraphSelection = this.view.state.selection;
      if (
        this.handleInsertBlockSlash(
          view,
          paragraphSelection.from,
          paragraphSelection.to,
          text,
        )
      )
        return true;
      // A missing slash popup anchor falls back to meaningful text in the
      // transient paragraph that was just created.
      this.dispatchTransaction(this.view.state.tr.insertText(text));
      this.view.focus();
      return true;
    }
    return this.materializeBoundary(selection.head, text);
  }

  private handleBoundaryBeforeInput(
    view: EditorView,
    event: InputEvent,
  ): boolean {
    if (
      event.inputType !== "insertCompositionText" ||
      !(view.state.selection instanceof BlockBoundarySelection)
    )
      return false;
    // Keep the browser's composition transaction alive. The paragraph is
    // created before the native composition text arrives, so IME input takes
    // the ordinary ProseMirror text path without losing its first update.
    this.materializeBoundary(view.state.selection.head);
    return false;
  }

  private materializeBoundary(position: number, text = ""): boolean {
    const state = this.view.state;
    const selection = state.selection;
    const paragraph = this.schema.nodes.paragraph;
    const starter = getStarterState(state);
    if (
      !(selection instanceof BlockBoundarySelection) ||
      selection.head !== position ||
      !paragraph ||
      !isBlockBoundary(state.doc, position) ||
      (starter?.active && starter.untouched) ||
      !this.canEditBlock()
    )
      return false;
    let transaction: Transaction;
    try {
      transaction = state.tr.insert(position, paragraph.create());
      const textPosition = position + 1;
      if (text) transaction = transaction.insertText(text, textPosition);
      transaction = transaction
        .setSelection(
          TextSelection.create(transaction.doc, textPosition + text.length),
        )
        .scrollIntoView();
    } catch {
      return false;
    }
    this.dispatchTransaction(transaction);
    this.view.focus();
    return true;
  }

  private createTransientBlockGapTransaction(
    position: number,
  ): Transaction | null {
    const state = this.view.state;
    const paragraph = this.schema.nodes.paragraph;
    const starter = getStarterState(state);
    if (
      !paragraph ||
      !this.canEditBlock() ||
      this.transientBlanks ||
      (starter?.active && starter.untouched) ||
      !Number.isInteger(position) ||
      !isBlockBoundary(state.doc, position)
    )
      return null;
    try {
      const transaction = state.tr.insert(position, paragraph.create());
      const to = position + paragraph.create().nodeSize;
      return transaction
        .setSelection(TextSelection.create(transaction.doc, position + 1))
        .setMeta("addToHistory", false)
        .setMeta(TRANSIENT_BLANK_META, {
          kind: "append",
          from: position,
          to,
          count: 1,
          meaningful: false,
        } satisfies TransientBlankTransactionMeta)
        .scrollIntoView();
    } catch {
      return null;
    }
  }

  private insertTransientBlockGap(
    position: number,
    openPopup = false,
  ): boolean {
    const state = this.view.state;
    if (
      openPopup &&
      (position <= 0 ||
        position >= state.doc.content.size ||
        !this.blockGapStateIsCurrent(position))
    )
      return false;
    const layout = openPopup ? this.blockGapLayoutAt(position) : null;
    const transaction = this.createTransientBlockGapTransaction(position);
    if (!transaction) return false;
    this.view.focus();
    this.dispatchTransaction(transaction);
    if (!openPopup) return true;

    if (!layout || !this.captureWritingPopupSelection()) {
      this.discardTransientBlanksInState();
      this.clearBlockGapInsert();
      return false;
    }
    // The newly inserted paragraph now owns this area. Reuse the existing
    // empty-line button as the popup anchor so the transient paragraph cannot
    // leave both insertion affordances visible at once.
    this.updateEmptyLineInsert(this.view.state.selection);
    if (this.emptyLineButton.hidden) {
      this.discardTransientBlanksInState();
      this.clearBlockGapInsert();
      return false;
    }
    this.clearBlockGapInsert();
    if (
      !this.openWritingPopup(
        this.insertPopup,
        this.insertPopupToggle,
        this.emptyLineButton,
      )
    ) {
      this.discardTransientBlanksInState();
      this.clearBlockGapInsert();
      return false;
    }
    return true;
  }

  private handleAppKeyDown(event: KeyboardEvent): boolean {
    const starter = getStarterState(this.view.state);
    if (
      !(starter?.active && starter.untouched) &&
      this.navigation.handleKeyDown(event, this.composing)
    )
      return true;
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

  private bodyNavigation: BodyNavigation | undefined;

  private get navigation(): BodyNavigation {
    return (this.bodyNavigation ??= new BodyNavigation(this.view));
  }

  private exitTable(
    state: EditorState,
    dispatch?: (tr: Transaction) => void,
  ): boolean {
    const context = tableContext(state.selection);
    if (!context) return false;
    return this.moveSelectionAfterTable(state, context, dispatch);
  }

  private exitTableAtEnd(
    state: EditorState,
    _dispatch?: (tr: Transaction) => void,
    axis: "horiz" | "vert" = "vert",
  ): boolean {
    if (!(state.selection instanceof TextSelection) || !state.selection.empty)
      return false;
    const context = tableContext(state.selection);
    if (!context) return false;
    if (
      axis === "vert"
        ? context.rect.bottom < context.map.height
        : context.rect.right < context.map.width ||
          context.rect.bottom < context.map.height
    )
      return false;
    if (
      state.selection.$from.parentOffset <
      state.selection.$from.parent.content.size
    )
      return false;
    const cell = state.doc.nodeAt(context.cellPos);
    if (!cell) return false;
    // ArrowDown at the end of an earlier paragraph should continue through the
    // cell. Leave only when the cursor is at the final textblock boundary.
    const cellContentEnd = context.cellPos + cell.nodeSize - 1;
    if (state.selection.from < cellContentEnd - 1) return false;
    return this.navigation.moveFromBlockEdge(
      context.tableStart - 1 + context.table.nodeSize,
      1,
      axis === "vert",
      axis === "vert" ? state.selection.head : undefined,
    );
  }

  private exitTableAtStart(
    state: EditorState,
    _dispatch?: (tr: Transaction) => void,
    axis: "horiz" | "vert" = "vert",
  ): boolean {
    if (!(state.selection instanceof TextSelection) || !state.selection.empty)
      return false;
    const context = tableContext(state.selection);
    if (!context) return false;
    if (
      axis === "vert"
        ? context.rect.top !== 0
        : context.rect.left !== 0 || context.rect.top !== 0
    )
      return false;
    // Only the first direct textblock in the first cell can leave the table.
    // Other paragraphs and wrapped rows keep the table's native navigation.
    if (state.selection.$from.before() !== context.cellPos + 1) return false;
    if (state.selection.$from.parentOffset !== 0) return false;
    if (axis === "vert") {
      try {
        if (!this.view.endOfTextblock("up")) return false;
      } catch {
        return false;
      }
    }
    return this.navigation.moveFromBlockEdge(
      context.tableStart - 1,
      -1,
      axis === "vert",
      axis === "vert" ? state.selection.head : undefined,
    );
  }

  private moveSelectionAfterTable(
    state: EditorState,
    context: TableContext,
    dispatch?: (tr: Transaction) => void,
  ): boolean {
    const tablePosition = context.tableStart - 1;
    return this.moveSelectionAfterBlock(
      state,
      tablePosition,
      context.table,
      dispatch,
      (selection) => Boolean(tableContext(selection)),
    );
  }

  private moveSelectionAfterBlock(
    state: EditorState,
    position: number,
    node: PMNode,
    dispatch?: (tr: Transaction) => void,
    isInsideBlock?: (selection: Selection) => boolean,
  ): boolean {
    const paragraph = this.schema.nodes.paragraph;
    if (!paragraph) return false;
    const blockEnd = position + node.nodeSize;
    let transaction = state.tr;
    let target: Selection;
    // Escape keeps its dedicated virtual insertion stop between top-level
    // blocks. Arrow navigation uses BodyNavigation's actual-target graph.
    if (
      state.doc.resolve(position).depth === 0 &&
      isBlockBoundary(state.doc, blockEnd)
    ) {
      target = new BlockBoundarySelection(state.doc.resolve(blockEnd));
      transaction = transaction
        .setSelection(target)
        .setMeta("addToHistory", false)
        .scrollIntoView();
      if (dispatch) dispatch(transaction);
      return true;
    }
    try {
      target = Selection.near(
        state.doc.resolve(Math.min(blockEnd, state.doc.content.size)),
        1,
      );
    } catch {
      target = state.selection;
    }

    // A block with no following text position (notably a final atom) gets a
    // writable paragraph only as a transient caret target. Table callers pass
    // an explicit predicate because Selection.near can remain inside a table.
    const needsTrailingParagraph =
      target.from < blockEnd || Boolean(isInsideBlock?.(target));
    if (!needsTrailingParagraph) {
      transaction = transaction.setSelection(target).scrollIntoView();
      if (dispatch) dispatch(transaction);
      return true;
    }

    const from = Math.min(blockEnd, transaction.doc.content.size);
    const trailing = paragraph.create();
    transaction = transaction
      .insert(from, trailing)
      .setMeta(TRANSIENT_BLANK_META, {
        kind: "append",
        from,
        to: from + trailing.nodeSize,
        count: 1,
        meaningful: false,
      } satisfies TransientBlankTransactionMeta);
    target = Selection.near(
      transaction.doc.resolve(Math.min(from + 1, transaction.doc.content.size)),
      1,
    );
    transaction = transaction.setSelection(target).scrollIntoView();
    if (dispatch) dispatch(transaction);
    return true;
  }

  private moveSelectionAroundAlert(
    direction: AlertBoundaryDirection,
    position: number,
    event?: KeyboardEvent,
  ): boolean {
    return this.navigation.moveFromTextarea(direction, position, event);
  }

  private gfmUnavailable(dispatch?: (tr: Transaction) => void): boolean {
    if (dispatch)
      this.setNotice("This GFM feature is unavailable in CommonMark.");
    return false;
  }

  private dispatchTransaction(tr: Transaction): boolean {
    const oldSelection = this.view.state.selection;
    const rootTransientMeta = tr.getMeta(TRANSIENT_BLANK_META) as
      TransientBlankTransactionMeta | undefined;
    // Extend the user's first edit with removal of the untouched generated
    // paragraphs. Keeping the cleanup in this transaction makes the edit
    // atomic for the host's Markdown undo history and avoids serializing the
    // click distance as authored blank lines.
    const committedTransient =
      rootTransientMeta?.kind !== "append" &&
      this.commitTransientBlanksInTransaction(tr);
    if (
      tr.getMeta(SPREADSHEET_TABLE_PASTE_META) === true &&
      !this.spreadsheetPasteWithinMarkdownLimit(tr, committedTransient)
    )
      return false;
    const applied = this.view.state.applyTransaction(tr);
    const transactions = applied.transactions;
    const editTarget = this.profileFeatureEditTarget;
    if (editTarget && editTarget.document === this.view.state.doc) {
      let position = editTarget.position;
      let deleted = false;
      for (const transaction of transactions) {
        const mapped = transaction.mapping.mapResult(position, 1);
        position = mapped.pos;
        deleted ||= mapped.deleted;
      }
      if (!deleted && applied.state.doc.nodeAt(position) === editTarget.node) {
        editTarget.position = position;
        editTarget.document = applied.state.doc;
      }
    }
    const appendMeta = transactions
      .map(
        (transaction) =>
          transaction.getMeta(TRANSIENT_BLANK_META) as
            TransientBlankTransactionMeta | undefined,
      )
      .find((meta) => meta?.kind === "append");

    if (this.transientBlanks && appendMeta?.kind !== "append") {
      for (const transaction of transactions)
        this.mapTransientBlankRange(transaction);
    }

    this.view.updateState(applied.state);
    if (committedTransient && applied.transactions.length > 0)
      this.transientBlanks = null;

    const appendedTransient = this.mapAppendedTransientBlankRange(transactions);
    if (appendedTransient) this.transientBlanks = appendedTransient;

    let transientOnly = false;
    let discardedTransient = false;
    if (this.transientBlanks) {
      const hasContent = this.transientBlankHasContent();
      const selectionInTransient = this.selectionInsideTransient(
        this.view.state.selection,
      );
      if (appendMeta?.kind === "append") {
        // A click or table exit only creates a caret target. A meaningful
        // transaction such as table insertion still needs to sync immediately,
        // while its trailing paragraph remains omitted from the source.
        transientOnly = appendMeta.meaningful !== true;
      } else if (hasContent) {
        // The transaction already removed untouched generated paragraphs;
        // only the edited target remains authored content. Clear the marker
        // so the target is serialized normally from now on.
        this.transientBlanks = null;
      } else if (
        transactions.some(
          (transaction) => transaction.docChanged || transaction.selectionSet,
        ) &&
        !selectionInTransient
      ) {
        discardedTransient = this.discardTransientBlanksInState();
      }
    }

    const docChanged = transactions.some(
      (transaction) => transaction.docChanged,
    );
    const alertLocalInput = transactions.some(
      (transaction) => transaction.getMeta(ALERT_LOCAL_INPUT_META) === true,
    );
    const selectionSet = transactions.some(
      (transaction) => transaction.selectionSet,
    );
    const storedMarksSet = transactions.some(
      (transaction) => transaction.storedMarksSet,
    );
    if (docChanged && !transientOnly) {
      this.closeWritingPopups();
      this.dirty = true;
      const markdown = this.serializeCurrent();
      if (markdown !== null) this.persistRecovery(markdown);
      else
        this.persistRecovery(
          this.lastValidMarkdown,
          this.authoritativeMarkdown,
          this.authoritativeVersion,
          true,
        );
      if (markdown !== null) {
        if (alertLocalInput) {
          // Keep source integrity, recovery, and host sync synchronous. Preview
          // and compatibility are derived views and can share one frame across
          // a burst of native textarea input events.
          this.sourceEl.value = markdown;
        }
        if (
          this.vscode &&
          !this.syncPaused &&
          !this.pendingExternal &&
          this.initialized &&
          !this.previewOnly
        )
          this.sync.enqueue(markdown);
        // The serialized source is the single snapshot shared by recovery,
        // synchronization, and all later derived work. Keep the edit message
        // ahead of optional rendering/diagnostics so typing never waits for a
        // hidden preview to parse and replace its DOM.
        if (!alertLocalInput)
          this.refreshDerivedViews(markdown, undefined, {
            renderPreview: this.mode === "preview",
            refreshCompatibility: false,
          });
        this.scheduleDerivedViews(markdown);
      }
    }
    if (selectionSet || storedMarksSet || docChanged || discardedTransient)
      this.updateToolbarState(oldSelection, this.view.state.selection, {
        revealTableToolbar: selectionSet || docChanged || discardedTransient,
      });
    return true;
  }

  private commitTransientBlanksInTransaction(tr: Transaction): boolean {
    const range = this.transientBlanks;
    if (!range) return false;
    const generated = this.transientBlankNodes();
    if (generated.length === 0) return false;

    const mappedRange: TransientBlankRange = {
      from: tr.mapping.map(range.from, 1),
      to: tr.mapping.map(range.to, -1),
      count: range.count,
    };
    const generatedNodes = new Set(generated.map(({ node }) => node));
    const nodes = topLevelRangeNodes(tr.doc, mappedRange);
    const hasAuthoredContent = nodes.some(
      ({ node }) =>
        !generatedNodes.has(node) ||
        node.type.name !== "paragraph" ||
        node.content.size > 0,
    );
    if (!hasAuthoredContent) return false;

    const removable = nodes.filter(
      ({ node }) =>
        generatedNodes.has(node) &&
        node.type.name === "paragraph" &&
        node.content.size === 0,
    );
    try {
      for (let index = removable.length - 1; index >= 0; index -= 1) {
        const node = removable[index]!;
        tr.delete(node.from, node.to);
      }
    } catch {
      // Leave the original transaction untouched when a malformed mapping
      // cannot safely address the generated nodes.
      return false;
    }
    return true;
  }

  private mapTransientBlankRange(tr: Transaction): void {
    const range = this.transientBlanks;
    if (!range) return;
    range.from = tr.mapping.map(range.from, 1);
    range.to = tr.mapping.map(range.to, -1);
    if (range.to < range.from) range.to = range.from;
  }

  private mapAppendedTransientBlankRange(
    transactions: readonly Transaction[],
  ): TransientBlankRange | null {
    const metaIndex = transactions.findIndex(
      (transaction) =>
        (
          transaction.getMeta(TRANSIENT_BLANK_META) as
            TransientBlankTransactionMeta | undefined
        )?.kind === "append",
    );
    if (metaIndex < 0) return null;
    const appendMeta = transactions[metaIndex]?.getMeta(
      TRANSIENT_BLANK_META,
    ) as TransientBlankTransactionMeta | undefined;
    if (appendMeta?.kind !== "append") return null;
    let from = Number(appendMeta.from);
    let to = Number(appendMeta.to);
    const count = Number(appendMeta.count ?? 1);
    for (const transaction of transactions.slice(metaIndex + 1)) {
      from = transaction.mapping.map(from, 1);
      to = transaction.mapping.map(to, -1);
      if (to < from) to = from;
    }
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to <= from ||
      !Number.isInteger(count) ||
      count <= 0
    )
      return null;
    return { from, to, count };
  }

  private transientBlankNodes(): Array<{
    node: PMNode;
    from: number;
    to: number;
  }> {
    return this.transientBlanks
      ? topLevelRangeNodes(this.view.state.doc, this.transientBlanks)
      : [];
  }

  private transientBlankHasContent(): boolean {
    const range = this.transientBlanks;
    if (!range) return false;
    return this.transientBlankHasContentInState(this.view.state, range);
  }

  private transientBlankHasContentInState(
    state: EditorState,
    range: TransientBlankRange,
  ): boolean {
    const nodes = topLevelRangeNodes(state.doc, range);
    if (nodes.length !== range.count) return true;
    return nodes.some(
      ({ node }) => node.type.name !== "paragraph" || node.content.size > 0,
    );
  }

  private selectionInsideTransient(selection: Selection): boolean {
    const range = this.transientBlanks;
    if (!range || selection.empty === false) return false;
    return selection.from >= range.from && selection.from < range.to;
  }

  /** Remove generated empty paragraphs without creating a host edit. */
  private discardTransientBlanksInState(): boolean {
    const range = this.transientBlanks;
    if (!range) return false;
    const nodes = this.transientBlankNodes();
    if (
      nodes.length !== range.count ||
      nodes.some(
        ({ node }) => node.type.name !== "paragraph" || node.content.size > 0,
      )
    ) {
      this.transientBlanks = null;
      return false;
    }
    const from = nodes[0]?.from;
    const to = nodes.at(-1)?.to;
    this.transientBlanks = null;
    if (from === undefined || to === undefined || to <= from) return false;
    let transaction = this.view.state.tr
      .delete(from, to)
      .setMeta(TRANSIENT_BLANK_META, {
        kind: "discard",
        from,
        to,
        count: nodes.length,
      } satisfies TransientBlankTransactionMeta);
    const starter = getStarterState(this.view.state);
    if (starter?.active && starter.untouched)
      transaction = setStarterMeta(transaction, {
        active: true,
        untouched: true,
        preserveSource: true,
      });
    this.view.updateState(this.view.state.apply(transaction));
    return true;
  }

  private currentMarkdown(): string {
    if (this.parseError && this.preservedSource !== null)
      return this.preservedSource;
    if (this.serializedDocument === this.view.state.doc)
      return this.lastValidMarkdown;
    return this.serializeCurrent() ?? this.lastValidMarkdown;
  }

  private transientBlankRangeAfterTransactions(
    transactions: readonly Transaction[],
    committedTransient: boolean,
  ): TransientBlankRange | null {
    const appended = this.mapAppendedTransientBlankRange(transactions);
    if (appended) return appended;
    if (committedTransient || !this.transientBlanks) return null;
    const range = { ...this.transientBlanks };
    for (const transaction of transactions) {
      range.from = transaction.mapping.map(range.from, 1);
      range.to = transaction.mapping.map(range.to, -1);
      if (range.to < range.from) range.to = range.from;
    }
    return range;
  }

  private documentForSerializationForState(
    state: EditorState,
    transientBlanks: TransientBlankRange | null,
  ): PMNode {
    if (
      !transientBlanks ||
      this.transientBlankHasContentInState(state, transientBlanks)
    )
      return state.doc;
    return removeTopLevelRange(state.doc, transientBlanks);
  }

  private serializeMarkdownForState(
    state: EditorState,
    transientBlanks: TransientBlankRange | null,
  ): string {
    const serialized = this.core.serializeMarkdown(
      this.documentForSerializationForState(state, transientBlanks),
      this.previousSnapshot,
    );
    return serializeStarterSource(
      state,
      this.starterOriginalSource,
      serialized,
    );
  }

  /**
   * Check a spreadsheet table paste against the final source before the
   * ProseMirror state is committed. The candidate uses the same plugin,
   * starter-source, and transient-blank serialization path as a real edit.
   */
  private spreadsheetPasteWithinMarkdownLimit(
    tr: Transaction,
    committedTransient: boolean,
  ): boolean {
    const applied = this.view.state.applyTransaction(tr);
    const transientBlanks = this.transientBlankRangeAfterTransactions(
      applied.transactions,
      committedTransient,
    );
    let markdown: string;
    try {
      markdown = this.serializeMarkdownForState(applied.state, transientBlanks);
    } catch {
      this.notifyHost(
        "warning",
        "Table paste could not be serialized safely and was rejected.",
      );
      return false;
    }
    if (markdown.length <= MAX_MARKDOWN_LENGTH) return true;
    this.notifyHost(
      "warning",
      `Table paste would exceed the ${MAX_MARKDOWN_LENGTH.toLocaleString("en-US")}-character Markdown source limit.`,
    );
    return false;
  }

  private documentForSerialization(): PMNode {
    return this.documentForSerializationForState(
      this.view.state,
      this.transientBlanks,
    );
  }

  private serializeCurrent(): string | null {
    if (this.parseError && this.preservedSource !== null)
      return this.preservedSource;
    try {
      const markdown = this.serializeMarkdownForState(
        this.view.state,
        this.transientBlanks,
      );
      this.serializationError = null;
      this.lastNotificationKey = null;
      this.lastValidMarkdown = markdown;
      this.serializedDocument = this.view.state.doc;
      return markdown;
    } catch (error) {
      this.serializationError =
        error instanceof Error
          ? error.message
          : "Markdown could not be serialized.";
      this.preservedSource = this.lastValidMarkdown;
      // The ProseMirror document is still a valid local editing state. A
      // serializer failure must not turn it into a read-only view or replace
      // it with the last successful Markdown snapshot. Keep the structured
      // state in recovery storage and retry serialization on the next edit.
      this.persistRecovery(
        this.lastValidMarkdown,
        this.authoritativeMarkdown,
        this.authoritativeVersion,
        true,
      );
      this.notifyHost(
        "error",
        `Markdown could not be synchronized: ${this.serializationError}`,
      );
      return null;
    }
  }

  private refreshDerivedViews(
    markdown: string,
    fallbackHtml?: string,
    options: DerivedViewsOptions = {},
  ): void {
    if (this.destroyed) return;
    const renderPreview = options.renderPreview ?? this.mode === "preview";
    const refreshCompatibility = options.refreshCompatibility ?? true;
    const previewKey = derivedStateKey(
      markdown,
      this.profile,
      this.resourceBaseUrl,
    );
    const hasHostFallback = fallbackHtml !== undefined;

    this.sourceEl.value = markdown;
    if (renderPreview) {
      if (
        this.previewNeedsRefresh ||
        this.previewRenderKey !== previewKey ||
        (hasHostFallback && this.previewUsesTextFallback)
      ) {
        try {
          // A host-rendered preview is already produced by the same safe core
          // renderer. Prefer it when supplied so the document and preview
          // notifications do not trigger a second full parse in the webview.
          this.previewEl.innerHTML =
            fallbackHtml ?? this.core.renderMarkdown(markdown, this.profile);
          this.previewUsesTextFallback = false;
        } catch {
          if (fallbackHtml !== undefined) {
            this.previewEl.innerHTML = fallbackHtml;
            this.previewUsesTextFallback = false;
          } else {
            this.previewEl.textContent = markdown;
            this.previewUsesTextFallback = true;
          }
        }
        this.resolveDisplayImages(this.previewEl);
        this.previewEnhancer?.dispose();
        this.previewEnhancer = enhanceRenderedContent(
          this.previewEl,
          this.codeBlockControlOptions(),
        );
        this.previewRenderKey = previewKey;
        this.previewNeedsRefresh = false;
      }
    } else {
      this.previewNeedsRefresh = true;
    }
    // ImageNodeView ignores this display-only attribute mutation so the
    // absolute webview URI never leaks into the ProseMirror document.
    this.resolveDisplayImages(this.view.dom);
    if (refreshCompatibility) this.refreshCompatibility(markdown);
  }

  private scheduleDerivedViews(markdown: string): void {
    if (this.destroyed) return;
    const revision = ++this.derivedViewsRevision;
    this.pendingDerivedViews = {
      markdown,
      profile: this.profile,
      resourceBaseUrl: this.resourceBaseUrl,
      document: this.view.state.doc,
      revision,
    };
    if (this.derivedViewsTimer !== undefined) return;
    this.derivedViewsTimer = setTimeout(() => {
      this.derivedViewsTimer = undefined;
      const pending = this.pendingDerivedViews;
      this.pendingDerivedViews = null;
      if (
        this.destroyed ||
        !pending ||
        pending.revision !== this.derivedViewsRevision ||
        pending.document !== this.view.state.doc ||
        pending.profile !== this.profile ||
        pending.resourceBaseUrl !== this.resourceBaseUrl
      )
        return;
      this.refreshDerivedViews(pending.markdown, undefined, {
        renderPreview: this.mode === "preview",
        refreshCompatibility: true,
      });
    }, 0);
  }

  private codeBlockControlOptions(): CodeBlockControlOptions {
    // Keep this callback dynamic: the initial document may be constructed
    // before the host's clipboard capability flag arrives. Existing NodeViews
    // must still switch to the authoritative host route after that message.
    return { copyText: (value) => this.copyCodeBlockText(value) };
  }

  private canEditBlock(): boolean {
    return (
      this.initialized &&
      !this.previewOnly &&
      this.mode === "rich" &&
      !this.parseError &&
      !this.conflict &&
      !this.syncPaused &&
      !this.pendingExternal &&
      !this.pendingProfile &&
      this.view?.editable !== false
    );
  }

  private handleBlockComposition(active: boolean): void {
    this.composing = active;
    if (this.blockCompositionTimer !== undefined) {
      clearTimeout(this.blockCompositionTimer);
      this.blockCompositionTimer = undefined;
    }
    if (!active) {
      // The final native input event can follow compositionend. Defer external
      // replacement beyond its microtasks so that input updates the draft
      // before a successful rebase can replace the native textarea.
      this.blockCompositionTimer = setTimeout(() => {
        this.blockCompositionTimer = undefined;
        if (this.destroyed || this.composing) return;
        this.flushExternalAfterComposition();
        this.flushDeferredHostCommand();
      }, 0);
    }
  }

  private preserveHeaderDraft(draft: string, message: string): void {
    if (this.destroyed) return;
    const dialog = document.createElement("dialog");
    dialog.className = "mm-input-dialog mm-block-draft-dialog";
    dialog.setAttribute("aria-label", "Preserved block draft");
    const help = document.createElement("p");
    help.textContent = message;
    const input = document.createElement("textarea");
    input.className = "mm-dialog-input";
    input.setAttribute("aria-label", "Block draft to copy");
    input.value = draft;
    input.readOnly = true;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => {
      this.closeDialog(dialog);
      dialog.remove();
    });
    dialog.addEventListener("cancel", () => dialog.remove());
    dialog.append(help, input, close);
    this.root.append(dialog);
    this.openDialog(dialog);
    input.focus();
    input.select();
  }

  private async copyCodeBlockText(value: string): Promise<boolean> {
    if (this.vscode && this.clipboardAvailable) {
      try {
        if (await this.writeHostClipboard(value)) return true;
      } catch {
        // Fall through to the browser clipboard path when the host route is
        // unavailable or rejects the request.
      }
    }
    return copyClipboardText(value, this.root.ownerDocument);
  }

  private writeHostClipboard(value: string): Promise<boolean> {
    if (!this.vscode || !this.clipboardAvailable) return Promise.resolve(false);
    const requestId = newOperationId();
    return new Promise<boolean>((resolve) => {
      const timer = this.root.ownerDocument.defaultView?.setTimeout(() => {
        this.pendingClipboard.delete(requestId);
        resolve(false);
      }, 5_000);
      this.pendingClipboard.set(
        requestId,
        timer === undefined ? { resolve } : { resolve, timer },
      );
      this.vscode?.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "clipboard-write",
        requestId,
        text: value,
      });
    });
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
    const key = compatibilityStateKey(markdown, this.profile);
    if (this.compatibilityKey === key) return;
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
    this.compatibilityKey = key;
    this.compatibilityEl.replaceChildren();
    if (!issues.length) {
      this.compatibilityEl.textContent = "";
      this.compatibilityEl.removeAttribute("title");
      this.root.removeAttribute("data-compatibility-level");
      return;
    }
    const level = issues.some((issue) => issue.level === "error")
      ? "error"
      : "warning";
    this.root.setAttribute("data-compatibility-level", level);
    const icon = makeElement("span", {
      class: "mm-compatibility-icon",
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

  private setInitialized(value: boolean): void {
    this.initialized = value;
    this.root.toggleAttribute("data-loading", !value);
    this.updateEditingControlState();
  }

  private updateEditingControlState(
    selection = this.view.state.selection,
  ): void {
    const editingDisabled =
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      Boolean(this.parseError);
    for (const element of Array.from(
      this.root.querySelectorAll<
        | HTMLButtonElement
        | HTMLSelectElement
        | HTMLInputElement
        | HTMLTextAreaElement
      >(
        ".mm-tool-button, .mm-emoji-button, .mm-heading-select, .mm-floating-button",
      ),
    )) {
      element.disabled =
        editingDisabled ||
        (element.dataset.gfmOnly === "true" && this.profile === "commonmark");
    }
    const blockEditingDisabled = !this.canEditBlock();
    if (this.blockGapButton) {
      this.blockGapButton.disabled = !this.canUseBlockGapInsert();
      if (this.blockGapButton.disabled) this.clearBlockGapInsert();
    }
    for (const control of this.root.querySelectorAll<
      | HTMLButtonElement
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
    >(
      ".mm-code-language-trigger, .mm-code-language-inline, .mm-details-summary",
    ))
      control.disabled = blockEditingDisabled;
    for (const body of this.root.querySelectorAll<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    ))
      setAlertBodyReadOnly(body, blockEditingDisabled);
    for (const body of this.root.querySelectorAll<HTMLElement>(
      ".mm-details-body",
    )) {
      if (blockEditingDisabled) body.contentEditable = "false";
      else body.removeAttribute("contenteditable");
    }
    for (const button of Array.from(
      this.root.querySelectorAll<HTMLButtonElement>(".mm-mode-button"),
    )) {
      button.disabled =
        !this.initialized ||
        (this.previewOnly && button.dataset.mode === "rich");
    }
    if (this.profileSelect) {
      this.profileSelect.disabled =
        !this.initialized ||
        this.syncPaused ||
        this.composing ||
        Boolean(this.pendingProfile?.operationId);
    }
    const inTable =
      this.initialized &&
      !this.parseError &&
      this.mode === "rich" &&
      Boolean(tableContext(this.view.state.selection));
    for (const button of Array.from(
      this.root.querySelectorAll<HTMLButtonElement>(".mm-table-toolbar-button"),
    ))
      button.disabled = !inTable || this.profile === "commonmark";
    if (editingDisabled) {
      this.closeWritingPopups();
      this.closeEmojiPicker();
      this.invalidateProfileFeatureDialog();
    }
    this.updateProfileToolbar();
    // Normal selection visibility belongs to updateSelectionToolbar. This
    // path may only force the toolbar closed when the selection is ineligible.
    if (this.selectionToolbar && !this.selectionToolbarEligible(selection)) {
      this.selectionToolbar.hidden = true;
      this.selectionToolbar.setAttribute("aria-hidden", "true");
      this.clearSelectionToolbarSelection();
    }
    if (editingDisabled && this.emptyLineButton)
      this.emptyLineButton.hidden = true;
    if (editingDisabled && this.blockGapButton) this.clearBlockGapInsert();
    this.updateTableToolbar();
    this.updateToolbarActiveState(selection);
  }

  private setConflict(message: string): void {
    this.conflict = true;
    this.syncPaused = true;
    if (this.tableDialogOpen) this.closeTableDialog(message);
    this.closeWritingPopups();
    this.closeEmojiPicker();
    this.invalidateProfileFeatureDialog();
    // Lock native inputs first so text accepted before the rejection is part
    // of the same recoverable snapshot as the ProseMirror document.
    this.updateEditingControlState();
    const localMarkdown = this.currentMarkdown();
    this.persistRecovery(
      localMarkdown,
      this.sync.draftBaseMarkdown,
      this.sync.version,
      this.serializationError !== null || this.parseError !== null,
    );
    this.notifyHost("error", message);
  }

  /**
   * Action hints are deliberately not rendered in a persistent editor footer
   * or moved to a toast. Dedicated synchronization and serialization failures
   * call notifyHost directly; ordinary waiting and command-state hints stay
   * silent while the queue drains.
   */
  private setNotice(
    _message: string,
    _state: "info" | "error" = "info",
  ): void {}

  private notifyHost(
    level: "info" | "warning" | "error",
    message: string,
  ): void {
    const key = `${level}:${message}`;
    if (key === this.lastNotificationKey) return;
    this.lastNotificationKey = key;
    this.vscode?.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "notify",
      level,
      message: message.slice(0, 1_024),
    });
  }

  private installTooltipHandlers(): void {
    this.root.addEventListener(
      "pointerover",
      this.tooltipPointerOverHandler,
      true,
    );
    this.root.addEventListener(
      "pointerout",
      this.tooltipPointerOutHandler,
      true,
    );
    this.root.addEventListener("focusin", this.tooltipFocusInHandler, true);
    this.root.addEventListener("focusout", this.tooltipFocusOutHandler, true);
    this.root.addEventListener(
      "pointerdown",
      this.tooltipPointerDownHandler,
      true,
    );
    this.root.addEventListener("click", this.tooltipClickHandler, true);
    this.root.addEventListener("scroll", this.tooltipScrollHandler, true);
    window.addEventListener("scroll", this.tooltipScrollHandler, true);
    document.addEventListener("keydown", this.tooltipKeyDownHandler, true);
  }

  private tooltipTargetFor(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    if (target === this.tooltip || this.tooltip?.contains(target)) return null;
    const candidate = target.closest<HTMLElement>("[data-tooltip]");
    if (!candidate || !this.root.contains(candidate)) return null;
    return candidate.dataset.tooltip?.trim() ? candidate : null;
  }

  private setTooltip(element: HTMLElement, label: string): void {
    element.dataset.tooltip = label;
    element.removeAttribute("title");
  }

  private showTooltip(target: HTMLElement): void {
    const label = target.dataset.tooltip?.trim();
    if (!label || this.destroyed) return;
    if (this.tooltipTarget !== target) {
      this.hideTooltip();
      this.tooltipTarget = target;
      this.tooltipPreviousDescribedBy = target.getAttribute("aria-describedby");
      const describedBy = (this.tooltipPreviousDescribedBy ?? "")
        .split(/\s+/)
        .filter(Boolean);
      if (!describedBy.includes(this.tooltip.id))
        target.setAttribute(
          "aria-describedby",
          [...describedBy, this.tooltip.id].join(" "),
        );
    }
    this.tooltip.textContent = label;
    this.tooltip.hidden = false;
    this.tooltip.setAttribute("aria-hidden", "false");
    this.positionTooltip(target);
  }

  private hideTooltip(): void {
    if (!this.tooltip) return;
    if (this.tooltipTarget) {
      if (this.tooltipPreviousDescribedBy === null)
        this.tooltipTarget.removeAttribute("aria-describedby");
      else
        this.tooltipTarget.setAttribute(
          "aria-describedby",
          this.tooltipPreviousDescribedBy,
        );
    }
    this.tooltipTarget = null;
    this.tooltipPreviousDescribedBy = null;
    this.tooltip.hidden = true;
    this.tooltip.setAttribute("aria-hidden", "true");
    this.tooltip.textContent = "";
  }

  private positionTooltip(target: HTMLElement): void {
    const targetRect = target.getBoundingClientRect();
    const tooltipRect = this.tooltip.getBoundingClientRect();
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const width =
      tooltipRect.width ||
      Math.min(320, Math.max(72, target.dataset.tooltip?.length ?? 72));
    const height = tooltipRect.height || 28;
    let left = targetRect.left + targetRect.width / 2 - width / 2;
    let top = targetRect.bottom + 6;
    if (viewportHeight > 0 && top + height > viewportHeight - 6)
      top = targetRect.top - height - 6;
    left = Math.max(6, Math.min(left, Math.max(6, viewportWidth - width - 6)));
    top = Math.max(6, Math.min(top, Math.max(6, viewportHeight - height - 6)));
    this.tooltip.style.left = `${Math.round(left)}px`;
    this.tooltip.style.top = `${Math.round(top)}px`;
  }

  private buildToolbar(): HTMLElement {
    const toolbar = makeElement("div", {
      class: "mm-toolbar",
      role: "toolbar",
      "aria-label": "Markdown formatting",
    });
    const primary = makeElement("div", {
      class: "mm-toolbar-primary",
      "data-toolbar-row": "primary",
    });
    toolbar.append(primary);
    const sourceButton = makeElement("button", {
      type: "button",
      class: "mm-mode-button mm-source-button",
      "data-mode": "source",
      "aria-label": "Source view",
      "data-tooltip": "Source view",
    }) as HTMLButtonElement;
    sourceButton.textContent = "Source";
    sourceButton.addEventListener("mousedown", (event) =>
      event.preventDefault(),
    );
    sourceButton.addEventListener("click", () => this.requestSource());
    const separator = (parent: HTMLElement = primary): void =>
      parent.append(
        makeElement("span", {
          class: "mm-toolbar-separator",
          "aria-hidden": "true",
        }),
      );
    const addButton = (
      label: string,
      title: string,
      command: () => void,
      testId?: string,
      parent: HTMLElement = primary,
      menuItem = false,
      iconName?: ToolbarIconName,
      activeKey?: ToolbarActiveKey,
    ): HTMLButtonElement => {
      const button = makeElement("button", {
        type: "button",
        class: "mm-tool-button",
        "data-tooltip": title,
        "aria-label": title,
        ...(menuItem ? { role: "menuitem" } : {}),
        ...(testId ? { "data-testid": testId } : {}),
      }) as HTMLButtonElement;
      if (iconName) appendToolbarIcon(button, iconName);
      else button.textContent = label;
      if (activeKey) {
        button.dataset.toolbarActive = activeKey;
        button.setAttribute("aria-pressed", "false");
      }
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        // A menu item's mousedown must not focus the ProseMirror surface:
        // doing so fires the document focusin guard and closes the menu before
        // the browser can deliver the corresponding click. Selection restore
        // happens synchronously in the click handler instead.
        if (!menuItem) this.view.focus();
      });
      button.addEventListener("click", () => {
        const guardedSelection = this.popupSelection;
        if (
          menuItem &&
          guardedSelection &&
          !this.restoreWritingPopupSelection()
        ) {
          this.closeWritingPopups();
          this.setNotice(
            "The document changed while this menu was open; nothing was applied.",
            "error",
          );
          return;
        }
        if (!menuItem) this.restoreWritingPopupSelection();
        command();
        if (menuItem && !this.tableDialogOpen) this.closeWritingPopups();
      });
      parent.append(button);
      return button;
    };
    this.profileSelect = document.createElement("select");
    this.profileSelect.className = "mm-profile-select";
    this.setTooltip(this.profileSelect, "Markdown profile");
    this.profileSelect.setAttribute("aria-label", "Markdown profile");
    for (const [value, label] of [
      ["github", "GitHub"],
      ["gitlab", "GitLab"],
      ["commonmark", "CommonMark"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.profileSelect.append(option);
    }
    this.updateProfileSelect();
    this.profileSelect.addEventListener("change", () => {
      this.requestProfileChange(this.profileSelect.value as DocumentProfile);
    });
    primary.append(this.profileSelect);
    separator();

    const headingSelect = document.createElement("select");
    headingSelect.className = "mm-heading-select";
    this.setTooltip(headingSelect, "Heading level");
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
      // Keep the editor selection while allowing the native select to open.
      // Preventing this event makes the control impossible to use by mouse.
      void event;
      const { from, to } = this.view.state.selection;
      this.savedSelection = { from, to };
      this.headingSelection = this.view.state.selection;
    });
    headingSelect.addEventListener(
      "focus",
      () => (this.headingSelection = this.view.state.selection),
    );
    headingSelect.addEventListener("change", () => {
      if (!this.restoreSelectionObject(this.headingSelection))
        this.view.focus();
      this.headingSelection = null;
      const value = headingSelect.value;
      const command =
        value === "p"
          ? commandForBlock("paragraph")
          : commandForBlock("heading", { level: Number(value) });
      command(this.view.state, (tr) => {
        const starter = getStarterState(this.view.state);
        if (value === "p" && starter?.active)
          setStarterMeta(tr, {
            active: false,
            untouched: true,
            preserveSource: true,
          });
        this.dispatchTransaction(tr);
      });
    });
    primary.append(headingSelect);
    separator();
    addButton(
      "",
      "Bold",
      () => this.runCommand(commandForMark("strong", this.schema)),
      "toolbar-bold",
      primary,
      false,
      "bold",
      "strong",
    );
    addButton(
      "",
      "Italic",
      () => this.runCommand(commandForMark("em", this.schema)),
      "toolbar-italic",
      primary,
      false,
      "italic",
      "em",
    );
    const strikeButton = addButton(
      "",
      "Strikethrough",
      () => {
        if (this.profile === "commonmark") {
          this.setNotice("Strikethrough is unavailable in CommonMark.");
          return;
        }
        this.runCommand(commandForMark("strike", this.schema));
      },
      "toolbar-strike",
      primary,
      false,
      "strikethrough",
      "strike",
    );
    strikeButton.dataset.gfmOnly = "true";
    addButton(
      "",
      "Inline code",
      () => this.runCommand(commandForMark("code", this.schema)),
      "toolbar-code",
      primary,
      false,
      "inline-code",
      "code",
    );
    addButton(
      "",
      "Insert link",
      () => this.insertLink(),
      "toolbar-link",
      primary,
      false,
      "link",
      "link",
    );
    const imageButton = addButton(
      "",
      "Insert image",
      () => this.insertImage(),
      "toolbar-image",
      primary,
      false,
      "image",
      "image",
    );
    imageButton.dataset.tooltip =
      "Insert image; Shift + drag an image to import";
    const emojiButton = makeElement("button", {
      type: "button",
      class: "mm-emoji-button",
      "data-tooltip": "Insert emoji",
      "aria-label": "Insert emoji",
      "data-testid": "toolbar-emoji",
    }) as HTMLButtonElement;
    emojiButton.textContent = "😊";
    emojiButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.captureEmojiSelection();
    });
    emojiButton.addEventListener("click", () =>
      this.openEmojiPicker(emojiButton),
    );
    primary.append(emojiButton);
    this.buildEmojiPicker(toolbar, emojiButton);
    const bulletListButton = addButton(
      "",
      "Bullet list",
      () => this.runListCommand("bullet_list"),
      "toolbar-bullet-list",
      primary,
      false,
      "bullet-list",
    );
    bulletListButton.dataset.listKind = "bullet";
    bulletListButton.setAttribute("aria-pressed", "false");
    const orderedListButton = addButton(
      "",
      "Ordered list",
      () => this.runListCommand("ordered_list"),
      "toolbar-ordered-list",
      primary,
      false,
      "ordered-list",
    );
    orderedListButton.dataset.listKind = "ordered";
    orderedListButton.setAttribute("aria-pressed", "false");
    const taskButton = addButton(
      "",
      "Task list",
      () => this.runTaskList(),
      "toolbar-task-list",
      primary,
      false,
      "checklist",
    );
    taskButton.dataset.gfmOnly = "true";
    taskButton.dataset.listKind = "task";
    taskButton.setAttribute("aria-pressed", "false");
    addButton(
      "",
      "Block quote",
      () => this.runCommand(commandForBlock("blockquote")),
      "toolbar-quote",
      primary,
      false,
      "blockquote",
      "blockquote",
    );
    addButton(
      "",
      "Code block",
      () => this.runCommand(commandForBlock("code_block", { params: "" })),
      "toolbar-code-block",
      primary,
      false,
      "code-block",
      "code_block",
    );
    const insertTableButton = addButton(
      "",
      "Insert table",
      () => this.openTableDialog(insertTableButton),
      "toolbar-table",
      primary,
      false,
      "table",
      "table",
    );
    insertTableButton.dataset.gfmOnly = "true";
    addButton(
      "",
      "Horizontal rule",
      () => this.insertHorizontalRule(),
      "toolbar-horizontal-rule",
      primary,
      false,
      "divider",
      "horizontal_rule",
    );
    addButton(
      "",
      "Format Markdown",
      () => this.formatDocument(),
      "toolbar-format",
      primary,
      false,
      "format",
    );
    separator();
    const makeField = (
      labelText: string,
      type: string,
      placeholder: string,
    ): HTMLInputElement => {
      const label = document.createElement("label");
      label.className = "mm-dialog-field";
      const caption = document.createElement("span");
      caption.textContent = labelText;
      const input = document.createElement("input");
      input.type = type;
      input.placeholder = placeholder;
      label.append(caption, input);
      return input;
    };
    const link = document.createElement("dialog");
    link.className = "mm-input-dialog";
    link.setAttribute("aria-labelledby", "mm-link-dialog-title");
    const linkForm = document.createElement("form");
    linkForm.className = "mm-dialog-form";
    const linkTitle = document.createElement("h2");
    linkTitle.id = "mm-link-dialog-title";
    linkTitle.textContent = "Insert link";
    this.linkUrlInput = makeField(
      "Link path or URL",
      "text",
      "./docs/example.md",
    );
    this.linkUrlInput.spellcheck = false;
    this.linkUrlInput.autocapitalize = "off";
    this.linkUrlInput.inputMode = "url";
    this.linkTextInput = makeField("Text", "text", "Selected text");
    const linkActions = document.createElement("div");
    linkActions.className = "mm-dialog-actions";
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
    image.className = "mm-input-dialog";
    image.setAttribute("aria-labelledby", "mm-image-dialog-title");
    const imageForm = document.createElement("form");
    imageForm.className = "mm-dialog-form";
    const imageTitle = document.createElement("h2");
    imageTitle.id = "mm-image-dialog-title";
    imageTitle.textContent = "Insert image";
    this.imageUrlInput = makeField(
      "Image path or URL",
      "text",
      "./images/example.png",
    );
    this.imageAltInput = makeField("Alt text", "text", "Description");
    const imageActions = document.createElement("div");
    imageActions.className = "mm-dialog-actions";
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

    this.buildTableDialog(toolbar);
    this.tableToolbar = this.buildTableToolbar();
    toolbar.append(this.tableToolbar);
    this.profileToolbar = this.buildProfileToolbar();
    toolbar.append(this.profileToolbar);
    this.buildProfileFeatureDialog(toolbar);
    primary.append(sourceButton);
    return toolbar;
  }

  private buildProfileToolbar(): HTMLElement {
    const toolbar = makeElement("div", {
      class: "mm-profile-toolbar",
      role: "toolbar",
      "aria-label": "Profile-specific Markdown features",
      "aria-hidden": "true",
      hidden: "true",
    });
    const shortLabels: Record<ProfileFeatureId, string> = {
      alert: "Alert",
      details: "Details",
      math: "Math",
      mermaid: "Mermaid",
      "gitlab-toc": "TOC",
      "gitlab-description-list": "Definition",
      "gitlab-diff-added": "+ Diff",
      "gitlab-diff-removed": "− Diff",
    };
    for (const feature of getProfileFeatures("gitlab")) {
      const button = makeElement("button", {
        type: "button",
        class: "mm-profile-feature-button",
        "data-profile-feature": feature.id,
        "data-tooltip": feature.description,
        "aria-label": feature.label,
      }) as HTMLButtonElement;
      button.textContent = shortLabels[feature.id] ?? feature.label;
      button.addEventListener("mousedown", (event) => {
        if (!this.canUseProfileFeature(feature)) return;
        event.preventDefault();
        this.captureProfileFeatureSelection();
      });
      button.addEventListener("click", () => {
        if (!this.canUseProfileFeature(feature)) return;
        if (feature.id === "gitlab-toc") {
          this.runProfileFeature(feature.id);
        } else {
          this.openProfileFeatureDialog(feature.id, button);
        }
      });
      toolbar.append(button);
    }
    return toolbar;
  }

  private buildProfileFeatureDialog(container: HTMLElement): void {
    const dialog = document.createElement("dialog");
    dialog.className = "mm-input-dialog mm-profile-feature-dialog";
    dialog.setAttribute("aria-labelledby", "mm-profile-feature-dialog-title");
    dialog.setAttribute("data-feature-dialog", "true");
    const form = document.createElement("form");
    form.className = "mm-dialog-form";
    const title = document.createElement("h2");
    title.id = "mm-profile-feature-dialog-title";
    title.textContent = "Insert feature";
    this.profileFeatureMermaidMeta = document.createElement("div");
    this.profileFeatureMermaidMeta.className = "mm-mermaid-dialog-meta";
    this.profileFeatureMermaidMeta.hidden = true;
    this.profileFeatureMermaidVersion = document.createElement("span");
    this.profileFeatureMermaidVersion.className = "mm-mermaid-version";
    this.profileFeatureMermaidVersion.dataset.featureMermaidVersion = "true";
    this.profileFeatureMermaidStatus = document.createElement("span");
    this.profileFeatureMermaidStatus.className = "mm-mermaid-validation-status";
    this.profileFeatureMermaidStatus.dataset.validationState = "empty";
    this.profileFeatureMermaidStatus.setAttribute("role", "status");
    this.profileFeatureMermaidStatus.setAttribute("aria-live", "polite");
    this.profileFeatureMermaidStatus.setAttribute("aria-atomic", "true");
    this.profileFeatureMermaidStatus.setAttribute(
      "aria-label",
      "Mermaid syntax status",
    );
    this.profileFeatureMermaidMeta.append(
      this.profileFeatureMermaidVersion,
      this.profileFeatureMermaidStatus,
    );
    const alertField = document.createElement("label");
    alertField.className = "mm-dialog-field";
    alertField.dataset.featureFieldContainer = "alert-type";
    const alertCaption = document.createElement("span");
    alertCaption.textContent = "Alert type";
    this.profileFeatureAlertType = document.createElement("select");
    this.profileFeatureAlertType.dataset.featureField = "alert-type";
    this.profileFeatureAlertType.setAttribute("aria-label", "Alert type");
    for (const kind of [
      "NOTE",
      "TIP",
      "IMPORTANT",
      "WARNING",
      "CAUTION",
    ] as const) {
      const option = document.createElement("option");
      option.value = kind;
      option.textContent = kind;
      this.profileFeatureAlertType.append(option);
    }
    alertField.append(alertCaption, this.profileFeatureAlertType);

    const titleField = document.createElement("label");
    titleField.className = "mm-dialog-field";
    titleField.dataset.featureFieldContainer = "title";
    const titleCaption = document.createElement("span");
    titleCaption.textContent = "Title";
    this.profileFeatureTitleInput = document.createElement("input");
    this.profileFeatureTitleInput.type = "text";
    this.profileFeatureTitleInput.dataset.featureField = "title";
    this.profileFeatureTitleInput.setAttribute("aria-label", "Title");
    titleField.append(titleCaption, this.profileFeatureTitleInput);

    const termField = document.createElement("label");
    termField.className = "mm-dialog-field";
    termField.dataset.featureFieldContainer = "term";
    const termCaption = document.createElement("span");
    termCaption.textContent = "Term";
    this.profileFeatureTermInput = document.createElement("input");
    this.profileFeatureTermInput.type = "text";
    this.profileFeatureTermInput.dataset.featureField = "term";
    this.profileFeatureTermInput.setAttribute("aria-label", "Term");
    termField.append(termCaption, this.profileFeatureTermInput);

    const bodyField = document.createElement("label");
    bodyField.className = "mm-dialog-field";
    bodyField.dataset.featureFieldContainer = "body";
    this.profileFeatureBodyLabel = document.createElement("span");
    this.profileFeatureBodyLabel.textContent = "Body";
    this.profileFeatureBodyInput = document.createElement("textarea");
    this.profileFeatureBodyInput.rows = 8;
    this.profileFeatureBodyInput.required = true;
    this.profileFeatureBodyInput.dataset.featureField = "body";
    this.profileFeatureBodyInput.setAttribute("aria-label", "Body");
    this.profileFeatureBodyInput.addEventListener("input", () => {
      if (this.profileFeatureId === "mermaid" && this.profileFeatureDialogOpen)
        this.scheduleMermaidValidation();
    });
    bodyField.append(
      this.profileFeatureBodyLabel,
      this.profileFeatureBodyInput,
    );
    this.profileFeatureError = makeElement("p", {
      class: "mm-profile-feature-error",
      "data-feature-error": "true",
      role: "alert",
      hidden: "true",
    });
    this.profileFeatureError.textContent = "";
    bodyField.append(this.profileFeatureError);

    const actions = document.createElement("div");
    actions.className = "mm-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.closeProfileFeatureDialog());
    const apply = document.createElement("button");
    apply.type = "submit";
    apply.textContent = "Insert";
    this.profileFeatureApplyButton = apply;
    actions.append(cancel, apply);
    form.append(
      title,
      this.profileFeatureMermaidMeta,
      alertField,
      titleField,
      termField,
      bodyField,
      actions,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.commitProfileFeatureDialog();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeProfileFeatureDialog();
    });
    dialog.addEventListener("close", () => {
      if (this.profileFeatureDialogOpen)
        this.closeProfileFeatureDialog(undefined, false);
    });
    dialog.append(form);
    container.append(dialog);
    this.profileFeatureDialog = dialog;
  }

  private canUseProfileFeature(
    feature: ProfileFeatureDefinition | ProfileFeatureId,
  ): boolean {
    const definition =
      typeof feature === "string"
        ? getProfileFeatures(this.profile).find(
            (candidate) => candidate.id === feature,
          )
        : feature;
    if (
      !definition ||
      !definition.profiles.includes(this.profile) ||
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.composing ||
      Boolean(this.pendingProfile)
    )
      return false;
    if (definition.kind === "inline") {
      const selection = this.view.state.selection;
      let inCodeBlock = false;
      for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
        if (selection.$from.node(depth).type.name === "code_block") {
          inCodeBlock = true;
          break;
        }
      }
      if (
        !(selection instanceof TextSelection) ||
        selection.$from.parent !== selection.$to.parent ||
        inCodeBlock
      )
        return false;
    }
    return true;
  }

  private captureProfileFeatureSelection(): boolean {
    if (
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.composing ||
      this.pendingProfile
    )
      return false;
    this.profileFeatureSelection = this.view.state.selection;
    this.profileFeatureDocumentGeneration = this.documentGeneration;
    this.profileFeatureProfile = this.profile;
    return true;
  }

  private selectedProfileFeatureText(): string {
    const selection = this.profileFeatureSelection;
    if (
      !selection ||
      !(selection instanceof TextSelection) ||
      selection.empty ||
      selection.$from.doc !== this.view.state.doc
    )
      return "";
    return this.view.state.doc.textBetween(
      selection.from,
      selection.to,
      "\n",
      "\n",
    );
  }

  private profileFeatureDefinition(
    id: ProfileFeatureId,
  ): ProfileFeatureDefinition | null {
    return (
      getProfileFeatures(this.profile).find((feature) => feature.id === id) ??
      null
    );
  }

  private updateMermaidValidation(snapshot: MermaidValidationSnapshot): void {
    this.profileFeatureMermaidSnapshot = snapshot;
    if (!this.profileFeatureMermaidStatus) return;
    const label =
      snapshot.status === "valid"
        ? `✓ Valid · ${humanizeMermaidDiagramType(snapshot.diagramType ?? "")}`
        : snapshot.status === "checking"
          ? "Checking…"
          : snapshot.status === "empty"
            ? "Enter Mermaid source"
            : "✕ Syntax error";
    this.profileFeatureMermaidStatus.dataset.validationState = snapshot.status;
    this.profileFeatureMermaidStatus.textContent = label;
    this.profileFeatureMermaidStatus.setAttribute(
      "aria-label",
      `Mermaid syntax status: ${label}`,
    );
    if (this.profileFeatureId === "mermaid")
      this.profileFeatureApplyButton.disabled =
        snapshot.status !== "valid" ||
        !this.profileFeatureDialogOpen ||
        !this.profileFeatureError.hidden;
  }

  private scheduleMermaidValidation(): void {
    if (this.profileFeatureId !== "mermaid") return;
    this.profileFeatureApplyButton.disabled = true;
    this.mermaidValidation.schedule(this.profileFeatureBodyInput.value);
  }

  private mermaidValidationIsCurrentAndValid(source: string): boolean {
    const snapshot = this.profileFeatureMermaidSnapshot;
    return (
      snapshot?.status === "valid" &&
      snapshot.source === source &&
      this.profileFeatureBodyInput.value === source
    );
  }

  private async validateAndCommitMermaid(source: string): Promise<void> {
    const snapshot = await this.mermaidValidation.validateNow(source);
    if (
      !snapshot ||
      !this.profileFeatureDialogOpen ||
      this.profileFeatureId !== "mermaid" ||
      this.profileFeatureBodyInput.value !== source
    )
      return;
    if (snapshot.status !== "valid") {
      this.profileFeatureBodyInput.focus();
      return;
    }
    this.commitProfileFeatureDialogCore();
  }

  private openProfileFeatureDialog(
    id: ProfileFeatureId,
    invokingButton: HTMLButtonElement | null = null,
  ): void {
    const feature = this.profileFeatureDefinition(id);
    if (!feature || !this.canUseProfileFeature(feature)) {
      this.setNotice(
        "This feature is unavailable in the current editing mode.",
        "error",
      );
      return;
    }
    if (!this.captureProfileFeatureSelection()) return;
    this.closeWritingPopups();
    this.closeEmojiPicker();
    this.profileFeatureEditTarget = null;
    this.profileFeatureAlertNodeView = null;
    this.profileFeatureId = id;
    this.profileFeatureInvokingButton = invokingButton;
    this.profileFeatureDialogOpen = true;
    this.mermaidValidation.cancel();
    this.profileFeatureMermaidSnapshot = null;
    this.profileFeatureMermaidMeta.hidden = id !== "mermaid";
    if (id === "mermaid")
      this.profileFeatureMermaidVersion.textContent =
        "Mermaid " + mermaidRuntimeVersionFromGlobal();
    this.profileFeatureDialog.dataset.profileFeature = id;
    this.profileFeatureDialog.dataset.profileFeatureMode = "insert";
    this.profileFeatureDialog.querySelector("h2")!.textContent =
      "Insert " + (id === "mermaid" ? "Mermaid" : feature.label);
    this.profileFeatureApplyButton.textContent = "Insert";
    this.profileFeatureApplyButton.disabled = id === "mermaid";
    this.profileFeatureAlertType.parentElement!.hidden = id !== "alert";
    this.profileFeatureTitleInput.parentElement!.hidden = id !== "details";
    this.profileFeatureTermInput.parentElement!.hidden =
      id !== "gitlab-description-list";
    const selected = this.selectedProfileFeatureText();
    this.profileFeatureBodyInput.value = selected;
    this.profileFeatureError.hidden = true;
    this.profileFeatureError.textContent = "";
    this.profileFeatureTitleInput.value = "Details";
    this.profileFeatureTermInput.value = "Term";
    this.profileFeatureAlertType.value = "NOTE";
    const bodyLabel =
      id === "math"
        ? "Expression"
        : id === "mermaid"
          ? "Diagram source"
          : id === "gitlab-description-list"
            ? "Definition"
            : id === "gitlab-diff-added" || id === "gitlab-diff-removed"
              ? "Text"
              : "Body";
    this.profileFeatureBodyLabel.textContent = bodyLabel;
    this.profileFeatureBodyInput.setAttribute("aria-label", bodyLabel);
    if (!selected) {
      if (id === "alert") this.profileFeatureBodyInput.value = "Alert details";
      else if (id === "math") this.profileFeatureBodyInput.value = "x = y";
      else if (id === "mermaid")
        this.profileFeatureBodyInput.value =
          "flowchart TD\n    A[Start] --> B[End]";
      else if (id === "gitlab-description-list")
        this.profileFeatureBodyInput.value = "Description";
      else if (id === "gitlab-diff-added" || id === "gitlab-diff-removed")
        this.profileFeatureBodyInput.value = "Selected text";
      else if (id === "details")
        this.profileFeatureBodyInput.value = "Details content";
    }
    if (id === "mermaid") this.scheduleMermaidValidation();
    this.openDialog(this.profileFeatureDialog);
    if (id === "details") this.profileFeatureTitleInput.focus();
    else if (id === "gitlab-description-list")
      this.profileFeatureTermInput.focus();
    else this.profileFeatureBodyInput.focus();
  }

  private openProfileFeatureAlertEditor(
    position: number,
    returnFocus?: HTMLElement,
  ): void {
    const feature = this.profileFeatureDefinition("alert");
    if (
      !feature ||
      this.profileFeatureDialogOpen ||
      !this.view.editable ||
      !this.canUseProfileFeature(feature)
    )
      return;
    const document = this.view.state.doc;
    const node = document.nodeAt(position);
    if (
      !node ||
      node.type.name !== "raw_block" ||
      String(node.attrs.kind ?? "") !== "alert"
    )
      return;

    const source = String(node.attrs.source ?? "");
    const parts = parseAlertSource(source);
    const marker = parts.marker.toUpperCase();
    const alertType = ALERT_TYPES.includes(marker as AlertType)
      ? (marker as AlertType)
      : "NOTE";

    this.closeWritingPopups();
    this.closeEmojiPicker();
    this.profileFeatureSelection = null;
    this.profileFeatureDocumentGeneration = -1;
    this.profileFeatureProfile = null;
    this.profileFeatureId = "alert";
    this.profileFeatureInvokingButton = null;
    this.profileFeatureEditTarget = {
      position,
      node,
      document,
      documentGeneration: this.documentGeneration,
      profile: this.profile,
      source,
      returnFocus: returnFocus ?? null,
      bodySelection:
        returnFocus instanceof HTMLTextAreaElement
          ? [
              returnFocus.selectionStart,
              returnFocus.selectionEnd,
              returnFocus.selectionDirection,
            ]
          : undefined,
    };
    const nodeView = this.view.nodeDOM(position);
    this.profileFeatureAlertNodeView =
      nodeView instanceof HTMLElement ? nodeView : null;
    this.profileFeatureAlertNodeView?.classList.add("mm-alert-dialog-open");
    this.profileFeatureDialogOpen = true;
    this.mermaidValidation.cancel();
    this.profileFeatureMermaidSnapshot = null;
    this.profileFeatureMermaidMeta.hidden = true;
    this.profileFeatureDialog.dataset.profileFeature = "alert";
    this.profileFeatureDialog.dataset.profileFeatureMode = "edit";
    this.profileFeatureDialog.querySelector("h2")!.textContent = "Edit Alert";
    this.profileFeatureApplyButton.textContent = "Update";
    this.profileFeatureApplyButton.disabled = false;
    this.profileFeatureAlertType.parentElement!.hidden = false;
    this.profileFeatureTitleInput.parentElement!.hidden = true;
    this.profileFeatureTermInput.parentElement!.hidden = true;
    this.profileFeatureAlertType.value = alertType;
    this.profileFeatureBodyLabel.textContent = "Body";
    this.profileFeatureBodyInput.setAttribute("aria-label", "Body");
    this.profileFeatureBodyInput.value = parts.body;
    this.profileFeatureError.hidden = true;
    this.profileFeatureError.textContent = "";
    this.openDialog(this.profileFeatureDialog);
    this.profileFeatureBodyInput.focus();
  }

  private openRenderedBlockEditor(
    position: number,
    returnFocus?: HTMLElement,
  ): void {
    if (!this.canEditBlock() || this.composing || this.profileFeatureDialogOpen)
      return;
    const node = this.view.state.doc.nodeAt(position);
    const sourceEditor = node && blockSourceEditor(node);
    if (!node || !sourceEditor) return;
    this.openProfileFeatureDialog(sourceEditor.kind);
    if (!this.profileFeatureDialogOpen) return;
    this.profileFeatureSelection = null;
    this.profileFeatureEditTarget = {
      position,
      node,
      document: this.view.state.doc,
      documentGeneration: this.documentGeneration,
      profile: this.profile,
      source: String(node.attrs.source ?? ""),
      returnFocus: returnFocus ?? null,
    };
    this.profileFeatureDialog.dataset.profileFeatureMode = "edit";
    this.profileFeatureDialog.querySelector("h2")!.textContent =
      sourceEditor.kind === "math" ? "Edit Math" : "Edit Mermaid";
    this.profileFeatureApplyButton.textContent = "Update";
    this.profileFeatureBodyInput.value = sourceEditor.body;
    if (sourceEditor.kind === "mermaid") this.scheduleMermaidValidation();
    this.profileFeatureBodyInput.focus();
  }

  private profileFeatureValues(): ProfileFeatureValues {
    const id = this.profileFeatureId;
    const body = this.profileFeatureBodyInput.value;
    if (id === "alert")
      return {
        alertType: this.profileFeatureAlertType.value as
          "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION",
        body,
      };
    if (id === "details")
      return { summary: this.profileFeatureTitleInput.value, body };
    if (id === "math") return { expression: body };
    if (id === "mermaid") return { source: body };
    if (id === "gitlab-description-list")
      return { term: this.profileFeatureTermInput.value, definition: body };
    if (id === "gitlab-diff-added" || id === "gitlab-diff-removed")
      return { text: body };
    return {};
  }

  private invalidateProfileFeatureDialog(): void {
    if (!this.profileFeatureEditTarget) {
      this.closeProfileFeatureDialog();
      return;
    }
    this.profileFeatureError.hidden = false;
    this.profileFeatureError.textContent =
      "The document or editing mode changed; nothing was updated. Copy your draft before closing this dialog.";
    this.profileFeatureApplyButton.disabled = true;
  }

  private closeProfileFeatureDialog(
    message?: string,
    restoreFocus = true,
  ): void {
    if (
      !this.profileFeatureDialogOpen &&
      !this.profileFeatureSelection &&
      !this.profileFeatureEditTarget
    )
      return;
    this.profileFeatureDialogOpen = false;
    const button = this.profileFeatureInvokingButton;
    const editReturnFocus = this.profileFeatureEditTarget?.returnFocus;
    const bodySelection = this.profileFeatureEditTarget?.bodySelection;
    const editTarget = this.profileFeatureEditTarget;
    const alertNodeView = this.profileFeatureAlertNodeView;
    const returnNode =
      editTarget &&
      editTarget.documentGeneration === this.documentGeneration &&
      this.profileFeatureError.hidden
        ? this.view.nodeDOM(editTarget.position)
        : null;
    this.profileFeatureInvokingButton = null;
    this.profileFeatureSelection = null;
    this.profileFeatureDocumentGeneration = -1;
    this.profileFeatureProfile = null;
    this.profileFeatureEditTarget = null;
    this.profileFeatureAlertNodeView = null;
    this.profileFeatureId = null;
    this.mermaidValidation.cancel();
    this.profileFeatureMermaidSnapshot = null;
    this.profileFeatureMermaidMeta.hidden = true;
    this.profileFeatureDialog.removeAttribute("data-profile-feature");
    this.profileFeatureDialog.removeAttribute("data-profile-feature-mode");
    this.closeDialog(this.profileFeatureDialog);
    alertNodeView?.classList.remove("mm-alert-dialog-open");
    if (message) this.setNotice(message, "error");
    if (restoreFocus) {
      if (editReturnFocus?.isConnected) {
        editReturnFocus.focus({ preventScroll: true });
        if (editReturnFocus instanceof HTMLTextAreaElement) {
          if (bodySelection)
            editReturnFocus.setSelectionRange(...bodySelection);
        }
      } else if (returnNode instanceof HTMLElement && returnNode.isConnected)
        returnNode.focus({ preventScroll: true });
      else if (button?.isConnected) button.focus();
    }
  }

  private runProfileFeature(id: ProfileFeatureId): boolean {
    const feature = this.profileFeatureDefinition(id);
    if (!feature || !this.canUseProfileFeature(feature)) return false;
    if (!this.captureProfileFeatureSelection()) return false;
    const selection = this.profileFeatureSelection;
    if (!selection || !this.restoreSelectionObject(selection)) {
      this.closeProfileFeatureDialog();
      this.setNotice(
        "The document changed while the feature menu was open; nothing was inserted.",
        "error",
      );
      return false;
    }
    const command = createProfileFeatureCommand(
      this.core,
      this.profile,
      id,
      {},
    );
    const applied = command(this.view.state, (tr) =>
      this.dispatchTransaction(tr),
    );
    if (!applied) {
      this.setNotice("The feature could not be inserted.", "error");
      return false;
    }
    this.profileFeatureSelection = null;
    this.profileFeatureDocumentGeneration = -1;
    this.profileFeatureProfile = null;
    this.view.focus();
    return true;
  }

  private commitProfileFeatureDialog(): void {
    if (
      this.profileFeatureId === "mermaid" &&
      !this.mermaidValidationIsCurrentAndValid(
        this.profileFeatureBodyInput.value,
      )
    ) {
      void this.validateAndCommitMermaid(this.profileFeatureBodyInput.value);
      return;
    }
    this.commitProfileFeatureDialogCore();
  }

  private commitProfileFeatureDialogCore(): void {
    const editTarget = this.profileFeatureEditTarget;
    if (editTarget) {
      const stale =
        !this.profileFeatureDialogOpen ||
        !this.canEditBlock() ||
        !this.initialized ||
        this.previewOnly ||
        this.mode !== "rich" ||
        this.parseError ||
        this.conflict ||
        this.syncPaused ||
        this.composing ||
        Boolean(this.pendingProfile) ||
        this.profile !== editTarget.profile ||
        this.documentGeneration !== editTarget.documentGeneration ||
        editTarget.document !== this.view.state.doc;
      const currentNode = stale
        ? null
        : this.view.state.doc.nodeAt(editTarget.position);
      const currentSourceEditor = currentNode
        ? blockSourceEditor(currentNode)
        : null;
      const currentIsAlert =
        currentNode?.type.name === "raw_block" &&
        String(currentNode.attrs.kind ?? "") === "alert";
      if (
        stale ||
        currentNode !== editTarget.node ||
        !currentNode ||
        (!currentIsAlert && !currentSourceEditor) ||
        String(currentNode.attrs.source ?? "") !== editTarget.source
      ) {
        this.profileFeatureError.hidden = false;
        this.profileFeatureError.textContent =
          "The document changed while this block dialog was open; nothing was updated. Your draft is still available here to copy.";
        this.setNotice(this.profileFeatureError.textContent, "error");
        return;
      }

      const sourceEditor = currentSourceEditor;
      if (sourceEditor) {
        const body = this.profileFeatureBodyInput.value;
        const nextSource =
          body === sourceEditor.body
            ? editTarget.source
            : sourceEditor.replace(body);
        // Validate the wrapper as one rendered source atom; never silently
        // split a source containing a closing delimiter into new blocks/text.
        const parsed = this.core.parseMarkdown(nextSource, this.profile).doc;
        const parsedSourceEditor =
          currentNode.type.name === "raw_inline"
            ? parsed.childCount === 1 &&
              parsed.firstChild?.type.name === "paragraph" &&
              parsed.firstChild.childCount === 1
              ? blockSourceEditor(parsed.firstChild.firstChild!)
              : null
            : parsed.childCount === 1
              ? blockSourceEditor(parsed.firstChild!)
              : null;
        if (
          !parsedSourceEditor ||
          parsedSourceEditor.kind !== sourceEditor.kind
        ) {
          this.profileFeatureError.hidden = false;
          this.profileFeatureError.textContent =
            "The source must remain one Math or Mermaid block. Your draft has been kept.";
          return;
        }
        if (nextSource !== editTarget.source)
          this.dispatchTransaction(
            this.view.state.tr.setNodeMarkup(editTarget.position, undefined, {
              ...currentNode.attrs,
              source: nextSource,
            }),
          );
        this.closeProfileFeatureDialog();
        return;
      }

      const candidateType = this.profileFeatureAlertType.value.toUpperCase();
      if (!ALERT_TYPES.includes(candidateType as AlertType)) {
        this.profileFeatureError.hidden = false;
        this.profileFeatureError.textContent = "Choose a valid Alert type.";
        this.profileFeatureAlertType.focus();
        return;
      }
      const nextType = candidateType as AlertType;
      const originalParts = parseAlertSource(editTarget.source);
      let nextSource = editTarget.source;
      if (this.profileFeatureBodyInput.value !== originalParts.body) {
        nextSource = alertSourceWithBody(
          nextSource,
          this.profileFeatureBodyInput.value,
        );
      }
      if (nextType.toLowerCase() !== originalParts.marker.toLowerCase())
        nextSource = alertSourceWithType(nextSource, nextType);

      try {
        if (nextSource !== String(currentNode.attrs.source ?? ""))
          this.dispatchTransaction(
            this.view.state.tr.setNodeMarkup(editTarget.position, undefined, {
              ...currentNode.attrs,
              source: nextSource,
            }),
          );
      } catch {
        this.profileFeatureError.hidden = false;
        this.profileFeatureError.textContent =
          "The Alert could not be updated.";
        this.profileFeatureBodyInput.focus();
        return;
      }
      this.closeProfileFeatureDialog();
      return;
    }

    const saved = this.profileFeatureSelection;
    const id = this.profileFeatureId;
    if (!saved || !id) return;
    const stale =
      !this.profileFeatureDialogOpen ||
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.composing ||
      Boolean(this.pendingProfile) ||
      this.profile !== this.profileFeatureProfile ||
      this.documentGeneration !== this.profileFeatureDocumentGeneration ||
      saved.$from.doc !== this.view.state.doc;
    if (stale || !this.restoreSelectionObject(saved)) {
      this.closeProfileFeatureDialog(
        "The document changed while this feature dialog was open; nothing was inserted.",
      );
      return;
    }
    const command = createProfileFeatureCommand(
      this.core,
      this.profile,
      id,
      this.profileFeatureValues(),
    );
    const applied = command(this.view.state, (tr) =>
      this.dispatchTransaction(tr),
    );
    if (!applied) {
      this.profileFeatureError.hidden = false;
      this.profileFeatureError.textContent =
        "Enter valid feature content before inserting.";
      this.profileFeatureBodyInput.focus();
      return;
    }
    this.closeProfileFeatureDialog(undefined, false);
    this.view.focus();
  }

  private buildEmojiPicker(
    container: HTMLElement,
    invokingButton: HTMLButtonElement,
  ): void {
    const dialog = document.createElement("dialog");
    dialog.className = "mm-input-dialog mm-emoji-dialog";
    dialog.setAttribute("aria-labelledby", "mm-emoji-dialog-title");
    const form = document.createElement("form");
    form.className = "mm-dialog-form";
    const title = document.createElement("h2");
    title.id = "mm-emoji-dialog-title";
    title.textContent = "Insert emoji";
    const help = document.createElement("p");
    help.className = "mm-emoji-help";
    help.textContent = "Search common emoji, then choose one to insert.";
    const searchLabel = document.createElement("label");
    searchLabel.className = "mm-dialog-field";
    const searchCaption = document.createElement("span");
    searchCaption.textContent = "Search";
    this.emojiSearchInput = document.createElement("input");
    this.emojiSearchInput.type = "search";
    this.emojiSearchInput.className = "mm-emoji-search";
    this.emojiSearchInput.placeholder = "Search by name or keyword";
    this.emojiSearchInput.setAttribute("aria-label", "Search emoji");
    searchLabel.append(searchCaption, this.emojiSearchInput);
    this.emojiGrid = document.createElement("div");
    this.emojiGrid.className = "mm-emoji-grid";
    this.emojiGrid.setAttribute("role", "listbox");
    this.emojiGrid.setAttribute("aria-label", "Common emoji");
    this.emojiSearchInput.addEventListener("input", () =>
      this.renderEmojiGrid(),
    );
    const actions = document.createElement("div");
    actions.className = "mm-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.closeEmojiPicker());
    actions.append(cancel);
    form.addEventListener("submit", (event) => event.preventDefault());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeEmojiPicker();
    });
    dialog.addEventListener("close", () => {
      if (this.emojiDialogOpen) this.closeEmojiPicker(false);
    });
    form.append(title, help, searchLabel, this.emojiGrid, actions);
    dialog.append(form);
    container.append(dialog);
    this.emojiDialog = dialog;
    this.emojiInvokingButton = invokingButton;
    this.renderEmojiGrid();
  }

  private captureEmojiSelection(): void {
    if (
      !this.initialized ||
      this.mode !== "rich" ||
      this.previewOnly ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.composing
    )
      return;
    this.emojiSelection = this.view.state.selection;
    this.emojiDocumentGeneration = this.documentGeneration;
    this.emojiProfile = this.profile;
  }

  private openEmojiPicker(invokingButton: HTMLButtonElement): void {
    if (
      !this.initialized ||
      this.previewOnly ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.mode !== "rich" ||
      this.composing
    ) {
      this.setNotice("Emoji are unavailable in the current editing mode.");
      return;
    }
    this.closeWritingPopups();
    this.captureEmojiSelection();
    this.emojiInvokingButton = invokingButton;
    this.emojiDialogOpen = true;
    this.emojiSearchInput.value = "";
    this.renderEmojiGrid();
    this.openDialog(this.emojiDialog);
    this.emojiSearchInput.focus();
  }

  private closeEmojiPicker(restoreFocus = true): void {
    if (!this.emojiDialogOpen && !this.emojiSelection) return;
    const button = this.emojiInvokingButton;
    this.emojiDialogOpen = false;
    this.emojiSelection = null;
    this.emojiDocumentGeneration = -1;
    this.emojiProfile = null;
    this.closeDialog(this.emojiDialog);
    if (restoreFocus && button?.isConnected) button.focus();
  }

  private renderEmojiGrid(): void {
    if (!this.emojiGrid || !this.emojiSearchInput) return;
    const query = this.emojiSearchInput.value.trim().toLocaleLowerCase();
    const matches = COMMON_EMOJI.filter((entry) =>
      query
        ? (entry.name + " " + entry.keywords + " " + entry.emoji)
            .toLocaleLowerCase()
            .includes(query)
        : true,
    );
    this.emojiGrid.replaceChildren();
    for (const entry of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mm-emoji-choice";
      button.dataset.emoji = entry.emoji;
      button.setAttribute("role", "option");
      button.setAttribute("aria-label", entry.name);
      this.setTooltip(button, entry.name);
      button.textContent = entry.emoji;
      button.addEventListener("click", () => this.applyEmoji(entry.emoji));
      this.emojiGrid.append(button);
    }
    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "mm-emoji-empty";
      empty.textContent = "No matching emoji.";
      this.emojiGrid.append(empty);
    }
    this.emojiGrid.setAttribute(
      "aria-label",
      matches.length + " emoji results",
    );
  }

  private applyEmoji(emoji: string): void {
    const selection = this.emojiSelection;
    const stale =
      !this.emojiDialogOpen ||
      !selection ||
      this.emojiDocumentGeneration !== this.documentGeneration ||
      this.emojiProfile !== this.profile ||
      selection.$from.doc !== this.view.state.doc ||
      !(selection instanceof TextSelection);
    if (stale || !this.restoreSelectionObject(selection)) {
      this.closeEmojiPicker();
      this.setNotice(
        "The document changed while the emoji picker was open; nothing was inserted.",
        "error",
      );
      return;
    }
    this.dispatchTransaction(this.view.state.tr.insertText(emoji));
    this.closeEmojiPicker(false);
  }

  private buildSelectionToolbar(): HTMLElement {
    const toolbar = makeElement("div", {
      class: "mm-floating-toolbar mm-selection-toolbar",
      role: "toolbar",
      "aria-label": "Selection formatting",
      "aria-hidden": "true",
      hidden: "true",
    });
    toolbar.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.clearSelectionToolbarSelection();
        const selection = this.view.state.selection;
        if (selection instanceof TextSelection && !selection.empty) {
          this.dispatchTransaction(
            this.view.state.tr
              .setSelection(
                TextSelection.create(this.view.state.doc, selection.head),
              )
              .setMeta("addToHistory", false),
          );
        }
        this.view.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const enabledButtons = Array.from(
        toolbar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      );
      const current = enabledButtons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (current < 0 || !enabledButtons.length) return;
      event.preventDefault();
      const delta = event.shiftKey ? -1 : 1;
      const next =
        (current + delta + enabledButtons.length) % enabledButtons.length;
      enabledButtons[next]?.focus();
    });
    const addMarkButton = (
      label: string,
      markName: string,
      testId: string,
      command: () => void,
    ): void => {
      const button = makeElement("button", {
        type: "button",
        class: "mm-floating-button",
        "aria-label": `${label} selection`,
        "aria-pressed": "false",
        "data-mark": markName,
        "data-testid": testId,
      }) as HTMLButtonElement;
      const iconName: ToolbarIconName =
        markName === "strong"
          ? "bold"
          : markName === "em"
            ? "italic"
            : markName === "strike"
              ? "strikethrough"
              : markName === "code"
                ? "inline-code"
                : "link";
      appendToolbarIcon(button, iconName, undefined, { size: 18 });
      if (markName === "strike") button.dataset.gfmOnly = "true";
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.captureSelectionToolbarSelection();
      });
      button.addEventListener("click", () => {
        if (!this.restoreSelectionToolbarSelection()) return;
        command();
        this.clearSelectionToolbarSelection();
      });
      toolbar.append(button);
    };
    addMarkButton("Bold", "strong", "selection-bold", () =>
      this.runCommand(commandForMark("strong", this.schema)),
    );
    addMarkButton("Italic", "em", "selection-italic", () =>
      this.runCommand(commandForMark("em", this.schema)),
    );
    addMarkButton("Strike", "strike", "selection-strike", () => {
      if (this.profile === "commonmark") {
        this.setNotice("Strikethrough is unavailable in CommonMark.");
        return;
      }
      this.runCommand(commandForMark("strike", this.schema));
    });
    addMarkButton("Inline code", "code", "selection-code", () =>
      this.runCommand(commandForMark("code", this.schema)),
    );
    const link = makeElement("button", {
      type: "button",
      class: "mm-floating-button",
      "aria-label": "Link selection",
      "aria-pressed": "false",
      "data-mark": "link",
      "data-testid": "selection-link",
    }) as HTMLButtonElement;
    appendToolbarIcon(link, "link", undefined, { size: 18 });
    link.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.captureSelectionToolbarSelection();
    });
    link.addEventListener("click", () => {
      if (!this.restoreSelectionToolbarSelection()) return;
      this.clearSelectionToolbarSelection();
      this.insertLink();
    });
    toolbar.append(link);
    return toolbar;
  }

  private buildEmptyLineButton(): HTMLButtonElement {
    const button = makeElement("button", {
      type: "button",
      class: "mm-empty-line-insert",
      "data-tooltip": "Insert block",
      "aria-label": "Insert block at current line",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      hidden: "true",
    }) as HTMLButtonElement;
    button.textContent = "+";

    const panel = makeElement("div", {
      class: "mm-popup-panel mm-empty-line-popup",
      role: "menu",
      "aria-label": "Insert block",
      hidden: "true",
    });
    panel.id = "mm-empty-line-insert-popup";
    button.setAttribute("aria-controls", panel.id);
    this.insertPopup = panel;
    this.insertPopupToggle = button;

    const addMenuButton = (
      label: string,
      title: string,
      command: () => void,
      testId?: string,
      iconName?: ToolbarIconName,
    ): HTMLButtonElement => {
      const item = makeElement("button", {
        type: "button",
        class: "mm-tool-button",
        role: "menuitem",
        "aria-label": title,
        ...(testId ? { "data-testid": testId } : {}),
      }) as HTMLButtonElement;
      if (iconName) appendToolbarIcon(item, iconName, label, { size: 18 });
      else item.textContent = label;
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      item.addEventListener("click", () => {
        // Consuming before restoring is important: focusing the editor during
        // restore fires the outside-focus guard, which must close the popup
        // without materializing a slash that is already being committed.
        this.consumeSlashTrigger();
        if (!this.restoreWritingPopupSelection()) {
          this.closeWritingPopups();
          this.setNotice(
            "The document changed while this menu was open; nothing was applied.",
            "error",
          );
          return;
        }
        command();
        if (!this.tableDialogOpen) this.closeWritingPopups("consume");
      });
      panel.append(item);
      return item;
    };

    const bulletMenuButton = addMenuButton(
      "Bullet list",
      "Bullet list",
      () => this.runListCommand("bullet_list"),
      undefined,
      "bullet-list",
    );
    bulletMenuButton.dataset.listKind = "bullet";
    const orderedMenuButton = addMenuButton(
      "Ordered list",
      "Ordered list",
      () => this.runListCommand("ordered_list"),
      undefined,
      "ordered-list",
    );
    orderedMenuButton.dataset.listKind = "ordered";
    const taskButton = addMenuButton(
      "Task",
      "Task list",
      () => this.runTaskList(),
      undefined,
      "checklist",
    );
    taskButton.dataset.gfmOnly = "true";
    taskButton.dataset.listKind = "task";
    addMenuButton(
      "Quote",
      "Block quote",
      () => this.runCommand(commandForBlock("blockquote")),
      undefined,
      "blockquote",
    );
    addMenuButton(
      "Code",
      "Code block",
      () => this.runCommand(commandForBlock("code_block", { params: "" })),
      undefined,
      "code-block",
    );
    const tableButton = addMenuButton(
      "Table",
      "Insert table",
      () => this.openTableDialog(tableButton),
      "toolbar-table-context",
      "table",
    );
    tableButton.dataset.gfmOnly = "true";
    addMenuButton(
      "Image",
      "Insert image",
      () => this.insertImage(),
      undefined,
      "image",
    );
    addMenuButton(
      "Horizontal rule",
      "Horizontal rule",
      () => this.insertHorizontalRule(),
      undefined,
      "divider",
    );
    for (const feature of PROFILE_FEATURES.filter(
      (candidate) => candidate.kind === "block",
    )) {
      const item = addMenuButton(
        feature.label,
        feature.label,
        () => {
          if (feature.id === "gitlab-toc") this.runProfileFeature(feature.id);
          else this.openProfileFeatureDialog(feature.id, item);
        },
        `insert-profile-${feature.id}`,
      );
      item.dataset.insertProfileFeature = feature.id;
      item.hidden = true;
      item.setAttribute("aria-hidden", "true");
      this.insertPopupProfileItems.set(feature.id, item);
    }
    panel.addEventListener("pointermove", () =>
      this.setPopupInputModality(panel, "pointer"),
    );
    panel.addEventListener("pointerdown", () =>
      this.setPopupInputModality(panel, "pointer"),
    );
    let buttonActivationModality: PopupInputModality | null = null;
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        const returnFocus = this.popupReturnFocus ?? button;
        const returnToEditor = this.isInsertPopupAnchor(returnFocus);
        this.closeWritingPopups("cancel");
        if (returnToEditor) this.view.focus();
        else returnFocus.focus();
        return;
      }
      if (event.key === "Tab") {
        this.setPopupInputModality(panel, "keyboard");
        const enabledItems = Array.from(
          panel.querySelectorAll<HTMLButtonElement>(
            'button[role="menuitem"]:not(:disabled):not([hidden])',
          ),
        );
        const current = enabledItems.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (current < 0 || enabledItems.length === 0) return;
        event.preventDefault();
        const delta = event.shiftKey ? -1 : 1;
        const next =
          (current + delta + enabledItems.length) % enabledItems.length;
        enabledItems[next]?.focus();
        return;
      }
      if (
        event.key !== "ArrowRight" &&
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      )
        return;
      this.setPopupInputModality(panel, "keyboard");
      event.preventDefault();
      const visibleItems = Array.from(
        panel.querySelectorAll<HTMLButtonElement>(
          'button[role="menuitem"]:not([hidden])',
        ),
      );
      if (!visibleItems.length) return;
      const activeItem = document.activeElement as HTMLButtonElement;
      const profileNavigation = Boolean(
        activeItem?.dataset.insertProfileFeature,
      );
      const items = visibleItems.filter((item) =>
        profileNavigation
          ? Boolean(item.dataset.insertProfileFeature)
          : !item.dataset.insertProfileFeature,
      );
      if (!items.length) return;
      const current = items.indexOf(activeItem);
      let next = -1;
      if (event.key === "Home")
        next = items.findIndex((item) => !item.disabled);
      else if (event.key === "End") {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          if (!items[index]?.disabled) {
            next = index;
            break;
          }
        }
      } else {
        const delta =
          event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowLeft"
              ? -1
              : event.key === "ArrowDown"
                ? 2
                : -2;
        next = movePopupFocusIndex(items, current, delta);
      }
      if (next >= 0) items[next]?.focus();
    });

    button.addEventListener("mousedown", (event) => {
      buttonActivationModality = "pointer";
      event.preventDefault();
      this.captureWritingPopupSelection();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        buttonActivationModality = "keyboard";
        return;
      }
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      if (this.activePopup !== panel)
        this.toggleWritingPopup(panel, button, "keyboard");
      else this.setPopupInputModality(panel, "keyboard");
      this.focusPopupItem(panel, 0);
    });
    button.addEventListener("click", () => {
      const inputModality = buttonActivationModality ?? "pointer";
      buttonActivationModality = null;
      this.toggleWritingPopup(panel, button, inputModality);
    });

    this.stage.append(panel);
    return button;
  }

  private buildBlockGapButton(): HTMLButtonElement {
    const button = makeElement("button", {
      type: "button",
      class: "mm-block-gap-insert",
      "data-tooltip": "Insert block between blocks",
      "aria-label": "Insert block between blocks",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      hidden: "true",
    }) as HTMLButtonElement;
    button.textContent = "+";
    if (this.insertPopup?.id)
      button.setAttribute("aria-controls", this.insertPopup.id);
    button.addEventListener("mousedown", (event) => {
      // Keep the existing editor selection so the transient paragraph is
      // created from the PM boundary rather than from browser focus.
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      const position = this.blockGapPosition;
      if (
        position === null ||
        !this.blockGapStateIsCurrent(position) ||
        !this.blockGapLayoutAt(position)
      )
        return;
      this.insertTransientBlockGap(position, true);
    });
    return button;
  }

  private isInsertPopupAnchor(
    anchor: HTMLElement | null,
  ): anchor is HTMLButtonElement {
    return anchor === this.emptyLineButton || anchor === this.blockGapButton;
  }

  private captureWritingPopupSelection(): boolean {
    if (
      !this.view ||
      !this.initialized ||
      this.mode !== "rich" ||
      this.previewOnly ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.composing
    )
      return false;
    this.popupSelection = this.view.state.selection;
    this.popupDocumentGeneration = this.documentGeneration;
    this.popupProfile = this.profile;
    return true;
  }

  private captureSelectionToolbarSelection(): void {
    if (!this.selectionToolbar || this.selectionToolbar.hidden) return;
    this.selectionToolbarSelection = this.view.state.selection;
    this.selectionToolbarDocumentGeneration = this.documentGeneration;
    this.selectionToolbarProfile = this.profile;
  }

  private selectionToolbarEligible(selection: Selection): boolean {
    if (
      !this.initialized ||
      this.previewOnly ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.composing ||
      this.mode !== "rich" ||
      !(selection instanceof TextSelection) ||
      selection.empty ||
      selection.from >= selection.to ||
      selectionTouchesTable(selection)
    )
      return false;
    if (selection.$from.parent.type.name === "code_block") return false;
    for (let depth = selection.$from.depth; depth > 0; depth -= 1)
      if (selection.$from.node(depth).type.name === "code_block") return false;
    return true;
  }

  private focusSelectionToolbar(
    selection: Selection = this.view.state.selection,
  ): boolean {
    if (
      !this.selectionToolbar ||
      this.selectionToolbar.hidden ||
      !this.selectionToolbarEligible(selection)
    )
      return false;
    const first = this.selectionToolbar.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    if (!first) return false;
    this.captureSelectionToolbarSelection();
    first.focus();
    return true;
  }

  private restoreSelectionToolbarSelection(): boolean {
    if (
      !this.selectionToolbarSelection ||
      this.selectionToolbarDocumentGeneration !== this.documentGeneration ||
      this.selectionToolbarProfile !== this.profile
    )
      return false;
    return this.restoreSelectionObject(this.selectionToolbarSelection);
  }

  private clearSelectionToolbarSelection(): void {
    this.selectionToolbarSelection = null;
    this.selectionToolbarDocumentGeneration = -1;
    this.selectionToolbarProfile = null;
  }

  private restoreWritingPopupSelection(): boolean {
    const selection = this.popupSelection;
    if (
      !selection ||
      this.popupDocumentGeneration !== this.documentGeneration ||
      this.popupProfile !== this.profile ||
      selection.$from.doc !== this.view.state.doc
    )
      return false;
    return this.restoreSelectionObject(selection);
  }

  private toggleWritingPopup(
    popup: HTMLElement,
    toggle: HTMLButtonElement,
    inputModality: PopupInputModality = "pointer",
  ): void {
    if (this.activePopup === popup) {
      this.closeWritingPopups("cancel");
      return;
    }
    this.captureWritingPopupSelection();
    this.openWritingPopup(popup, toggle, toggle, inputModality);
  }

  private openWritingPopup(
    popup: HTMLElement,
    toggle: HTMLButtonElement,
    anchor: HTMLElement,
    inputModality: PopupInputModality = "pointer",
  ): boolean {
    if (
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.composing
    )
      return false;
    if (popup === this.insertPopup) this.updateInsertPopupProfileFeatures();
    const retainedSelection = this.popupSelection;
    const retainedGeneration = this.popupDocumentGeneration;
    const retainedProfile = this.popupProfile;
    if (this.activePopup && this.activePopup !== popup)
      this.closeWritingPopups();
    if (
      retainedSelection &&
      retainedSelection.$from.doc === this.view.state.doc
    ) {
      this.popupSelection = retainedSelection;
      this.popupDocumentGeneration = retainedGeneration;
      this.popupProfile = retainedProfile;
    }
    this.activePopup = popup;
    this.activePopupToggle = toggle;
    this.popupAnchor = anchor;
    this.popupReturnFocus = anchor;
    popup.hidden = false;
    popup.setAttribute("aria-hidden", "false");
    this.setPopupInputModality(popup, inputModality);
    toggle.setAttribute("aria-expanded", "true");
    // Keep every popup in the viewport. Fixed positioning also lets a menu
    // opened from the empty-line affordance stay beside its anchor while the
    // document scrolls.
    popup.dataset.floating = "true";
    if (this.isInsertPopupAnchor(anchor))
      anchor.setAttribute("aria-expanded", "true");
    this.positionWritingPopup();
    if (this.isInsertPopupAnchor(anchor)) this.focusPopupItem(popup, 0);
    return true;
  }

  private closeWritingPopups(
    reason: WritingPopupCloseReason = "discard",
  ): void {
    if (reason === "cancel" && this.slashTrigger) {
      this.materializeSlashTrigger();
      return;
    }
    const gapPopupOpen = this.activePopupToggle === this.blockGapButton;
    this.slashTrigger = null;
    this.clearWritingPopupState();
    if (gapPopupOpen) this.clearBlockGapInsert();
  }

  private clearWritingPopupState(): void {
    const active = this.activePopup;
    const anchor = this.popupAnchor;
    if (active) {
      active.hidden = true;
      active.setAttribute("aria-hidden", "true");
      active.removeAttribute("data-floating");
      active.style.removeProperty("position");
      active.style.removeProperty("left");
      active.style.removeProperty("top");
      this.activePopupToggle?.setAttribute("aria-expanded", "false");
    }
    if (this.isInsertPopupAnchor(anchor))
      anchor.setAttribute("aria-expanded", "false");
    active?.removeAttribute("data-input-modality");
    this.activePopup = null;
    this.activePopupToggle = null;
    this.popupAnchor = null;
    this.popupReturnFocus = null;
    this.popupSelection = null;
    this.popupProfile = null;
    this.popupDocumentGeneration = -1;
  }

  private setPopupInputModality(
    popup: HTMLElement,
    inputModality: PopupInputModality,
  ): void {
    popup.dataset.inputModality = inputModality;
  }

  private consumeSlashTrigger(): void {
    this.slashTrigger = null;
  }

  private materializeSlashTrigger(): void {
    const trigger = this.slashTrigger;
    this.slashTrigger = null;
    if (!trigger) {
      this.clearWritingPopupState();
      return;
    }

    let restored = false;
    this.materializingSlash = true;
    try {
      restored =
        trigger.selection === this.popupSelection &&
        trigger.documentGeneration === this.documentGeneration &&
        trigger.profile === this.profile &&
        this.restoreWritingPopupSelection();
      this.clearWritingPopupState();
    } finally {
      this.materializingSlash = false;
    }
    if (!restored) return;
    this.dispatchTransaction(this.view.state.tr.insertText("/"));
    this.view.focus();
  }

  private positionWritingPopup(): void {
    const popup = this.activePopup;
    const anchor = this.popupAnchor;
    if (
      !popup ||
      !anchor ||
      popup.hidden ||
      popup.dataset.floating !== "true" ||
      !anchor.isConnected
    )
      return;
    const anchorRect = anchor.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const width = popupRect.width || 230;
    const height = popupRect.height || 120;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 6;
    if (viewportHeight > 0 && top + height > viewportHeight - 6)
      top = anchorRect.top - height - 6;
    left = Math.max(6, Math.min(left, Math.max(6, viewportWidth - width - 6)));
    top = Math.max(6, Math.min(top, Math.max(6, viewportHeight - height - 6)));
    popup.style.position = "fixed";
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  private focusPopupItem(popup: HTMLElement, index: number): void {
    const items = popup.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled):not([hidden])',
    );
    items.item(Math.max(0, Math.min(index, items.length - 1)))?.focus();
  }

  private updateSelectionToolbar(selection = this.view.state.selection): void {
    if (!this.selectionToolbar || !this.stage || !this.view) return;
    for (const button of Array.from(
      this.selectionToolbar.querySelectorAll<HTMLButtonElement>("[data-mark]"),
    )) {
      const markName = button.dataset.mark;
      const active = Boolean(
        markName &&
        !button.disabled &&
        isToolbarMarkActive(this.view.state, selection, markName),
      );
      button.setAttribute("aria-pressed", String(active));
    }
    if (!this.selectionToolbarEligible(selection)) {
      this.selectionToolbar.hidden = true;
      this.selectionToolbar.setAttribute("aria-hidden", "true");
      this.clearSelectionToolbarSelection();
      return;
    }
    this.selectionToolbar.hidden = false;
    this.selectionToolbar.setAttribute("aria-hidden", "false");
    this.selectionToolbarSelection = selection;
    this.selectionToolbarDocumentGeneration = this.documentGeneration;
    this.selectionToolbarProfile = this.profile;
    const stageRect = this.stage.getBoundingClientRect();
    let from: ReturnType<EditorView["coordsAtPos"]>;
    let to: ReturnType<EditorView["coordsAtPos"]>;
    try {
      from = this.view.coordsAtPos(selection.from);
      to = this.view.coordsAtPos(selection.to);
    } catch {
      this.selectionToolbar.hidden = true;
      this.selectionToolbar.setAttribute("aria-hidden", "true");
      this.clearSelectionToolbarSelection();
      return;
    }
    if (
      stageRect.height > 0 &&
      (to.bottom < stageRect.top || from.top > stageRect.bottom)
    ) {
      this.selectionToolbar.hidden = true;
      this.selectionToolbar.setAttribute("aria-hidden", "true");
      this.selectionToolbarSelection = null;
      return;
    }
    const toolbarRect = this.selectionToolbar.getBoundingClientRect();
    const width = toolbarRect.width || 240;
    const height = toolbarRect.height || 32;
    const viewportWidth = this.stage.clientWidth || stageRect.width;
    const viewportHeight = this.stage.clientHeight || stageRect.height;
    let left = (from.left + to.right) / 2 - stageRect.left - width / 2;
    let top = from.top - stageRect.top + this.stage.scrollTop - height - 7;
    if (top < this.stage.scrollTop + 6)
      top = to.bottom - stageRect.top + this.stage.scrollTop + 7;
    const minLeft = this.stage.scrollLeft + 6;
    const maxLeft =
      viewportWidth > 0
        ? this.stage.scrollLeft + Math.max(6, viewportWidth - width - 6)
        : left;
    const minTop = this.stage.scrollTop + 6;
    const maxTop =
      viewportHeight > 0
        ? this.stage.scrollTop + Math.max(6, viewportHeight - height - 6)
        : top;
    left = Math.max(minLeft, Math.min(maxLeft, left));
    top = Math.max(minTop, Math.min(maxTop, top));
    this.selectionToolbar.style.left = `${Math.round(left)}px`;
    this.selectionToolbar.style.top = `${Math.round(top)}px`;
  }

  private handleBlankDocumentPointer(event: MouseEvent): boolean {
    if (event.defaultPrevented) return false;
    if (event.button !== undefined && event.button !== 0) return false;
    if (
      !this.initialized ||
      this.previewOnly ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.composing ||
      this.mode !== "rich"
    )
      return false;
    const target = event.target;
    if (!(target instanceof Node)) return false;
    const richPanel = this.root.querySelector<HTMLElement>(
      '[data-panel="rich"]',
    );
    if (!richPanel || !(target === this.stage || richPanel.contains(target)))
      return false;
    if (
      target instanceof Element &&
      target.closest(
        ".mm-table-toolbar, .mm-selection-toolbar, .mm-empty-line-insert, .mm-popup-panel, .mm-rich-footnotes, a, dialog, button, select, input, textarea",
      )
    )
      return false;

    const editorDom = this.view.dom;

    // A second blank-space click starts from the authored document again. This
    // keeps repeated exploratory clicks from accumulating invisible paragraphs.
    if (this.transientBlanks) this.discardTransientBlanksInState();
    const lastBlockInfo = this.lastVisibleDocumentBlock(editorDom);
    if (!lastBlockInfo) return false;
    const { element: lastBlock, rect: lastRect } = lastBlockInfo;
    const y = Number.isFinite(event.clientY)
      ? event.clientY
      : Number.isFinite(event.pageY)
        ? event.pageY
        : lastRect.bottom;
    if (!Number.isFinite(y) || y <= lastRect.bottom + 2) return false;

    const paragraph = this.schema.nodes.paragraph;
    if (!paragraph) return false;
    const pitch = this.blankLinePitch(lastBlock, lastRect);
    const count = Math.max(
      1,
      Math.min(200, Math.ceil((y - lastRect.bottom) / pitch)),
    );
    const appended = this.appendTransientBlankParagraphs(count);
    if (!appended) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  private lastVisibleDocumentBlock(
    editorDom: HTMLElement,
  ): { element: Element; rect: DOMRect } | null {
    const elements = Array.from(editorDom.children);
    let fallback: { element: Element; rect: DOMRect } | null = null;
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements[index];
      if (!(element instanceof Element)) continue;
      if (
        element.matches(
          ".mm-rich-footnotes, .ProseMirror-widget, [data-pm-widget]",
        )
      )
        continue;
      const rect = element.getBoundingClientRect();
      const hasArea =
        rect.width > 0 || rect.height > 0 || rect.bottom > rect.top;
      if (hasArea && !element.matches('[aria-hidden="true"]'))
        return { element, rect };
      const isContentBlock =
        /^(P|H[1-6]|UL|OL|BLOCKQUOTE|PRE|TABLE|HR|IMG|DIV)$/.test(
          element.tagName,
        );
      const hasContent =
        Boolean(element.textContent?.trim()) ||
        Boolean(element.querySelector("br, img, table, code, pre"));
      if (!fallback && isContentBlock && hasContent)
        fallback = { element, rect };
    }
    return fallback;
  }

  private measureBlankParagraphPitch(lastRect: DOMRect): number {
    let lineHeight = 0;
    let marginTop = 0;
    let marginBottom = 0;
    try {
      const computed = getComputedStyle(this.view.dom);
      const fontSize = Number.parseFloat(computed.fontSize);
      lineHeight = Number.parseFloat(computed.lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0)
        lineHeight =
          Number.isFinite(fontSize) && fontSize > 0
            ? fontSize * 1.6
            : lastRect.height > 0
              ? lastRect.height
              : 24;
    } catch {
      lineHeight = lastRect.height > 0 ? lastRect.height : 24;
    }

    const probeRoot = document.createElement("div");
    const probeParagraph = document.createElement("p");
    const probeSibling = document.createElement("span");
    probeRoot.className = "mm-document-content";
    probeRoot.style.cssText =
      "position:absolute;left:-100000px;top:0;width:800px;height:0;overflow:hidden;visibility:hidden;pointer-events:none;";
    probeSibling.style.display = "none";
    probeRoot.append(probeParagraph, probeSibling);
    this.root.append(probeRoot);
    try {
      const computed = getComputedStyle(probeParagraph);
      const measuredLineHeight = Number.parseFloat(computed.lineHeight);
      const measuredMarginTop = Number.parseFloat(computed.marginTop);
      const measuredMarginBottom = Number.parseFloat(computed.marginBottom);
      if (Number.isFinite(measuredLineHeight) && measuredLineHeight > 0)
        lineHeight = measuredLineHeight;
      if (Number.isFinite(measuredMarginTop) && measuredMarginTop >= 0)
        marginTop = measuredMarginTop;
      if (Number.isFinite(measuredMarginBottom) && measuredMarginBottom >= 0)
        marginBottom = measuredMarginBottom;
    } catch {
      // Keep the editor metrics fallback.
    } finally {
      probeRoot.remove();
    }
    return Math.max(1, lineHeight + Math.max(marginTop, marginBottom));
  }

  private blankLinePitch(lastBlock: Element, lastRect: DOMRect): number {
    void lastBlock;
    return this.measureBlankParagraphPitch(lastRect);
  }

  private appendTransientBlankParagraphs(count: number): boolean {
    const paragraph = this.schema.nodes.paragraph;
    if (!paragraph || count < 1) return false;
    const nodes = Array.from({ length: count }, () => paragraph.create());
    const from = this.view.state.doc.content.size;
    const size = nodes.reduce((total, node) => total + node.nodeSize, 0);
    const to = from + size;
    let transaction: Transaction;
    try {
      transaction = this.view.state.tr.insert(from, Fragment.fromArray(nodes));
      transaction = transaction
        .setSelection(TextSelection.create(transaction.doc, to - 1))
        .setMeta(TRANSIENT_BLANK_META, {
          kind: "append",
          from,
          to,
          count: nodes.length,
          meaningful: false,
        } satisfies TransientBlankTransactionMeta);
      const starter = getStarterState(this.view.state);
      if (starter?.active && starter.untouched)
        transaction = setStarterMeta(transaction, {
          active: true,
          untouched: true,
          preserveSource: true,
        });
    } catch {
      return false;
    }
    this.view.focus();
    this.dispatchTransaction(transaction);
    return true;
  }

  private canUseBlockGapInsert(): boolean {
    const starter = getStarterState(this.view.state);
    return (
      this.canEditBlock() &&
      !(this.view.state.selection instanceof BlockBoundarySelection) &&
      !(starter?.active && starter.untouched) &&
      (!this.transientBlanks || this.activePopupToggle === this.blockGapButton)
    );
  }

  private blockGapLayouts(): BlockGapLayout[] {
    if (!this.view || !this.initialized || this.view.state.doc.childCount < 2)
      return [];
    const layouts: BlockGapLayout[] = [];
    let position = 0;
    for (
      let index = 0;
      index < this.view.state.doc.childCount - 1;
      index += 1
    ) {
      const previous = this.view.state.doc.child(index);
      const next = this.view.state.doc.child(index + 1);
      const boundary = position + previous.nodeSize;
      if (!isBlockBoundary(this.view.state.doc, boundary)) {
        position = boundary;
        continue;
      }
      // Blank-spacing nodes already own this visual area through the
      // empty-line affordance (or source-preserving spacer representation).
      // Keep block-gap candidates structural so the two reusable buttons can
      // never overlap around the same direct-child blank run.
      if (isBlankSpacingNode(previous) || isBlankSpacingNode(next)) {
        position = boundary;
        continue;
      }
      const previousDOM = this.view.nodeDOM(position);
      const nextDOM = this.view.nodeDOM(boundary);
      if (previousDOM instanceof Element && nextDOM instanceof Element) {
        const previousRect = previousDOM.getBoundingClientRect();
        const nextRect = nextDOM.getBoundingClientRect();
        const finiteRect = (rect: DOMRect): boolean =>
          Number.isFinite(rect.left) &&
          Number.isFinite(rect.top) &&
          Number.isFinite(rect.bottom);
        if (
          previousDOM.isConnected &&
          nextDOM.isConnected &&
          finiteRect(previousRect) &&
          finiteRect(nextRect)
        )
          layouts.push({
            position: boundary,
            previousRect,
            nextRect,
          });
      }
      position = boundary;
    }
    return layouts;
  }

  private blockGapLayoutAt(position: number): BlockGapLayout | null {
    return (
      this.blockGapLayouts().find((layout) => layout.position === position) ??
      null
    );
  }

  private blockGapLayoutForPointer(clientY: number): BlockGapLayout | null {
    if (!Number.isFinite(clientY)) return null;
    let closest: BlockGapLayout | null = null;
    let closestDistance = Infinity;
    for (const layout of this.blockGapLayouts()) {
      const gapTop = layout.previousRect.bottom;
      const gapBottom = layout.nextRect.top;
      const gapHeight = gapBottom - gapTop;
      const hitTop = gapHeight > 0 ? gapTop - 4 : (gapTop + gapBottom) / 2 - 5;
      const hitBottom =
        gapHeight > 0 ? gapBottom + 4 : (gapTop + gapBottom) / 2 + 5;
      if (clientY < hitTop || clientY > hitBottom) continue;
      const center = (hitTop + hitBottom) / 2;
      const distance = Math.abs(clientY - center);
      if (distance < closestDistance) {
        closest = layout;
        closestDistance = distance;
      }
    }
    return closest;
  }

  private showBlockGapInsert(
    layout: BlockGapLayout,
    position = layout.position,
  ): void {
    if (!this.blockGapButton || !this.stage || !this.view) return;
    const stageRect = this.stage.getBoundingClientRect();
    const buttonRect = this.blockGapButton.getBoundingClientRect();
    const width = buttonRect.width || 20;
    const height = buttonRect.height || 20;
    const contentLeft = Math.min(
      layout.previousRect.left,
      layout.nextRect.left,
    );
    const centerY = (layout.previousRect.bottom + layout.nextRect.top) / 2;
    const left = Math.max(
      this.stage.scrollLeft + 2,
      contentLeft - stageRect.left + this.stage.scrollLeft - width - 6,
    );
    const top = Math.max(
      this.stage.scrollTop + 4,
      centerY - stageRect.top + this.stage.scrollTop - height / 2,
    );
    this.blockGapPosition = position;
    this.blockGapDocument = this.view.state.doc;
    this.blockGapDocumentGeneration = this.documentGeneration;
    this.blockGapProfile = this.profile;
    this.blockGapButton.hidden = false;
    this.blockGapButton.disabled = false;
    this.blockGapButton.setAttribute("aria-hidden", "false");
    this.blockGapButton.dataset.position = String(position);
    this.blockGapButton.style.left = `${Math.round(left)}px`;
    this.blockGapButton.style.top = `${Math.round(top)}px`;
  }

  private blockGapStateIsCurrent(position = this.blockGapPosition): boolean {
    return Boolean(
      position !== null &&
      this.blockGapDocument === this.view.state.doc &&
      this.blockGapDocumentGeneration === this.documentGeneration &&
      this.blockGapProfile === this.profile &&
      this.blockGapButton &&
      !this.blockGapButton.hidden,
    );
  }

  private clearBlockGapInsert(): void {
    this.blockGapPosition = null;
    this.blockGapDocument = null;
    this.blockGapDocumentGeneration = -1;
    this.blockGapProfile = null;
    if (!this.blockGapButton) return;
    this.blockGapButton.hidden = true;
    this.blockGapButton.disabled = true;
    this.blockGapButton.setAttribute("aria-hidden", "true");
    if (this.activePopupToggle !== this.blockGapButton)
      this.blockGapButton.setAttribute("aria-expanded", "false");
    this.blockGapButton.removeAttribute("data-position");
    this.blockGapButton.style.removeProperty("left");
    this.blockGapButton.style.removeProperty("top");
  }

  private updateBlockGapFromPointer(event: PointerEvent): void {
    if (event.pointerType === "touch") return;
    const target = event.target;
    if (!(target instanceof Node) || !this.stage.contains(target)) return;
    const element = target instanceof Element ? target : target.parentElement;
    if (this.activePopup) {
      if (
        this.activePopupToggle === this.blockGapButton &&
        element &&
        (this.activePopup.contains(element) ||
          this.blockGapButton.contains(element))
      )
        return;
      return;
    }
    if (
      element?.closest(
        ".mm-block-gap-insert, .mm-popup-panel, .mm-table-toolbar, .mm-selection-toolbar, button, input, textarea, select",
      )
    ) {
      if (!element.closest(".mm-block-gap-insert")) this.clearBlockGapInsert();
      return;
    }
    if (!this.canUseBlockGapInsert()) {
      this.clearBlockGapInsert();
      return;
    }
    const layout = this.blockGapLayoutForPointer(event.clientY);
    if (layout) this.showBlockGapInsert(layout);
    else this.clearBlockGapInsert();
  }

  private updateBlockGapInsert(): void {
    if (!this.blockGapButton || !this.stage || !this.view) return;
    const position = this.blockGapPosition;
    if (
      position === null ||
      !this.blockGapStateIsCurrent(position) ||
      !this.canUseBlockGapInsert()
    ) {
      this.clearBlockGapInsert();
      return;
    }
    const layout = this.blockGapLayoutAt(position);
    if (layout) this.showBlockGapInsert(layout, position);
    else this.clearBlockGapInsert();
  }

  private canUseEmptyLineInsert(selection: Selection): boolean {
    const parent = selection.$from.parent;
    const starter = getStarterState(this.view.state);
    return (
      this.initialized &&
      !this.previewOnly &&
      !this.parseError &&
      !this.conflict &&
      !this.syncPaused &&
      !this.composing &&
      this.mode === "rich" &&
      selection.empty &&
      selection.$from.depth === 1 &&
      parent.type.name === "paragraph" &&
      parent.content.size === 0 &&
      !starter?.active
    );
  }

  private updateEmptyLineInsert(selection = this.view.state.selection): void {
    if (!this.emptyLineButton || !this.stage || !this.view) return;
    if (!this.canUseEmptyLineInsert(selection)) {
      this.emptyLineButton.hidden = true;
      return;
    }
    const dom = this.view.nodeDOM(selection.$from.before(1));
    if (!(dom instanceof Element) || !dom.isConnected) {
      this.emptyLineButton.hidden = true;
      return;
    }
    const stageRect = this.stage.getBoundingClientRect();
    const rect = dom.getBoundingClientRect();
    const width = this.emptyLineButton.getBoundingClientRect().width || 20;
    const height = this.emptyLineButton.getBoundingClientRect().height || 20;
    const left = Math.max(
      this.stage.scrollLeft + 2,
      rect.left - stageRect.left + this.stage.scrollLeft - width - 6,
    );
    const top = Math.max(
      this.stage.scrollTop + 4,
      rect.top -
        stageRect.top +
        this.stage.scrollTop +
        Math.max(0, (rect.height || height) / 2 - height / 2),
    );
    this.emptyLineButton.hidden = false;
    this.emptyLineButton.style.left = `${Math.round(left)}px`;
    this.emptyLineButton.style.top = `${Math.round(top)}px`;
  }

  private updateWritingToolbarState(): void {
    if (this.destroyed || !this.view) return;
    this.updateToolbarActiveState(this.view.state.selection);
    this.updateSelectionToolbar(this.view.state.selection);
    this.updateEmptyLineInsert(this.view.state.selection);
    this.updateBlockGapInsert();
    this.positionWritingPopup();
  }

  private requestTableToolbarReveal(target: EventTarget | null): void {
    if (
      this.destroyed ||
      !this.view ||
      !(target instanceof Element) ||
      !this.view.dom.contains(target)
    )
      return;
    this.tableToolbarRevealRequested = Boolean(target.closest("td, th"));
    if (this.tableToolbarRevealRequested) this.scheduleWritingToolbarUpdate();
  }

  private scheduleWritingToolbarUpdate(): void {
    if (this.destroyed) return;
    const update = (): void => {
      if (!this.destroyed) {
        this.updateTableToolbar();
        this.updateWritingToolbarState();
      }
    };
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(update);
    else setTimeout(update, 0);
  }

  private buildTableToolbar(): HTMLElement {
    const toolbar = makeElement("div", {
      class: "mm-table-toolbar",
      role: "toolbar",
      "aria-label": "Table actions",
      "aria-hidden": "true",
      hidden: "true",
    });

    const addGroup = (
      label: string,
      actions: Array<[TableToolbarAction, string, string, ToolbarIconName]>,
    ): void => {
      const group = makeElement("div", {
        class: "mm-table-toolbar-group",
        role: "group",
        "aria-label": label,
      });
      const heading = makeElement("span", {
        class: "mm-table-toolbar-group-label",
        "aria-hidden": "true",
      });
      heading.textContent = label;
      const controls = makeElement("div", {
        class: "mm-table-toolbar-actions",
      });
      group.append(heading, controls);
      for (const [action, text, title, iconKind] of actions) {
        const button = makeElement("button", {
          type: "button",
          class: "mm-table-toolbar-button",
          "data-action": action,
          "data-tooltip": title,
          "aria-label": title,
        }) as HTMLButtonElement;
        if (action.startsWith("align-") || action === "table-numbering")
          button.setAttribute("aria-pressed", "false");
        const labelElement = makeElement("span", {
          class: "mm-table-toolbar-button-label",
        });
        labelElement.textContent = text;
        appendToolbarIcon(button, iconKind, undefined, {
          className: "mm-table-toolbar-icon",
          size: 14,
        });
        button.append(labelElement);
        button.addEventListener("mousedown", (event) => {
          // Keep the ProseMirror selection in place while the contextual
          // toolbar receives focus. The command runs from that stable state.
          event.preventDefault();
        });
        button.addEventListener("click", () =>
          this.runContextualTableAction(action),
        );
        controls.append(button);
      }
      toolbar.append(group);
    };

    addGroup("Row", [
      ["row-above", "Above", "Add row above", "table-row-above"],
      ["row-below", "Below", "Add row below", "table-row-below"],
      ["row-delete", "Delete", "Delete selected row", "table-row-delete"],
    ]);
    addGroup("Column", [
      ["col-left", "Left", "Add column left", "table-column-left"],
      ["col-right", "Right", "Add column right", "table-column-right"],
      ["col-delete", "Delete", "Delete selected column", "table-column-delete"],
    ]);
    addGroup("Align", [
      ["align-left", "Left", "Align selected column left", "table-align-left"],
      [
        "align-center",
        "Center",
        "Align selected column center",
        "table-align-center",
      ],
      [
        "align-right",
        "Right",
        "Align selected column right",
        "table-align-right",
      ],
    ]);
    addGroup("Rows", [
      ["table-numbering", "#", "Number table rows", "table-numbering"],
    ]);
    addGroup("Table", [
      ["table-delete", "Delete table", "Delete table", "table-delete"],
    ]);
    return toolbar;
  }

  private buildTableDialog(container: HTMLElement): void {
    const dialog = document.createElement("dialog");
    dialog.className = "mm-input-dialog mm-table-dialog";
    dialog.setAttribute("aria-labelledby", "mm-table-dialog-title");
    const form = document.createElement("form");
    form.className = "mm-dialog-form";
    const title = document.createElement("h2");
    title.id = "mm-table-dialog-title";
    title.textContent = "Insert table";
    const help = document.createElement("p");
    help.className = "mm-table-dialog-help";
    help.textContent =
      "Rows includes the header row. Choose 1–20 columns and 1–50 rows.";

    const makeNumberField = (
      labelText: string,
      min: number,
      max: number,
      value: number,
    ): HTMLInputElement => {
      const label = document.createElement("label");
      label.className = "mm-dialog-field";
      const caption = document.createElement("span");
      caption.textContent = labelText;
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.step = "1";
      input.value = String(value);
      input.inputMode = "numeric";
      label.append(caption, input);
      return input;
    };
    this.tableColumnsInput = makeNumberField("Columns", 1, 20, 3);
    this.tableRowsInput = makeNumberField("Rows (including header)", 1, 50, 3);
    const fields = document.createElement("div");
    fields.className = "mm-table-dialog-fields";
    fields.append(
      this.tableColumnsInput.parentElement as HTMLElement,
      this.tableRowsInput.parentElement as HTMLElement,
    );

    const gridLabel = document.createElement("span");
    gridLabel.className = "mm-table-grid-label";
    gridLabel.textContent = "Click to select; double-click to insert";
    this.tableGrid = document.createElement("div");
    this.tableGrid.className = "mm-table-grid";
    this.tableGrid.setAttribute("role", "grid");
    this.tableGrid.setAttribute("aria-label", "Table size preview");
    this.tableGrid.setAttribute("aria-rowcount", "6");
    this.tableGrid.setAttribute("aria-colcount", "8");
    this.tableGrid.tabIndex = 0;
    this.tableGridCells = [];
    for (let row = 0; row < 6; row += 1) {
      const gridRow = document.createElement("div");
      gridRow.className = "mm-table-grid-row";
      gridRow.setAttribute("role", "row");
      for (let column = 0; column < 8; column += 1) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "mm-table-grid-cell";
        cell.setAttribute("role", "gridcell");
        cell.tabIndex = -1;
        cell.id = `mm-table-grid-cell-${row + 1}-${column + 1}`;
        cell.dataset.gridRow = String(row + 1);
        cell.dataset.gridColumn = String(column + 1);
        cell.setAttribute(
          "aria-label",
          `${column + 1} columns by ${row + 1} rows`,
        );
        gridRow.append(cell);
        this.tableGridCells.push(cell);
      }
      this.tableGrid.append(gridRow);
    }
    const getCell = (event: Event): HTMLButtonElement | null => {
      const target = event.target;
      if (!(target instanceof Element)) return null;
      const cell = target.closest<HTMLButtonElement>(".mm-table-grid-cell");
      return cell && this.tableGrid.contains(cell) ? cell : null;
    };
    const restorePreview = (): void => {
      if (!this.tableDialogOpen) return;
      if (this.tableDialogSelectionLocked) return;
      this.previewTableDialogDimensions(
        this.tableDialogColumns,
        this.tableDialogRows,
        false,
      );
    };
    const previewCell = (event: Event): void => {
      if (!this.tableDialogOpen) return;
      if (this.tableDialogSelectionLocked) return;
      const cell = getCell(event);
      if (!cell) return;
      this.previewTableDialogDimensions(
        Number(cell.dataset.gridColumn),
        Number(cell.dataset.gridRow),
      );
    };
    this.tableGrid.addEventListener("pointermove", previewCell);
    this.tableGrid.addEventListener("mouseover", previewCell);
    this.tableGrid.addEventListener("mouseenter", previewCell);
    this.tableGrid.addEventListener("pointerleave", restorePreview);
    this.tableGrid.addEventListener("mouseleave", restorePreview);
    this.tableGrid.addEventListener("focusin", previewCell);
    this.tableGrid.addEventListener("click", (event) => {
      if (!this.tableDialogOpen) return;
      const cell = getCell(event);
      if (!cell) return;
      event.preventDefault();
      this.tableDialogSelectionLocked = true;
      this.selectTableDialogDimensions(
        Number(cell.dataset.gridColumn),
        Number(cell.dataset.gridRow),
      );
    });
    this.tableGrid.addEventListener("dblclick", (event) => {
      if (!this.tableDialogOpen) return;
      const cell = getCell(event);
      if (!cell) return;
      event.preventDefault();
      this.selectTableDialogDimensions(
        Number(cell.dataset.gridColumn),
        Number(cell.dataset.gridRow),
      );
      this.commitTableDialog();
    });
    this.tableGrid.addEventListener("keydown", (event) => {
      if (!this.tableDialogOpen) return;
      this.tableDialogSelectionLocked = false;
      const currentRow = Number(this.tableGrid.dataset.focusRow ?? 3);
      const currentColumn = Number(this.tableGrid.dataset.focusColumn ?? 3);
      let row = currentRow;
      let column = currentColumn;
      if (event.key === "ArrowUp") row = Math.max(1, row - 1);
      else if (event.key === "ArrowDown") row = Math.min(6, row + 1);
      else if (event.key === "ArrowLeft") column = Math.max(1, column - 1);
      else if (event.key === "ArrowRight") column = Math.min(8, column + 1);
      else if (event.key === "Home") column = 1;
      else if (event.key === "End") column = 8;
      else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        this.selectTableDialogDimensions(currentColumn, currentRow);
        return;
      } else return;
      event.preventDefault();
      this.tableGrid.dataset.focusRow = String(row);
      this.tableGrid.dataset.focusColumn = String(column);
      this.previewTableDialogDimensions(column, row);
    });
    this.tableSizeLabel = document.createElement("span");
    this.tableSizeLabel.className = "mm-table-size";
    this.tableSizeLabel.setAttribute("aria-live", "polite");

    this.tableDialogError = document.createElement("p");
    this.tableDialogError.className = "mm-table-dialog-error";
    this.tableDialogError.setAttribute("role", "alert");
    this.tableDialogError.hidden = true;

    const gridWrap = document.createElement("div");
    gridWrap.className = "mm-table-grid-wrap";
    gridWrap.append(gridLabel, this.tableGrid, this.tableSizeLabel);

    const actions = document.createElement("div");
    actions.className = "mm-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.closeTableDialog());
    const insert = document.createElement("button");
    insert.type = "submit";
    insert.className = "mm-dialog-primary";
    insert.textContent = "Insert table";
    this.tableDialogInsertButton = insert;
    actions.append(cancel, insert);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.commitTableDialog();
    });
    const updateFromInput = (): void => {
      this.validateTableDialogInputs();
    };
    this.tableColumnsInput.addEventListener("input", updateFromInput);
    this.tableRowsInput.addEventListener("input", updateFromInput);
    this.tableColumnsInput.addEventListener("change", updateFromInput);
    this.tableRowsInput.addEventListener("change", updateFromInput);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeTableDialog();
    });
    form.append(title, help, gridWrap, fields, this.tableDialogError, actions);
    dialog.append(form);
    container.append(dialog);
    this.tableDialog = dialog;
    this.renderTableGrid();
  }

  private validateTableDialogInputs(): boolean {
    const values: Array<{
      input: HTMLInputElement;
      label: string;
      min: number;
      max: number;
    }> = [
      {
        input: this.tableColumnsInput,
        label: "Columns",
        min: 1,
        max: 20,
      },
      {
        input: this.tableRowsInput,
        label: "Rows",
        min: 1,
        max: 50,
      },
    ];
    const invalid = values.find(({ input, min, max }) => {
      const value = Number(input.value);
      return !Number.isInteger(value) || value < min || value > max;
    });
    if (invalid) {
      const reason = invalid.input.value.trim()
        ? `${invalid.label} must be a whole number from ${invalid.min} to ${invalid.max}.`
        : `${invalid.label} is required.`;
      invalid.input.setCustomValidity(reason);
      this.tableDialogError.textContent = reason;
      this.tableDialogError.hidden = false;
      this.tableDialogInsertButton.disabled = true;
      return false;
    }
    for (const { input } of values) input.setCustomValidity("");
    this.tableDialogError.hidden = true;
    this.tableDialogError.textContent = "";
    this.tableDialogInsertButton.disabled = false;
    const columns = Number(this.tableColumnsInput.value);
    const rows = Number(this.tableRowsInput.value);
    this.selectTableDialogDimensions(columns, rows);
    return true;
  }

  private renderTableGrid(): void {
    if (!this.tableGrid || !this.tableSizeLabel) return;
    const displayRows = this.tableDialogPreviewing
      ? this.tableDialogPreviewRows
      : this.tableDialogRows;
    const displayColumns = this.tableDialogPreviewing
      ? this.tableDialogPreviewColumns
      : this.tableDialogColumns;
    const focusRow = Math.min(6, Math.max(1, Math.round(displayRows)));
    const focusColumn = Math.min(8, Math.max(1, Math.round(displayColumns)));
    this.tableGrid.dataset.focusRow = String(focusRow);
    this.tableGrid.dataset.focusColumn = String(focusColumn);
    this.tableGrid.setAttribute(
      "aria-activedescendant",
      `mm-table-grid-cell-${focusRow}-${focusColumn}`,
    );
    for (const cell of this.tableGridCells) {
      const row = Number(cell.dataset.gridRow);
      const column = Number(cell.dataset.gridColumn);
      const preview = row <= focusRow && column <= focusColumn;
      cell.classList.toggle("is-preview", preview);
      cell.classList.remove("is-selected");
      cell.removeAttribute("data-selected");
      cell.setAttribute(
        "aria-selected",
        String(row === focusRow && column === focusColumn),
      );
    }
    this.tableSizeLabel.textContent = `${displayColumns} × ${displayRows}`;
    this.tableSizeLabel.setAttribute(
      "aria-label",
      `${displayColumns} columns by ${displayRows} rows`,
    );
  }

  private previewTableDialogDimensions(
    columns: number,
    rows: number,
    active = true,
  ): void {
    const normalizedColumns = Math.max(
      1,
      Math.min(
        20,
        Math.round(
          Number.isFinite(columns) ? columns : this.tableDialogColumns,
        ),
      ),
    );
    const normalizedRows = Math.max(
      1,
      Math.min(
        50,
        Math.round(Number.isFinite(rows) ? rows : this.tableDialogRows),
      ),
    );
    const previewColumns = active
      ? normalizedColumns
      : Math.min(8, this.tableDialogColumns);
    const previewRows = active
      ? normalizedRows
      : Math.min(6, this.tableDialogRows);
    if (
      this.tableDialogPreviewing === active &&
      this.tableDialogPreviewColumns === previewColumns &&
      this.tableDialogPreviewRows === previewRows
    )
      return;
    this.tableDialogPreviewing = active;
    this.tableDialogPreviewColumns = previewColumns;
    this.tableDialogPreviewRows = previewRows;
    this.renderTableGrid();
  }

  private selectTableDialogDimensions(columns: number, rows: number): void {
    const nextColumns = Math.max(
      1,
      Math.min(
        20,
        Math.round(
          Number.isFinite(columns) ? columns : this.tableDialogColumns,
        ),
      ),
    );
    const nextRows = Math.max(
      1,
      Math.min(
        50,
        Math.round(Number.isFinite(rows) ? rows : this.tableDialogRows),
      ),
    );
    const dimensionsChanged =
      this.tableDialogColumns !== nextColumns ||
      this.tableDialogRows !== nextRows;
    const previewChanged =
      this.tableDialogPreviewing ||
      this.tableDialogPreviewColumns !== Math.min(8, nextColumns) ||
      this.tableDialogPreviewRows !== Math.min(6, nextRows);
    this.tableDialogColumns = nextColumns;
    this.tableDialogRows = nextRows;
    this.tableDialogPreviewing = false;
    this.tableDialogPreviewColumns = Math.min(8, nextColumns);
    this.tableDialogPreviewRows = Math.min(6, nextRows);
    if (this.tableColumnsInput) {
      this.tableColumnsInput.value = String(this.tableDialogColumns);
      this.tableRowsInput.value = String(this.tableDialogRows);
      this.tableColumnsInput.setCustomValidity("");
      this.tableRowsInput.setCustomValidity("");
    }
    if (this.tableDialogError) {
      this.tableDialogError.hidden = true;
      this.tableDialogError.textContent = "";
    }
    this.tableDialogSelectionLocked = false;
    if (this.tableDialogInsertButton)
      this.tableDialogInsertButton.disabled = false;
    if (dimensionsChanged || previewChanged) this.renderTableGrid();
  }

  private openTableDialog(invokingButton: HTMLButtonElement): void {
    if (
      this.profile === "commonmark" ||
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      this.parseError ||
      this.conflict ||
      this.syncPaused
    ) {
      this.setNotice("Tables are unavailable in the current editing mode.");
      return;
    }
    const popupSelection = this.popupSelection;
    this.closeWritingPopups();
    this.closeEmojiPicker();
    this.tableDialogSelection = {
      selection:
        popupSelection && popupSelection.$from.doc === this.view.state.doc
          ? popupSelection
          : this.view.state.selection,
      doc: this.view.state.doc,
      version: this.version,
      profile: this.profile,
      documentGeneration: this.documentGeneration,
    };
    this.tableDialogInvokingButton = invokingButton;
    this.tableDialogOpen = true;
    this.tableDialogSelectionLocked = false;
    this.selectTableDialogDimensions(3, 3);
    this.openDialog(this.tableDialog);
    this.tableGrid.focus({ preventScroll: true });
  }

  private closeTableDialog(message?: string, restoreFocus = true): void {
    if (!this.tableDialogOpen && !this.tableDialogSelection) return;
    this.tableDialogOpen = false;
    const button = this.tableDialogInvokingButton;
    this.tableDialogInvokingButton = null;
    this.tableDialogSelection = null;
    this.tableDialogSelectionLocked = false;
    this.closeDialog(this.tableDialog);
    if (message) this.setNotice(message, "error");
    if (restoreFocus && button?.isConnected) button.focus();
  }

  private commitTableDialog(): void {
    const saved = this.tableDialogSelection;
    if (!saved) return;
    if (
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      this.parseError ||
      this.conflict ||
      this.syncPaused ||
      this.profile !== saved.profile ||
      this.documentGeneration !== saved.documentGeneration ||
      this.view.state.doc !== saved.doc
    ) {
      this.closeTableDialog(
        "The document changed while the table dialog was open; nothing was inserted.",
      );
      return;
    }
    if (tableContext(saved.selection)) {
      this.closeTableDialog(
        "Place the cursor outside an existing table before inserting a table.",
      );
      return;
    }
    const inserted = this.insertTable(
      this.tableDialogColumns,
      this.tableDialogRows,
      saved.selection,
    );
    if (inserted) this.closeTableDialog(undefined, false);
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

  private restoreSelectionObject(selection: Selection | null): boolean {
    if (!selection || selection.$from.doc !== this.view.state.doc) return false;
    this.view.focus();
    this.view.updateState(
      this.view.state.apply(this.view.state.tr.setSelection(selection)),
    );
    return true;
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

  private insertHorizontalRule(): void {
    const horizontalRule = this.schema.nodes.horizontal_rule;
    if (!horizontalRule) return;
    this.dispatchTransaction(
      this.view.state.tr
        .replaceSelectionWith(horizontalRule.create())
        .scrollIntoView(),
    );
    this.view.focus();
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
    const kind: ListKind | null =
      typeName === "ordered_list"
        ? "ordered"
        : typeName === "bullet_list"
          ? "bullet"
          : null;
    if (!kind) return;
    this.runCommand(createListCommand(kind, this.schema));
  }

  private runTaskList(): void {
    if (this.profile === "commonmark") {
      this.setNotice("Task lists are unavailable in CommonMark.");
      return;
    }
    this.runCommand(createListCommand("task", this.schema));
  }

  private updateTableNumberingState(context: TableContext | null): void {
    const button = this.tableToolbar?.querySelector<HTMLButtonElement>(
      '[data-action="table-numbering"]',
    );
    if (!button) return;
    const active =
      Boolean(context) &&
      this.profile !== "commonmark" &&
      isTableNumbered(this.view.state);
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-active", active);
  }

  private runTableNumbering(): void {
    this.runTableCommand(createTableNumberingCommand(this.schema));
  }

  private runContextualTableAction(action: TableToolbarAction): void {
    if (action === "align-left") {
      this.runAlignment("left");
      return;
    }
    if (action === "align-center") {
      this.runAlignment("center");
      return;
    }
    if (action === "align-right") {
      this.runAlignment("right");
      return;
    }
    if (action === "table-numbering") {
      this.runTableNumbering();
      return;
    }
    if (action === "table-delete") {
      this.deleteTable();
      return;
    }
    const commands: Partial<
      Record<
        Exclude<TableToolbarAction, "table-delete" | `align-${string}`>,
        (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean
      >
    > = {
      "row-above": addRowBefore,
      "row-below": addRowAfter,
      "row-delete": deleteRow,
      "col-left": addColumnBefore,
      "col-right": addColumnAfter,
      "col-delete": deleteColumn,
    };
    const command = commands[action as keyof typeof commands];
    if (command) this.runTableCommand(command);
  }

  private deleteTable(): boolean {
    if (this.profile === "commonmark") {
      this.setNotice("Tables are unavailable in CommonMark.");
      return false;
    }
    const context = tableContext(this.view.state.selection);
    const paragraph = this.schema.nodes.paragraph;
    if (!context || !paragraph) {
      this.setNotice("Place the cursor inside a table to delete it.");
      return false;
    }
    this.view.focus();
    const transaction = this.view.state.tr.replaceWith(
      context.tableStart - 1,
      context.tableStart - 1 + context.table.nodeSize,
      paragraph.create(),
    );
    transaction.setSelection(
      TextSelection.near(
        transaction.doc.resolve(
          Math.min(context.tableStart - 1, transaction.doc.content.size),
        ),
        1,
      ),
    );
    transaction.scrollIntoView();
    this.dispatchTransaction(transaction);
    return true;
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
    if (!tableContext(this.view.state.selection)) {
      this.setNotice("Place the cursor inside a table to use table commands.");
      return false;
    }
    this.view.focus();
    return command(this.view.state, (tr) =>
      this.dispatchTransaction(this.normalizeTableTransaction(tr)),
    );
  }

  private captureTableSelection(
    context: TableContext,
    selection: Selection,
  ): TableSelectionBookmark {
    if (selection instanceof CellSelection) {
      const anchor = context.map.findCell(
        selection.$anchorCell.pos - context.tableStart,
      );
      const head = context.map.findCell(
        selection.$headCell.pos - context.tableStart,
      );
      return {
        kind: "cells",
        anchor: { row: anchor.top, column: anchor.left },
        head: { row: head.top, column: head.left },
      };
    }
    const cell = context.map.findCell(context.cellPos - context.tableStart);
    return {
      kind: "text",
      row: cell.top,
      column: cell.left,
      anchorOffset: Math.max(1, selection.anchor - context.cellPos),
      headOffset: Math.max(1, selection.head - context.cellPos),
    };
  }

  /** Replace a whole table while restoring the selected logical cell. */
  private replaceTablePreservingSelection(
    transaction: Transaction,
    context: TableContext,
    replacement: PMNode,
  ): Transaction {
    const start = context.tableStart - 1;
    const currentTable = transaction.doc.nodeAt(start) ?? context.table;
    const bookmark = this.captureTableSelection(context, transaction.selection);
    transaction.replaceWith(start, start + currentTable.nodeSize, replacement);
    const insertedTable = transaction.doc.nodeAt(start);
    if (!insertedTable || insertedTable.type.spec.tableRole !== "table")
      return transaction;
    const tableStart = start + 1;
    const map = TableMap.get(insertedTable);
    const cellPosition = (row: number, column: number): number => {
      const safeRow = Math.max(0, Math.min(map.height - 1, row));
      const safeColumn = Math.max(0, Math.min(map.width - 1, column));
      return tableStart + map.positionAt(safeRow, safeColumn, insertedTable);
    };
    try {
      if (bookmark.kind === "cells") {
        transaction.setSelection(
          CellSelection.create(
            transaction.doc,
            cellPosition(bookmark.anchor.row, bookmark.anchor.column),
            cellPosition(bookmark.head.row, bookmark.head.column),
          ),
        );
      } else {
        const cellPos = cellPosition(bookmark.row, bookmark.column);
        const cell = insertedTable.nodeAt(
          map.positionAt(
            Math.max(0, Math.min(map.height - 1, bookmark.row)),
            Math.max(0, Math.min(map.width - 1, bookmark.column)),
            insertedTable,
          ),
        );
        const contentSize = cell?.content.size ?? 0;
        const anchor = Math.min(
          Math.max(1, bookmark.anchorOffset),
          Math.max(1, contentSize),
        );
        const head = Math.min(
          Math.max(1, bookmark.headOffset),
          Math.max(1, contentSize),
        );
        transaction.setSelection(
          TextSelection.create(
            transaction.doc,
            cellPos + anchor,
            cellPos + head,
          ),
        );
      }
    } catch {
      // A malformed table from an extension should still be left in the doc;
      // ProseMirror will place a valid nearby selection when it dispatches.
    }
    return transaction.scrollIntoView();
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
    return this.replaceTablePreservingSelection(tr, context, normalized);
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
      this.replaceTablePreservingSelection(
        this.view.state.tr,
        context,
        aligned,
      ),
    );
    return true;
  }

  private insertTable(
    columns = 3,
    rows = 3,
    savedSelection: Selection = this.view.state.selection,
  ): boolean {
    if (this.profile === "commonmark") {
      this.setNotice("Tables are unavailable in CommonMark.");
      return false;
    }
    const normalizedColumns = Math.max(
      1,
      Math.min(20, Math.round(Number.isFinite(columns) ? columns : 3)),
    );
    const normalizedRows = Math.max(
      1,
      Math.min(50, Math.round(Number.isFinite(rows) ? rows : 3)),
    );
    const node = createEmptyTableNode(
      this.schema,
      normalizedColumns,
      normalizedRows,
    );
    if (!node) return false;
    return this.insertTableNode(node, savedSelection);
  }

  /** Insert an already-sized table without applying the Insert Table limits. */
  private insertTableNode(
    node: PMNode,
    savedSelection: Selection = this.view.state.selection,
    options: TableInsertionOptions = {},
  ): boolean {
    const table = this.schema.nodes.table;
    const paragraph = this.schema.nodes.paragraph;
    if (!table || !paragraph) return false;
    const state = this.view.state;
    let transaction: Transaction;
    try {
      transaction = state.tr.setSelection(savedSelection);
      const selection = transaction.selection;
      const $from = selection.$from;
      const $to = selection.$to;
      if (selection instanceof TextSelection && $from.sameParent($to)) {
        const parent = $from.parent;
        const blockStart = $from.before($from.depth);
        const fromOffset = selection.from - $from.start($from.depth);
        const toOffset = selection.to - $from.start($from.depth);
        const parts: PMNode[] = [];
        if (fromOffset > 0) parts.push(parent.cut(0, fromOffset));
        parts.push(node);
        if (toOffset < parent.content.size)
          parts.push(parent.cut(toOffset, parent.content.size));
        transaction.replaceWith(
          blockStart,
          blockStart + parent.nodeSize,
          Fragment.fromArray(parts),
        );
      } else {
        transaction.replaceRangeWith(selection.from, selection.to, node);
      }
    } catch {
      this.setNotice(
        "The table could not be inserted at this selection.",
        "error",
      );
      return false;
    }
    let tablePos = -1;
    const mappedInsertion = transaction.mapping.map(savedSelection.from);
    let nearestDistance = Number.POSITIVE_INFINITY;
    transaction.doc.nodesBetween(
      0,
      transaction.doc.content.size,
      (candidate, position) => {
        if (candidate.type !== table) return;
        if (candidate === node) {
          tablePos = position;
          nearestDistance = 0;
          return;
        }
        if (candidate.eq(node) && tablePos < 0) {
          const distance = Math.abs(position - mappedInsertion);
          if (distance < nearestDistance) {
            tablePos = position;
            nearestDistance = distance;
          }
        }
      },
    );
    if (tablePos >= 0) {
      const insertedTable = transaction.doc.nodeAt(tablePos);
      if (insertedTable) {
        const tableEnd = tablePos + insertedTable.nodeSize;
        if (!transaction.doc.nodeAt(tableEnd)) {
          const trailing = paragraph.create();
          transaction = transaction
            .insert(tableEnd, trailing)
            .setMeta(TRANSIENT_BLANK_META, {
              kind: "append",
              from: tableEnd,
              to: tableEnd + trailing.nodeSize,
              count: 1,
              meaningful: true,
            } satisfies TransientBlankTransactionMeta);
        }
        const map = TableMap.get(insertedTable);
        const firstCellPos = tablePos + 1 + (map.map[0] ?? 1);
        try {
          transaction.setSelection(
            TextSelection.near(transaction.doc.resolve(firstCellPos + 1), 1),
          );
        } catch {
          // A malformed schema should still leave the inserted table usable.
        }
      }
    }
    if (options.spreadsheetPaste)
      transaction = transaction.setMeta(SPREADSHEET_TABLE_PASTE_META, true);
    transaction.scrollIntoView();
    if (!this.dispatchTransaction(transaction)) {
      options.onRejected?.();
      return false;
    }
    this.view.focus();
    return true;
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
      if (this.composing || this.hasPendingHostSync()) {
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
        this.serializedDocument = this.view.state.doc;
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

  private setMode(
    mode: EditorMode,
    requestHost = true,
    options: { refreshPreview?: boolean } = {},
  ): void {
    if (this.previewOnly && mode !== "preview" && mode !== "source") return;
    if (mode !== this.mode) {
      this.closeWritingPopups();
      this.closeEmojiPicker();
      this.derivedViewsRevision += 1;
      this.pendingDerivedViews = null;
    }
    if (this.tableDialogOpen && mode !== "rich") this.closeTableDialog();
    this.mode = mode;
    if (mode !== "preview") {
      this.previewEnhancer?.dispose();
      this.previewEnhancer = undefined;
      // The preview DOM remains mounted while hidden, but its enhancer is
      // disposed. Force a fresh display pass when Preview is selected again,
      // even if the Markdown/profile/resource key is unchanged.
      this.previewNeedsRefresh = true;
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
    if (mode === "preview" && options.refreshPreview !== false) {
      this.refreshDerivedViews(this.currentMarkdown(), undefined, {
        renderPreview: true,
        refreshCompatibility: true,
      });
      if (requestHost && this.hasPendingHostSync())
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
      if (requestHost && this.hasPendingHostSync())
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

  private updateToolbarActiveState(
    selection = this.view.state.selection,
  ): void {
    if (!this.view) return;

    const activeState = getToolbarActiveState(
      this.view.state,
      selection,
      Boolean(tableContext(selection)),
    );
    const editingDisabled =
      !this.initialized ||
      this.previewOnly ||
      this.mode !== "rich" ||
      Boolean(this.parseError);

    for (const button of Array.from(
      this.root.querySelectorAll<HTMLButtonElement>("[data-toolbar-active]"),
    )) {
      const key = button.dataset.toolbarActive as ToolbarActiveKey | undefined;
      const active = Boolean(
        !editingDisabled && key && !button.disabled && activeState[key],
      );
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("is-active", active);
    }

    for (const button of Array.from(
      this.root.querySelectorAll<HTMLButtonElement>("[data-list-kind]"),
    )) {
      const kind = button.dataset.listKind as ListKind | undefined;
      const active = Boolean(
        !editingDisabled &&
        kind &&
        !button.disabled &&
        activeState.listKind === kind,
      );
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("is-active", active);
    }
  }

  private updateToolbarState(
    _oldSelection: Selection,
    selection: Selection,
    options: { revealTableToolbar?: boolean } = {},
  ): void {
    const heading =
      this.root.querySelector<HTMLSelectElement>(".mm-heading-select");
    if (heading) {
      const { $from } = selection;
      const node = $from.parent;
      heading.value =
        node.type.name === "heading" ? String(node.attrs.level) : "p";
    }
    this.updateEditingControlState(selection);
    this.updateTableToolbar(selection, {
      allowReveal: options.revealTableToolbar === true,
    });
    this.updateSelectionToolbar(selection);
    this.updateEmptyLineInsert(selection);
    this.updateBlockGapInsert();
    this.positionWritingPopup();
  }

  private updateProfileToolbar(): void {
    if (!this.profileToolbar) return;
    const visible =
      this.initialized &&
      !this.previewOnly &&
      !this.parseError &&
      this.mode === "rich" &&
      (this.profile === "github" || this.profile === "gitlab");
    this.profileToolbar.hidden = !visible;
    this.profileToolbar.setAttribute("aria-hidden", String(!visible));
    const allowed = new Set(
      getProfileFeatures(this.profile).map((feature) => feature.id),
    );
    for (const button of Array.from(
      this.profileToolbar.querySelectorAll<HTMLButtonElement>(
        "[data-profile-feature]",
      ),
    )) {
      const id = button.dataset.profileFeature as ProfileFeatureId | undefined;
      const available = Boolean(id && allowed.has(id));
      button.hidden = !available;
      button.disabled =
        !visible || !available || !this.canUseProfileFeature(id!);
    }
    this.updateInsertPopupProfileFeatures();
  }

  private updateInsertPopupProfileFeatures(): void {
    if (!this.insertPopup) return;
    const allowed = new Set(
      getProfileFeatures(this.profile)
        .filter((feature) => feature.kind === "block")
        .map((feature) => feature.id),
    );
    const visible =
      this.initialized &&
      !this.previewOnly &&
      !this.parseError &&
      this.mode === "rich";
    for (const [id, item] of this.insertPopupProfileItems) {
      const available = visible && allowed.has(id);
      item.hidden = !available;
      item.disabled = !available || !this.canUseProfileFeature(id);
      item.setAttribute("aria-hidden", String(!available));
    }
  }

  private revealTableToolbar(): void {
    if (this.tableToolbarRevealed) return;
    this.tableToolbarRevealed = true;
    this.tableToolbar.classList.add("is-revealing");
    if (this.tableToolbarRevealTimer !== undefined)
      clearTimeout(this.tableToolbarRevealTimer);
    this.tableToolbarRevealTimer = setTimeout(() => {
      this.tableToolbar.classList.remove("is-revealing");
      this.tableToolbarRevealTimer = undefined;
    }, 220);
  }

  private updateTableToolbar(
    selection = this.view.state.selection,
    options: { allowReveal?: boolean } = {},
  ): void {
    if (this.destroyed || !this.tableToolbar || !this.view) return;
    const updateAlignmentState = (
      active: "left" | "center" | "right" | null,
    ): void => {
      for (const button of Array.from(
        this.tableToolbar.querySelectorAll<HTMLButtonElement>(
          '[data-action^="align-"]',
        ),
      )) {
        const action = button.dataset.action?.slice("align-".length);
        button.setAttribute("aria-pressed", String(active === action));
      }
    };
    const canShow =
      this.initialized &&
      !this.previewOnly &&
      !this.parseError &&
      !this.conflict &&
      !this.syncPaused &&
      this.mode === "rich" &&
      this.profile !== "commonmark";
    const context = canShow ? tableContext(selection) : null;
    if (
      canShow &&
      context &&
      (options.allowReveal === true || this.tableToolbarRevealRequested)
    ) {
      this.revealTableToolbar();
      this.tableToolbarRevealRequested = false;
    }

    const visible = canShow && this.tableToolbarRevealed;
    const actionsEnabled = visible && context !== null;
    for (const button of Array.from(
      this.tableToolbar.querySelectorAll<HTMLButtonElement>(
        ".mm-table-toolbar-button",
      ),
    ))
      button.disabled = !actionsEnabled;

    this.tableToolbar.hidden = !visible;
    this.tableToolbar.setAttribute("aria-hidden", String(!visible));
    if (!visible || !context) {
      updateAlignmentState(null);
      this.tableToolbar.removeAttribute("data-table-pos");
      this.updateTableNumberingState(null);
      return;
    }

    // A null alignment is Markdown's default left alignment. Show a pressed
    // state only when every cell in the selected column(s) agrees.
    const alignments = new Set<"left" | "center" | "right">();
    for (let row = 0; row < context.map.height; row += 1) {
      for (
        let column = context.rect.left;
        column < context.rect.right;
        column += 1
      ) {
        const cell = context.table.nodeAt(
          context.map.positionAt(row, column, context.table),
        );
        const alignment = cell?.attrs.alignment;
        alignments.add(
          alignment === "center" || alignment === "right" ? alignment : "left",
        );
      }
    }
    updateAlignmentState(
      alignments.size === 1 ? ([...alignments][0] ?? null) : null,
    );

    this.tableToolbar.dataset.tablePos = String(context.tableStart - 1);
    this.updateTableNumberingState(context);
  }

  private postReady(): void {
    this.vscode?.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "ready",
      requestId: newOperationId(),
    });
  }

  private hasPendingHostSync(): boolean {
    return Boolean(this.vscode && (this.sync.hasPending || this.dirty));
  }

  private updateProfileSelect(): void {
    if (!this.profileSelect) return;
    this.profileSelect.value = this.profile;
  }

  private requestSource(): void {
    if (!this.initialized) return;
    if (
      this.composing ||
      (this.hasPendingHostSync() &&
        !this.sync.hasBlockedConflict &&
        !this.syncPaused)
    ) {
      this.deferredHostCommand = "source";
      this.setNotice("Waiting to open source until the latest edit is synced.");
      return;
    }
    if (!this.vscode) {
      // Small embedders have no native editor to reveal. Preserve the old
      // source panel as a useful local fallback while hosted VS Code opens the
      // real TextDocument through the source protocol request.
      this.setMode("source", false);
      return;
    }
    this.vscode.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "source",
      operationId: newOperationId(),
    });
    this.setNotice("Opening source…");
  }

  private requestProfileChange(profile: DocumentProfile): void {
    if (
      profile !== "github" &&
      profile !== "gitlab" &&
      profile !== "commonmark"
    ) {
      this.updateProfileSelect();
      return;
    }
    if (this.pendingProfile?.operationId) {
      this.updateProfileSelect();
      this.setNotice("Waiting for the current profile change to finish.");
      return;
    }
    if (profile === this.profile && !this.pendingProfile) {
      this.updateProfileSelect();
      return;
    }
    if (profile === this.profile && this.pendingProfile) {
      this.pendingProfile = null;
      this.updateProfileSelect();
      this.updateEditingControlState();
      return;
    }

    this.closeWritingPopups();
    this.closeEmojiPicker();
    this.invalidateProfileFeatureDialog();
    this.pendingProfile = { profile };
    this.profileSelect.value = profile;
    if (this.composing || this.hasPendingHostSync()) {
      this.setNotice(
        "Waiting to switch profile until the latest edit is synced.",
      );
      this.updateEditingControlState();
      return;
    }
    this.sendProfileChange();
  }

  private sendProfileChange(): void {
    const pending = this.pendingProfile;
    if (
      !pending ||
      pending.operationId ||
      this.composing ||
      this.hasPendingHostSync() ||
      this.syncPaused
    )
      return;
    if (!this.vscode) {
      this.pendingProfile = null;
      const markdown = this.currentMarkdown();
      this.applyDocument({
        protocolVersion: PROTOCOL_VERSION,
        type: "document",
        markdown,
        version: this.version,
        profile: pending.profile,
      });
      return;
    }
    const operationId = newOperationId();
    pending.operationId = operationId;
    this.setNotice("Switching to " + pending.profile + " profile…");
    this.updateEditingControlState();
    this.vscode.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "set-profile",
      profile: pending.profile,
      baseVersion: this.version,
      operationId,
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
    if (this.composing || this.hasPendingHostSync()) {
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
    if (this.pendingSaveOperationId) {
      // Save is serialized by the host. Coalesce repeated Cmd/Ctrl+S presses
      // into one follow-up request instead of running two save pipelines over
      // different snapshots.
      this.deferredHostCommand = "save";
      return true;
    }
    if (this.composing || this.hasPendingHostSync()) {
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
    if (this.composing || this.hasPendingHostSync() || this.syncPaused) return;
    if (this.pendingProfile) {
      this.sendProfileChange();
      return;
    }
    if (!this.deferredHostCommand) return;
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
    if (command === "source") {
      if (this.vscode) {
        this.vscode.postMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: "source",
          operationId,
        });
        this.setNotice("Opening source…");
      } else {
        this.setMode("source", false);
      }
    } else if (command === "preview")
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
      this.clipboardAvailable = message.clipboardAvailable === true;
      this.receiveDocument(message);
    } else if (message.type === "preview") {
      this.clipboardAvailable = message.clipboardAvailable === true;
      this.receivePreview(message);
    } else if (message.type === "edit-rejected") {
      if (this.sync.inflight?.operationId !== message.operationId) return;
      // A valid rejection must capture native Alert text before attempting a
      // rebase that might replace its NodeView. Successful reconciliation below
      // restores editing; an overlap keeps the input read-only and recoverable.
      this.conflict = true;
      this.syncPaused = true;
      this.updateEditingControlState();
      if (this.composing) {
        // Keep the pending operation and its original base until the final
        // composition input is available for the three-way merge.
        this.pendingRejectedEdit = message;
        return;
      }
      const external: DocumentMessage = {
        protocolVersion: PROTOCOL_VERSION,
        type: "document",
        markdown: message.currentMarkdown,
        version: message.currentVersion,
        profile: this.profile,
        reason: "external",
        ...(this.documentId === undefined
          ? {}
          : { documentId: this.documentId }),
        ...(this.resourceBaseUrl === undefined
          ? {}
          : { resourceBaseUrl: this.resourceBaseUrl }),
      };
      const localMarkdown = this.currentMarkdown();
      if (message.reason === "stale" || message.reason === "busy") {
        const result = this.sync.rebaseRejected(
          message.operationId,
          message.currentVersion,
          message.currentMarkdown,
          localMarkdown,
        );
        this.applyReconciliation(external, result, localMarkdown);
      } else if (
        this.sync.fail(
          message.operationId,
          message.currentVersion,
          message.currentMarkdown,
          localMarkdown,
        )
      ) {
        this.version = Math.max(this.version, message.currentVersion);
        this.setConflict(message.message);
      }
    } else if (message.type === "format-rejected") {
      this.setNotice(message.message, "error");
    } else if (message.type === "save-result") {
      this.handleSaveResult(message);
    } else if (message.type === "clipboard-result") {
      this.resolveClipboard(message);
    } else if (message.type === "image-import-result") {
      this.imageImport.handleResult(this.view, message);
    } else if (message.type === "error") {
      if (
        message.operationId &&
        this.imageImport.handleError(
          this.view,
          message.operationId,
          message.message,
        )
      )
        return;
      if (
        this.pendingProfile?.operationId &&
        this.pendingProfile.operationId === message.operationId
      ) {
        this.pendingProfile = null;
        this.updateProfileSelect();
        this.updateEditingControlState();
      }
      this.setNotice(message.message, "error");
    }
  }

  private resolveClipboard(message: ClipboardResultMessage): void {
    const pending = this.pendingClipboard.get(message.requestId);
    if (!pending) return;
    this.pendingClipboard.delete(message.requestId);
    if (pending.timer !== undefined)
      this.root.ownerDocument.defaultView?.clearTimeout(pending.timer);
    pending.resolve(message.success);
  }

  private receivePreview(message: HostPreviewMessage): void {
    this.clipboardAvailable = message.clipboardAvailable === true;
    if (
      message.version < this.version ||
      message.version < this.authoritativeVersion
    )
      return;
    if (this.sync.hasPending || this.dirty) {
      this.setNotice("Preview update waiting for the local draft to sync.");
      return;
    }
    // A document notification establishes the authoritative profile for its
    // version. A preview with the same source/version but another profile is
    // therefore stale once the local state agrees with that authoritative
    // profile; do not let it roll the UI back. A valid document -> preview pair
    // has the same profile and remains eligible below.
    if (
      this.initialized &&
      message.version === this.authoritativeVersion &&
      message.markdown === this.authoritativeMarkdown &&
      message.profile !== this.authoritativeProfile &&
      this.profile === this.authoritativeProfile
    )
      return;
    if (
      this.initialized &&
      message.version === this.authoritativeVersion &&
      message.profile === this.authoritativeProfile &&
      message.markdown !== this.authoritativeMarkdown
    )
      return;
    if (
      !this.initialized ||
      this.authoritativeVersion < message.version ||
      this.authoritativeMarkdown !== message.markdown ||
      this.authoritativeProfile !== message.profile
    ) {
      this.applyDocument({
        protocolVersion: PROTOCOL_VERSION,
        type: "document",
        markdown: message.markdown,
        version: message.version,
        profile: message.profile,
        mode: "preview",
        reason: "external",
        ...(message.resourceBaseUrl
          ? { resourceBaseUrl: message.resourceBaseUrl }
          : {}),
        ...(message.typography ? { typography: message.typography } : {}),
      });
    }
    this.profile = message.profile;
    this.updateProfileSelect();
    this.closeEmojiPicker();
    this.invalidateProfileFeatureDialog();
    if (this.pendingProfile && message.profile === this.pendingProfile.profile)
      this.pendingProfile = null;
    this.updateEditingControlState();
    this.version = Math.max(this.version, message.version);
    this.authoritativeMarkdown = message.markdown;
    this.authoritativeProfile = message.profile;
    this.authoritativeVersion = Math.max(
      this.authoritativeVersion,
      message.version,
    );
    this.resourceBaseUrl = message.resourceBaseUrl;
    this.applyTypography(message.typography);
    this.lastValidMarkdown = message.markdown;
    this.serializedDocument = this.view.state.doc;
    this.refreshDerivedViews(message.markdown, message.html, {
      renderPreview: true,
      refreshCompatibility: true,
    });
  }

  private handleSaveResult(message: SaveResultMessage): void {
    if (
      !this.pendingSaveOperationId ||
      message.operationId !== this.pendingSaveOperationId
    )
      return;
    this.pendingSaveOperationId = undefined;
    this.version = Math.max(this.version, message.version);
    if (!message.saved) {
      // The host already reports the concrete failure through VS Code's
      // notification surface. Do not retry a failed save implicitly; a later
      // explicit save request is the only way to try again.
      if (this.deferredHostCommand === "save") this.deferredHostCommand = null;
      return;
    }
    // `saved` describes the save operation that was requested. A later edit
    // may leave the current document dirty, which is a separate state and
    // must not turn a successful save into a failure or clear its recovery.
    if (!message.isDirty && !this.dirty && !this.sync.hasPending)
      this.clearRecoveryIfSaved();
    this.flushDeferredHostCommand();
  }

  receiveDocument(message: DocumentMessage): void {
    this.clipboardAvailable = message.clipboardAvailable === true;
    if (message.documentId) this.documentId = message.documentId;
    if (message.reason === "save") {
      this.receiveSaveSnapshot(message);
      return;
    }
    if (
      !message.operationId &&
      message.version < this.version &&
      !this.reloadRequested
    )
      return;
    // A delayed acknowledgement for an already completed operation is not a
    // new external edit. Ignore it unless it carries a newer, meaningful
    // history/configuration snapshot.
    if (
      message.operationId &&
      message.reason === "ack" &&
      !this.sync.isPendingOperation(message.operationId) &&
      this.pendingProfile?.operationId !== message.operationId
    ) {
      // ACKs are broadcast to every panel. An operation unknown to this
      // panel may therefore be another panel's successful edit, not a stale
      // notification. Ignore only an already-observed snapshot; a newer ACK
      // is an ordinary authoritative external update for this panel.
      if (
        message.version < this.authoritativeVersion ||
        (message.version === this.authoritativeVersion &&
          message.markdown === this.authoritativeMarkdown)
      )
        return;
    }
    const profileAck = Boolean(
      this.pendingProfile?.operationId &&
      this.pendingProfile.operationId === message.operationId,
    );
    if (profileAck) this.pendingProfile = null;
    else if (
      this.pendingProfile &&
      !message.operationId &&
      message.profile === this.pendingProfile.profile
    )
      this.pendingProfile = null;
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
      this.authoritativeMarkdown = message.markdown;
      this.authoritativeProfile = message.profile;
      this.authoritativeVersion = Math.max(
        this.authoritativeVersion,
        message.version,
      );
      this.operationId = message.operationId;
      if (hadPendingExternal) {
        const external = this.pendingExternal;
        if (!external) return;
        this.pendingExternal = null;
        this.reconcileExternalDocument(external);
        return;
      }
      this.conflict = false;
      this.syncPaused = false;
      this.dirty = this.sync.hasPending;
      this.updateProfileSelect();
      this.updateEditingControlState();
      if (!this.sync.hasPending && message.markdown === this.currentMarkdown())
        this.clearRecoveryIfSaved();
      this.flushDeferredHostCommand();
      return;
    }

    const hadImplicitAck =
      !message.operationId &&
      this.sync.acknowledgeSnapshot(message.version, message.markdown, {
        pauseQueue: hadPendingExternal,
      });
    if (hadImplicitAck) {
      this.version = Math.max(this.version, message.version);
      this.authoritativeMarkdown = message.markdown;
      this.authoritativeProfile = message.profile;
      this.authoritativeVersion = Math.max(
        this.authoritativeVersion,
        message.version,
      );
      if (this.pendingExternal) {
        const external = this.pendingExternal;
        this.pendingExternal = null;
        this.reconcileExternalDocument(external);
      } else {
        this.dirty = this.sync.hasPending;
        this.conflict = false;
        this.syncPaused = false;
        this.updateEditingControlState();
        this.flushDeferredHostCommand();
      }
      return;
    }
    if (this.isDuplicateAuthoritativeSnapshot(message)) {
      this.acceptDuplicateAuthoritativeSnapshot(message);
      return;
    }
    if (this.composing) {
      this.rememberPendingExternal(message);
      return;
    }
    if (this.reloadRequested) {
      this.reloadRequested = false;
      this.applyDocument(message, { force: true });
      return;
    }
    if (this.sync.hasBlockedConflict || this.conflict || this.syncPaused) {
      this.reconcileExternalDocument(message);
      return;
    }
    if (this.sync.inflight || this.sync.queuedEdit || this.dirty) {
      this.closeWritingPopups();
      this.invalidateProfileFeatureDialog();
      this.rememberPendingExternal(message);
      return;
    }
    this.applyDocument(message);
  }

  private receiveSaveSnapshot(message: DocumentMessage): void {
    if (message.version < this.authoritativeVersion) return;
    const localMarkdown = this.currentMarkdown();
    const keepLocalDraft =
      this.composing ||
      this.sync.hasPending ||
      this.dirty ||
      localMarkdown !== message.markdown;
    this.version = Math.max(this.version, message.version);
    this.authoritativeMarkdown = message.markdown;
    this.authoritativeProfile = message.profile;
    this.authoritativeVersion = Math.max(
      this.authoritativeVersion,
      message.version,
    );
    this.profile = message.profile;
    this.resourceBaseUrl = message.resourceBaseUrl;
    this.applyTypography(message.typography);
    this.sync.noteAuthoritative(message.version, message.markdown);
    this.updateProfileSelect();
    this.updateEditingControlState();
    if (!keepLocalDraft) this.applyDocument(message);
  }

  private rememberPendingExternal(message: DocumentMessage): void {
    if (
      !this.pendingExternal ||
      message.version >= this.pendingExternal.version
    )
      this.pendingExternal = message;
    // Block controls cannot accept unsynchronized native text while the
    // authoritative snapshot awaits an ACK or the end of composition.
    this.updateEditingControlState();
  }

  private reconcileExternalDocument(message: DocumentMessage): void {
    if (this.composing || this.blockCompositionTimer !== undefined) {
      this.rememberPendingExternal(message);
      return;
    }
    if (this.serializationError || this.parseError) {
      // There is no trustworthy Markdown snapshot to diff while serialization
      // or parsing is failing. Keep the structured PM document and the incoming
      // native snapshot separate until the representation recovers; guessing
      // from the previous source could silently discard local input.
      this.pendingExternal = message;
      this.dirty = true;
      this.setConflict(
        this.serializationError
          ? `The local draft could not be synchronized: ${this.serializationError}`
          : "The external Markdown snapshot could not be opened in the rich editor.",
      );
      this.persistRecovery(
        this.currentMarkdown(),
        this.sync.draftBaseMarkdown,
        this.sync.version,
        true,
      );
      return;
    }
    // The profile is part of the authoritative TextDocument context. Preserve
    // it even when the Markdown body can be merged without rebuilding the PM
    // document, otherwise a delayed edit ACK can roll a profile change back.
    if (message.profile !== this.profile) {
      this.profile = message.profile;
      this.updateProfileSelect();
      this.updateEditingControlState();
    }
    const localMarkdown = this.currentMarkdown();
    const result = this.sync.reconcileExternal(
      message.version,
      message.markdown,
      localMarkdown,
    );
    this.applyReconciliation(message, result, localMarkdown);
  }

  private applyReconciliation(
    message: DocumentMessage,
    result: {
      kind: "merged" | "accepted" | "conflict" | "ignored";
      markdown: string;
    },
    localMarkdown: string,
  ): void {
    if (result.kind === "ignored") return;

    if (result.kind === "conflict") {
      this.pendingExternal = message;
      this.dirty = true;
      this.conflict = true;
      this.syncPaused = true;
      this.setConflict(
        "The document changed externally and the local draft could not be merged automatically.",
      );
      return;
    }

    this.pendingExternal = null;
    const localMatches = localMarkdown === result.markdown;
    if (!localMatches) {
      const { operationId: _operationId, ...withoutOperation } = message;
      this.applyDocument(
        {
          ...withoutOperation,
          markdown: result.markdown,
          reason: "external",
        },
        { force: true },
      );
      if (this.parseError) {
        // The merge itself is only a line-level safety check. If the resulting
        // source cannot be represented by the rich parser, keep the local PM
        // document and leave the native source snapshot pending rather than
        // treating a failed display conversion as a successful sync.
        this.pendingExternal = message;
        this.dirty = true;
        this.conflict = true;
        this.syncPaused = true;
        this.persistRecovery(
          localMarkdown,
          this.sync.draftBaseMarkdown,
          this.sync.version,
          true,
        );
        return;
      }
    }
    this.authoritativeMarkdown = message.markdown;
    this.authoritativeProfile = message.profile;
    this.authoritativeVersion = Math.max(
      this.authoritativeVersion,
      message.version,
    );
    this.version = Math.max(this.version, message.version);
    this.profile = message.profile;
    this.resourceBaseUrl = message.resourceBaseUrl;
    this.applyTypography(message.typography);
    this.sync.noteAuthoritative(message.version, message.markdown);
    this.conflict = false;
    this.syncPaused = false;
    this.dirty = result.kind === "merged";
    this.updateProfileSelect();
    this.updateEditingControlState();
    if (result.kind === "merged") {
      this.lastValidMarkdown = result.markdown;
      this.serializedDocument = this.view.state.doc;
      this.persistRecovery(result.markdown, message.markdown, message.version);
      if (this.vscode && this.initialized && !this.previewOnly)
        this.sync.enqueue(result.markdown);
    } else {
      this.clearRecoveryIfSaved();
    }
    this.flushDeferredHostCommand();
  }

  private isDuplicateAuthoritativeSnapshot(message: DocumentMessage): boolean {
    if (
      message.operationId ||
      (!this.sync.hasPending && !this.dirty && !this.composing) ||
      this.pendingExternal ||
      this.conflict ||
      this.syncPaused
    )
      return false;
    // History and explicit reload/recovery messages carry meaningful state
    // even when their Markdown text happens to be unchanged.
    if (message.reason !== undefined && message.reason !== "external")
      return false;
    const sameAuthoritativeSource =
      message.profile === this.authoritativeProfile &&
      message.markdown === this.authoritativeMarkdown;
    // A dirty-only TextDocument event can arrive before the edit ack and carry
    // the exact source submitted by the inflight edit. It is an authoritative
    // echo, not a competing draft: the queued edit was based on this source.
    const sameInflightSource =
      this.sync.inflight !== null &&
      message.profile === this.authoritativeProfile &&
      message.markdown === this.sync.inflight.markdown;
    if (!sameAuthoritativeSource && !sameInflightSource) return false;
    if (
      message.mode !== undefined &&
      message.mode !== (this.previewOnly ? "preview" : "editor")
    )
      return false;
    return message.version >= this.authoritativeVersion;
  }

  private acceptDuplicateAuthoritativeSnapshot(message: DocumentMessage): void {
    this.version = Math.max(this.version, message.version);
    this.authoritativeMarkdown = message.markdown;
    this.authoritativeProfile = message.profile;
    this.authoritativeVersion = Math.max(
      this.authoritativeVersion,
      message.version,
    );
    this.resourceBaseUrl = message.resourceBaseUrl;
    this.applyTypography(message.typography);
    this.profile = message.profile;
    this.sync.setVersion(Math.max(this.sync.version, message.version));
    this.updateProfileSelect();
    this.updateEditingControlState();
    // The PM state remains untouched. Use the last serialized local draft so
    // an authoritative echo cannot reserialize or replace a newer queued edit.
    this.refreshDerivedViews(this.lastValidMarkdown, undefined, {
      renderPreview: this.mode === "preview",
      refreshCompatibility: false,
    });
    this.scheduleDerivedViews(this.lastValidMarkdown);
  }

  private applyDocument(
    message: DocumentMessage,
    options: { force?: boolean } = {},
  ): void {
    if (this.composing) {
      this.pendingExternal = message;
      return;
    }

    this.derivedViewsRevision += 1;
    this.pendingDerivedViews = null;

    const wasInitialized = this.initialized;
    const previousState = this.view.state;
    const previousDoc = previousState.doc;
    const forceReparse =
      options.force === true ||
      message.reason === "initial" ||
      message.reason === "recovery" ||
      message.reason === "undo" ||
      message.reason === "redo";
    const previousProfile = this.profile;
    const stage = this.root.querySelector<HTMLElement>(".mm-stage");
    const scrollTop = stage?.scrollTop ?? 0;

    // A TextDocument event can repeat the authoritative source after an edit
    // acknowledgement. Keep the exact EditorState when the source and profile
    // are the same. Any different authoritative source is parsed and applied
    // below, including terminal whitespace changes, so TextDocument remains
    // the sole source of truth.
    let currentMarkdown: string | null = null;
    if (!this.parseError) {
      try {
        currentMarkdown = this.currentMarkdown();
      } catch {
        currentMarkdown = null;
      }
    }
    let preserveState =
      wasInitialized &&
      !forceReparse &&
      currentMarkdown !== null &&
      previousProfile === message.profile &&
      currentMarkdown === message.markdown;
    const abortedAlertEdit =
      this.profileFeatureEditTarget !== null &&
      (!preserveState || message.mode === "preview");
    if (abortedAlertEdit) {
      this.profileFeatureError.hidden = false;
      this.profileFeatureError.textContent =
        "The document changed; nothing was updated. Copy your draft before closing this dialog.";
    }

    if (!preserveState || message.mode === "preview")
      this.imageImport.cancel(this.view);

    if (!preserveState) {
      if (this.tableDialogOpen)
        this.closeTableDialog(
          "The document changed while the table dialog was open; nothing was inserted.",
        );
      this.closeWritingPopups();
      this.closeEmojiPicker();
      this.transientBlanks = null;
      this.documentGeneration += 1;
      this.clearBlockGapInsert();
    }

    this.profile = message.profile;
    this.updateProfileSelect();
    this.authoritativeMarkdown = message.markdown;
    this.authoritativeProfile = message.profile;
    this.authoritativeVersion = Math.max(
      this.authoritativeVersion,
      message.version,
    );
    this.previewOnly = message.mode === "preview";
    this.applyTypography(message.typography);
    this.version = Math.max(this.version, message.version);
    this.operationId = message.operationId;
    this.resourceBaseUrl = message.resourceBaseUrl;
    if (message.mode === "preview")
      this.setMode("preview", false, { refreshPreview: false });

    if (preserveState) {
      this.view.setProps({ editable: () => !this.previewOnly });
      this.parseError = null;
      this.serializationError = null;
      this.lastNotificationKey = null;
      this.preservedSource = null;
      this.dirty = false;
      this.conflict = false;
      this.syncPaused = false;
      this.reloadRequested = false;
      this.lastValidMarkdown = message.markdown;
      this.serializedDocument = this.view.state.doc;
      this.pendingExternal = null;
      this.sync.setVersion(this.version);
      this.sync.noteAuthoritative(this.version, message.markdown);
      this.sync.clear();
      this.setInitialized(true);
      this.refreshDerivedViews(message.markdown, undefined, {
        // Entering the preview panel is a display event, so make its first
        // snapshot visible immediately. Rich editing never takes this path;
        // its compatibility work remains in the deferred batch below.
        renderPreview: message.mode === "preview" || this.mode === "preview",
        refreshCompatibility: message.mode === "preview",
      });
      if (message.mode !== "preview") {
        this.scheduleDerivedViews(message.markdown);
        this.updateToolbarState(
          this.view.state.selection,
          this.view.state.selection,
        );
      }
      if (stage) stage.scrollTop = scrollTop;
      this.clearRecoveryIfSaved();
      this.restoreRecoveryState();
      this.flushDeferredHostCommand();
      if (abortedAlertEdit)
        this.setNotice(
          "The document changed while this Alert dialog was open; nothing was updated.",
          "error",
        );
      return;
    }

    let parsed: ParseResult;
    try {
      parsed = this.core.parseMarkdown(message.markdown, this.profile);
      this.parseError = null;
      this.lastNotificationKey = null;
      this.preservedSource = null;
    } catch (error) {
      this.parseError =
        error instanceof Error
          ? error.message
          : "Markdown could not be parsed.";
      this.preservedSource = message.markdown;
      this.view.setProps({ editable: () => false });
      this.syncPaused = true;
      this.sync.noteAuthoritative(message.version, message.markdown);
      this.sourceEl.value = message.markdown;
      if (message.mode !== "preview")
        this.previewEl.textContent = message.markdown;
      this.setInitialized(true);
      if (message.mode !== "preview") {
        this.setMode("source", false);
        // A parser exception only disables the rich representation. Keep the
        // raw source visible and hand editing to VS Code's native source
        // editor, where the unsupported document remains fully editable.
        this.vscode?.postMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: "source",
          operationId: newOperationId(),
        });
      }
      this.notifyHost(
        "error",
        `Markdown could not be opened in the rich editor: ${this.parseError}`,
      );
      if (abortedAlertEdit)
        this.setNotice(
          "The document changed while this Alert dialog was open; nothing was updated.",
          "error",
        );
      this.persistRecovery(message.markdown, message.markdown, message.version);
      return;
    }
    this.view.setProps({ editable: () => !this.previewOnly });
    this.previousSnapshot = parsed.snapshot ?? parsed;
    const prepared = prepareStarterDocument(
      message.markdown,
      parsed.doc,
      this.schema,
    );
    const editorDoc = prepared.doc;
    this.starterOriginalSource = message.markdown;
    if (!editorDoc.eq(previousDoc)) {
      let nextState = EditorState.create({
        schema: this.schema,
        doc: editorDoc,
        plugins: previousState.plugins,
      });
      nextState = nextState.apply(setStarterMeta(nextState.tr, prepared.state));
      nextState = nextState.apply(
        nextState.tr.setSelection(
          selectionForDocument(previousState.selection, editorDoc),
        ),
      );
      this.view.updateState(nextState);
    } else if (
      JSON.stringify(getStarterState(previousState)) !==
      JSON.stringify(prepared.state)
    ) {
      this.view.updateState(
        previousState.apply(setStarterMeta(previousState.tr, prepared.state)),
      );
    }
    // Remove the loading veil only after the authoritative document and its
    // starter state have both been reflected in ProseMirror.
    this.setInitialized(true);
    this.dirty = false;
    this.conflict = false;
    this.syncPaused = false;
    this.reloadRequested = false;
    this.lastValidMarkdown = message.markdown;
    this.serializationError = null;
    this.lastNotificationKey = null;
    this.serializedDocument = this.view.state.doc;
    this.pendingExternal = null;
    this.sync.setVersion(this.version);
    this.sync.noteAuthoritative(this.version, message.markdown);
    this.sync.clear();
    this.refreshDerivedViews(message.markdown, undefined, {
      renderPreview: message.mode === "preview" || this.mode === "preview",
      refreshCompatibility: message.mode === "preview",
    });
    if (message.mode !== "preview") {
      this.scheduleDerivedViews(message.markdown);
      this.updateToolbarState(
        this.view.state.selection,
        this.view.state.selection,
      );
    }
    if (stage) stage.scrollTop = scrollTop;
    this.clearRecoveryIfSaved();
    this.restoreRecoveryState();
    this.flushDeferredHostCommand();
    if (abortedAlertEdit)
      this.setNotice(
        "The document changed while this Alert dialog was open; nothing was updated.",
        "error",
      );
  }

  private flushExternalAfterComposition(): void {
    if (this.pendingRejectedEdit) {
      const rejected = this.pendingRejectedEdit;
      this.pendingRejectedEdit = null;
      this.handleMessage(rejected);
    }
    if (!this.pendingExternal) return;
    const external = this.pendingExternal;
    this.pendingExternal = null;
    // An edit acknowledgement may still be in flight after composition ends.
    // Keep the external snapshot until that acknowledgement gives us the
    // original base and the latest local draft for a three-way merge.
    if (this.sync.inflight) {
      this.pendingExternal = external;
      return;
    }
    if (this.dirty) {
      this.pendingExternal = external;
      this.reconcileExternalDocument(external);
      return;
    }
    this.applyDocument(external);
  }

  private persistRecovery(
    markdown: string,
    baseMarkdown = this.authoritativeMarkdown,
    baseVersion = this.authoritativeVersion,
    includeDocument = false,
  ): void {
    if (!this.vscode?.setState) return;
    const state: RecoveryState = {
      recoveryDraft: markdown,
      recoveryBaseMarkdown: baseMarkdown,
      recoveryBaseVersion: baseVersion,
      recoveryVersion: this.version,
      recoveryProfile: this.profile,
      recoveryTimestamp: Date.now(),
      ...(this.documentId ? { documentId: this.documentId } : {}),
    };
    if (includeDocument) {
      try {
        state.recoveryDocument = this.view.state.doc.toJSON();
      } catch {
        // Markdown and provenance remain useful even if a future node type is
        // not JSON serializable.
      }
    }
    this.vscode.setState(state satisfies RecoveryState);
  }

  private recoveryBelongsToCurrentDocument(saved: RecoveryState): boolean {
    if (this.documentId !== undefined)
      return saved.documentId === this.documentId;
    return saved.documentId === undefined;
  }

  private recoveryBaseMatchesCurrent(saved: RecoveryState): boolean {
    if (saved.recoveryBaseMarkdown !== undefined)
      return (
        saved.recoveryBaseMarkdown === this.authoritativeMarkdown &&
        (saved.recoveryBaseVersion === undefined ||
          saved.recoveryBaseVersion <= this.authoritativeVersion)
      );
    return saved.recoveryVersion === this.version;
  }

  private restoreRecoveryState(): void {
    const saved = this.vscode?.getState?.() as RecoveryState | undefined;
    if (!saved || typeof saved.recoveryDraft !== "string") return;
    if (!this.recoveryBelongsToCurrentDocument(saved)) return;
    if (saved.recoveryDraft === this.currentMarkdown()) {
      this.clearRecoveryIfSaved();
      return;
    }
    // Recovery is automatic only when the draft records the exact
    // authoritative document it was based on. A changed document is left in
    // storage for diagnostics/host-side recovery, never silently overwritten.
    if (
      (saved.recoveryProfile ?? this.profile) !== this.profile ||
      !this.recoveryBaseMatchesCurrent(saved)
    )
      return;
    this.restoreRecoveryDraft(saved);
  }

  private restoreRecoveryDraft(saved: RecoveryState): void {
    const draft = saved.recoveryDraft;
    if (draft === undefined) return;
    const profile = saved.recoveryProfile ?? this.profile;
    let editorDoc: PMNode | undefined;
    let snapshot: unknown;
    let starterState: StarterPluginState | undefined;
    if (saved.recoveryDocument !== undefined) {
      try {
        editorDoc = PMNode.fromJSON(this.schema, saved.recoveryDocument);
      } catch {
        editorDoc = undefined;
      }
    }
    if (!editorDoc) {
      try {
        const parsed = this.core.parseMarkdown(draft, profile);
        const prepared = prepareStarterDocument(draft, parsed.doc, this.schema);
        editorDoc = prepared.doc;
        starterState = prepared.state;
        snapshot = parsed.snapshot ?? parsed;
      } catch (error) {
        this.notifyHost(
          "error",
          error instanceof Error
            ? `The saved Markdown draft could not be restored: ${error.message}`
            : "The saved Markdown draft could not be restored.",
        );
        return;
      }
    }

    let recoveryState = EditorState.create({
      schema: this.schema,
      doc: editorDoc,
      plugins: this.view.state.plugins,
    });
    if (starterState)
      recoveryState = recoveryState.apply(
        setStarterMeta(recoveryState.tr, starterState),
      );
    this.view.updateState(recoveryState);
    this.profile = profile;
    this.previousSnapshot = snapshot;
    this.starterOriginalSource = draft;
    this.parseError = null;
    this.serializationError = null;
    this.preservedSource = null;
    this.lastValidMarkdown = draft;
    this.serializedDocument = this.view.state.doc;
    this.dirty = true;
    this.conflict = false;
    this.syncPaused = false;
    this.documentGeneration += 1;
    this.sync.clear();
    this.sync.noteAuthoritative(
      this.authoritativeVersion,
      this.authoritativeMarkdown,
    );
    this.view.setProps({ editable: () => !this.previewOnly });
    this.refreshDerivedViews(draft, undefined, {
      renderPreview: this.mode === "preview",
      refreshCompatibility: false,
    });
    this.scheduleDerivedViews(draft);
    this.updateProfileSelect();
    this.updateEditingControlState();
    this.persistRecovery(
      draft,
      this.authoritativeMarkdown,
      this.authoritativeVersion,
    );
    if (this.vscode && this.initialized && !this.previewOnly)
      this.sync.enqueue(draft);
  }

  private clearRecoveryIfSaved(): void {
    if (this.serializationError) return;
    const saved = this.vscode?.getState?.() as RecoveryState | undefined;
    if (
      !saved ||
      typeof saved.recoveryDraft !== "string" ||
      !this.recoveryBelongsToCurrentDocument(saved) ||
      saved.recoveryDraft !== this.currentMarkdown()
    )
      return;
    this.vscode?.setState?.({});
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
      this.replaceTablePreservingSelection(view.state.tr, selected, tableNode),
    );
    return true;
  }

  private handlePaste(view: EditorView, event: ClipboardEvent): boolean {
    if (!event.clipboardData) return false;
    const selection = view.state.selection;
    if (
      isTextOrientedPasteTarget(event.target) ||
      isTextOrientedPasteSelection(selection)
    )
      return false;

    const payload = {
      internal: readClipboardData(event.clipboardData, TABLE_CLIPBOARD_MIME),
      text: readClipboardData(event.clipboardData, "text/plain"),
      html: readClipboardData(event.clipboardData, "text/html"),
    };
    const context = tableContext(selection);
    if (!context) {
      const detected = detectSpreadsheetPaste(payload);
      const hasHtmlTable = hasClipboardTableMarkup(payload.html);
      // CommonMark keeps ProseMirror's plain-text paste behavior even when a
      // spreadsheet also supplies HTML. This avoids letting the generic
      // clipboard parser turn an HTML table into a Markdown table.
      if (this.profile === "commonmark") {
        const tableFallbackText =
          payload.text ||
          (detected.kind === "matrix" || detected.kind === "single-cell"
            ? matrixToTsv(detected.matrix)
            : "");
        if (hasHtmlTable) {
          if (
            this.canEditBlock() &&
            tableFallbackText &&
            tableFallbackText.length <= MAX_CLIPBOARD_TEXT_LENGTH
          ) {
            if (
              selection instanceof BlockBoundarySelection &&
              !this.materializeBoundary(selection.head)
            )
              return false;
            this.view.pasteText(tableFallbackText, event);
            event.preventDefault();
            return true;
          }
          this.notifyHost(
            "warning",
            detected.kind === "too-large"
              ? `Table paste is too large. Markdown Mint supports up to ${MAX_CLIPBOARD_CELLS.toLocaleString("en-US")} pasted cells.`
              : "Table paste could not be parsed safely and was rejected.",
          );
          event.preventDefault();
          return true;
        }
        if (this.canEditBlock() && detected.kind !== "none") {
          if (selection instanceof BlockBoundarySelection) {
            if (!this.materializeBoundary(selection.head)) return false;
          }
          const plainText =
            payload.text ||
            (detected.kind === "matrix" || detected.kind === "single-cell"
              ? matrixToTsv(detected.matrix)
              : "");
          if (plainText) {
            this.view.pasteText(plainText, event);
            event.preventDefault();
            return true;
          }
        }
        if (selection instanceof BlockBoundarySelection)
          this.materializeBoundary(selection.head);
        return false;
      }
      if (!this.canEditBlock()) {
        if (hasHtmlTable) {
          event.preventDefault();
          return true;
        }
        if (selection instanceof BlockBoundarySelection)
          this.materializeBoundary(selection.head);
        return false;
      }
      if (
        !(selection instanceof TextSelection) &&
        !(selection instanceof BlockBoundarySelection)
      )
        return false;

      if (detected.kind === "too-large") {
        this.notifyHost(
          "warning",
          `Table paste is too large. Markdown Mint supports up to ${MAX_CLIPBOARD_CELLS.toLocaleString("en-US")} pasted cells.`,
        );
        event.preventDefault();
        return true;
      }
      if (detected.kind === "single-cell") {
        const value = payload.text || detected.matrix.values[0]?.[0] || "";
        if (!value) return false;
        if (selection instanceof BlockBoundarySelection) {
          if (!this.materializeBoundary(selection.head)) return false;
        }
        this.view.pasteText(value, event);
        event.preventDefault();
        return true;
      }
      if (detected.kind === "matrix") {
        const tableNode = createTableNodeFromMatrix(
          this.schema,
          detected.matrix,
        );
        let pasteRejected = false;
        if (
          tableNode &&
          this.insertTableNode(tableNode, selection, {
            spreadsheetPaste: true,
            onRejected: () => {
              pasteRejected = true;
            },
          })
        ) {
          event.preventDefault();
          return true;
        }
        if (pasteRejected) {
          event.preventDefault();
          return true;
        }
      }
      if (hasHtmlTable) {
        if (
          payload.text &&
          payload.text.length <= MAX_CLIPBOARD_TEXT_LENGTH &&
          (selection instanceof TextSelection ||
            selection instanceof BlockBoundarySelection)
        ) {
          if (
            selection instanceof BlockBoundarySelection &&
            !this.materializeBoundary(selection.head)
          )
            return false;
          this.view.pasteText(payload.text, event);
          event.preventDefault();
          return true;
        }
        this.notifyHost(
          "warning",
          "Table paste could not be parsed safely and was rejected.",
        );
        event.preventDefault();
        return true;
      }
      if (selection instanceof BlockBoundarySelection)
        // Materialize the insertion point, then let ProseMirror's native paste
        // pipeline handle non-table clipboard payloads.
        this.materializeBoundary(selection.head);
      return false;
    }

    const isCellSelection = selection instanceof CellSelection;
    const hasHtmlTable = hasClipboardTableMarkup(payload.html);

    // Evaluate clipboard flavors in priority order and stop as soon as one
    // valid candidate is found. In particular, a lower-priority malformed or
    // oversized HTML flavor must not veto valid internal Markdown Mint or TSV
    // data.
    const internalResult = parseInternalMatrixWithStatus(payload.internal);
    if (internalResult.failure === "too-large") {
      this.notifyHost(
        "warning",
        `Table paste is too large. Markdown Mint supports up to ${MAX_CLIPBOARD_CELLS.toLocaleString("en-US")} pasted cells.`,
      );
      event.preventDefault();
      return true;
    }
    let matrix = internalResult.matrix;
    if (!matrix) {
      const tsvResult = parseTsvWithStatus(
        payload.text.includes("\t") ? payload.text : "",
      );
      if (tsvResult.failure === "too-large") {
        this.notifyHost(
          "warning",
          `Table paste is too large. Markdown Mint supports up to ${MAX_CLIPBOARD_CELLS.toLocaleString("en-US")} pasted cells.`,
        );
        event.preventDefault();
        return true;
      }
      matrix = tsvResult.matrix;
    }
    if (!matrix && hasHtmlTable) {
      const htmlResult = parseClipboardHtmlWithStatus(payload.html);
      if (htmlResult.failure === "too-large") {
        this.notifyHost(
          "warning",
          `Table paste is too large. Markdown Mint supports up to ${MAX_CLIPBOARD_CELLS.toLocaleString("en-US")} pasted cells.`,
        );
        event.preventDefault();
        return true;
      }
      matrix = htmlResult.matrix;
    }

    // Plain text in an ordinary text selection must continue through
    // ProseMirror's native paste pipeline. Only table-shaped clipboard data
    // (or a CellSelection, which has historically accepted a 1x1 fallback)
    // belongs to the table replacement path. A table-shaped HTML flavor with
    // no safe matrix must never fall through to ProseMirror's HTML parser.
    if (!isCellSelection && !matrix) {
      if (hasHtmlTable) {
        if (payload.text && payload.text.length <= MAX_CLIPBOARD_TEXT_LENGTH) {
          this.view.pasteText(payload.text, event);
          event.preventDefault();
          return true;
        }
        this.notifyHost(
          "warning",
          "Table paste could not be parsed safely and was rejected.",
        );
        event.preventDefault();
        return true;
      }
      return false;
    }
    if (this.profile === "commonmark") {
      this.setNotice("Table paste is unavailable in CommonMark.");
      event.preventDefault();
      return true;
    }
    if (!matrix && payload.text)
      matrix = { values: [[payload.text]], rows: 1, columns: 1 };
    if (!matrix) {
      if (hasHtmlTable) {
        this.notifyHost(
          "warning",
          "Table paste could not be parsed safely and was rejected.",
        );
        event.preventDefault();
        return true;
      }
      return false;
    }
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
      this.replaceTablePreservingSelection(
        view.state.tr,
        context,
        tableNode,
      ).setMeta(SPREADSHEET_TABLE_PASTE_META, true),
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

export type { TableMatrix } from "./tableClipboard";
