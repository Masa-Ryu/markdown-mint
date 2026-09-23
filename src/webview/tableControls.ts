import type { Node as PMNode } from "prosemirror-model";
import {
  measureEditorPerformance,
  recordEditorPerformanceCount,
  recordEditorPerformanceDuration,
  tableControlsDisabledForBenchmark,
} from "../shared/performanceBenchmark";
import { appendToolbarIcon } from "./icons";

export type TableControlAxis = "row" | "column";

export interface TableControlSelection {
  axis: TableControlAxis;
  index: number;
}

export interface TableControlTarget {
  tablePos: number;
  table: PMNode;
  tableElement: HTMLTableElement;
  document: PMNode;
  documentGeneration: number;
  numbered: boolean;
  supported: boolean;
  selection?: TableControlSelection | null;
}

/**
 * Benchmark prototype for separating the table viewport from the horizontal
 * scroll mechanism. Production controls continue to use the DOM ancestor
 * path; this owner is enabled only by the benchmark bundle.
 */
export interface TableHorizontalScrollOwner {
  getScrollLeft(): number;
  getMaxScrollLeft(): number;
  setScrollLeft(value: number): void;
  scrollBy(delta: number): void;
  getViewportRect(): DOMRect;
  subscribe(listener: () => void): () => void;
  getElement(): HTMLElement;
}

export class NativeTableScrollOwner implements TableHorizontalScrollOwner {
  constructor(
    private readonly element: HTMLElement,
    private readonly viewport: HTMLElement = element,
  ) {}

  getScrollLeft(): number {
    return this.element.scrollLeft;
  }

  getMaxScrollLeft(): number {
    return Math.max(0, this.element.scrollWidth - this.element.clientWidth);
  }

  setScrollLeft(value: number): void {
    this.element.scrollLeft = value;
  }

  scrollBy(delta: number): void {
    this.setScrollLeft(this.getScrollLeft() + delta);
  }

  getViewportRect(): DOMRect {
    return clientRect(this.viewport);
  }

  subscribe(listener: () => void): () => void {
    this.element.addEventListener("scroll", listener, { passive: true });
    return () => this.element.removeEventListener("scroll", listener);
  }

  getElement(): HTMLElement {
    return this.element;
  }
}

export class ProxyTableScrollOwner implements TableHorizontalScrollOwner {
  constructor(
    private readonly proxy: HTMLElement,
    private readonly viewport: HTMLElement,
  ) {}

  getScrollLeft(): number {
    return this.proxy.scrollLeft;
  }

  getMaxScrollLeft(): number {
    return Math.max(0, this.proxy.scrollWidth - this.proxy.clientWidth);
  }

  setScrollLeft(value: number): void {
    this.proxy.scrollLeft = Math.max(
      0,
      Math.min(this.getMaxScrollLeft(), value),
    );
  }

  scrollBy(delta: number): void {
    this.setScrollLeft(this.getScrollLeft() + delta);
  }

  getViewportRect(): DOMRect {
    return clientRect(this.viewport);
  }

  subscribe(listener: () => void): () => void {
    this.proxy.addEventListener("scroll", listener, { passive: true });
    return () => this.proxy.removeEventListener("scroll", listener);
  }

  getElement(): HTMLElement {
    return this.proxy;
  }
}

function horizontalScrollOwnerForTable(
  table: HTMLTableElement,
): TableHorizontalScrollOwner | null {
  if (!__MM_EDITOR_PERFORMANCE_BENCHMARK__) return null;
  const wrapper = table.closest<HTMLElement>(".mm-table-scroll");
  const proxy = wrapper?.querySelector<HTMLElement>(
    ":scope > .mm-table-scrollbar-proxy[data-mm-benchmark-scroll-proxy]",
  );
  const viewport = wrapper?.querySelector<HTMLElement>(
    ":scope > .mm-table-viewport[data-mm-benchmark-table-viewport]",
  );
  if (proxy && viewport) return new ProxyTableScrollOwner(proxy, viewport);
  if (wrapper) {
    const style = getComputedStyle(wrapper);
    if (style.overflowX === "auto" || style.overflowX === "scroll")
      return new NativeTableScrollOwner(wrapper, wrapper);
  }
  const tableStyle = getComputedStyle(table);
  if (tableStyle.overflowX === "auto" || tableStyle.overflowX === "scroll")
    return new NativeTableScrollOwner(table, table);
  return null;
}

export interface TableControlsCallbacks {
  canEdit: () => boolean;
  onHoverTable: (table: HTMLTableElement | null) => void;
  onSelect: (
    selection: TableControlSelection,
    target: TableControlTarget,
  ) => void;
  onInsert: (
    axis: TableControlAxis,
    boundary: number,
    target: TableControlTarget,
  ) => void;
  onAppend: (axis: TableControlAxis, target: TableControlTarget) => void;
  onMove: (
    selection: TableControlSelection,
    boundary: number,
    target: TableControlTarget,
  ) => void;
  canMove: (
    selection: TableControlSelection,
    boundary: number,
    target: TableControlTarget,
  ) => boolean;
  canInsert: (
    axis: TableControlAxis,
    boundary: number,
    target: TableControlTarget,
  ) => boolean;
  onDelete: (
    selection: TableControlSelection,
    target: TableControlTarget,
  ) => void;
  onEscape: () => void;
}

interface Layout {
  tableRect: DOMRect;
  gridRect: RectLike;
  visibleGridRect: RectLike;
  controlClipRect: RectLike;
  stageRect: DOMRect;
  cellRects: RectLike[][];
  rowBoundaries: number[];
  columnBoundaries: number[];
  scrollLeft: number;
  scrollTop: number;
}

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type DragDropState = "invalid" | "no-change" | "valid";

interface DragState {
  pointerId: number;
  selection: TableControlSelection;
  target: TableControlTarget;
  source: HTMLButtonElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  boundary: number | null;
  dropState: DragDropState;
}

const DRAG_THRESHOLD = 6;
const EDGE_SCROLL_DISTANCE = 42;
const EDGE_SCROLL_STEP = 22;
const INSERT_BOUNDARY_DISTANCE = 12;
const PREVIEW_OFFSET = 14;
const PREVIEW_MAX_TEXT_LENGTH = 42;
const PREVIEW_MAX_VALUES = 4;
const DROP_FLASH_DURATION = 520;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function clientRect(element: Element): DOMRect {
  return element.getBoundingClientRect();
}

function rectLike(value: DOMRect | RectLike): RectLike {
  return {
    left: value.left,
    top: value.top,
    right: value.right,
    bottom: value.bottom,
  };
}

function rectWidth(value: RectLike): number {
  return Math.max(0, value.right - value.left);
}

function rectHeight(value: RectLike): number {
  return Math.max(0, value.bottom - value.top);
}

function hasRectArea(value: RectLike): boolean {
  return rectWidth(value) > 0 && rectHeight(value) > 0;
}

function rectsOverlap(first: RectLike, second: RectLike): boolean {
  return !(
    first.right <= second.left ||
    first.left >= second.right ||
    first.bottom <= second.top ||
    first.top >= second.bottom
  );
}

function pointInRect(x: number, y: number, rect: RectLike): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function unionRect(rects: RectLike[]): RectLike | null {
  const measured = rects.filter(
    (rect) =>
      finite(rect.left) &&
      finite(rect.top) &&
      finite(rect.right) &&
      finite(rect.bottom) &&
      rect.right >= rect.left &&
      rect.bottom >= rect.top,
  );
  if (measured.length === 0) return null;
  return {
    left: Math.min(...measured.map((rect) => rect.left)),
    top: Math.min(...measured.map((rect) => rect.top)),
    right: Math.max(...measured.map((rect) => rect.right)),
    bottom: Math.max(...measured.map((rect) => rect.bottom)),
  };
}

function intersectRect(first: RectLike, second: RectLike): RectLike | null {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  if (right < left || bottom < top) return null;
  return { left, top, right, bottom };
}

function nearestBoundaryWithin(
  boundaries: number[],
  value: number,
  distance: number,
): number | null {
  const boundary = nearestBoundary(boundaries, value);
  if (boundary === null || Math.abs(boundaries[boundary]! - value) > distance)
    return null;
  return boundary;
}

function intervalAt(boundaries: number[], value: number): number | null {
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start === undefined || end === undefined) continue;
    if (value >= start && value <= end) return index;
  }
  return null;
}

function selectionKey(selection: TableControlSelection): string {
  return `${selection.axis}:${selection.index}`;
}

function setBox(
  element: HTMLElement,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
  element.style.width = `${Math.max(0, Math.round(width))}px`;
  element.style.height = `${Math.max(0, Math.round(height))}px`;
}

function nearestBoundary(boundaries: number[], value: number): number | null {
  let nearest = -1;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    if (boundary === undefined || !finite(boundary)) continue;
    const currentDistance = Math.abs(boundary - value);
    if (currentDistance < distance) {
      nearest = index;
      distance = currentDistance;
    }
  }
  return nearest < 0 ? null : nearest;
}

