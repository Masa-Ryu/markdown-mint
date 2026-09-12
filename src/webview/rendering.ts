import { Decoration, DecorationSet } from "prosemirror-view";
import { NodeSelection, Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import * as core from "../core/index";
import { alertSourceWithBody, parseAlertSource } from "../core/alerts";
import { blockSourceEditor } from "./blockSourceEditing";
import {
  escapeHtml,
  highlightCodeSpans,
  renderAdvancedBlock,
} from "../core/visualRendering";
import type { HighlightSpan } from "../core/visualRendering";
import type { Profile } from "../core/index";
import {
  enhanceRenderedContent,
  type RenderingEnhancer,
} from "./mermaidEnhancer";
import { colorLiteralDecorations } from "./colorLiterals";

export { enhanceRenderedContent };
export type { RenderingEnhancer };

interface CodeHighlightState {
  node: PMNode;
  position: number;
  source: string;
  language: string;
  spans: HighlightSpan[];
}

interface RenderingPluginState {
  decorations: DecorationSet;
  codeBlocks: CodeHighlightState[];
  profile: Profile;
}

const renderingPluginKey = new PluginKey<RenderingPluginState>(
  "markdown-mint-rendering",
);

function headingDecorations(
  state: EditorState,
  profile: Profile,
): Decoration[] {
  return core.headingAnchorIds(state.doc, profile).map((anchor) =>
    Decoration.node(
      anchor.position,
      anchor.position + state.doc.nodeAt(anchor.position)!.nodeSize,
      {
        id: anchor.id,
        "data-mm-heading-id": anchor.id,
      },
    ),
  );
}

function stableContentHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function footnoteDecoration(
  state: EditorState,
  profile: Profile,
): Decoration | undefined {
  if (typeof document === "undefined") return undefined;
  let html: string;
  try {
    html = core.renderFootnotesHtml(state.doc, profile, state.doc);
  } catch {
    return undefined;
  }
  if (!html) return undefined;
  const decorationEnhancer: { current?: RenderingEnhancer } = {};
  const widget = Decoration.widget(
    state.doc.content.size,
    () => {
      const dom = document.createElement("div");
      dom.className = "mm-rich-footnotes";
      dom.contentEditable = "false";
      dom.setAttribute("aria-live", "polite");
      appendGeneratedHtml(dom, html);
      decorationEnhancer.current = enhanceRenderedContent(dom);
      return dom;
    },
    {
      side: 1,
      ignoreSelection: true,
      stopEvent: () => true,
      key: "markdown-mint-footnotes:" + stableContentHash(html),
      destroy: () => decorationEnhancer.current?.dispose(),
    },
  );
  return widget;
}

function baseRenderingDecorations(
  state: EditorState,
  getProfile?: () => Profile,
): { profile: Profile; decorations: Decoration[] } {
  const profile = getProfile?.() ?? "github";
  const decorations: Decoration[] = [
    ...headingDecorations(state, profile),
    ...colorLiteralDecorations(state.doc),
  ];
  state.doc.descendants((node, position) => {
    if (dependsOnDocumentContext(node)) {
      // An unchanged atom otherwise skips NodeView.update(), even when an
      // earlier heading changes every TOC target. The immutable document in
      // the decoration spec makes context changes visible to ProseMirror.
      decorations.push(
        Decoration.node(
          position,
          position + node.nodeSize,
          {},
          { renderDocument: state.doc },
        ),
      );
    }
  });
  const footnotes = footnoteDecoration(state, profile);
  if (footnotes) decorations.push(footnotes);
  return { profile, decorations };
}

function collectCodeBlocks(state: EditorState): Array<{
  node: PMNode;
  position: number;
  source: string;
  language: string;
}> {
  const codeBlocks: Array<{
    node: PMNode;
    position: number;
    source: string;
    language: string;
  }> = [];
  state.doc.descendants((node, position) => {
    if (node.type.name !== "code_block") return true;
    codeBlocks.push({
      node,
      position,
      source: node.textContent,
      language: String(node.attrs.params ?? ""),
    });
    return false;
  });
  return codeBlocks;
}

function sameCodeBlockInputs(
  left: CodeHighlightState[],
  right: Array<{
    node: PMNode;
    position: number;
    source: string;
    language: string;
  }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (previous, index) =>
        previous.node === right[index]!.node &&
        previous.source === right[index]!.source &&
        previous.language === right[index]!.language,
    )
  );
}

