import * as core from "../core";
import { PROTOCOL_VERSION, type MarkdownProfile } from "../shared/protocol";
import { configureMermaidRuntimeLoader } from "./mermaidValidation";
import {
  createEditorApp,
  type CoreBridge,
  type EditorAppOptions,
  type EditorInitialDocument,
  type MarkdownEditorApp,
  type VSCodeApiLike,
} from "./editor";
import { installModalSubmitShortcut } from "./modalSubmitShortcut";

declare global {
  interface Window {
    acquireVsCodeApi?: () => VSCodeApiLike;
    markdownMint?: MarkdownEditorApp;
  }
}

/** Adapt the dependency-free core module to the webview's narrow bridge. */
export function createCoreBridge(): CoreBridge {
  return {
    schema: core.schema,
    parseMarkdown: (source, profile) => core.parseMarkdown(source, profile),
    serializeMarkdown: (doc, previous) =>
      core.serializeMarkdown(
        doc,
        previous as Parameters<typeof core.serializeMarkdown>[1],
      ),
    renderMarkdown: (source, profile) => core.renderMarkdown(source, profile),
    inspectCompatibility: (source, profile) =>
      core.inspectCompatibility(source, profile),
    formatMarkdown: (source, options) =>
      core.formatMarkdown(
        source,
        options as Parameters<typeof core.formatMarkdown>[1],
      ),
  };
}

function getVsCodeApi(): VSCodeApiLike | undefined {
  try {
    return window.acquireVsCodeApi?.();
  } catch {
    return undefined;
  }
}

function getRoot(): HTMLElement {
  const existing =
    document.querySelector<HTMLElement>("[data-markdown-mint-root]") ??
    document.getElementById("markdown-mint") ??
    document.getElementById("app");
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = "markdown-mint";
  root.dataset.markdownMintRoot = "true";
  root.dataset.mode = document.body.dataset.markdownMintMode ?? "editor";
  document.body.replaceChildren(root);
  return root;
}

function initialDocumentFromRoot(
  root: HTMLElement,
): EditorInitialDocument | undefined {
  const markdown = root.dataset.markdown;
  if (markdown === undefined) return undefined;
  const profile = root.dataset.profile;
  const initial: EditorInitialDocument = {
    markdown,
    version: Number(root.dataset.version ?? "1") || 1,
    profile:
      profile === "gitlab" || profile === "commonmark" ? profile : "github",
  };
  if (root.dataset.operationId) initial.operationId = root.dataset.operationId;
  if (root.dataset.mode === "preview" || root.dataset.mode === "editor")
    initial.mode = root.dataset.mode;
  return initial;
}

export function startWebview(
  options: Partial<EditorAppOptions> = {},
): MarkdownEditorApp {
  const root = options.root ?? getRoot();
  const mermaidRuntimeUri = root.dataset.mermaidRuntimeUri;
  if (mermaidRuntimeUri)
    configureMermaidRuntimeLoader({
      src: mermaidRuntimeUri,
      ownerDocument: root.ownerDocument,
      ...(root.dataset.mermaidRuntimeNonce
        ? { nonce: root.dataset.mermaidRuntimeNonce }
        : {}),
    });
  const vscode = options.vscode === undefined ? getVsCodeApi() : options.vscode;
  const appOptions: EditorAppOptions = {
    root,
    core: options.core ?? createCoreBridge(),
    hostUndo: options.hostUndo ?? true,
  };
  if (vscode) appOptions.vscode = vscode;
  const initialDocument =
    options.initialDocument ?? initialDocumentFromRoot(root);
  if (initialDocument) appOptions.initialDocument = initialDocument;
  const initialMode =
    options.initialMode ??
    (root.dataset.mode === "preview" ||
    document.body.dataset.markdownMintMode === "preview"
      ? "preview"
      : undefined);
  if (initialMode) appOptions.initialMode = initialMode;
  const app = createEditorApp(appOptions);
  installModalSubmitShortcut(root);
  window.markdownMint = app;
  return app;
}

export function boot(): MarkdownEditorApp | undefined {
  if (typeof document === "undefined") return undefined;
  return startWebview();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => boot(), { once: true });
  else boot();
}

// Keep the protocol constant referenced in the webview bundle. It is useful
// to browser harnesses which inspect the boot contract before a host replies.
void PROTOCOL_VERSION;
void (undefined as MarkdownProfile | undefined);
