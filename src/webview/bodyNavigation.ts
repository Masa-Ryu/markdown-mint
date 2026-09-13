import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Selection, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { BlockBoundarySelection, isBlockBoundary } from "./blockBoundary";

type Direction = -1 | 1;
type CaretRect = { left: number; top: number; bottom: number };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function textareaCaret(value: string, offset: number): number {
  // Range rectangles are indexed by UTF-16 offsets, while a user caret must
  // not split a surrogate pair, combining sequence, or joined emoji.
  return offset >= value.length
    ? value.length
    : (graphemes.segment(value).containing(offset)?.index ?? offset);
}

function plainArrow(event: KeyboardEvent): boolean {
  return (
    /^Arrow(Left|Right|Up|Down)$/.test(event.key) &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}

/** A layout mirror uses the browser's own shaping and wrapping, including tabs,
 * proportional fonts and textarea padding. It exists only during a key event. */
export function withTextareaLayout<T>(
  editor: HTMLTextAreaElement,
  read: (caret: (offset: number) => CaretRect) => T,
): T | undefined {
  const owner = editor.ownerDocument;
  const window = owner.defaultView;
  const bounds = editor.getBoundingClientRect();
  if (!window || !bounds.width || !bounds.height) return undefined;
  const computed = window.getComputedStyle(editor);
  const mirror = owner.createElement("div");
  for (const property of [
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "font-stretch",
    "font-variant",
    "font-feature-settings",
    "font-variation-settings",
    "line-height",
    "letter-spacing",
    "word-spacing",
    "text-indent",
    "text-align",
    "text-transform",
    "direction",
    "tab-size",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
  ])
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "border-box",
    borderStyle: "solid",
    margin: "0",
    left: `${bounds.left}px`,
    top: `${bounds.top - editor.scrollTop}px`,
    width: `${bounds.width}px`,
    height: "auto",
    minHeight: "0",
    whiteSpace: editor.wrap === "off" ? "pre" : "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: "normal",
  });
  // A trailing zero-width character gives empty and newline-terminated values
  // a measurable final caret without changing the user's textarea value.
  const text = owner.createTextNode(`${editor.value}\u200b`);
  mirror.append(text);
  owner.body.append(mirror);
  const range = owner.createRange();
  try {
    return read((offset) => {
      const index = Math.max(0, Math.min(offset, editor.value.length));
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const rect = range.getBoundingClientRect();
      return {
        left: rect.left - editor.scrollLeft,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
  } finally {
    mirror.remove();
  }
}

/** Find a caret on the requested displayed row. The search visits only the
 * target row after locating it logarithmically; it does not count newlines. */
function caretOnRow(
  length: number,
  caret: (offset: number) => CaretRect,
  top: number,
  goal: number,
): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (caret(mid).top < top - 1) low = mid + 1;
    else high = mid;
  }
  let best = low;
  let distance = Infinity;
  for (let index = low; index <= length; index += 1) {
    const rect = caret(index);
    if (rect.top > top + 1) break;
    const nextDistance = Math.abs(rect.left - goal);
    if (nextDistance < distance) {
      best = index;
      distance = nextDistance;
    }
  }
  return best;
}

export class BodyNavigation {
  private goalX: number | undefined;
  private readonly resetGoal = (): void => {
    this.goalX = undefined;
  };
  private readonly resetForKey = (event: Event): void => {
    if (
      !(event instanceof KeyboardEvent) ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      !plainArrow(event)
    )
      this.resetGoal();
  };

  constructor(
    private readonly view: EditorView,
    private readonly exitDocument: (position: number, node: PMNode) => boolean,
  ) {
    view.dom.addEventListener("pointerdown", this.resetGoal, true);
    view.dom.addEventListener("input", this.resetGoal, true);
    view.dom.addEventListener("keydown", this.resetForKey, true);
  }

  destroy(): void {
    this.view.dom.removeEventListener("pointerdown", this.resetGoal, true);
    this.view.dom.removeEventListener("input", this.resetGoal, true);
    this.view.dom.removeEventListener("keydown", this.resetForKey, true);
  }

