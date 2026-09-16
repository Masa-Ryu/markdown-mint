import type { Node as PMNode } from "prosemirror-model";

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
  onDelete: (
    selection: TableControlSelection,
    target: TableControlTarget,
  ) => void;
  onEscape: () => void;
}

interface Layout {
  tableRect: DOMRect;
  stageRect: DOMRect;
  rowBoundaries: number[];
  columnBoundaries: number[];
  scrollLeft: number;
  scrollTop: number;
}

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
}

const DRAG_THRESHOLD = 6;
const EDGE_SCROLL_DISTANCE = 42;
const EDGE_SCROLL_STEP = 22;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function clientRect(element: Element): DOMRect {
  return element.getBoundingClientRect();
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
  private readonly resizeObserver: ResizeObserver | null;
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window | null;
  private rowRovingIndex: number | null = null;
  private columnRovingIndex: number | null = null;
  private canceledClickSource: HTMLButtonElement | null = null;
  private destroyed = false;
  private focused = false;

  private readonly stagePointerMove = (event: PointerEvent): void => {
    if (this.destroyed) return;
    if (this.drag) {
      this.handleDragMove(event);
      return;
    }
    this.storedPointerX = event.clientX;
    this.storedPointerY = event.clientY;
    const target = event.target;
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
      this.updateInsertHover(event.clientX, event.clientY);
    } else {
      this.hideInsertButtons();
    }
  };

  private readonly stagePointerLeave = (): void => {
    if (this.drag || this.focused) return;
    this.hideInsertButtons();
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
  };

  private readonly focusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    this.focused = next instanceof Node && this.element.contains(next);
    if (!this.focused && !this.drag) {
      this.hideInsertButtons();
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
    this.resizeObserver = ResizeObserverCtor
      ? new ResizeObserverCtor(() => this.updateLayout())
      : null;
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
    if (!target || !this.callbacks.canEdit()) {
      this.clear();
      return;
    }
    const changed =
      !this.target ||
      this.target.tableElement !== target.tableElement ||
      this.target.tablePos !== target.tablePos ||
      this.target.table !== target.table ||
      this.target.document !== target.document ||
      this.target.documentGeneration !== target.documentGeneration ||
      this.target.table.childCount !== target.table.childCount ||
      this.target.table.firstChild?.childCount !==
        target.table.firstChild?.childCount ||
      this.target.numbered !== target.numbered ||
      this.target.supported !== target.supported;
    if (changed && this.drag) this.cancelDrag(false);
    this.target = target;
    if (changed) {
      this.renderTarget();
      this.resizeObserver?.disconnect();
      this.resizeObserver?.observe(this.stage);
      this.resizeObserver?.observe(target.tableElement);
    }
    this.element.hidden = false;
    this.element.setAttribute("aria-hidden", "false");
    this.updateSelectionState();
    this.updateLayout();
  }

  clear(): void {
    this.cancelDrag(false);
    this.target = null;
    this.layout = null;
    this.resizeObserver?.disconnect();
    this.hideInsertButtons();
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
    button?.focus();
  }

  updateLayout(): void {
    if (!this.target || this.element.hidden) return;
    const tableRect = clientRect(this.target.tableElement);
    const stageRect = clientRect(this.stage);
    const rows = Array.from(
      this.target.tableElement.querySelectorAll<HTMLTableRowElement>("tr"),
    );
    const height = this.target.table.childCount;
    const width = this.target.table.firstChild?.childCount ?? 0;
    const rowMeasured: Array<number | undefined> = Array.from(
      { length: height + 1 },
      () => undefined,
    );
    rows.slice(0, height).forEach((row, index) => {
      const rect = clientRect(row);
      if (finite(rect.top)) rowMeasured[index] = rect.top;
      if (finite(rect.bottom)) rowMeasured[index + 1] = rect.bottom;
    });
    const firstRowCells = rows[0]
      ? Array.from(
          rows[0].querySelectorAll<HTMLElement>(":scope > th, :scope > td"),
        )
      : [];
    const columnMeasured: Array<number | undefined> = Array.from(
      { length: width + 1 },
      () => undefined,
    );
    firstRowCells.slice(0, width).forEach((cell, index) => {
      const rect = clientRect(cell);
      if (finite(rect.left)) columnMeasured[index] = rect.left;
      if (finite(rect.right)) columnMeasured[index + 1] = rect.right;
    });
    const rowBoundaries = completeBoundaries(
      rowMeasured,
      tableRect.top,
      tableRect.bottom,
    );
    const columnBoundaries = completeBoundaries(
      columnMeasured,
      tableRect.left,
      tableRect.right,
    );
    this.layout = {
      tableRect,
      stageRect,
      rowBoundaries,
      columnBoundaries,
      scrollLeft: this.stage.scrollLeft,
      scrollTop: this.stage.scrollTop,
    };
    const localX = (client: number): number =>
      client - stageRect.left + this.stage.scrollLeft;
    const localY = (client: number): number =>
      client - stageRect.top + this.stage.scrollTop;
    const tableLeft = localX(tableRect.left);
    const tableTop = localY(tableRect.top);
    const tableRight = localX(tableRect.right);
    const tableBottom = localY(tableRect.bottom);
    this.rowHandles.forEach((button) => {
      const index = Number(button.dataset.index);
      const top = localY(rowBoundaries[index] ?? tableRect.top);
      const bottom = localY(rowBoundaries[index + 1] ?? tableRect.bottom);
      setBox(button, tableLeft - 30, (top + bottom) / 2 - 12, 24, 24);
    });
    this.columnHandles.forEach((button) => {
      const index = Number(button.dataset.index);
      const left = localX(columnBoundaries[index] ?? tableRect.left);
      const right = localX(columnBoundaries[index + 1] ?? tableRect.right);
      setBox(button, (left + right) / 2 - 12, tableTop - 30, 24, 24);
    });
    setBox(this.rowInsert, tableLeft - 30, tableTop - 12, 24, 24);
    setBox(this.columnInsert, tableLeft - 12, tableTop - 30, 24, 24);
    setBox(
      this.rowInsertLine,
      tableLeft,
      tableTop,
      Math.max(0, tableRight - tableLeft),
      2,
    );
    setBox(
      this.columnInsertLine,
      tableLeft,
      tableTop,
      2,
      Math.max(0, tableBottom - tableTop),
    );
    setBox(
      this.rowAppend,
      tableLeft,
      tableBottom,
      Math.max(24, tableRight - tableLeft - 32),
      30,
    );
    setBox(
      this.columnAppend,
      tableRight,
      tableTop,
      30,
      Math.max(24, tableBottom - tableTop - 32),
    );
    if (!this.drag) this.updateInsertHoverFromStoredPointer();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelDrag(false);
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
    this.element.remove();
  }

  private renderTarget(): void {
    if (!this.target) return;
    this.rowHandles = [];
    this.columnHandles = [];
    this.rowRovingIndex = null;
    this.columnRovingIndex = null;
    this.element.replaceChildren();
    const layer = this.stage.ownerDocument.createElement("div");
    layer.className = "mm-table-controls-layer";
    this.element.append(layer);

    const height = this.target.table.childCount;
    const width = this.target.table.firstChild?.childCount ?? 0;
    for (let row = 1; row < height; row += 1) {
      const handle = this.makeHandle("row", row, `Select row ${row}`);
      this.rowHandles.push(handle);
      layer.append(handle);
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
      layer.append(handle);
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
    layer.append(
      this.rowInsertLine,
      this.columnInsertLine,
      this.rowInsert,
      this.columnInsert,
      this.rowAppend,
      this.columnAppend,
    );
    this.updateSelectionState();
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
    button.disabled = !this.target?.supported || !this.callbacks.canEdit();
    button.textContent = "⋮";
    if (axis === "column") button.textContent = "⋯";
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
      this.updateSelectionState();
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
    };
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
    }
    const overTable = this.pointNearTargetTable(
      drag.selection.axis,
      event.clientX,
      event.clientY,
    );
    drag.boundary = overTable
      ? this.boundaryAt(drag.selection.axis, event.clientX, event.clientY)
      : null;
    this.showDropLine(drag.selection.axis, drag.boundary);
    this.scheduleAutoScroll();
  }

  private finishDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.stopAutoScroll();
    this.drag = null;
    drag.source.classList.remove("is-dragging");
    try {
      if (drag.source.hasPointerCapture(event.pointerId))
        drag.source.releasePointerCapture(event.pointerId);
    } catch {
      // Releasing an already-lost capture is harmless.
    }
    this.hideDropLine();
    if (!drag.moved) {
      if (!drag.source.disabled) {
        drag.source.focus();
        this.callbacks.onSelect(drag.selection, drag.target);
      }
      this.clearClickSuppression(drag.source);
      return;
    }
    this.clearClickSuppression(drag.source);
    if (drag.boundary !== null && this.callbacks.canEdit())
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

  private clearClickSuppression(source: HTMLButtonElement): void {
    const clear = (): void => {
      if (source.dataset.suppressClick === "true")
        delete source.dataset.suppressClick;
    };
    if (typeof queueMicrotask === "function") queueMicrotask(clear);
    else void Promise.resolve().then(clear);
  }

  private pointNearTargetTable(
    axis: TableControlAxis,
    clientX: number,
    clientY: number,
  ): boolean {
    const rect = this.layout?.tableRect;
    if (!rect || !this.target) return false;
    if (axis === "row")
      return (
        clientX >= rect.left - 46 &&
        clientX <= rect.right + 12 &&
        clientY >= rect.top - 12 &&
        clientY <= rect.bottom + 12
      );
    return (
      clientX >= rect.left - 12 &&
      clientX <= rect.right + 12 &&
      clientY >= rect.top - 46 &&
      clientY <= rect.bottom + 12
    );
  }

  private boundaryAt(
    axis: TableControlAxis,
    clientX: number,
    clientY: number,
  ): number | null {
    if (!this.layout || !this.target) return null;
    const { tableRect, rowBoundaries, columnBoundaries } = this.layout;
    if (axis === "row") {
      if (
        clientX < tableRect.left - 46 ||
        clientX > tableRect.right + 12 ||
        clientY < tableRect.top - 12 ||
        clientY > tableRect.bottom + 12
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
      clientX < tableRect.left - 12 ||
      clientX > tableRect.right + 12 ||
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

  private updateInsertHover(clientX: number, clientY: number): void {
    if (!this.layout || !this.target || !this.target.supported) {
      this.hideInsertButtons();
      return;
    }
    const { tableRect } = this.layout;
    const nearRows =
      clientX >= tableRect.left - 46 && clientX <= tableRect.left + 16;
    const nearColumns =
      clientY >= tableRect.top - 46 && clientY <= tableRect.top + 16;
    if (
      nearRows &&
      clientY >= tableRect.top - 8 &&
      clientY <= tableRect.bottom + 8
    ) {
      const boundary = this.boundaryAt("row", clientX, clientY);
      this.showInsertButton("row", boundary);
    } else {
      this.hideInsertButton("row");
    }
    if (
      nearColumns &&
      clientX >= tableRect.left - 8 &&
      clientX <= tableRect.right + 8
    ) {
      const boundary = this.boundaryAt("column", clientX, clientY);
      this.showInsertButton("column", boundary);
    } else {
      this.hideInsertButton("column");
    }
  }

  private storedPointerX: number | null = null;
  private storedPointerY: number | null = null;

  private updateInsertHoverFromStoredPointer(): void {
    if (this.storedPointerX === null || this.storedPointerY === null) return;
    this.updateInsertHover(this.storedPointerX, this.storedPointerY);
  }

  private showInsertButton(
    axis: TableControlAxis,
    boundary: number | null,
  ): void {
    const button = axis === "row" ? this.rowInsert : this.columnInsert;
    const line = axis === "row" ? this.rowInsertLine : this.columnInsertLine;
    if (boundary === null) {
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
      const { tableRect, stageRect, rowBoundaries, columnBoundaries } =
        this.layout;
      const localX = (client: number): number =>
        client - stageRect.left + this.stage.scrollLeft;
      const localY = (client: number): number =>
        client - stageRect.top + this.stage.scrollTop;
      if (axis === "row") {
        const y = localY(rowBoundaries[boundary] ?? tableRect.top);
        line.style.top = `${Math.round(y - 1)}px`;
        line.style.left = `${Math.round(localX(tableRect.left))}px`;
        line.style.width = `${Math.round(tableRect.width)}px`;
        line.style.height = "2px";
        button.style.top = `${Math.round(y - 12)}px`;
      } else {
        const x = localX(columnBoundaries[boundary] ?? tableRect.left);
        line.style.left = `${Math.round(x - 1)}px`;
        line.style.top = `${Math.round(localY(tableRect.top))}px`;
        line.style.width = "2px";
        line.style.height = `${Math.round(tableRect.height)}px`;
        button.style.left = `${Math.round(x - 12)}px`;
      }
    }
  }

  private hideInsertButton(axis: TableControlAxis): void {
    (axis === "row" ? this.rowInsert : this.columnInsert).hidden = true;
    (axis === "row" ? this.rowInsertLine : this.columnInsertLine).hidden = true;
  }

  private hideInsertButtons(): void {
    if (this.rowInsert) this.hideInsertButton("row");
    if (this.columnInsert) this.hideInsertButton("column");
    this.storedPointerX = null;
    this.storedPointerY = null;
  }

  private showDropLine(axis: TableControlAxis, boundary: number | null): void {
    this.showInsertButton(axis, boundary);
    const other = axis === "row" ? "column" : "row";
    this.hideInsertButton(other);
  }

  private hideDropLine(): void {
    this.hideInsertButtons();
  }

  private scheduleAutoScroll(): void {
    if (this.autoScrollFrame !== undefined) return;
    const tick = (): void => {
      this.autoScrollFrame = undefined;
      const drag = this.drag;
      if (!drag || this.destroyed) return;
      const rect = this.stage.getBoundingClientRect();
      let changed = false;
      if (drag.lastY < rect.top + EDGE_SCROLL_DISTANCE) {
        this.stage.scrollTop = Math.max(
          0,
          this.stage.scrollTop - EDGE_SCROLL_STEP,
        );
        changed = true;
      } else if (drag.lastY > rect.bottom - EDGE_SCROLL_DISTANCE) {
        this.stage.scrollTop += EDGE_SCROLL_STEP;
        changed = true;
      }
      if (drag.lastX < rect.left + EDGE_SCROLL_DISTANCE) {
        this.stage.scrollLeft = Math.max(
          0,
          this.stage.scrollLeft - EDGE_SCROLL_STEP,
        );
        changed = true;
      } else if (drag.lastX > rect.right - EDGE_SCROLL_DISTANCE) {
        this.stage.scrollLeft += EDGE_SCROLL_STEP;
        changed = true;
      }
      if (changed) {
        this.updateLayout();
        drag.boundary = this.boundaryAt(
          drag.selection.axis,
          drag.lastX,
          drag.lastY,
        );
        this.showDropLine(drag.selection.axis, drag.boundary);
      }
      if (
        drag.lastY < rect.top + EDGE_SCROLL_DISTANCE ||
        drag.lastY > rect.bottom - EDGE_SCROLL_DISTANCE ||
        drag.lastX < rect.left + EDGE_SCROLL_DISTANCE ||
        drag.lastX > rect.right - EDGE_SCROLL_DISTANCE
      )
        this.scheduleAutoScroll();
    };
    if (typeof requestAnimationFrame === "function")
      this.autoScrollFrame = requestAnimationFrame(tick);
    else this.autoScrollFrame = window.setTimeout(tick, 16);
  }

  private stopAutoScroll(): void {
    if (this.autoScrollFrame === undefined) return;
    if (typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(this.autoScrollFrame);
    else window.clearTimeout(this.autoScrollFrame);
    this.autoScrollFrame = undefined;
  }
}

export { DRAG_THRESHOLD as TABLE_DRAG_THRESHOLD };