function completeBoundaries(
  measured: Array<number | undefined>,
  start: number,
  end: number,
): number[] {
  const result = measured.slice();
  result[0] ??= start;
  result[result.length - 1] ??= end;
  for (let index = 0; index < result.length; index += 1) {
    if (result[index] !== undefined) continue;
    let previous = index - 1;
    while (previous >= 0 && result[previous] === undefined) previous -= 1;
    let next = index + 1;
    while (next < result.length && result[next] === undefined) next += 1;
    const previousValue = result[previous];
    const nextValue = result[next];
    if (previousValue !== undefined && nextValue !== undefined) {
      result[index] =
        previousValue +
        ((nextValue - previousValue) * (index - previous)) / (next - previous);
    }
  }
  const fallbackStep = (end - start) / Math.max(1, result.length - 1);
  return result.map((value, index) =>
    value === undefined || !finite(value)
      ? start + fallbackStep * index
      : value,
  );
}

/**
 * DOM-only controller for the editing rails around a table.
 *
 * The controller never changes the ProseMirror document. It owns only a
 * small, persistent set of buttons and transient drag geometry; the editor
 * callback decides when a validated transaction should be committed.
 */
export class TableControls {
  readonly element: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly callbacks: TableControlsCallbacks;
  private target: TableControlTarget | null = null;
  private layout: Layout | null = null;
  private rowHandles: HTMLButtonElement[] = [];
  private columnHandles: HTMLButtonElement[] = [];
  private rowInsert!: HTMLButtonElement;
  private columnInsert!: HTMLButtonElement;
  private rowInsertLine!: HTMLElement;
  private columnInsertLine!: HTMLElement;
  private rowAppend!: HTMLButtonElement;
  private columnAppend!: HTMLButtonElement;
  private drag: DragState | null = null;
  private autoScrollFrame: number | undefined;
  private layoutFrame: {
    id: number;
    kind: "animation" | "timeout";
  } | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window | null;
  private rowRovingIndex: number | null = null;
  private columnRovingIndex: number | null = null;
  private canceledClickSource: HTMLButtonElement | null = null;
  private highlightLayer!: HTMLElement;
  private presentationLayer!: HTMLElement;
  private handleLayer!: HTMLElement;
  private rowHighlight!: HTMLElement;
  private columnHighlight!: HTMLElement;
  private dragOriginHighlight!: HTMLElement;
  private moveIndicator!: HTMLElement;
  private dragPreview: HTMLElement | null = null;
  private dragPreviewDestination: HTMLElement | null = null;
  private hoveredSelection: TableControlSelection | null = null;
  private focusedSelection: TableControlSelection | null = null;
  private flashedSelection: TableControlSelection | null = null;
  private flashedTable: HTMLTableElement | null = null;
  private flashedTablePos: number | null = null;
  private flashedDocumentGeneration: number | null = null;
  private flashTimer: number | undefined;
  private scrollContainers: HTMLElement[] = [];
  private horizontalScrollOwner: TableHorizontalScrollOwner | null = null;
  private horizontalScrollOwnerUnsubscribe: (() => void) | null = null;
  private destroyed = false;
  private focused = false;

  private readonly scroll = (): void => {
    if (this.destroyed) return;
    if (
      __MM_EDITOR_PERFORMANCE_BENCHMARK__ &&
      this.horizontalScrollOwner instanceof ProxyTableScrollOwner
    )
      this.updateLayout();
    else this.requestLayout();
    if (this.drag) this.updateDragPresentation();
    else this.updatePointerPresentationFromStoredPointer();
  };

  private readonly stagePointerMove = (event: PointerEvent): void => {
    if (this.destroyed) return;
    if (this.drag) {
      this.handleDragMove(event);
      return;
    }
    this.storedPointerX = event.clientX;
    this.storedPointerY = event.clientY;
    const target = event.target;
    const handleTarget =
      target instanceof Element
        ? target.closest<HTMLButtonElement>('[data-table-control$="-handle"]')
        : null;
    if (
      handleTarget &&
      this.element.contains(handleTarget) &&
      handleTarget.dataset.axis &&
      handleTarget.dataset.index
    ) {
      this.setHoveredSelection({
        axis: handleTarget.dataset.axis as TableControlAxis,
        index: Number(handleTarget.dataset.index),
      });
      return;
    }
    if (target instanceof Node && this.element.contains(target)) return;
    const tableFromEvent =
      target instanceof Element
        ? target.closest<HTMLTableElement>("table")
        : null;
    const table =
      tableFromEvent ??
      (this.target &&
      (this.pointNearTargetTable("row", event.clientX, event.clientY) ||
        this.pointNearTargetTable("column", event.clientX, event.clientY))
        ? this.target.tableElement
        : null);
    this.callbacks.onHoverTable(table);
    if (table && this.target?.tableElement === table) {
      this.updatePointerPresentation(event.clientX, event.clientY);
    } else {
      this.hideInsertButtons();
      this.clearTransientPresentation();
    }
  };

  private readonly stagePointerLeave = (): void => {
    if (this.drag || this.focused) return;
    this.hideInsertButtons();
    this.hoveredSelection = null;
    this.clearTransientPresentation();
    this.callbacks.onHoverTable(null);
  };

  private readonly stagePointerCancel = (): void => {
    if (this.drag) this.cancelDrag();
  };

  private readonly stagePointerUp = (event: PointerEvent): void => {
    if (this.drag) this.finishDrag(event);
  };

  private readonly windowBlur = (): void => {
    if (this.drag) this.cancelDrag();
    else this.clearCanceledClickSuppression();
  };

