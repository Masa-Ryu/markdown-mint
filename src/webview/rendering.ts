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

function alertSourceParts(source: string): {
  readonly body: string;
  readonly header: string;
  readonly bodyPrefix: string;
  readonly lineEnding: string;
  readonly trailingLineEnding: string;
} {
  const lineEnding = source.includes("\r\n")
    ? "\r\n"
    : source.includes("\r")
      ? "\r"
      : "\n";
  const normalized = source.replace(/\r\n|\r/g, "\n");
  const lines = normalized.split("\n");
  const markerIndex = Math.max(
    0,
    lines.findIndex((line) =>
      /^\s*>?[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(line),
    ),
  );
  const markerLine = lines[markerIndex] ?? "";
  const markerPrefix = markerLine.match(/^(\s*>[ \t]?)/)?.[1] ?? "";
  const bodyLines = lines.slice(markerIndex + 1);
  const firstBodyPrefix = bodyLines
    .map((line) => line.match(/^(\s*>[ \t]?)/)?.[1])
    .find((prefix): prefix is string => prefix !== undefined);
  const bodyPrefix = firstBodyPrefix ?? markerPrefix;
  const body = bodyLines
    .map((line) => line.replace(/^\s*>[ \t]?/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  const trailingMatch = normalized.match(/\n+$/);
  const trailingLineEnding = trailingMatch
    ? trailingMatch[0].replace(/\n/g, lineEnding)
    : "";
  return {
    body,
    header: lines.slice(0, markerIndex + 1).join("\n"),
    bodyPrefix,
    lineEnding,
    trailingLineEnding,
  };
}

function alertSourceWithBody(source: string, body: string): string {
  const parts = alertSourceParts(source);
  const normalizedBody = body.replace(/\r\n|\r/g, "\n");
  const bodyLines = normalizedBody
    ? normalizedBody
        .split("\n")
        .map((line) => parts.bodyPrefix + line)
        .join(parts.lineEnding)
    : "";
  return (
    parts.header.replace(/\n/g, parts.lineEnding) +
    (bodyLines ? parts.lineEnding + bodyLines : "") +
    parts.trailingLineEnding
  );
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
): NodeView {
  let current = node;
  let lastDocument = view.state.doc;
  let disposed = false;
  let enhancer: RenderingEnhancer | undefined;

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

  const resizeBodyEditor = (): void => {
    bodyEditor.style.height = "auto";
    const height = Math.max(bodyEditor.scrollHeight, 36);
    bodyEditor.style.height = `${height}px`;
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
    const position = positionOf();
    if (position === undefined) return;
    const currentNode = view.state.doc.nodeAt(position);
    if (
      !currentNode ||
      currentNode.type.name !== "raw_block" ||
      String(currentNode.attrs.kind ?? "") !== "alert"
    )
      return;
    const source = alertSourceWithBody(
      String(currentNode.attrs.source ?? ""),
      bodyEditor.value,
    );
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
    const bodyEditorHadFocus =
      bodyEditor.ownerDocument.activeElement === bodyEditor;
    const selectionStart = bodyEditorHadFocus
      ? bodyEditor.selectionStart
      : null;
    const selectionEnd = bodyEditorHadFocus ? bodyEditor.selectionEnd : null;
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
    const alert = preview.querySelector<HTMLElement>(".markdown-alert");
    const title = alert?.querySelector<HTMLElement>(".markdown-alert-title");
    if (alert && title) {
      const parts = alertSourceParts(sourceFor(current));
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
    enhancer = enhanceRenderedContent(preview);
  };

  bodyEditor.addEventListener("mousedown", (event) => event.stopPropagation());
  bodyEditor.addEventListener("input", () => {
    updateSource();
    resizeBodyEditor();
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
      return Boolean(target.closest("a,button,input,summary,select,textarea"));
    },
    ignoreMutation: () => true,
    destroy: () => {
      disposed = true;
      enhancer?.dispose();
      enhancer = undefined;
    },
  };
}
