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
import type { HighlightSpan } from "../core/visualRendering";
import type { Profile } from "../core/index";
import {
  enhanceRenderedContent,
  type RenderingEnhancer,
} from "./mermaidEnhancer";

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
  const decorations: Decoration[] = headingDecorations(state, profile);
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
          Decoration.inline(from, to, {
            class: span.className,
            "data-mm-syntax": "true",
          }),
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
export type AlertBoundaryExit = (
  direction: AlertBoundaryDirection,
  position: number,
) => boolean;

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
  const bodySourceLines: string[] = [];
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/^\s*>[ \t]?/.test(line)) break;
    bodySourceLines.push(line);
  }
  const firstBodyPrefix = bodySourceLines
    .map((line) => line.match(/^(\s*>[ \t]?)/)?.[1])
    .find((prefix): prefix is string => prefix !== undefined);
  const bodyPrefix = firstBodyPrefix ?? markerPrefix;
  const body = bodySourceLines
    .map((line) => line.replace(/^\s*>[ \t]?/, ""))
    .join("\n");
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
  onBoundaryExit?: AlertBoundaryExit,
): NodeView {
  let current = node;
  let lastDocument = view.state.doc;
  let lastProfile = getProfile?.() ?? "github";
  let lastLocalSource: string | null = null;
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
    // EditorView.updateState() invokes this NodeView's update synchronously.
    // Mark the exact source before dispatch so that the update caused by this
    // textarea is allowed to keep the existing editor DOM intact.
    lastLocalSource = source;
    try {
      view.dispatch(
        view.state.tr.setNodeMarkup(position, undefined, {
          ...currentNode.attrs,
          source,
        }),
      );
    } catch (error) {
      // A failed dispatch must not make a later external update look local.
      lastLocalSource = null;
      throw error;
    }
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
    lastProfile = profile;
  };

  bodyEditor.addEventListener("mousedown", (event) => event.stopPropagation());
  // The editor's global keymap handles Enter for ProseMirror blocks. Keep the
  // alert textarea's native newline behavior by stopping the event before it
  // bubbles to the editor surface; do not prevent the browser default.
  bodyEditor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.stopPropagation();
      return;
    }
    if (
      event.isComposing ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (bodyEditor.selectionStart !== bodyEditor.selectionEnd) return;
    const direction =
      event.key === "ArrowRight"
        ? "after"
        : event.key === "ArrowLeft"
          ? "before"
          : null;
    if (!direction) return;
    const position = positionOf();
    if (
      position === undefined ||
      (direction === "after"
        ? bodyEditor.selectionEnd !== bodyEditor.value.length
        : bodyEditor.selectionStart !== 0) ||
      !onBoundaryExit?.(direction, position)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
  });
  bodyEditor.addEventListener("input", () => {
    resizeBodyEditor();
    updateSource();
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