  private readonly ownerDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.drag || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelDrag(false, true);
    this.callbacks.onEscape();
  };

  private readonly ownerDocumentPointerUp = (): void => {
    const source = this.canceledClickSource;
    if (!source) return;
    this.canceledClickSource = null;
    const clear = (): void => {
      if (source.dataset.suppressClick === "true")
        delete source.dataset.suppressClick;
    };
    this.ownerWindow?.setTimeout(clear, 0) ?? clear();
  };

  private readonly focusIn = (): void => {
    this.focused = true;
    this.updatePresentation();
  };

  private readonly focusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    this.focused = next instanceof Node && this.element.contains(next);
    if (!this.focused && !this.drag) {
      this.hideInsertButtons();
      this.focusedSelection = null;
      this.updatePresentation();
      this.callbacks.onHoverTable(null);
    }
  };

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (!this.target || !this.callbacks.canEdit()) return;
    if (event.key === "Escape") {
      if (!this.drag && !this.target.selection) return;
      event.preventDefault();
      this.cancelDrag(false);
      this.callbacks.onEscape();
      return;
    }
    const selected = this.target.selection;
    if (!selected) {
      this.moveRovingFocus(event);
      return;
    }
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      this.callbacks.onDelete(selected, this.target);
      return;
    }
    const direction =
      selected.axis === "row"
        ? event.key === "ArrowUp"
          ? -1
          : event.key === "ArrowDown"
            ? 1
            : 0
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowRight"
            ? 1
            : 0;
    if (direction === 0) return;
    event.preventDefault();
    const boundary = selected.index + (direction > 0 ? 2 : -1);
    this.callbacks.onMove(selected, boundary, this.target);
  };

  constructor(stage: HTMLElement, callbacks: TableControlsCallbacks) {
    this.stage = stage;
    this.callbacks = callbacks;
    this.ownerDocument = stage.ownerDocument;
    this.ownerWindow = stage.ownerDocument.defaultView;
    this.element = stage.ownerDocument.createElement("div");
    this.element.className = "mm-table-controls";
    this.element.setAttribute("aria-label", "Table controls");
    this.element.setAttribute("aria-hidden", "true");
    this.element.hidden = true;
    stage.append(this.element);
    const ResizeObserverCtor = stage.ownerDocument.defaultView?.ResizeObserver;
    const benchmarkControlsDisabled =
      __MM_EDITOR_PERFORMANCE_BENCHMARK__ &&
      tableControlsDisabledForBenchmark();
    this.resizeObserver =
      !benchmarkControlsDisabled && ResizeObserverCtor
        ? new ResizeObserverCtor(() => this.requestLayout())
        : null;
    if (benchmarkControlsDisabled) return;
    this.resizeObserver?.observe(stage);
    stage.addEventListener("pointermove", this.stagePointerMove);
    stage.addEventListener("pointerleave", this.stagePointerLeave);
    stage.addEventListener("pointercancel", this.stagePointerCancel);
    stage.addEventListener("pointerup", this.stagePointerUp);
    this.ownerWindow?.addEventListener("blur", this.windowBlur);
    this.ownerDocument.addEventListener(
      "keydown",
      this.ownerDocumentKeyDown,
      true,
    );
    this.ownerDocument.addEventListener(
      "pointerup",
      this.ownerDocumentPointerUp,
    );
    this.element.addEventListener("focusin", this.focusIn);
    this.element.addEventListener("focusout", this.focusOut);
    this.element.addEventListener("keydown", this.keyDown);
  }

  /** Update the one table whose controls are currently allowed to be shown. */
  update(target: TableControlTarget | null): void {
    if (this.destroyed) return;
    if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
      if (tableControlsDisabledForBenchmark()) return;
      measureEditorPerformance("tableControls.update", () =>
        this.updateInternal(target),
      );
      return;
    }
    this.updateInternal(target);
  }

  private updateInternal(target: TableControlTarget | null): void {
    if (this.destroyed) return;
    if (!target || !this.callbacks.canEdit()) {
      this.clear();
      return;
    }
    const previous = this.target;
    const targetChanged =
      !previous ||
      previous.tableElement !== target.tableElement ||
      previous.tablePos !== target.tablePos ||
      previous.table !== target.table ||
      previous.document !== target.document ||
      previous.documentGeneration !== target.documentGeneration;
    const structureChanged =
      !previous ||
      previous.tableElement !== target.tableElement ||
      previous.table.childCount !== target.table.childCount ||
      previous.table.firstChild?.childCount !==
        target.table.firstChild?.childCount ||
      previous.numbered !== target.numbered ||
      previous.supported !== target.supported;
    if (targetChanged && this.drag) this.cancelDrag(false);
    if (targetChanged) this.clearFlashState();
    this.target = target;
    this.element.hidden = false;
    this.element.setAttribute("aria-hidden", "false");
    if (structureChanged) {
      this.layout = null;
      this.renderTarget();
      this.resizeObserver?.disconnect();
      this.resizeObserver?.observe(this.stage);
      this.resizeObserver?.observe(target.tableElement);
      this.refreshScrollContainers();
      this.updateSelectionState();
      this.updateLayout();
      return;
    }
    this.updateSelectionState();
    if (!this.layout || !hasRectArea(this.layout.gridRect)) {
      this.updateLayout();
      return;
    }
    if (targetChanged) this.requestLayout();
  }

  clear(): void {
    this.cancelDrag(false);
    this.cancelScheduledLayout();
    this.target = null;
    this.layout = null;
    this.resizeObserver?.disconnect();
    this.removeScrollListeners();
    this.hideInsertButtons();
    this.clearTransientPresentation();
    this.hoveredSelection = null;
    this.focusedSelection = null;
    this.clearFlashState();
    this.element.hidden = true;
    this.element.setAttribute("aria-hidden", "true");
  }

  focusFirst(): void {
    if (!this.target || this.element.hidden) return;
    const selected = this.target.selection;
    const button =
      (selected ? this.handleForSelection(selected) : undefined) ??
      this.rowHandles[0] ??
      this.columnHandles[0];
    if (button) {
      button.hidden = false;
      button.focus();
    }
  }

  updateLayout(): void {
    if (
      __MM_EDITOR_PERFORMANCE_BENCHMARK__ &&
      tableControlsDisabledForBenchmark()
    )
      return;
    this.cancelScheduledLayout();
    this.measureLayout();
  }

  /** Request one layout measurement on the next animation frame. */
  requestLayout(): void {
    if (
      this.destroyed ||
      (__MM_EDITOR_PERFORMANCE_BENCHMARK__ &&
        tableControlsDisabledForBenchmark()) ||
      !this.target ||
      this.element.hidden ||
      this.layoutFrame !== null
    )
      return;
    const measure = (): void => {
      this.layoutFrame = null;
      this.measureLayout();
    };
    if (this.ownerWindow?.requestAnimationFrame) {
      this.layoutFrame = {
        id: this.ownerWindow.requestAnimationFrame(measure),
        kind: "animation",
      };
    } else if (this.ownerWindow) {
      this.layoutFrame = {
        id: this.ownerWindow.setTimeout(measure, 16),
        kind: "timeout",
      };
    } else {
      measure();
    }
  }

  private cancelScheduledLayout(): void {
    const scheduled = this.layoutFrame;
    if (!scheduled) return;
    if (scheduled.kind === "animation")
      this.ownerWindow?.cancelAnimationFrame(scheduled.id);
    else this.ownerWindow?.clearTimeout(scheduled.id);
    this.layoutFrame = null;
  }

  private measureLayout(): void {
    if (!this.target || this.element.hidden) return;
    if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
      measureEditorPerformance("tableControls.measureLayout", () =>
        this.measureLayoutInternal(),
      );
      return;
    }
    this.measureLayoutInternal();
  }

  private measureLayoutInternal(): void {
    if (!this.target || this.element.hidden) return;
    const now = (): number => this.ownerWindow?.performance.now() ?? Date.now();
    const recordSegment = (name: string, startedAt: number): void => {
      recordEditorPerformanceDuration(name, now() - startedAt);
    };
    let getBoundingClientRectCalls = 0;
    let rowsMeasured = 0;
    let cellsMeasured = 0;
    const measureClientRect = __MM_EDITOR_PERFORMANCE_BENCHMARK__
      ? (element: Element): DOMRect => {
          getBoundingClientRectCalls += 1;
          return clientRect(element);
        }
      : clientRect;
    let segmentStartedAt = __MM_EDITOR_PERFORMANCE_BENCHMARK__ ? now() : 0;
    const tableRect = __MM_EDITOR_PERFORMANCE_BENCHMARK__
      ? measureClientRect(this.target.tableElement)
      : clientRect(this.target.tableElement);
    const stageRect = __MM_EDITOR_PERFORMANCE_BENCHMARK__
      ? measureClientRect(this.stage)
      : clientRect(this.stage);
    if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
      recordSegment(
        "tableControls.measureLayout.tableAndStageRect",
        segmentStartedAt,
      );
      segmentStartedAt = now();
    }
    const rows = Array.from(this.target.tableElement.rows);
    const height = this.target.table.childCount;
    const width = this.target.table.firstChild?.childCount ?? 0;
    const columnRects: Array<RectLike[]> = Array.from(
      { length: width },
      () => [],
    );
    const allCellRects: RectLike[] = [];
    const cellRects: RectLike[][] = [];
    const rowMeasured: Array<number | undefined> = Array.from(
      { length: height + 1 },
      () => undefined,
    );
    rows.slice(0, height).forEach((row, rowIndex) => {
      if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) rowsMeasured += 1;
      const cells = Array.from(row.cells).slice(0, width);
      if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) cellsMeasured += cells.length;
      const measuredCells = cells.map((cell) =>
        rectLike(
          __MM_EDITOR_PERFORMANCE_BENCHMARK__
            ? measureClientRect(cell)
            : clientRect(cell),
        ),
      );
      cellRects[rowIndex] = measuredCells;
      const rowRect =
        unionRect(measuredCells) ??
        rectLike(
          __MM_EDITOR_PERFORMANCE_BENCHMARK__
            ? measureClientRect(row)
            : clientRect(row),
        );
      if (rowRect) {
        rowMeasured[rowIndex] = rowRect.top;
        rowMeasured[rowIndex + 1] = rowRect.bottom;
        allCellRects.push(...measuredCells);
      }
      measuredCells.forEach((rect, columnIndex) => {
        if (columnRects[columnIndex]) columnRects[columnIndex]!.push(rect);
      });
    });
    if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
      recordSegment(
        "tableControls.measureLayout.cellRectCollection",
        segmentStartedAt,
      );
      segmentStartedAt = now();
    }
    const columnMeasured: Array<number | undefined> = Array.from(
      { length: width + 1 },
      () => undefined,
    );
    columnRects.forEach((rects, index) => {
      const rect = unionRect(rects);
      if (!rect) return;
      columnMeasured[index] = rect.left;
      columnMeasured[index + 1] = rect.right;
    });
    const gridRect = unionRect(allCellRects) ?? rectLike(tableRect);
    const controlClipRect = this.measureControlClip(
      stageRect,
      __MM_EDITOR_PERFORMANCE_BENCHMARK__ ? measureClientRect : clientRect,
    );
    const visibleGridRect = intersectRect(
      intersectRect(gridRect, rectLike(tableRect)) ?? gridRect,
      controlClipRect,
    ) ?? {
      left: gridRect.left,
      top: gridRect.top,
      right: gridRect.left,
      bottom: gridRect.top,
    };
    const rowBoundaries = completeBoundaries(
      rowMeasured,
      gridRect.top,
      gridRect.bottom,
    );
    const columnBoundaries = completeBoundaries(
      columnMeasured,
      gridRect.left,
      gridRect.right,
    );
    this.layout = {
      tableRect,
      gridRect,
      visibleGridRect,
      controlClipRect,
      stageRect,
      cellRects,
      rowBoundaries,
      columnBoundaries,
      scrollLeft: this.stage.scrollLeft,
      scrollTop: this.stage.scrollTop,
    };
    if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
      recordSegment(
        "tableControls.measureLayout.boundaryCalculation",
        segmentStartedAt,
      );
      segmentStartedAt = now();
    }
    const localX = (client: number): number =>
      client - stageRect.left + this.stage.scrollLeft;
    const localY = (client: number): number =>
      client - stageRect.top + this.stage.scrollTop;
    const localRect = (rect: RectLike): RectLike => ({
      left: localX(rect.left),
      top: localY(rect.top),
      right: localX(rect.right),
      bottom: localY(rect.bottom),
    });
    const grid = localRect(gridRect);
    const visibleGrid = localRect(visibleGridRect);
    const tableLeft = localX(tableRect.left);
    const tableTop = localY(tableRect.top);
    const proxyViewportLeft =
      this.horizontalScrollOwner instanceof ProxyTableScrollOwner
        ? localX(this.horizontalScrollOwner.getViewportRect().left)
        : tableLeft;
    const rowHandleLeft =
      this.horizontalScrollOwner instanceof ProxyTableScrollOwner &&
      __MM_EDITOR_PERFORMANCE_BENCHMARK__
        ? Math.max(localX(stageRect.left) + 4, proxyViewportLeft - 30)
        : tableLeft - 30;
    this.rowHandles.forEach((button) => {
      const index = Number(button.dataset.index);
      const top = localY(rowBoundaries[index] ?? gridRect.top);
      const bottom = localY(rowBoundaries[index + 1] ?? gridRect.bottom);
      setBox(button, rowHandleLeft, (top + bottom) / 2 - 12, 24, 24);
    });
    this.columnHandles.forEach((button) => {
      const index = Number(button.dataset.index);
      const left = localX(columnBoundaries[index] ?? gridRect.left);
      const right = localX(columnBoundaries[index + 1] ?? gridRect.right);
      setBox(button, (left + right) / 2 - 12, tableTop - 30, 24, 24);
    });
    setBox(
      this.rowInsert,
      localX(visibleGridRect.left) - 30,
      localY(visibleGridRect.top) - 12,
      24,
      24,
    );
    setBox(
      this.columnInsert,
      localX(visibleGridRect.left) - 12,
      localY(visibleGridRect.top) - 30,
      24,
      24,
    );
    setBox(
      this.rowInsertLine,
      visibleGrid.left,
      visibleGrid.top,
      rectWidth(visibleGrid),
      2,
    );
    setBox(
      this.columnInsertLine,
      visibleGrid.left,
      visibleGrid.top,
      2,
      rectHeight(visibleGrid),
    );
    setBox(this.rowAppend, grid.left, grid.bottom + 3, 24, 24);
    setBox(this.columnAppend, grid.right + 3, grid.top, 24, 24);
    if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
      recordSegment(
        "tableControls.measureLayout.controlPositioning",
        segmentStartedAt,
      );
      segmentStartedAt = now();
    }
    if (!this.drag) this.updatePointerPresentationFromStoredPointer();
    else this.updateDragPresentation();
    this.updatePresentation();
    if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
      recordSegment(
        "tableControls.measureLayout.presentationUpdate",
        segmentStartedAt,
      );
      recordEditorPerformanceCount(
        "tableControls.measureLayout.rowsMeasured",
        rowsMeasured,
      );
      recordEditorPerformanceCount(
        "tableControls.measureLayout.cellsMeasured",
        cellsMeasured,
      );
      recordEditorPerformanceCount(
        "tableControls.measureLayout.getBoundingClientRectCalls",
        getBoundingClientRectCalls,
      );
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelDrag(false);
    this.cancelScheduledLayout();
    this.stopAutoScroll();
    this.resizeObserver?.disconnect();
    this.stage.removeEventListener("pointermove", this.stagePointerMove);
    this.stage.removeEventListener("pointerleave", this.stagePointerLeave);
    this.stage.removeEventListener("pointercancel", this.stagePointerCancel);
    this.stage.removeEventListener("pointerup", this.stagePointerUp);
    this.ownerWindow?.removeEventListener("blur", this.windowBlur);
    this.ownerDocument.removeEventListener(
      "keydown",
      this.ownerDocumentKeyDown,
      true,
    );
    this.ownerDocument.removeEventListener(
      "pointerup",
      this.ownerDocumentPointerUp,
    );
    this.clearCanceledClickSuppression();
    this.element.removeEventListener("focusin", this.focusIn);
    this.element.removeEventListener("focusout", this.focusOut);
    this.element.removeEventListener("keydown", this.keyDown);
    this.removeScrollListeners();
    if (this.flashTimer !== undefined) {
      this.ownerWindow?.clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    this.flashedSelection = null;
    this.flashedTable = null;
    this.flashedTablePos = null;
    this.flashedDocumentGeneration = null;
    this.removeDragPreview();
    this.element.remove();
  }

  private renderTarget(): void {
    if (!this.target) return;
    if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
      measureEditorPerformance("tableControls.renderTarget", () =>
        this.renderTargetInternal(),
      );
      recordEditorPerformanceCount(
        "tableControls.renderTarget.rowHandleCount",
        this.rowHandles.length,
      );
      recordEditorPerformanceCount(
        "tableControls.renderTarget.columnHandleCount",
        this.columnHandles.length,
      );
      return;
    }
    this.renderTargetInternal();
  }

  private renderTargetInternal(): void {
    if (!this.target) return;
    this.rowHandles = [];
    this.columnHandles = [];
    this.rowRovingIndex = null;
    this.columnRovingIndex = null;
    this.hoveredSelection = null;
    this.focusedSelection = null;
    this.element.replaceChildren();
    this.highlightLayer = this.makeLayer("mm-table-controls-highlights");
    this.presentationLayer = this.makeLayer("mm-table-controls-presentation");
    this.handleLayer = this.makeLayer("mm-table-controls-layer");
    this.element.append(
      this.highlightLayer,
      this.presentationLayer,
      this.handleLayer,
    );
    this.rowHighlight = this.makeHighlight("row");
    this.columnHighlight = this.makeHighlight("column");
    this.dragOriginHighlight = this.makeHighlight("drag-origin");
    this.rowHighlight.hidden = true;
    this.columnHighlight.hidden = true;
    this.dragOriginHighlight.hidden = true;
    this.highlightLayer.append(
      this.rowHighlight,
      this.columnHighlight,
      this.dragOriginHighlight,
    );
    this.moveIndicator = this.stage.ownerDocument.createElement("div");
    this.moveIndicator.className = "mm-table-move-indicator";
    this.moveIndicator.hidden = true;
    this.moveIndicator.setAttribute("aria-hidden", "true");
    this.presentationLayer.append(this.moveIndicator);

    const height = this.target.table.childCount;
    const width = this.target.table.firstChild?.childCount ?? 0;
    for (let row = 1; row < height; row += 1) {
      const handle = this.makeHandle("row", row, `Select row ${row}`);
      this.rowHandles.push(handle);
      this.handleLayer.append(handle);
    }
    for (
      let column = this.target.numbered ? 1 : 0;
      column < width;
      column += 1
    ) {
      const handle = this.makeHandle(
        "column",
        column,
        `Select column ${column + 1}`,
      );
      this.columnHandles.push(handle);
      this.handleLayer.append(handle);
    }

    this.rowInsert = this.makeInsertButton("row", "Insert row at boundary");
    this.columnInsert = this.makeInsertButton(
      "column",
      "Insert column at boundary",
    );
    this.rowInsertLine = this.makeLine("row");
    this.columnInsertLine = this.makeLine("column");
    this.rowAppend = this.makeAppendButton("row", "Add row at end");
    this.columnAppend = this.makeAppendButton("column", "Add column at end");
    this.handleLayer.append(
      this.rowInsertLine,
      this.columnInsertLine,
      this.rowInsert,
      this.columnInsert,
      this.rowAppend,
      this.columnAppend,
    );
    this.updateSelectionState();
  }

  private makeLayer(className: string): HTMLElement {
    const layer = this.stage.ownerDocument.createElement("div");
    layer.className = className;
    return layer;
  }

  private makeHighlight(axis: TableControlAxis | "drag-origin"): HTMLElement {
    const highlight = this.stage.ownerDocument.createElement("div");
    highlight.className = `mm-table-control-highlight mm-table-${axis}-highlight`;
    highlight.dataset.axis = axis;
    highlight.setAttribute("aria-hidden", "true");
    return highlight;
  }

  private makeHandle(
    axis: TableControlAxis,
    index: number,
    label: string,
  ): HTMLButtonElement {
    const button = this.stage.ownerDocument.createElement("button");
    button.type = "button";
    button.className = `mm-table-${axis}-handle`;
    button.dataset.tableControl = `${axis}-handle`;
    button.dataset.axis = axis;
    button.dataset.index = String(index);
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", "false");
    button.tabIndex = -1;
    button.hidden = true;
    button.disabled = !this.target?.supported || !this.callbacks.canEdit();
    appendToolbarIcon(button, "table-grip", undefined, {
      className: "mm-table-control-icon",
      size: 14,
    });
    button.addEventListener("pointerdown", (event) =>
      this.startDrag(event, button, { axis, index }),
    );
    button.addEventListener("pointerup", (event) => this.finishDrag(event));
    button.addEventListener("pointercancel", () => this.cancelDrag());
    button.addEventListener("lostpointercapture", () => {
      if (this.drag?.source === button) this.cancelDrag();
    });
    button.addEventListener("click", () => {
      if (button.dataset.suppressClick === "true") {
        delete button.dataset.suppressClick;
        return;
      }
      if (this.target && !button.disabled)
        this.callbacks.onSelect({ axis, index }, this.target);
    });
    button.addEventListener("focus", () => {
      if (axis === "row") this.rowRovingIndex = index;
      else this.columnRovingIndex = index;
      this.focusedSelection = { axis, index };
      this.updateSelectionState();
      this.updatePresentation();
    });
    return button;
  }

  private makeInsertButton(
    axis: TableControlAxis,
    label: string,
  ): HTMLButtonElement {
    const button = this.stage.ownerDocument.createElement("button");
    button.type = "button";
    button.className = `mm-table-${axis}-insert`;
    button.dataset.tableControl = `${axis}-insert`;
    button.setAttribute("aria-label", label);
    button.textContent = "+";
    button.hidden = true;
    button.tabIndex = -1;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const boundary = Number(button.dataset.boundary);
      if (this.target && Number.isInteger(boundary) && !button.disabled)
        this.callbacks.onInsert(axis, boundary, this.target);
    });
    return button;
  }

  private makeLine(axis: TableControlAxis): HTMLElement {
    const line = this.stage.ownerDocument.createElement("div");
    line.className = `mm-table-${axis}-insert-line`;
    line.hidden = true;
    line.setAttribute("aria-hidden", "true");
    return line;
  }

  private makeAppendButton(
    axis: TableControlAxis,
    label: string,
  ): HTMLButtonElement {
    const button = this.stage.ownerDocument.createElement("button");
    button.type = "button";
    button.className = `mm-table-${axis}-append`;
    button.dataset.tableControl = `${axis}-append`;
    button.setAttribute("aria-label", label);
    button.textContent = "+";
    button.hidden = true;
    button.tabIndex = -1;
    button.disabled = !this.target?.supported || !this.callbacks.canEdit();
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      if (this.target && !button.disabled)
        this.callbacks.onAppend(axis, this.target);
    });
    return button;
  }

  private updateSelectionState(): void {
    const selected = this.target?.selection ?? null;
    const updateAxis = (
      axis: TableControlAxis,
      buttons: HTMLButtonElement[],
    ): void => {
      const preferred =
        selected?.axis === axis
          ? selected.index
          : axis === "row"
            ? this.rowRovingIndex
            : this.columnRovingIndex;
      const activeButton =
        buttons.find((button) => Number(button.dataset.index) === preferred) ??
        buttons[0];
      const activeIndex = activeButton
        ? Number(activeButton.dataset.index)
        : null;
      if (axis === "row") this.rowRovingIndex = activeIndex;
      else this.columnRovingIndex = activeIndex;
      for (const button of buttons) {
        const index = Number(button.dataset.index);
        const selectedForButton =
          selected?.axis === axis && selected.index === index;
        button.classList.toggle("is-selected", selectedForButton);
        button.setAttribute("aria-pressed", String(selectedForButton));
        button.tabIndex = activeIndex === index ? 0 : -1;
      }
    };
    updateAxis("row", this.rowHandles);
    updateAxis("column", this.columnHandles);
    const supported = Boolean(
      this.target?.supported && this.callbacks.canEdit(),
    );
    for (const button of [
      ...this.rowHandles,
      ...this.columnHandles,
      this.rowAppend,
      this.columnAppend,
    ])
      if (button) button.disabled = !supported;
    if (this.rowInsert) this.rowInsert.disabled = !supported;
    if (this.columnInsert) this.columnInsert.disabled = !supported;
    this.updatePresentation();
  }

  private handleForSelection(
    selection: TableControlSelection,
  ): HTMLButtonElement | undefined {
    const buttons =
      selection.axis === "row" ? this.rowHandles : this.columnHandles;
    return buttons.find(
      (button) => Number(button.dataset.index) === selection.index,
    );
  }

  private moveRovingFocus(event: KeyboardEvent): void {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    )
      return;
    const button = event.target;
    if (!(button instanceof HTMLButtonElement)) return;
    const axis = button.dataset.axis;
    const direction =
      axis === "row"
        ? event.key === "ArrowUp"
          ? -1
          : event.key === "ArrowDown"
            ? 1
            : 0
        : axis === "column"
          ? event.key === "ArrowLeft"
            ? -1
            : event.key === "ArrowRight"
              ? 1
              : 0
          : 0;
    if (direction === 0) return;
    const handles = axis === "row" ? this.rowHandles : this.columnHandles;
    const currentIndex = handles.indexOf(button);
    if (currentIndex < 0) return;
    const nextIndex = Math.max(
      0,
      Math.min(handles.length - 1, currentIndex + direction),
    );
    event.preventDefault();
    const next = handles[nextIndex];
    if (!next || next === button) return;
    if (axis === "row") this.rowRovingIndex = Number(next.dataset.index);
    else this.columnRovingIndex = Number(next.dataset.index);
    next.hidden = false;
    next.focus();
  }

  private startDrag(
    event: PointerEvent,
    source: HTMLButtonElement,
    selection: TableControlSelection,
  ): void {
    if (!this.target || source.disabled || !this.callbacks.canEdit()) return;
    event.preventDefault();
    const target = this.target;
    this.drag = {
      pointerId: event.pointerId,
      selection,
      target,
      source,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      boundary: null,
      dropState: "invalid",
    };
    source.hidden = false;
    source.dataset.suppressClick = "true";
    try {
      source.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some embedded test surfaces. The
      // stage/window cancellation paths still prevent stale commits.
    }
  }

  private handleDragMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    const distance = Math.hypot(
      event.clientX - drag.startX,
      event.clientY - drag.startY,
    );
    if (!drag.moved && distance < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.source.classList.add("is-dragging");
      this.createDragPreview(drag);
    }
    this.updateDragPresentation();
    this.scheduleAutoScroll();
  }

  private finishDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    this.stopAutoScroll();
    if (drag.moved) {
      this.updateLayout();
      this.updateDragPresentation();
    }
    this.drag = null;
    drag.source.classList.remove("is-dragging");
    try {
      if (drag.source.hasPointerCapture(event.pointerId))
        drag.source.releasePointerCapture(event.pointerId);
    } catch {
      // Releasing an already-lost capture is harmless.
    }
    const canCommit =
      drag.moved &&
      drag.dropState === "valid" &&
      drag.boundary !== null &&
      this.callbacks.canMove(drag.selection, drag.boundary, drag.target);
    this.hideDropLine();
    if (!drag.moved) {
      if (!drag.source.disabled) {
        drag.source.focus();
        this.callbacks.onSelect(drag.selection, drag.target);
      }
      this.clearClickSuppression(drag.source);
      return;
    }
    // The native click follows pointerup. Keep the reused handle suppressed
    // until that click has had a chance to consume the flag, otherwise a
    // completed move can immediately reselect the old row/column.
    this.clearClickSuppression(drag.source, true);
    if (canCommit && drag.boundary !== null && this.callbacks.canEdit())
      this.callbacks.onMove(drag.selection, drag.boundary, drag.target);
    else this.callbacks.onEscape();
  }

  private cancelDrag(notify = true, preserveClickSuppression = false): void {
    const drag = this.drag;
    if (!drag) return;
    this.stopAutoScroll();
    this.drag = null;
    drag.source.classList.remove("is-dragging");
    this.hideDropLine();
    try {
      if (drag.source.hasPointerCapture(drag.pointerId))
        drag.source.releasePointerCapture(drag.pointerId);
    } catch {
      // The capture may have been lost before the cancellation notification.
    }
    if (preserveClickSuppression) {
      this.canceledClickSource = drag.source;
    } else {
      delete drag.source.dataset.suppressClick;
    }
    if (notify) this.callbacks.onEscape();
  }

  private clearCanceledClickSuppression(): void {
    const source = this.canceledClickSource;
    this.canceledClickSource = null;
    if (source?.dataset.suppressClick === "true")
      delete source.dataset.suppressClick;
  }

  private clearClickSuppression(
    source: HTMLButtonElement,
    waitForNativeClick = false,
  ): void {
    const clear = (): void => {
      if (source.dataset.suppressClick === "true")
        delete source.dataset.suppressClick;
    };
    if (waitForNativeClick) {
      this.ownerWindow?.setTimeout(clear, 0) ?? clear();
      return;
    }
    if (typeof queueMicrotask === "function") queueMicrotask(clear);
    else void Promise.resolve().then(clear);
  }

  private pointNearTargetTable(
    axis: TableControlAxis,
    clientX: number,
    clientY: number,
  ): boolean {
    const rect = this.layout?.visibleGridRect;
    if (!rect || !this.target) return false;
    if (axis === "row")
      return (
        clientX >= this.layout!.tableRect.left - 46 &&
        clientX <= this.layout!.tableRect.right + 12 &&
        clientY >= rect.top - 12 &&
        clientY <= rect.bottom + 12
      );
    return (
      clientX >= rect.left - 12 &&
      clientX <= rect.right + 12 &&
      clientY >= this.layout!.tableRect.top - 46 &&
      clientY <= this.layout!.tableRect.bottom + 12
    );
  }

  private boundaryAt(
    axis: TableControlAxis,
    clientX: number,
    clientY: number,
  ): number | null {
    if (!this.layout || !this.target) return null;
    const { tableRect, visibleGridRect, rowBoundaries, columnBoundaries } =
      this.layout;
    if (axis === "row") {
      if (
        clientX < tableRect.left - 46 ||
        clientX > tableRect.right + 12 ||
        clientY < visibleGridRect.top - 12 ||
        clientY > visibleGridRect.bottom + 12
      )
        return null;
      const boundary = nearestBoundary(rowBoundaries, clientY);
      return boundary !== null &&
        boundary >= 1 &&
        boundary <= rowBoundaries.length - 1
        ? boundary
        : null;
    }
    if (
      clientX < visibleGridRect.left - 12 ||
      clientX > visibleGridRect.right + 12 ||
      clientY < tableRect.top - 46 ||
      clientY > tableRect.bottom + 12
    )
      return null;
    const boundary = nearestBoundary(columnBoundaries, clientX);
    const minimum = this.target.numbered ? 1 : 0;
    return boundary !== null &&
      boundary >= minimum &&
      boundary <= columnBoundaries.length - 1
      ? boundary
      : null;
  }

  private updatePointerPresentation(clientX: number, clientY: number): void {
    if (!this.layout || !this.target || !this.target.supported) {
      this.hideInsertButtons();
      return;
    }
    const { tableRect, visibleGridRect, rowBoundaries, columnBoundaries } =
      this.layout;
    const nearLeftRail =
      clientX >= tableRect.left - 38 && clientX <= visibleGridRect.left + 10;
    const nearTopRail =
      clientY >= tableRect.top - 38 && clientY <= visibleGridRect.top + 10;
    const inGridX =
      clientX >= visibleGridRect.left - 4 &&
      clientX <= visibleGridRect.right + 4;
    const inGridY =
      clientY >= visibleGridRect.top - 4 &&
      clientY <= visibleGridRect.bottom + 4;

    this.hideInsertButtons(false);
    this.hoveredSelection = null;
    if (nearLeftRail && nearTopRail) {
      this.updatePresentation();
      return;
    }
    if (nearLeftRail && inGridY) {
      const rowBoundary = nearestBoundaryWithin(
        rowBoundaries,
        clientY,
        INSERT_BOUNDARY_DISTANCE,
      );
      if (
        rowBoundary !== null &&
        this.callbacks.canInsert("row", rowBoundary, this.target)
      ) {
        this.showInsertButton("row", rowBoundary);
      } else {
        const row = intervalAt(rowBoundaries, clientY);
        if (row !== null && row >= 1)
          this.hoveredSelection = { axis: "row", index: row };
      }
    } else if (nearTopRail && inGridX) {
      const columnBoundary = nearestBoundaryWithin(
        columnBoundaries,
        clientX,
        INSERT_BOUNDARY_DISTANCE,
      );
      if (
        columnBoundary !== null &&
        this.callbacks.canInsert("column", columnBoundary, this.target)
      ) {
        this.showInsertButton("column", columnBoundary);
      } else {
        const column = intervalAt(columnBoundaries, clientX);
        const minimum = this.target.numbered ? 1 : 0;
        if (column !== null && column >= minimum)
          this.hoveredSelection = { axis: "column", index: column };
      }
    } else {
      this.showAppendHover(clientX, clientY);
    }
    this.updatePresentation();
  }

  private storedPointerX: number | null = null;
  private storedPointerY: number | null = null;

  private updatePointerPresentationFromStoredPointer(): void {
    if (this.storedPointerX === null || this.storedPointerY === null) return;
    this.updatePointerPresentation(this.storedPointerX, this.storedPointerY);
  }

  private showInsertButton(
    axis: TableControlAxis,
    boundary: number | null,
  ): void {
    const button = axis === "row" ? this.rowInsert : this.columnInsert;
    const line = axis === "row" ? this.rowInsertLine : this.columnInsertLine;
    if (
      boundary === null ||
      !this.layout ||
      !this.target ||
      !this.callbacks.canInsert(axis, boundary, this.target)
    ) {
      button.hidden = true;
      line.hidden = true;
      return;
    }
    button.dataset.boundary = String(boundary);
    button.setAttribute(
      "aria-label",
      axis === "row"
        ? `Insert row at boundary ${boundary}`
        : `Insert column at boundary ${boundary}`,
    );
    button.hidden = false;
    line.hidden = false;
    if (this.layout) {
      const { stageRect, visibleGridRect, rowBoundaries, columnBoundaries } =
        this.layout;
      const localX = (client: number): number =>
        client - stageRect.left + this.stage.scrollLeft;
      const localY = (client: number): number =>
        client - stageRect.top + this.stage.scrollTop;
      if (axis === "row") {
        const y = localY(rowBoundaries[boundary] ?? visibleGridRect.top);
        line.style.top = `${Math.round(y - 1)}px`;
        line.style.left = `${Math.round(localX(visibleGridRect.left))}px`;
        line.style.width = `${Math.round(rectWidth(visibleGridRect))}px`;
        line.style.height = "2px";
        button.style.left = `${Math.round(localX(visibleGridRect.left) - 30)}px`;
        button.style.top = `${Math.round(y - 12)}px`;
      } else {
        const x = localX(columnBoundaries[boundary] ?? visibleGridRect.left);
        line.style.left = `${Math.round(x - 1)}px`;
        line.style.top = `${Math.round(localY(visibleGridRect.top))}px`;
        line.style.width = "2px";
        line.style.height = `${Math.round(rectHeight(visibleGridRect))}px`;
        button.style.left = `${Math.round(x - 12)}px`;
        button.style.top = `${Math.round(localY(visibleGridRect.top) - 30)}px`;
      }
    }
    this.rowAppend.hidden = true;
    this.columnAppend.hidden = true;
  }

  private hideInsertButton(axis: TableControlAxis): void {
    (axis === "row" ? this.rowInsert : this.columnInsert).hidden = true;
    (axis === "row" ? this.rowInsertLine : this.columnInsertLine).hidden = true;
  }

  private hideInsertButtons(clearPointer = true): void {
    if (this.rowInsert) this.hideInsertButton("row");
    if (this.columnInsert) this.hideInsertButton("column");
    if (this.rowAppend) this.rowAppend.hidden = true;
    if (this.columnAppend) this.columnAppend.hidden = true;
    if (clearPointer) {
      this.storedPointerX = null;
      this.storedPointerY = null;
    }
  }

  private showAppendHover(clientX: number, clientY: number): void {
    if (!this.layout || !this.target) return;
    const { gridRect, visibleGridRect } = this.layout;
    const nearBottom =
      clientY >= gridRect.bottom - 10 && clientY <= gridRect.bottom + 32;
    const nearRight =
      clientX >= gridRect.right - 10 && clientX <= gridRect.right + 32;
    if (
      nearBottom &&
      clientX >= visibleGridRect.left &&
      clientX <= visibleGridRect.right &&
      gridRect.bottom <= visibleGridRect.bottom + 1
    )
      this.rowAppend.hidden = false;
    if (
      nearRight &&
      clientY >= visibleGridRect.top &&
      clientY <= visibleGridRect.bottom &&
      gridRect.right <= visibleGridRect.right + 1
    )
      this.columnAppend.hidden = false;
  }

  private setHoveredSelection(selection: TableControlSelection | null): void {
    this.hoveredSelection = selection;
    this.hideInsertButtons(false);
    this.updatePresentation();
  }

  private selectionRect(selection: TableControlSelection): RectLike | null {
    if (!this.layout) return null;
    const { visibleGridRect } = this.layout;
    const cells =
      selection.axis === "row"
        ? (this.layout.cellRects[selection.index] ?? [])
        : this.layout.cellRects
            .map((row) => row[selection.index])
            .filter((rect): rect is RectLike => Boolean(rect));
    const raw = unionRect(cells);
    if (!raw) return null;
    return intersectRect(raw, visibleGridRect);
  }

  private setHighlight(
    element: HTMLElement,
    selection: TableControlSelection,
    state: string,
  ): void {
    const rect = this.selectionRect(selection);
    if (!rect || !this.layout || !hasRectArea(rect)) {
      element.hidden = true;
      return;
    }
    const local = {
      left: rect.left - this.layout.stageRect.left + this.stage.scrollLeft,
      top: rect.top - this.layout.stageRect.top + this.stage.scrollTop,
      right: rect.right - this.layout.stageRect.left + this.stage.scrollLeft,
      bottom: rect.bottom - this.layout.stageRect.top + this.stage.scrollTop,
    };
    setBox(element, local.left, local.top, rectWidth(local), rectHeight(local));
    element.dataset.state = state;
    element.dataset.axis = selection.axis;
    element.dataset.index = String(selection.index);
    element.hidden = false;
  }

  private updatePresentation(): void {
    if (!this.target || !this.layout || !this.handleLayer) return;
    const selected = this.target.selection ?? null;
    const flashed = this.flashMatchesTarget() ? this.flashedSelection : null;
    const flashingSelected = Boolean(
      flashed && selected && selectionKey(flashed) === selectionKey(selected),
    );
    const active =
      (flashingSelected ? flashed : null) ??
      selected ??
      this.focusedSelection ??
      this.hoveredSelection;
    const visibleSelections = new Set(
      [
        selected,
        flashingSelected ? flashed : null,
        this.focusedSelection,
        this.hoveredSelection,
      ]
        .filter((selection): selection is TableControlSelection =>
          Boolean(selection),
        )
        .map(selectionKey),
    );
    if (this.focused) {
      if (this.rowRovingIndex !== null)
        visibleSelections.add(
          selectionKey({ axis: "row", index: this.rowRovingIndex }),
        );
      if (this.columnRovingIndex !== null)
        visibleSelections.add(
          selectionKey({ axis: "column", index: this.columnRovingIndex }),
        );
    }
    const updateHandles = (
      axis: TableControlAxis,
      handles: HTMLButtonElement[],
    ): void => {
      for (const handle of handles) {
        const selection = {
          axis,
          index: Number(handle.dataset.index),
        } satisfies TableControlSelection;
        const key = selectionKey(selection);
        const isSource = this.drag?.source === handle;
        const shouldShow = Boolean(
          this.drag ? isSource : visibleSelections.has(key),
        );
        handle.hidden = !shouldShow;
        handle.classList.toggle(
          "is-hovered",
          this.hoveredSelection?.axis === axis &&
            this.hoveredSelection.index === selection.index,
        );
        handle.classList.toggle(
          "is-focused",
          this.focusedSelection?.axis === axis &&
            this.focusedSelection.index === selection.index,
        );
        if (this.drag && isSource) handle.dataset.state = "dragging";
        else if (selected && selectionKey(selected) === key)
          handle.dataset.state = "selected";
        else if (
          this.focusedSelection &&
          selectionKey(this.focusedSelection) === key
        )
          handle.dataset.state = "focus";
        else if (
          this.hoveredSelection &&
          selectionKey(this.hoveredSelection) === key
        )
          handle.dataset.state = "hover";
        else handle.dataset.state = "normal";
      }
    };
    updateHandles("row", this.rowHandles);
    updateHandles("column", this.columnHandles);

    this.rowHighlight.hidden = true;
    this.columnHighlight.hidden = true;
    if (this.drag) {
      this.setHighlight(
        this.dragOriginHighlight,
        this.drag.selection,
        "drag-origin",
      );
    } else {
      this.dragOriginHighlight.hidden = true;
      if (active) {
        const state = flashingSelected
          ? "drop-flash"
          : selected
            ? "selected"
            : this.focusedSelection
              ? "focus"
              : "hover";
        this.setHighlight(
          active.axis === "row" ? this.rowHighlight : this.columnHighlight,
          active,
          state,
        );
      }
    }
  }

  private updateDragPresentation(): void {
    const drag = this.drag;
    if (!drag || !this.layout || !this.target) return;
    this.hideInsertButtons(false);
    const overTable = this.pointNearTargetTable(
      drag.selection.axis,
      drag.lastX,
      drag.lastY,
    );
    drag.boundary = overTable
      ? this.boundaryAt(drag.selection.axis, drag.lastX, drag.lastY)
      : null;
    if (drag.boundary === null) drag.dropState = "invalid";
    else if (
      drag.boundary === drag.selection.index ||
      drag.boundary === drag.selection.index + 1
    )
      drag.dropState = "no-change";
    else if (this.callbacks.canMove(drag.selection, drag.boundary, drag.target))
      drag.dropState = "valid";
    else drag.dropState = "invalid";
    this.updatePresentation();
    this.updateMoveIndicator();
    this.updateDragPreview();
  }

  private updateMoveIndicator(): void {
    const drag = this.drag;
    if (
      !drag ||
      !this.layout ||
      !drag.moved ||
      drag.dropState !== "valid" ||
      drag.boundary === null
    ) {
      this.moveIndicator.hidden = true;
      this.setDragPreviewDestination(null);
      return;
    }
    const { stageRect, visibleGridRect, rowBoundaries, columnBoundaries } =
      this.layout;
    const localX = (value: number): number =>
      value - stageRect.left + this.stage.scrollLeft;
    const localY = (value: number): number =>
      value - stageRect.top + this.stage.scrollTop;
    const boundary =
      drag.selection.axis === "row"
        ? rowBoundaries[drag.boundary]
        : columnBoundaries[drag.boundary];
    if (boundary === undefined) {
      this.moveIndicator.hidden = true;
      this.setDragPreviewDestination(null);
      return;
    }
    this.moveIndicator.dataset.axis = drag.selection.axis;
    const finalIndex =
      drag.boundary > drag.selection.index ? drag.boundary - 1 : drag.boundary;
    const displayPosition =
      drag.selection.axis === "row" ? finalIndex : finalIndex + 1;
    this.setDragPreviewDestination(`Move to position ${displayPosition}`);
    if (drag.selection.axis === "row") {
      if (boundary < visibleGridRect.top || boundary > visibleGridRect.bottom) {
        this.moveIndicator.hidden = true;
        this.setDragPreviewDestination(null);
        return;
      }
      setBox(
        this.moveIndicator,
        localX(visibleGridRect.left),
        localY(boundary - 1),
        rectWidth(visibleGridRect),
        2,
      );
    } else {
      if (boundary < visibleGridRect.left || boundary > visibleGridRect.right) {
        this.moveIndicator.hidden = true;
        this.setDragPreviewDestination(null);
        return;
      }
      setBox(
        this.moveIndicator,
        localX(boundary - 1),
        localY(visibleGridRect.top),
        2,
        rectHeight(visibleGridRect),
      );
    }
    this.moveIndicator.hidden = false;
  }

  private createDragPreview(drag: DragState): void {
    this.removeDragPreview();
    const preview = this.stage.ownerDocument.createElement("div");
    preview.className = "mm-table-drag-preview";
    preview.dataset.axis = drag.selection.axis;
    preview.setAttribute("aria-hidden", "true");
    const title = this.stage.ownerDocument.createElement("div");
    title.className = "mm-table-drag-preview-title";
    title.textContent =
      drag.selection.axis === "row"
        ? `Row ${drag.selection.index}`
        : `Column ${drag.selection.index + 1}`;
    preview.append(title);
    const values = this.stage.ownerDocument.createElement("div");
    values.className = "mm-table-drag-preview-values";
    const rows = Array.from(drag.target.tableElement.rows);
    const rawValues: string[] = [];
    let omitted = false;
    if (drag.selection.axis === "row") {
      const row = rows[drag.selection.index];
      if (row) {
        const cells = Array.from(row.cells);
        omitted = cells.length > PREVIEW_MAX_VALUES;
        for (const cell of cells.slice(0, PREVIEW_MAX_VALUES))
          rawValues.push(cell.textContent ?? "");
      }
    } else {
      omitted = rows.length > PREVIEW_MAX_VALUES;
      for (const row of rows.slice(0, PREVIEW_MAX_VALUES))
        rawValues.push(row.cells[drag.selection.index]?.textContent ?? "");
    }
    for (const [index, value] of rawValues.entries()) {
      const item = this.stage.ownerDocument.createElement("div");
      item.className = "mm-table-drag-preview-item";
      const text = value.trim().replace(/\s+/g, " ");
      item.textContent =
        text.length > PREVIEW_MAX_TEXT_LENGTH
          ? `${text.slice(0, PREVIEW_MAX_TEXT_LENGTH - 1)}…`
          : text || "(empty)";
      if (!text) item.classList.add("is-empty");
      if (text.length > PREVIEW_MAX_TEXT_LENGTH)
        item.classList.add("is-excerpt");
      values.append(item);
      if (index === rawValues.length - 1 && omitted) {
        const marker = this.stage.ownerDocument.createElement("div");
        marker.className =
          "mm-table-drag-preview-item mm-table-drag-preview-item-excerpt";
        marker.textContent = "…";
        marker.setAttribute("aria-label", "More values omitted");
        values.append(marker);
      }
    }
    preview.append(values);
    const destination = this.stage.ownerDocument.createElement("div");
    destination.className = "mm-table-drag-preview-destination";
    destination.hidden = true;
    preview.append(destination);
    this.presentationLayer.append(preview);
    this.dragPreview = preview;
    this.dragPreviewDestination = destination;
  }

  private updateDragPreview(): void {
    if (!this.dragPreview || !this.layout || !this.drag) return;
    const { stageRect, controlClipRect, visibleGridRect } = this.layout;
    const localX = (value: number): number =>
      value - stageRect.left + this.stage.scrollLeft;
    const localY = (value: number): number =>
      value - stageRect.top + this.stage.scrollTop;
    const clip = {
      left: localX(controlClipRect.left),
      top: localY(controlClipRect.top),
      right: localX(controlClipRect.right),
      bottom: localY(controlClipRect.bottom),
    };
    const visibleGrid = {
      left: localX(visibleGridRect.left),
      top: localY(visibleGridRect.top),
      right: localX(visibleGridRect.right),
      bottom: localY(visibleGridRect.bottom),
    };
    const width = this.dragPreview.offsetWidth || 180;
    const height = this.dragPreview.offsetHeight || 96;
    const clamp = (value: number, start: number, end: number): number =>
      Math.max(start + 4, Math.min(value, Math.max(start + 4, end - 4)));
    const pointerLeft = localX(this.drag.lastX);
    const pointerTop = localY(this.drag.lastY);
    const candidateLocalRects = [
      { left: pointerLeft + PREVIEW_OFFSET, top: pointerTop + PREVIEW_OFFSET },
      {
        left: pointerLeft - width - PREVIEW_OFFSET,
        top: pointerTop + PREVIEW_OFFSET,
      },
      {
        left: pointerLeft + PREVIEW_OFFSET,
        top: pointerTop - height - PREVIEW_OFFSET,
      },
      {
        left: pointerLeft - width - PREVIEW_OFFSET,
        top: pointerTop - height - PREVIEW_OFFSET,
      },
      {
        left: visibleGrid.right + PREVIEW_OFFSET,
        top: visibleGrid.top + PREVIEW_OFFSET,
      },
      {
        left: visibleGrid.left - width - PREVIEW_OFFSET,
        top: visibleGrid.bottom - height - PREVIEW_OFFSET,
      },
      { left: clip.left + 4, top: clip.top + 4 },
      { left: clip.right - width - 4, top: clip.top + 4 },
      { left: clip.left + 4, top: clip.bottom - height - 4 },
      { left: clip.right - width - 4, top: clip.bottom - height - 4 },
    ].map((candidate) => ({
      left: clamp(candidate.left, clip.left, clip.right - width),
      top: clamp(candidate.top, clip.top, clip.bottom - height),
    }));
    const toClientRect = (candidate: {
      left: number;
      top: number;
    }): RectLike => ({
      left: stageRect.left - this.stage.scrollLeft + candidate.left,
      top: stageRect.top - this.stage.scrollTop + candidate.top,
      right: stageRect.left - this.stage.scrollLeft + candidate.left + width,
      bottom: stageRect.top - this.stage.scrollTop + candidate.top + height,
    });
    const line = this.moveIndicator.hidden
      ? null
      : rectLike(clientRect(this.moveIndicator));
    const pointerX = this.drag.lastX;
    const pointerY = this.drag.lastY;
    const safe = candidateLocalRects.find((candidate) => {
      const rect = toClientRect(candidate);
      return (
        !pointInRect(pointerX, pointerY, rect) &&
        (!line || !rectsOverlap(rect, line))
      );
    });
    const chosen = safe ?? candidateLocalRects[0]!;
    this.dragPreview.style.left = `${Math.round(chosen.left)}px`;
    this.dragPreview.style.top = `${Math.round(chosen.top)}px`;
  }

  private removeDragPreview(): void {
    this.dragPreview?.remove();
    this.dragPreview = null;
    this.dragPreviewDestination = null;
  }

  private clearTransientPresentation(): void {
    if (this.rowInsert) this.hideInsertButton("row");
    if (this.columnInsert) this.hideInsertButton("column");
    if (this.rowAppend) this.rowAppend.hidden = true;
    if (this.columnAppend) this.columnAppend.hidden = true;
    if (this.moveIndicator) this.moveIndicator.hidden = true;
    if (this.dragOriginHighlight) this.dragOriginHighlight.hidden = true;
    this.removeDragPreview();
    this.updatePresentation();
  }

  flashSelection(selection: TableControlSelection): void {
    if (this.destroyed || !this.target) return;
    this.clearFlashState();
    this.flashedSelection = selection;
    this.flashedTable = this.target.tableElement;
    this.flashedTablePos = this.target.tablePos;
    this.flashedDocumentGeneration = this.target.documentGeneration;
    this.updatePresentation();
    const clear = (): void => {
      this.clearFlashState();
      this.updatePresentation();
    };
    if (this.ownerWindow)
      this.flashTimer = this.ownerWindow.setTimeout(clear, DROP_FLASH_DURATION);
    else clear();
  }

  private flashMatchesTarget(): boolean {
    return Boolean(
      this.target &&
      this.flashedSelection &&
      this.flashedTable === this.target.tableElement &&
      this.flashedTablePos === this.target.tablePos &&
      this.flashedDocumentGeneration === this.target.documentGeneration,
    );
  }

  private clearFlashState(): void {
    if (this.flashTimer !== undefined) {
      this.ownerWindow?.clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    this.flashedSelection = null;
    this.flashedTable = null;
    this.flashedTablePos = null;
    this.flashedDocumentGeneration = null;
  }

  private setDragPreviewDestination(text: string | null): void {
    if (!this.dragPreviewDestination) return;
    this.dragPreviewDestination.hidden = text === null;
    this.dragPreviewDestination.textContent = text ?? "";
  }

  private measureControlClip(
    stageRect: DOMRect,
    measureClientRect: (element: Element) => DOMRect = clientRect,
  ): RectLike {
    let clip = rectLike(stageRect);
    let ancestor = this.stage.parentElement;
    const getStyle = this.ownerWindow?.getComputedStyle.bind(this.ownerWindow);
    while (ancestor) {
      const style = getStyle?.(ancestor);
      const overflow = `${style?.overflow ?? ""} ${style?.overflowX ?? ""} ${style?.overflowY ?? ""}`;
      if (
        overflow.includes("hidden") ||
        overflow.includes("clip") ||
        overflow.includes("scroll") ||
        overflow.includes("auto")
      ) {
        const next = intersectRect(clip, rectLike(measureClientRect(ancestor)));
        if (next) clip = next;
      }
      ancestor = ancestor.parentElement;
    }
    return clip;
  }

  private refreshScrollContainers(): void {
    this.removeScrollListeners();
    if (!this.target) return;
    const candidates: HTMLElement[] = [];
    const add = (element: HTMLElement | null): void => {
      if (element && !candidates.includes(element)) candidates.push(element);
    };
    this.horizontalScrollOwner = horizontalScrollOwnerForTable(
      this.target.tableElement,
    );
    this.horizontalScrollOwnerUnsubscribe =
      this.horizontalScrollOwner?.subscribe(this.scroll) ?? null;
    add(this.stage);
    add(this.target.tableElement);
    let ancestor = this.target.tableElement.parentElement;
    while (ancestor) {
      add(ancestor);
      ancestor = ancestor.parentElement;
    }
    add(this.horizontalScrollOwner?.getElement() ?? null);
    for (const element of candidates) {
      if (element === this.horizontalScrollOwner?.getElement()) {
        this.scrollContainers.push(element);
        continue;
      }
      const style = this.ownerWindow?.getComputedStyle(element);
      const overflow = `${style?.overflow ?? ""} ${style?.overflowX ?? ""} ${style?.overflowY ?? ""}`;
      const scrollable =
        element === this.stage ||
        element === this.target.tableElement ||
        overflow.includes("auto") ||
        overflow.includes("scroll") ||
        overflow.includes("hidden");
      if (!scrollable) continue;
      element.addEventListener("scroll", this.scroll, { passive: true });
      this.scrollContainers.push(element);
    }
    if (__MM_EDITOR_PERFORMANCE_BENCHMARK__) {
      this.element.dataset.mmBenchmarkScrollContainers = this.scrollContainers
        .map((element) => {
          if (element === this.stage) return "stage";
          if (element === this.target?.tableElement) return "table";
          if (element === this.horizontalScrollOwner?.getElement())
            return this.horizontalScrollOwner instanceof ProxyTableScrollOwner
              ? "proxy"
              : "scroll-owner";
          return (
            element.className?.toString?.() || element.tagName.toLowerCase()
          );
        })
        .join(",");
      recordEditorPerformanceCount(
        "tableControls.refreshScrollContainers.count",
        this.scrollContainers.length,
      );
    }
  }

  private removeScrollListeners(): void {
    for (const element of this.scrollContainers)
      element.removeEventListener("scroll", this.scroll);
    this.scrollContainers = [];
    this.horizontalScrollOwnerUnsubscribe?.();
    this.horizontalScrollOwnerUnsubscribe = null;
    this.horizontalScrollOwner = null;
  }

  private hideDropLine(): void {
    this.moveIndicator.hidden = true;
    this.removeDragPreview();
    this.dragOriginHighlight.hidden = true;
    this.hideInsertButtons();
    this.updatePresentation();
  }

  private scheduleAutoScroll(): void {
    if (this.autoScrollFrame !== undefined) return;
    const tick = (): void => {
      this.autoScrollFrame = undefined;
      const drag = this.drag;
      if (!drag || this.destroyed) return;
      let changed = false;
      let nearScrollableEdge = false;
      const owner = this.horizontalScrollOwner;
      if (owner) {
        const rect = owner.getViewportRect();
        const insideX = drag.lastX >= rect.left && drag.lastX <= rect.right;
        if (insideX && owner.getMaxScrollLeft() > 0) {
          if (drag.lastX < rect.left + EDGE_SCROLL_DISTANCE) {
            const before = owner.getScrollLeft();
            owner.scrollBy(-EDGE_SCROLL_STEP);
            changed ||= owner.getScrollLeft() !== before;
            nearScrollableEdge = true;
          } else if (drag.lastX > rect.right - EDGE_SCROLL_DISTANCE) {
            const before = owner.getScrollLeft();
            owner.scrollBy(EDGE_SCROLL_STEP);
            changed ||= owner.getScrollLeft() !== before;
            nearScrollableEdge = true;
          }
        }
      }
      for (const container of this.scrollContainers) {
        if (container === owner?.getElement()) continue;
        const rect = clientRect(container);
        const canScrollY =
          container.scrollHeight > container.clientHeight ||
          container === this.stage;
        const canScrollX =
          container.scrollWidth > container.clientWidth ||
          container === this.stage ||
          container === this.target?.tableElement;
        const insideY = drag.lastY >= rect.top && drag.lastY <= rect.bottom;
        const insideX = drag.lastX >= rect.left && drag.lastX <= rect.right;
        if (insideY && canScrollY) {
          if (drag.lastY < rect.top + EDGE_SCROLL_DISTANCE) {
            const before = container.scrollTop;
            container.scrollTop = Math.max(0, before - EDGE_SCROLL_STEP);
            changed ||= container.scrollTop !== before;
            nearScrollableEdge = true;
          } else if (drag.lastY > rect.bottom - EDGE_SCROLL_DISTANCE) {
            const before = container.scrollTop;
            container.scrollTop = before + EDGE_SCROLL_STEP;
            changed ||= container.scrollTop !== before;
            nearScrollableEdge = true;
          }
        }
        if (insideX && canScrollX) {
          if (drag.lastX < rect.left + EDGE_SCROLL_DISTANCE) {
            const before = container.scrollLeft;
            container.scrollLeft = Math.max(0, before - EDGE_SCROLL_STEP);
            changed ||= container.scrollLeft !== before;
            nearScrollableEdge = true;
          } else if (drag.lastX > rect.right - EDGE_SCROLL_DISTANCE) {
            const before = container.scrollLeft;
            container.scrollLeft = before + EDGE_SCROLL_STEP;
            changed ||= container.scrollLeft !== before;
            nearScrollableEdge = true;
          }
        }
      }
      if (changed) {
        this.updateLayout();
        this.updateDragPresentation();
      }
      if (nearScrollableEdge) this.scheduleAutoScroll();
    };
    if (this.ownerWindow?.requestAnimationFrame)
      this.autoScrollFrame = this.ownerWindow.requestAnimationFrame(tick);
    else this.autoScrollFrame = this.ownerWindow?.setTimeout(tick, 16) ?? 0;
  }

  private stopAutoScroll(): void {
    if (this.autoScrollFrame === undefined) return;
    if (this.ownerWindow?.cancelAnimationFrame)
      this.ownerWindow.cancelAnimationFrame(this.autoScrollFrame);
    else this.ownerWindow?.clearTimeout(this.autoScrollFrame);
    this.autoScrollFrame = undefined;
  }
}

export { DRAG_THRESHOLD as TABLE_DRAG_THRESHOLD };