  handleKeyDown(event: KeyboardEvent, composing = false): boolean {
    if (composing || !plainArrow(event) || !this.view.editable) return false;
    const target = event.target;
    const active = this.view.dom.ownerDocument.activeElement;
    if (
      (target instanceof Element &&
        target.closest("input,textarea,select,button")) ||
      (active instanceof Element &&
        this.view.dom.contains(active) &&
        active.closest("input,textarea,select,button"))
    )
      return false;
    const { selection } = this.view.state;
    const direction: Direction =
      event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (!vertical) this.resetGoal();
    let moved = false;
    if (selection instanceof BlockBoundarySelection) {
      moved = this.moveFromBoundary(selection.head, direction, vertical);
    } else if (selection instanceof NodeSelection && selection.node.isBlock) {
      moved = this.moveFromBlock(
        selection.from,
        selection.node,
        direction,
        vertical,
      );
    } else if (selection instanceof TextSelection && selection.empty) {
      // Table cell navigation remains owned by the existing table keymap.
      for (let depth = selection.$from.depth; depth > 0; depth -= 1)
        if (selection.$from.node(depth).type.spec.tableRole) return false;
      const block = selection.$from.parent;
      if (!block.isTextblock) return false;
      const position = selection.$from.before();
      let atBoundary: boolean;
      if (vertical) {
        this.captureGoal(selection.head);
        try {
          atBoundary = this.view.endOfTextblock(direction < 0 ? "up" : "down");
        } catch {
          return false;
        }
      } else {
        atBoundary =
          selection.$from.parentOffset ===
          (direction < 0 ? 0 : block.content.size);
      }
      if (atBoundary) {
        const nodeDOM = this.view.nodeDOM(position);
        // Expanded code shares the existing editor DOM: only prevent an exit
        // to the obscured document, retaining normal displayed-row movement.
        if (
          vertical &&
          block.type.name === "code_block" &&
          nodeDOM instanceof Element &&
          (nodeDOM.classList.contains("mm-code-block-expanded") ||
            Boolean(nodeDOM.querySelector(".mm-code-block-expanded")))
        ) {
          event.preventDefault();
          return true;
        }
        moved = this.moveFromBlock(position, block, direction, vertical);
      } else if (vertical) moved = this.moveWithinTextblock(direction);
    }
    if (moved) event.preventDefault();
    return moved;
  }

