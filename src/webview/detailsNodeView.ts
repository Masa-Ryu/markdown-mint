import type { Node as PMNode } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import { NodeSelection, TextSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import {
  detailsSourceParts,
  parseDetailsSource,
  renderDetailsSummaryHtml,
  type Profile,
} from "../core/index";

export interface DetailsNodeViewOptions {
  getProfile: () => Profile;
  canEdit: () => boolean;
  /** Keep a recoverable copy when external changes prevent a safe commit. */
  preserveDraft: (draft: string, message: string) => void;
  composition?: (active: boolean) => void;
}

let nextDetailsId = 0;

/** A single ProseMirror editing surface owns the entire structured body. */
export function createDetailsNodeView(
  node: PMNode,
  view: EditorView,
  getPos: (() => number | undefined) | undefined,
  options: DetailsNodeViewOptions,
): NodeView {
  let current = node;
  let disposed = false;
  let open = detailsSourceParts(node)?.open ?? false;
  let editing:
    | {
        summary: string;
        source: string;
        profile: Profile;
        initialInput: string;
        attrs: PMNode["attrs"];
        bodySelection: { anchor: number; head: number } | undefined;
      }
    | undefined;
  let composing = false;
  let compositionEndedAt = -Infinity;
  let pendingBlur = false;
  const owner = view.dom.ownerDocument;
  const dom = owner.createElement("div");
  dom.className = "mm-details-node";
  const header = owner.createElement("div");
  header.className = "mm-details-header";
  header.contentEditable = "false";
  const toggle = owner.createElement("button");
  toggle.type = "button";
  toggle.className = "mm-details-toggle";
  const title = owner.createElement("button");
  title.type = "button";
  title.className = "mm-details-summary";
  title.setAttribute("aria-label", "Edit Details heading");
  title.title = "Edit Details heading (Markdown/HTML source)";
  const input = owner.createElement("input");
  input.type = "text";
  input.className = "mm-details-summary-input";
  input.setAttribute("aria-label", "Details heading (Markdown/HTML source)");
  input.hidden = true;
  const contentDOM = owner.createElement("div");
  contentDOM.className = "mm-details-body";
  contentDOM.id = `mm-details-body-${++nextDetailsId}`;
  toggle.setAttribute("aria-controls", contentDOM.id);
  header.append(toggle, title, input);
  dom.append(header, contentDOM);

  const positionOf = (): number | undefined => {
    try {
      const position = getPos?.();
      if (position === undefined) return undefined;
      const live = view.state.doc.nodeAt(position);
      if (!live || !live.eq(current)) return undefined;
      current = live;
      return position;
    } catch {
      return undefined;
    }
  };
  const editable = (): boolean =>
    !disposed && view.editable && options.canEdit();
  const updateDisplay = (): void => {
    dom.dataset.mmDetailsOpen = String(open);
    contentDOM.hidden = !open;
    toggle.textContent = open ? "▾" : "▸";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute(
      "aria-label",
      open ? "Collapse Details" : "Expand Details",
    );
    title.disabled = !editable();
    if (!editing) {
      const template = owner.createElement("template");
      template.innerHTML = renderDetailsSummaryHtml(
        String(current.attrs.summarySource ?? ""),
        options.getProfile(),
      );
      title.replaceChildren(...Array.from(template.content.childNodes));
      // Keep an empty heading empty in Markdown, but retain a visible control.
      if (!title.textContent && !title.children.length)
        title.textContent = "(empty heading)";
    }
  };
  const finishDisplay = (): void => {
    editing = undefined;
    pendingBlur = false;
    input.hidden = true;
    title.hidden = false;
    updateDisplay();
  };
  const restoreFocus = (
    bodySelection: { anchor: number; head: number } | undefined,
  ): void => {
    const position = positionOf();
    if (position === undefined || !dom.isConnected) return;
    if (open && bodySelection) {
      const anchor = position + 1 + bodySelection.anchor;
      const head = position + 1 + bodySelection.head;
      if (
        anchor <= position + current.nodeSize - 1 &&
        head <= position + current.nodeSize - 1 &&
        view.state.doc.resolve(anchor).parent.isTextblock &&
        view.state.doc.resolve(head).parent.isTextblock
      ) {
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.create(view.state.doc, anchor, head))
            .setMeta("addToHistory", false),
        );
        view.focus();
        return;
      }
    }
    title.focus({ preventScroll: true });
  };
  const retainDraft = (message: string): void => {
    if (editing && input.value !== editing.initialInput)
      options.preserveDraft(input.value, message);
  };
  const finish = (cancel: boolean, keyboard: boolean): void => {
    const session = editing;
    if (!session) return;
    const value = input.value;
    const position = positionOf();
    const changed = value !== session.initialInput;
    const parts = detailsSourceParts(current);
    const candidate =
      parts &&
      parseDetailsSource(
        parts.beforeSummary +
          value +
          parts.afterSummary +
          parts.body +
          parts.closing,
        current.attrs.sourceProfile as Profile,
      );
    const canCommit =
      editable() &&
      position !== undefined &&
      candidate?.summary === value &&
      candidate.body === parts?.body &&
      options.getProfile() === session.profile &&
      String(current.attrs.source ?? "") === session.source &&
      current.attrs === session.attrs &&
      String(current.attrs.summarySource ?? "") === session.summary;
    if (!cancel && changed && !canCommit)
      retainDraft(
        "The Details heading changed externally or is no longer editable. Your heading draft was preserved.",
      );
    // Mark the session finished BEFORE hiding/blurring the input or dispatch.
    finishDisplay();
    if (!cancel && changed && canCommit) {
      view.dispatch(
        closeHistory(view.state.tr).setNodeMarkup(position!, undefined, {
          ...current.attrs,
          summarySource: value,
        }),
      );
      view.dispatch(closeHistory(view.state.tr).setMeta("addToHistory", false));
    }
    if (keyboard) restoreFocus(session.bodySelection);
  };
  const start = (): void => {
    if (editing || !editable()) return;
    const position = positionOf();
    if (position === undefined) return;
    const selection = view.state.selection;
    const inside =
      selection.from > position && selection.to < position + current.nodeSize;
    const summary = String(current.attrs.summarySource ?? "");
    input.value = summary;
    editing = {
      summary,
      source: String(current.attrs.source ?? ""),
      profile: options.getProfile(),
      initialInput: input.value,
      attrs: current.attrs,
      bodySelection:
        inside && selection instanceof TextSelection
          ? {
              anchor: selection.anchor - position - 1,
              head: selection.head - position - 1,
            }
          : undefined,
    };
    title.hidden = true;
    input.hidden = false;
    input.focus({ preventScroll: true });
    input.select();
  };
  const clickTitle = (event: MouseEvent): void => {
    event.preventDefault();
    start();
  };
  const clickToggle = (): void => {
    if (disposed) return;
    const position = positionOf();
    if (position === undefined) return;
    const selection = view.state.selection;
    const inside =
      (selection.anchor > position &&
        selection.anchor < position + current.nodeSize) ||
      (selection.head > position &&
        selection.head < position + current.nodeSize);
    const focusInside = contentDOM.contains(owner.activeElement);
    open = !open;
    if (!open && (inside || focusInside)) {
      view.dispatch(
        view.state.tr
          .setSelection(NodeSelection.create(view.state.doc, position))
          .setMeta("addToHistory", false),
      );
      toggle.focus({ preventScroll: true });
    }
    updateDisplay();
  };
  const keydown = (event: KeyboardEvent): void => {
    if (
      event.isComposing ||
      composing ||
      event.keyCode === 229 ||
      (event.key === "Enter" && Date.now() - compositionEndedAt < 50)
    )
      return;
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      finish(event.key === "Escape", true);
    }
  };
  const blur = (): void => {
    if (composing) pendingBlur = true;
    else finish(false, false);
  };
  const compositionStart = (): void => {
    composing = true;
    options.composition?.(true);
  };
  const compositionEnd = (): void => {
    composing = false;
    options.composition?.(false);
    compositionEndedAt = Date.now();
    if (pendingBlur)
      queueMicrotask(() => {
        if (!disposed) finish(false, false);
      });
  };
  const selectWholeNode = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Only the nearest Details NodeView owns a click. This makes an inner
    // card's padding independent from its ancestor's contentDOM.
    if (target.closest(".mm-details-node") !== dom) return;
    // The body belongs to ProseMirror's normal text/contentDOM handling. The
    // controls also keep their own click and focus behavior. This check is
    // intentionally based on the closest control so nested Details do not
    // make an outer node selection when their descendants are clicked.
    if (contentDOM.contains(target)) return;
    if (
      target.closest(
        ".mm-details-toggle, .mm-details-summary, .mm-details-summary-input",
      )
    )
      return;
    if (target !== dom && target !== header) return;
    const position = positionOf();
    if (position === undefined) return;
    const selection = NodeSelection.create(view.state.doc, position);
    event.preventDefault();
    event.stopPropagation();
    if (
      view.state.selection instanceof NodeSelection &&
      view.state.selection.from === selection.from &&
      view.state.selection.to === selection.to
    )
      return;
    view.dispatch(
      view.state.tr.setSelection(selection).setMeta("addToHistory", false),
    );
  };
  title.addEventListener("click", clickTitle);
  toggle.addEventListener("click", clickToggle);
  dom.addEventListener("click", selectWholeNode);
  input.addEventListener("keydown", keydown);
  input.addEventListener("blur", blur);
  input.addEventListener("compositionstart", compositionStart);
  input.addEventListener("compositionend", compositionEnd);
  updateDisplay();
  return {
    dom,
    contentDOM,
    update: (next) => {
      if (next.type !== current.type) return false;
      const saved = editing?.bodySelection;
      if (saved) {
        const start = current.content.findDiffStart(next.content);
        const end = current.content.findDiffEnd(next.content);
        if (start !== null && end) {
          const map = (position: number): number =>
            position < start
              ? position
              : position <= end.a
                ? end.b
                : position + end.b - end.a;
          saved.anchor = map(saved.anchor);
          saved.head = map(saved.head);
        }
      }
      current = next;
      // Header drafts stay visible across updates; commit checks the live node
      // and profile, while getPos resolves movement without matching by text.
      updateDisplay();
      return true;
    },
    selectNode: () => dom.classList.add("ProseMirror-selectednode"),
    deselectNode: () => dom.classList.remove("ProseMirror-selectednode"),
    stopEvent: (event) =>
      event.target instanceof owner.defaultView!.Node &&
      header.contains(event.target),
    ignoreMutation: (mutation) => {
      if (mutation.type === "selection")
        return header.contains(owner.activeElement);
      return (
        mutation.target === dom ||
        (mutation.target === contentDOM && mutation.type === "attributes") ||
        header.contains(mutation.target)
      );
    },
    destroy: () => {
      retainDraft(
        "The Details block was removed or reloaded. Your heading draft was preserved.",
      );
      if (composing) options.composition?.(false);
      disposed = true;
      editing = undefined;
      title.removeEventListener("click", clickTitle);
      toggle.removeEventListener("click", clickToggle);
      input.removeEventListener("keydown", keydown);
      input.removeEventListener("blur", blur);
      input.removeEventListener("compositionstart", compositionStart);
      input.removeEventListener("compositionend", compositionEnd);
      dom.removeEventListener("click", selectWholeNode);
    },
  };
}