function takeReusableCodeBlock(
  block: {
    node: PMNode;
    position: number;
    source: string;
    language: string;
  },
  previous: CodeHighlightState[] | undefined,
  used: Set<CodeHighlightState>,
): CodeHighlightState | undefined {
  if (!previous) return undefined;
  const byNode = previous.find(
    (candidate) =>
      !used.has(candidate) &&
      candidate.node === block.node &&
      candidate.source === block.source &&
      candidate.language === block.language,
  );
  if (byNode) return byNode;
  return previous.find(
    (candidate) =>
      !used.has(candidate) &&
      candidate.source === block.source &&
      candidate.language === block.language,
  );
}

function codeDecorations(block: CodeHighlightState): Decoration[] {
  return block.spans.flatMap((span) => {
    const from = block.position + 1 + Math.max(0, span.from);
    const to = Math.min(
      block.position + block.node.nodeSize - 1,
      block.position + 1 + span.to,
    );
    return to > from
      ? [
          Decoration.inline(
            from,
            to,
            {
              class: span.className,
              "data-mm-syntax": "true",
            },
            { "data-mm-syntax": "true" },
          ),
        ]
      : [];
  });
}

function renderingDecorations(
  state: EditorState,
  getProfile?: () => Profile,
  previous?: CodeHighlightState[],
): RenderingPluginState {
  const base = baseRenderingDecorations(state, getProfile);
  const codeBlocks: CodeHighlightState[] = [];
  const used = new Set<CodeHighlightState>();
  for (const block of collectCodeBlocks(state)) {
    const reusable = takeReusableCodeBlock(block, previous, used);
    if (reusable) used.add(reusable);
    const spans =
      reusable?.spans ?? highlightCodeSpans(block.source, block.language);
    const current = { ...block, spans };
    codeBlocks.push(current);
    base.decorations.push(...codeDecorations(current));
  }
  return {
    profile: base.profile,
    decorations: DecorationSet.create(state.doc, base.decorations),
    codeBlocks,
  };
}

