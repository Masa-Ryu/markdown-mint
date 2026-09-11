import { Decoration, DecorationSet } from "prosemirror-view";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import * as core from "../core/index";
import {
  escapeHtml,
  highlightCodeSpans,
  renderAdvancedBlock,
} from "../core/visualRendering";
import type { Profile } from "../core/index";
import {
  enhanceRenderedContent,
  type RenderingEnhancer,
} from "./mermaidEnhancer";

export { enhanceRenderedContent };
export type { RenderingEnhancer };

const renderingPluginKey = new PluginKey<DecorationSet>(
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

function renderingDecorations(
  state: EditorState,
  getProfile?: () => Profile,
): DecorationSet {
  const profile = getProfile?.() ?? "github";
  const decorations: Decoration[] = headingDecorations(state, profile);
  const footnotes = footnoteDecoration(state, profile);
  if (footnotes) decorations.push(footnotes);
  state.doc.descendants((node, position) => {
    if (node.type.name !== "code_block") return true;
    const source = node.textContent;
    const language = String(node.attrs.params ?? "");
    for (const span of highlightCodeSpans(source, language)) {
      const from = position + 1 + Math.max(0, span.from);
      const to = Math.min(position + node.nodeSize - 1, position + 1 + span.to);
      if (to > from)
        decorations.push(
          Decoration.inline(from, to, {
            class: span.className,
            "data-mm-syntax": "true",
          }),
        );
    }
    return false;
  });
  return DecorationSet.create(state.doc, decorations);
}

export function createRenderingPlugin(
  getProfile?: () => Profile,
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: renderingPluginKey,
    state: {
      init: (_config, state) => renderingDecorations(state, getProfile),
      apply: (transaction, decorations, _oldState, newState) =>
        transaction.docChanged
          ? renderingDecorations(newState, getProfile)
          : decorations.map(transaction.mapping, newState.doc),
    },
    props: {
      decorations: (state) =>
        renderingPluginKey.getState(state) ?? DecorationSet.empty,
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
): NodeView {
  let current = node;
  let lastDocument = view.state.doc;
  let disposed = false;
  let enhancer: RenderingEnhancer | undefined;
  const inline = current.type.name === "raw_inline";
  const dom = document.createElement(inline ? "span" : "div");
  dom.className = inline
    ? "mm-rendered-node mm-rendered-inline"
    : "mm-rendered-node";
  dom.dataset.mmRenderedNode = current.type.name;
  dom.contentEditable = "false";
  dom.setAttribute("aria-live", "polite");

  const render = (): void => {
    if (disposed) return;
    const renderer = (core as unknown as CoreWithNodeRenderer).renderNodeHtml;
    let nodePosition: number | undefined;
    try {
      nodePosition = getPos?.();
    } catch {
      nodePosition = undefined;
    }
    const renderInput: PMNode | CoreRenderInput =
      nodePosition === undefined
        ? view.state.doc
        : { document: view.state.doc, nodePosition };
    const html = renderer
      ? renderer(current, getProfile?.() ?? "github", renderInput)
      : rawNodeFallback(current);
    enhancer?.dispose();
    appendGeneratedHtml(dom, html);
    enhancer = enhanceRenderedContent(dom);
  };

  render();

  return {
    dom,
    update: (nextNode) => {
      if (nextNode.type !== current.type) return false;
      const contextChanged =
        view.state.doc !== lastDocument &&
        (dependsOnDocumentContext(current) ||
          dependsOnDocumentContext(nextNode));
      if (nextNode.eq(current) && !contextChanged) {
        lastDocument = view.state.doc;
        return true;
      }
      current = nextNode;
      lastDocument = view.state.doc;
      dom.dataset.mmRenderedNode = current.type.name;
      render();
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
 * Render an alert atom with an opt-in source editor. Alerts stay raw atoms so
 * their original Markdown remains available to the serializer, while the
 * small source editor gives rich mode a safe editing path without exposing
 * generated HTML to ProseMirror's mutation observer.
 */
export function createAlertNodeView(
  node: PMNode,
  view: EditorView,
  getPos: (() => number | undefined) | undefined,
  getProfile?: () => Profile,
): NodeView {
  let current = node;
  let lastDocument = view.state.doc;
  let disposed = false;
  let enhancer: RenderingEnhancer | undefined;
  let editing = false;

  const dom = document.createElement("div");
  dom.className = "mm-rendered-node mm-alert-node-view";
  dom.dataset.mmRenderedNode = current.type.name;
  dom.contentEditable = "false";
  dom.setAttribute("aria-live", "polite");

  const preview = document.createElement("div");
  preview.className = "mm-alert-preview";
  preview.contentEditable = "false";
  dom.append(preview);

  const controls = document.createElement("div");
  controls.className = "mm-alert-node-controls";
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "mm-alert-edit-button";
  editButton.textContent = "Edit alert source";
  editButton.setAttribute("aria-expanded", "false");
  editButton.setAttribute("aria-label", "Edit alert Markdown source");
  controls.append(editButton);
  dom.append(controls);

  const sourceEditor = document.createElement("textarea");
  sourceEditor.className = "mm-alert-source-editor";
  sourceEditor.setAttribute("aria-label", "Alert Markdown source");
  sourceEditor.setAttribute("spellcheck", "false");
  sourceEditor.hidden = true;
  dom.append(sourceEditor);

  const sourceFor = (value: PMNode): string =>
    String(value.attrs.source ?? value.textContent ?? "");

  const setEditing = (next: boolean, focus = false): void => {
    editing = next;
    sourceEditor.hidden = !next;
    editButton.setAttribute("aria-expanded", String(next));
    editButton.textContent = next ? "Hide alert source" : "Edit alert source";
    if (next && focus) {
      sourceEditor.focus();
      sourceEditor.setSelectionRange(
        sourceEditor.value.length,
        sourceEditor.value.length,
      );
    }
  };

  const positionOf = (): number | undefined => {
    try {
      return getPos?.();
    } catch {
      return undefined;
    }
  };

  const updateSource = (): void => {
    const position = positionOf();
    if (position === undefined) return;
    const currentNode = view.state.doc.nodeAt(position);
    if (
      !currentNode ||
      currentNode.type.name !== "raw_block" ||
      String(currentNode.attrs.kind ?? "") !== "alert"
    )
      return;
    const source = sourceEditor.value;
    if (String(currentNode.attrs.source ?? "") === source) return;
    view.dispatch(
      view.state.tr.setNodeMarkup(position, undefined, {
        ...currentNode.attrs,
        source,
      }),
    );
  };

  const render = (): void => {
    if (disposed) return;
    const renderer = (core as unknown as CoreWithNodeRenderer).renderNodeHtml;
    const nodePosition = positionOf();
    const renderInput: PMNode | CoreRenderInput =
      nodePosition === undefined
        ? view.state.doc
        : { document: view.state.doc, nodePosition };
    const html = renderer
      ? renderer(current, getProfile?.() ?? "github", renderInput)
      : rawNodeFallback(current);
    enhancer?.dispose();
    appendGeneratedHtml(preview, html);
    enhancer = enhanceRenderedContent(preview);
    const source = sourceFor(current);
    if (sourceEditor.value !== source) sourceEditor.value = source;
    setEditing(editing);
  };

  editButton.addEventListener("mousedown", (event) => event.stopPropagation());
  editButton.addEventListener("click", () => setEditing(!editing, !editing));
  sourceEditor.addEventListener("mousedown", (event) =>
    event.stopPropagation(),
  );
  sourceEditor.addEventListener("input", updateSource);
  sourceEditor.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setEditing(false);
    view.focus();
  });
  preview.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setEditing(true, true);
  });

  render();

  return {
    dom,
    update: (nextNode) => {
      if (
        nextNode.type !== current.type ||
        String(nextNode.attrs.kind ?? "") !== "alert"
      )
        return false;
      const contextChanged =
        view.state.doc !== lastDocument &&
        (dependsOnDocumentContext(current) ||
          dependsOnDocumentContext(nextNode));
      if (nextNode.eq(current) && !contextChanged) {
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
      if (target.closest("a,button,input,summary,select,textarea")) return true;
      return (
        event.type === "dblclick" &&
        Boolean(target.closest(".mm-alert-preview"))
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