  moveFromTextarea(
    direction: "before" | "after",
    position: number,
    event?: KeyboardEvent,
  ): boolean {
    const block = this.view.state.doc.nodeAt(position);
    const editor = this.alertEditor(position);
    if (
      !block ||
      !editor ||
      !this.view.editable ||
      editor.selectionStart !== editor.selectionEnd ||
      (event && !plainArrow(event))
    )
      return false;
    const step: Direction = direction === "before" ? -1 : 1;
    const vertical = event?.key === "ArrowUp" || event?.key === "ArrowDown";
    if (!vertical) {
      this.resetGoal();
      if (editor.selectionStart !== (step < 0 ? 0 : editor.value.length))
        return false;
      return this.moveFromBlock(position, block, step, false);
    }
    return (
      withTextareaLayout(editor, (caret) => {
        const current = caret(editor.selectionStart);
        this.goalX ??= current.left;
        const edge = caret(step < 0 ? 0 : editor.value.length);
        if (Math.abs(current.top - edge.top) < 1)
          return this.moveFromBlock(position, block, step, true);
        let low = step < 0 ? 0 : editor.selectionStart + 1;
        let high = step < 0 ? editor.selectionStart : editor.value.length;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          const sameOrBefore = caret(mid).top <= current.top + 1;
          if (step < 0 ? caret(mid).top < current.top - 1 : sameOrBefore)
            low = mid + 1;
          else high = mid;
        }
        const next = caret(step < 0 ? Math.max(0, low - 1) : low);
        const offset = caretOnRow(
          editor.value.length,
          caret,
          next.top,
          this.goalX,
        );
        const safeOffset = textareaCaret(editor.value, offset);
        editor.setSelectionRange(safeOffset, safeOffset);
        return true;
      }) ?? false
    );
  }

  private captureGoal(position: number): void {
    if (this.goalX !== undefined) return;
    try {
      const rect = this.view.coordsAtPos(position);
      if (rect.bottom > rect.top) this.goalX = rect.left;
    } catch {
      /* No layout: preserve the native/default edge placement. */
    }
  }

  private moveWithinTextblock(direction: Direction): boolean {
    if (this.goalX === undefined) return false;
    const { selection } = this.view.state;
    try {
      const rect = this.view.coordsAtPos(selection.head);
      let low = direction < 0 ? selection.$from.start() : selection.head + 1;
      let high = direction < 0 ? selection.head : selection.$from.end();
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const top = this.view.coordsAtPos(mid).top;
        if (direction < 0 ? top < rect.top - 1 : top <= rect.top + 1)
          low = mid + 1;
        else high = mid;
      }
      const rowPosition =
        direction < 0 ? Math.max(selection.$from.start(), low - 1) : low;
      const row = this.view.coordsAtPos(rowPosition);
      if (Math.abs(row.top - rect.top) < 1) return false;
      const found = this.view.posAtCoords({
        left: this.goalX,
        top: (row.top + row.bottom) / 2,
      });
      if (!found || found.pos === selection.head) return false;
      const resolved = this.view.state.doc.resolve(found.pos);
      if (!resolved.sameParent(selection.$from)) return false;
      const next = this.view.coordsAtPos(found.pos);
      if (Math.abs(next.top - rect.top) < 1) return false;
      this.select(TextSelection.create(this.view.state.doc, found.pos));
      return true;
    } catch {
      return false;
    }
  }

  private moveFromBlock(
    position: number,
    block: PMNode,
    direction: Direction,
    vertical: boolean,
  ): boolean {
    const doc = this.view.state.doc;
    // Top-level block edges are virtual stops. Keeping this as a selection
    // avoids the transient paragraph that older navigation used as a caret
    // target, so crossing a boundary never edits the document.
    if (isBlockBoundary(doc, position) && doc.nodeAt(position) === block) {
      const boundary = direction < 0 ? position : position + block.nodeSize;
      return this.selectBoundary(boundary);
    }
    let cursor = direction < 0 ? position : position + block.nodeSize;
    const origin = doc.resolve(position);
    const originOuterPosition = origin.depth ? origin.before(1) : position;
    const originOuterBlock = origin.depth ? origin.node(1) : block;
    while (cursor >= 0 && cursor <= doc.content.size) {
      let selection = Selection.findFrom(doc.resolve(cursor), direction);
      if (!selection) break;
      // A nested textblock may have a valid Selection.findFrom result in the
      // next top-level node. Stop at the outer block first so the same
      // virtual boundary is used for Details, lists, and blockquotes.
      const candidate = selection.$from;
      const candidatePosition = candidate.depth
        ? candidate.before(1)
        : selection.from;
      const candidateBlock = candidate.depth
        ? candidate.node(1)
        : doc.nodeAt(selection.from);
      if (
        origin.depth > 0 &&
        (candidatePosition !== originOuterPosition ||
          candidateBlock !== originOuterBlock)
      ) {
        const boundary =
          direction < 0
            ? originOuterPosition
            : originOuterPosition + originOuterBlock.nodeSize;
        if (isBlockBoundary(doc, boundary))
          return this.selectBoundary(boundary);
      }
      // A collapsed structured Details remains one visible stop, regardless
      // of the depth of the hidden text position found by ProseMirror.
      for (let depth = 1; depth <= selection.$from.depth; depth += 1) {
        if (selection.$from.node(depth).type.name !== "details") continue;
        const container = selection.$from.before(depth);
        const dom = this.view.nodeDOM(container);
        if (
          dom instanceof HTMLElement &&
          dom.dataset.mmDetailsOpen === "false"
        ) {
          selection = NodeSelection.create(doc, container);
          break;
        }
      }
      if (selection instanceof NodeSelection) {
        const dom = this.view.nodeDOM(selection.from);
        if (dom instanceof HTMLElement && dom.hidden) {
          cursor = direction < 0 ? selection.from : selection.to;
          continue;
        }
        const editor = this.alertEditor(selection.from);
        if (editor) {
          this.view.dispatch(
            this.view.state.tr
              .setSelection(selection)
              .setMeta("addToHistory", false),
          );
          editor.focus({ preventScroll: true });
          let offset = direction < 0 ? editor.value.length : 0;
          if (vertical && this.goalX !== undefined) {
            offset =
              withTextareaLayout(editor, (caret) =>
                caretOnRow(
                  editor.value.length,
                  caret,
                  caret(offset).top,
                  this.goalX!,
                ),
              ) ?? offset;
          }
          const safeOffset = textareaCaret(editor.value, offset);
          editor.setSelectionRange(safeOffset, safeOffset);
          editor.scrollIntoView?.({ block: "nearest" });
          return true;
        }
      } else if (
        selection instanceof TextSelection &&
        vertical &&
        this.goalX !== undefined
      ) {
        selection = this.textSelectionAtX(selection);
      }
      this.select(selection);
      return true;
    }
    const resolved = doc.resolve(position);
    const outerBlock = resolved.depth ? resolved.node(1) : block;
    const outerPosition = resolved.depth ? resolved.before(1) : position;
    if (
      direction > 0 &&
      (outerBlock.type.name === "details" ||
        (resolved.depth === 0 && block.type.name !== "paragraph"))
    ) {
      const boundary = outerPosition + outerBlock.nodeSize;
      if (isBlockBoundary(doc, boundary)) return this.selectBoundary(boundary);
      // Preserve the old escape hatch for malformed or non-top-level states.
      const moved = this.exitDocument(outerPosition, outerBlock);
      if (moved) this.view.focus();
      return moved;
    }
    return false;
  }

  private moveFromBoundary(
    position: number,
    direction: Direction,
    vertical: boolean,
  ): boolean {
    const doc = this.view.state.doc;
    if (!isBlockBoundary(doc, position)) return false;
    let cursor = position;
    while (cursor >= 0 && cursor <= doc.content.size) {
      let selection = Selection.findFrom(doc.resolve(cursor), direction);
      if (!selection) return false;
      // A collapsed structured Details remains one visible stop, regardless
      // of the depth of the hidden text position found by ProseMirror.
      for (let depth = 1; depth <= selection.$from.depth; depth += 1) {
        if (selection.$from.node(depth).type.name !== "details") continue;
        const container = selection.$from.before(depth);
        const dom = this.view.nodeDOM(container);
        if (
          dom instanceof HTMLElement &&
          dom.dataset.mmDetailsOpen === "false"
        ) {
          selection = NodeSelection.create(doc, container);
          break;
        }
      }
      if (selection instanceof NodeSelection) {
        const dom = this.view.nodeDOM(selection.from);
        if (dom instanceof HTMLElement && dom.hidden) {
          cursor = direction < 0 ? selection.from : selection.to;
          continue;
        }
        const editor = this.alertEditor(selection.from);
        if (editor) {
          this.view.dispatch(
            this.view.state.tr
              .setSelection(selection)
              .setMeta("addToHistory", false),
          );
          editor.focus({ preventScroll: true });
          let offset = direction < 0 ? editor.value.length : 0;
          if (vertical && this.goalX !== undefined) {
            offset =
              withTextareaLayout(editor, (caret) =>
                caretOnRow(
                  editor.value.length,
                  caret,
                  caret(offset).top,
                  this.goalX!,
                ),
              ) ?? offset;
          }
          const safeOffset = textareaCaret(editor.value, offset);
          editor.setSelectionRange(safeOffset, safeOffset);
          editor.scrollIntoView?.({ block: "nearest" });
          return true;
        }
      } else if (
        selection instanceof TextSelection &&
        vertical &&
        this.goalX !== undefined
      ) {
        selection = this.textSelectionAtX(selection);
      }
      this.select(selection);
      return true;
    }
    return false;
  }

  private selectBoundary(position: number): boolean {
    const doc = this.view.state.doc;
    if (!isBlockBoundary(doc, position)) return false;
    try {
      this.select(new BlockBoundarySelection(doc.resolve(position)));
      return true;
    } catch {
      return false;
    }
  }

  private textSelectionAtX(selection: TextSelection): TextSelection {
    try {
      const rect = this.view.coordsAtPos(selection.head);
      const found = this.view.posAtCoords({
        left: this.goalX!,
        top: (rect.top + rect.bottom) / 2,
      });
      if (
        found &&
        this.view.state.doc.resolve(found.pos).sameParent(selection.$from)
      )
        return TextSelection.create(this.view.state.doc, found.pos);
    } catch {
      /* Fall back to the valid edge position in layout-less hosts. */
    }
    return selection;
  }

  private alertEditor(position: number): HTMLTextAreaElement | null {
    const node = this.view.state.doc.nodeAt(position);
    if (node?.type.name !== "raw_block" || node.attrs.kind !== "alert")
      return null;
    const dom = this.view.nodeDOM(position);
    return dom instanceof Element
      ? dom.querySelector<HTMLTextAreaElement>(".mm-alert-body-editor")
      : null;
  }

  private select(selection: Selection): void {
    const transaction = this.view.state.tr
      .setSelection(selection)
      .setMeta("addToHistory", false);
    this.view.dispatch(transaction.scrollIntoView());
    this.view.focus();
  }
}