export function createRenderingPlugin(
  getProfile?: () => Profile,
): Plugin<RenderingPluginState> {
  return new Plugin<RenderingPluginState>({
    key: renderingPluginKey,
    state: {
      init: (_config, state) => renderingDecorations(state, getProfile),
      apply: (transaction, renderingState, oldState, newState) => {
        if (!transaction.docChanged)
          return {
            ...renderingState,
            decorations: renderingState.decorations.map(
              transaction.mapping,
              newState.doc,
            ),
            codeBlocks: renderingState.codeBlocks.map((block) => ({
              ...block,
              position: transaction.mapping.map(block.position, 1),
            })),
          };

        const profile = getProfile?.() ?? "github";
        const nextCodeBlocks = collectCodeBlocks(newState);
        if (
          profile === renderingState.profile &&
          sameCodeBlockInputs(renderingState.codeBlocks, nextCodeBlocks)
        ) {
          // Heading anchors and footnote widgets depend on the full document,
          // so rebuild those decorations. Code spans are independent of that
          // context and can be moved by ProseMirror's mapping instead.
          const mapped = renderingState.decorations.map(
            transaction.mapping,
            newState.doc,
          );
          const base = baseRenderingDecorations(newState, getProfile);
          const codeBlocks = nextCodeBlocks.map((block, index) => ({
            ...block,
            spans: renderingState.codeBlocks[index]!.spans,
          }));
          base.decorations.push(
            ...mapped
              .find()
              .filter(
                (decoration) =>
                  (decoration.spec as Record<string, unknown>)[
                    "data-mm-syntax"
                  ] === "true",
              ),
          );
          return {
            profile,
            decorations: DecorationSet.create(newState.doc, base.decorations),
            codeBlocks,
          };
        }
        return renderingDecorations(
          newState,
          getProfile,
          renderingState.codeBlocks,
        );
      },
    },
    props: {
      decorations: (state) =>
        renderingPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}

interface CoreRenderInput {
  document?: PMNode;
  nodePosition?: number;
}

interface CoreWithNodeRenderer {
  renderNodeHtml?: (
    node: PMNode,
    profile?: Profile,
    input?: PMNode | CoreRenderInput,
  ) => string;
}

export type AlertBoundaryDirection = "before" | "after";
export type AlertHistoryCommand = "undo" | "redo";
export type AlertBoundaryExit = (
  direction: AlertBoundaryDirection,
  position: number,
  event?: KeyboardEvent,
) => boolean;
export type AlertEditRequest = (
  position: number,
  returnFocus?: HTMLElement,
) => void;
export const ALERT_LOCAL_INPUT_META = "markdown-mint-alert-local-input";

export interface BlockEditingOptions {
  canEdit?: () => boolean;
  composition?: (active: boolean) => void;
  /** Retain native input already accepted when host synchronization stopped. */
  canPreserveLocalInput?: () => boolean;
}

const alertEditingState = new WeakMap<
  HTMLTextAreaElement,
  (readOnly: boolean) => void
>();

/** Lock the native input and flush any text accepted before that transition. */
export function setAlertBodyReadOnly(
  editor: HTMLTextAreaElement,
  readOnly: boolean,
): void {
  const update = alertEditingState.get(editor);
  if (update) update(readOnly);
  else editor.readOnly = readOnly;
}

function dependsOnDocumentContext(node: PMNode): boolean {
  if (node.type.name !== "raw_block" && node.type.name !== "raw_inline")
    return false;
  const kind = String(node.attrs.kind ?? "").toLowerCase();
  return (
    kind.includes("footnote") ||
    kind.includes("toc") ||
    kind.includes("table-of-contents") ||
    kind.includes("heading")
  );
}

function rawNodeFallback(node: PMNode): string {
  const source = String(node.attrs.source ?? node.textContent ?? "");
  const kind = String(node.attrs.kind ?? node.type.name);
  return (
    renderAdvancedBlock(kind, source) ??
    '<pre data-markdown-raw="true" data-kind="' +
      escapeHtml(kind) +
      '">' +
      escapeHtml(source) +
      "</pre>"
  );
}

type RenderedBlockMargin = "flow" | "code" | "fallback" | "math" | "visual";

function renderedBlockMargin(
  node: PMNode,
  dom: HTMLElement,
): RenderedBlockMargin | undefined {
  if (node.type.name !== "raw_block") return undefined;
  const element = dom.firstElementChild;
  if (!element) return undefined;
  if (element.matches(".mm-math-block")) return "math";
  if (element.matches(".mm-diagram, .mm-static-asset")) return "visual";
  if (element.matches(".mm-code-block")) return "code";
  if (element.matches("pre[data-markdown-raw]")) return "fallback";
  if (element.matches(".table-of-contents, dl")) return "flow";
  if (element.matches("details")) return "flow";
  return undefined;
}

function updateRenderedBlockLayout(node: PMNode, dom: HTMLElement): void {
  const margin = renderedBlockMargin(node, dom);
  if (margin) dom.dataset.mmBlockMargin = margin;
  else delete dom.dataset.mmBlockMargin;
}

function appendGeneratedHtml(element: HTMLElement, html: string): void {
  const ownerDocument = element.ownerDocument;
  const template = ownerDocument.createElement("template");
  template.innerHTML = html;
  element.replaceChildren(...Array.from(template.content.childNodes));
}

export function createRenderedNodeView(
  node: PMNode,
  view: EditorView,
  getPos: (() => number | undefined) | undefined,
  getProfile?: () => Profile,
  onEditRequest?: AlertEditRequest,
  options: BlockEditingOptions = {},
): NodeView {
  let current = node;
  let lastDocument = view.state.doc;
  let disposed = false;
  let enhancer: RenderingEnhancer | undefined;
  const inline = current.type.name === "raw_inline";
  const renderer = (core as unknown as CoreWithNodeRenderer).renderNodeHtml;
  const positionOf = (): number | undefined => {
    try {
      return getPos?.();
    } catch {
      return undefined;
    }
  };
  const renderHtml = (node: PMNode): string => {
    const nodePosition = positionOf();
    const renderInput: PMNode | CoreRenderInput =
      nodePosition === undefined
        ? view.state.doc
        : { document: view.state.doc, nodePosition };
    return renderer
      ? renderer(node, getProfile?.() ?? "github", renderInput)
      : rawNodeFallback(node);
  };
  const initialHtml = renderHtml(current);
  const initiallyEmpty = initialHtml.trim() === "";
  const dom = document.createElement(inline ? "span" : "div");
  dom.className = inline
    ? "mm-rendered-node mm-rendered-inline"
    : "mm-rendered-node";
  dom.dataset.mmRenderedNode = current.type.name;
  dom.contentEditable = "false";
  dom.setAttribute("aria-live", "polite");
  dom.hidden = initiallyEmpty;

  const updateEmptyBoundaryMarkers = (): void => {
    delete dom.dataset.mmDocumentFirst;
    delete dom.dataset.mmDocumentLast;
    if (!dom.hidden) {
      delete dom.dataset.mmRenderedEmpty;
      return;
    }
    dom.dataset.mmRenderedEmpty = "true";
    const position = positionOf();
    if (position === undefined) return;
    try {
      if (view.state.doc.resolve(position).depth !== 0) return;
    } catch {
      return;
    }
    if (position === 0) dom.dataset.mmDocumentFirst = "true";
    if (position + current.nodeSize === view.state.doc.content.size)
      dom.dataset.mmDocumentLast = "true";
  };
  updateEmptyBoundaryMarkers();

  const render = (html: string): void => {
    if (disposed) return;
    enhancer?.dispose();
    appendGeneratedHtml(dom, html);
    dom.hidden = false;
    updateRenderedBlockLayout(current, dom);
    const sourceEditor = blockSourceEditor(current);
    if (sourceEditor && onEditRequest) {
      const header = document.createElement("button");
      header.type = "button";
      header.className = "mm-block-source-trigger";
      header.dataset.mmBlockSource = sourceEditor.kind;
      header.textContent = sourceEditor.kind === "math" ? "Math" : "Mermaid";
      header.setAttribute("aria-label", `Edit ${header.textContent} source`);
      header.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const position = positionOf();
        if (
          position !== undefined &&
          view.editable &&
          (options.canEdit?.() ?? true)
        )
          onEditRequest(position, header);
      });
      dom.prepend(header);
    }
    updateEmptyBoundaryMarkers();
    enhancer = enhanceRenderedContent(dom);
  };

  if (!initiallyEmpty) render(initialHtml);

  return {
    dom,
    update: (nextNode) => {
      if (nextNode.type !== current.type) return false;
      const contextChanged =
        view.state.doc !== lastDocument &&
        (dependsOnDocumentContext(current) ||
          dependsOnDocumentContext(nextNode));
      const nextHtml = renderHtml(nextNode);
      const nextEmpty = nextHtml.trim() === "";
      if (nextNode.eq(current) && !contextChanged) {
        updateEmptyBoundaryMarkers();
        lastDocument = view.state.doc;
        return true;
      }
      current = nextNode;
      lastDocument = view.state.doc;
      dom.dataset.mmRenderedNode = current.type.name;
      if (nextEmpty) {
        enhancer?.dispose();
        enhancer = undefined;
        dom.replaceChildren();
        delete dom.dataset.mmBlockMargin;
        dom.hidden = true;
        updateEmptyBoundaryMarkers();
      } else {
        render(nextHtml);
      }
      return true;
    },
    selectNode: () => {
      dom.classList.add("ProseMirror-selectednode");
    },
    deselectNode: () => {
      dom.classList.remove("ProseMirror-selectednode");
    },
    stopEvent: (event) => {
      const target = event.target;
      return (
        target instanceof Element &&
        Boolean(target.closest("a,button,input,summary,select,textarea"))
      );
    },
    ignoreMutation: () => true,
    destroy: () => {
      disposed = true;
      enhancer?.dispose();
      enhancer = undefined;
    },
  };
}

/**
 * Render an alert atom with its body as an inline editor. Alerts remain raw
 * atoms so their original Markdown marker and source shape stay available to
 * the serializer, while the body editor gives rich mode a direct writing path
 * without exposing quote prefixes or a separate source workflow.
 */
export function createAlertNodeView(
  node: PMNode,
  view: EditorView,
  getPos: (() => number | undefined) | undefined,
  getProfile?: () => Profile,
  onBoundaryExit?: AlertBoundaryExit,
  onHistoryCommand?: (command: AlertHistoryCommand) => boolean,
  onEditRequest?: AlertEditRequest,
  options: BlockEditingOptions = {},
): NodeView {
  let current = node;
  let lastDocument = view.state.doc;
  let lastProfile = getProfile?.() ?? "github";
  let lastLocalSource: string | null = null;
  let bodyComposing = false;
  let disposed = false;
  let enhancer: RenderingEnhancer | undefined;
  const canEdit = (): boolean =>
    !disposed && view.editable && (options.canEdit?.() ?? true);

  const dom = document.createElement("div");
  dom.className = "mm-rendered-node mm-alert-node-view";
  dom.dataset.mmRenderedNode = current.type.name;
  dom.contentEditable = "false";
  dom.setAttribute("aria-live", "polite");

  const preview = document.createElement("div");
  preview.className = "mm-alert-preview";
  preview.contentEditable = "false";
  dom.append(preview);

  const bodyEditor = document.createElement("textarea");
  bodyEditor.className = "mm-alert-body-editor";
  bodyEditor.setAttribute("aria-label", "Alert content");
  bodyEditor.setAttribute("placeholder", "Write alert content…");
  bodyEditor.setAttribute("spellcheck", "true");
  bodyEditor.rows = 1;
  let resizeFrame: number | undefined;
  let measuredWidth = -1;
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          const width = bodyEditor.clientWidth;
          if (width === measuredWidth || disposed) return;
          measuredWidth = width;
          resizeBodyEditor();
        });

  const resizeBodyEditor = (): void => {
    bodyEditor.style.height = "auto";
    const height = Math.max(bodyEditor.scrollHeight, 36);
    bodyEditor.style.height = `${height}px`;
  };
  resizeObserver?.observe(dom);

  const setBodyFocused = (focused: boolean): void => {
    dom.classList.toggle("mm-alert-body-focused", focused);
  };

  const sourceFor = (value: PMNode): string =>
    String(value.attrs.source ?? value.textContent ?? "");

  const positionOf = (): number | undefined => {
    try {
      return getPos?.();
    } catch {
      return undefined;
    }
  };

  const updateSource = (): void => {
    if (disposed || (!canEdit() && !options.canPreserveLocalInput?.())) return;
    const position = positionOf();
    if (position === undefined) return;
    const currentNode = view.state.doc.nodeAt(position);
    if (
      !currentNode ||
      currentNode !== current ||
      currentNode.type.name !== "raw_block" ||
      String(currentNode.attrs.kind ?? "") !== "alert"
    )
      return;
    const currentSource = String(currentNode.attrs.source ?? "");
    // The textarea normalizes line endings and lazy blockquote continuation
    // lines for editing. If its value still represents the current body, a
    // dialog opening must not rewrite those source bytes just because it
    // flushes the native control.
    if (parseAlertSource(currentSource).body === bodyEditor.value) return;
    const source = alertSourceWithBody(currentSource, bodyEditor.value);
    if (currentSource === source) return;
    // EditorView.updateState() invokes this NodeView's update synchronously.
    // Mark the exact source before dispatch so that the update caused by this
    // textarea is allowed to keep the existing editor DOM intact.
    lastLocalSource = source;
    try {
      view.dispatch(
        view.state.tr
          .setNodeMarkup(position, undefined, {
            ...currentNode.attrs,
            source,
          })
          .setMeta(ALERT_LOCAL_INPUT_META, true),
      );
    } catch (error) {
      // A failed dispatch must not make a later external update look local.
      lastLocalSource = null;
      throw error;
    }
  };

  alertEditingState.set(bodyEditor, (readOnly) => {
    const changed = bodyEditor.readOnly !== readOnly;
    // Keep focus/selection for copying. Setting disabled would blur the IME
    // input; readonly stops subsequent typing without hiding its current draft.
    bodyEditor.readOnly = readOnly;
    if (changed && readOnly) updateSource();
  });

  const openEditor = (event: Event): void => {
    if (
      !onEditRequest ||
      bodyComposing ||
      dom.classList.contains("mm-alert-dialog-open") ||
      !canEdit()
    )
      return;
    const position = positionOf();
    if (position === undefined) return;
    try {
      // A native textarea can receive its last keystroke before the input
      // event reaches this NodeView. Flush that value before taking the
      // snapshot used by the existing Alert edit dialog.
      updateSource();
    } catch {
      return;
    }
    const currentPosition = positionOf();
    const currentNode =
      currentPosition === undefined
        ? null
        : view.state.doc.nodeAt(currentPosition);
    if (
      currentPosition === undefined ||
      !currentNode ||
      currentNode !== current ||
      currentNode.type.name !== "raw_block" ||
      String(currentNode.attrs.kind ?? "") !== "alert"
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    onEditRequest(currentPosition, bodyEditor);
  };

  const render = (): void => {
    if (disposed) return;
    const bodyEditorHadFocus =
      bodyEditor.ownerDocument.activeElement === bodyEditor;
    const selectionStart = bodyEditorHadFocus
      ? bodyEditor.selectionStart
      : null;
    const selectionEnd = bodyEditorHadFocus ? bodyEditor.selectionEnd : null;
    const renderer = (core as unknown as CoreWithNodeRenderer).renderNodeHtml;
    const profile = getProfile?.() ?? "github";
    const nodePosition = positionOf();
    const renderInput: PMNode | CoreRenderInput =
      nodePosition === undefined
        ? view.state.doc
        : { document: view.state.doc, nodePosition };
    const html = renderer
      ? renderer(current, profile, renderInput)
      : rawNodeFallback(current);
    enhancer?.dispose();
    appendGeneratedHtml(preview, html);
    const alert = preview.querySelector<HTMLElement>(".markdown-alert");
    const title = alert?.querySelector<HTMLElement>(".markdown-alert-title");
    if (alert && title) {
      title.tabIndex = 0;
      title.setAttribute("role", "button");
      title.setAttribute("aria-label", "Edit Alert");
      title.addEventListener("click", (event) => {
        // A physical mouse click (including either click in a double click)
        // remains inert. Programmatic and assistive-technology activation is
        // delivered as a zero-detail click and uses the guarded editor path.
        if (event.detail !== 0) return;
        openEditor(event);
      });
      title.addEventListener("keydown", (event) => {
        if (
          (event.key !== "Enter" && event.key !== " ") ||
          event.isComposing ||
          event.keyCode === 229
        )
          return;
        openEditor(event);
      });
      const parts = parseAlertSource(sourceFor(current));
      if (bodyEditor.value !== parts.body) bodyEditor.value = parts.body;
      alert.replaceChildren(title, bodyEditor);
      resizeBodyEditor();
      if (bodyEditorHadFocus) {
        bodyEditor.focus({ preventScroll: true });
        const length = bodyEditor.value.length;
        bodyEditor.setSelectionRange(
          Math.min(selectionStart ?? length, length),
          Math.min(selectionEnd ?? length, length),
        );
      }
    }
    setBodyFocused(bodyEditorHadFocus);
    enhancer = enhanceRenderedContent(preview);
    lastProfile = profile;
  };

  bodyEditor.addEventListener("mousedown", (event) => event.stopPropagation());
  bodyEditor.addEventListener("focus", () => {
    setBodyFocused(true);
    const position = positionOf();
    if (
      position !== undefined &&
      view.state.doc.nodeAt(position)?.type.name === "raw_block" &&
      !(
        view.state.selection instanceof NodeSelection &&
        view.state.selection.from === position
      )
    )
      view.dispatch(
        view.state.tr.setSelection(
          NodeSelection.create(view.state.doc, position),
        ),
      );
  });
  bodyEditor.addEventListener("blur", () => setBodyFocused(false));
  dom.addEventListener("dblclick", openEditor);
  // NodeView stopEvent handling can keep the editor-level composition state
  // from seeing events from this native textarea. Track the textarea itself so
  // a synthetic/native IME event cannot trigger alert boundary navigation.
  bodyEditor.addEventListener("compositionstart", () => {
    bodyComposing = true;
    options.composition?.(true);
  });
  bodyEditor.addEventListener("compositionend", () => {
    bodyComposing = false;
    updateSource();
    options.composition?.(false);
  });
  // The editor's global keymap handles Enter for ProseMirror blocks. Keep the
  // alert textarea's native newline behavior by stopping the event before it
  // bubbles to the editor surface; do not prevent the browser default.
  bodyEditor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.stopPropagation();
      return;
    }
    if (event.isComposing || bodyComposing || event.keyCode === 229) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.altKey) {
      const key = event.key.toLowerCase();
      const history =
        key === "z"
          ? event.shiftKey
            ? "redo"
            : "undo"
          : key === "y"
            ? "redo"
            : null;
      if (history && onHistoryCommand?.(history)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
      return;
    if (bodyEditor.selectionStart !== bodyEditor.selectionEnd) return;
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? "after"
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? "before"
          : null;
    if (!direction) return;
    const position = positionOf();
    if (position === undefined || !onBoundaryExit?.(direction, position, event))
      return;
    event.preventDefault();
    event.stopPropagation();
  });
  bodyEditor.addEventListener("input", () => {
    resizeBodyEditor();
    updateSource();
  });

  render();
  resizeFrame = bodyEditor.ownerDocument.defaultView?.requestAnimationFrame(
    () => {
      resizeFrame = undefined;
      if (!disposed) resizeBodyEditor();
    },
  );

  return {
    dom,
    update: (nextNode) => {
      if (
        nextNode.type !== current.type ||
        String(nextNode.attrs.kind ?? "") !== "alert"
      )
        return false;
      const nextSource = sourceFor(nextNode);
      const nextProfile = getProfile?.() ?? "github";
      const contextChanged =
        view.state.doc !== lastDocument &&
        (dependsOnDocumentContext(current) ||
          dependsOnDocumentContext(nextNode));
      const profileChanged = nextProfile !== lastProfile;
      if (
        !contextChanged &&
        !profileChanged &&
        lastLocalSource !== null &&
        nextSource === lastLocalSource
      ) {
        current = nextNode;
        lastDocument = view.state.doc;
        lastLocalSource = null;
        return true;
      }
      lastLocalSource = null;
      if (nextNode.eq(current) && !contextChanged && !profileChanged) {
        current = nextNode;
        lastDocument = view.state.doc;
        return true;
      }
      current = nextNode;
      lastDocument = view.state.doc;
      dom.dataset.mmRenderedNode = current.type.name;
      render();
      return true;
    },
    selectNode: () => dom.classList.add("ProseMirror-selectednode"),
    deselectNode: () => dom.classList.remove("ProseMirror-selectednode"),
    stopEvent: (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return false;
      const keyboardEvent = event as KeyboardEvent;
      if (
        event.type === "keydown" &&
        ["z", "y"].includes(keyboardEvent.key.toLowerCase()) &&
        (keyboardEvent.ctrlKey || keyboardEvent.metaKey)
      )
        return false;
      return Boolean(target.closest("a,button,input,summary,select,textarea"));
    },
    ignoreMutation: () => true,
    destroy: () => {
      disposed = true;
      setBodyFocused(false);
      alertEditingState.delete(bodyEditor);
      resizeObserver?.disconnect();
      if (resizeFrame !== undefined)
        bodyEditor.ownerDocument.defaultView?.cancelAnimationFrame(resizeFrame);
      enhancer?.dispose();
      enhancer = undefined;
    },
  };
}
