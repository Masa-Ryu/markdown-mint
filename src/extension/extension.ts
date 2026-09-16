import * as path from "node:path";
import * as vscode from "vscode";
import type MarkdownIt from "markdown-it";
import { formatMarkdown, parseMarkdown, renderMarkdown } from "../core/index";
import {
  loadFormatterConfig,
  type FormatterConfigResult,
} from "./formatterConfig";
import { saveImageImport, saveImageImportUri } from "./imageImport";
import {
  MARKDOWN_MINT_VIEW_TYPE,
  MarkdownMintCodeLensProvider,
  OPEN_IN_MARKDOWN_MINT_COMMAND,
  openInMarkdownMint,
} from "./codeLens";
import {
  MAX_MARKDOWN_LENGTH,
  MAX_OPERATION_ID_LENGTH,
  PROTOCOL_VERSION,
  type DocumentMessage,
  type EditRejectedMessage,
  type ErrorMessage,
  type ClipboardResultMessage,
  type ClipboardWriteMessage,
  type ImageImportMessage,
  type ImageImportUriMessage,
  type FormatRejectedMessage,
  type HostDocumentReason,
  type HostMessage,
  type MarkdownProfile,
  type PanelMode,
  type SetProfileMessage,
  type PreviewTypography,
  type WebviewMessage,
  type RecoverDraftMessage,
  type SaveMessage,
  type SaveResultMessage,
  type UserNotificationMessage,
  type WorkspaceFileSearchMessage,
  type WorkspaceFileSearchResultMessage,
  isMarkdownProfile,
  isSafeLinkHref,
  parseWebviewMessage,
} from "../shared/protocol";
import { classifyLinkNavigation } from "./linkNavigation";
import { WorkspaceFileSearchHost } from "./workspaceFileSearch";

export const VIEW_TYPE = MARKDOWN_MINT_VIEW_TYPE;
export const PREVIEW_VIEW_TYPE = "markdownMint.preview";
const nativePatchInstalled = new WeakSet<object>();
const nativeSourceKey = Symbol("markdown-mint-source");

/**
 * Build the dedicated editor Webview policy.
 *
 * KaTeX emits layout-critical inline style attributes (for example `top`,
 * `height`, and `vertical-align`) for fractions, scripts, and matrices. Keep
 * external stylesheets and fonts restricted to the Webview resource origin,
 * while granting only style attributes the narrowly scoped inline permission
 * they need. Scripts remain nonce-only and connections remain disabled.
 */
export function webviewContentSecurityPolicy(
  cspSource: string,
  nonce: string,
): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} https: data:`,
    `style-src ${cspSource}`,
    `style-src-elem ${cspSource}`,
    "style-src-attr 'unsafe-inline'",
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
  ].join("; ");
}

type EditAction = "edit" | "format" | "undo" | "redo";

interface PendingEdit {
  readonly operationId: string;
  readonly baseVersion: number;
  readonly targetMarkdown: string;
  /** Text after the replacement before a separate setEndOfLine edit lands. */
  readonly intermediateMarkdown?: string;
  readonly action: EditAction;
  readonly session?: PanelSession;
}

interface PendingCommand {
  readonly operationId: string;
  readonly baseVersion: number;
  readonly action: "undo" | "redo";
}

interface DocumentState {
  readonly key: string;
  readonly uri: vscode.Uri;
  document: vscode.TextDocument;
  version: number;
  eol: vscode.EndOfLine;
  profile: MarkdownProfile;
  queue: Promise<void>;
  readonly panels: Set<PanelSession>;
  readonly pending: Map<string, PendingEdit>;
  pendingCommand?: PendingCommand;
}

interface PanelSession {
  readonly panel: vscode.WebviewPanel;
  readonly state: DocumentState;
  readonly mode: PanelMode;
  readonly disposables: vscode.Disposable[];
  ready: boolean;
  previewRenderKey?: string;
  previewRenderGeneration: number;
  previewDirty: boolean;
}

interface ResourceInfo {
  readonly roots: vscode.Uri[];
  readonly baseUrl?: string;
}

interface CoreParseResult {
  readonly diagnostics?: readonly unknown[];
  readonly errors?: readonly unknown[];
  readonly valid?: boolean;
  readonly source?: unknown;
}

interface CoreRenderResult {
  readonly html?: unknown;
}

interface CoreFormatResult {
  readonly source?: unknown;
  readonly markdown?: unknown;
}

export interface MarkdownMintApi {
  readonly renderWithNativeMarkdown: (
    source: string,
    uri?: vscode.Uri,
  ) => Thenable<string>;
  readonly extendMarkdownIt: (markdownIt: MarkdownIt) => MarkdownIt;
}

/** Small package-level adapter used by integration harnesses to verify that
 * the bundled formatter remains usable without a runtime node_modules tree. */
export async function formatMarkdownDocument(
  source: string,
  profile: MarkdownProfile = "github",
  options: Record<string, unknown> = {},
): Promise<string> {
  const formatted = await formatMarkdown(source, {
    ...options,
    markdownProfile: profile,
  });
  return typeof formatted === "string" ? formatted : source;
}

/** VS Code extension entry point. */
export function activate(context: vscode.ExtensionContext): MarkdownMintApi {
  const provider = new MarkdownMintEditorProvider(context);
  const codeLensProvider = new MarkdownMintCodeLensProvider();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: {
        retainContextWhenHidden: true,
        enableFindWidget: true,
      },
    }),
    provider,
    codeLensProvider,
    vscode.commands.registerCommand(
      "markdownMint.openPreview",
      (uri?: vscode.Uri) => provider.openPreview(uri),
    ),
    vscode.commands.registerCommand(
      "markdownMint.openSource",
      (uri?: vscode.Uri) => provider.openSource(uri),
    ),
    vscode.commands.registerCommand(
      "markdownMint.formatDocument",
      (uri?: vscode.Uri) => provider.formatActiveDocument(uri),
    ),
    vscode.commands.registerCommand(
      OPEN_IN_MARKDOWN_MINT_COMMAND,
      (uri?: vscode.Uri) => openInMarkdownMint(uri, VIEW_TYPE),
    ),
    vscode.languages.registerCodeLensProvider(
      { language: "markdown" },
      codeLensProvider,
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      { language: "markdown" },
      {
        provideDocumentFormattingEdits: (document) =>
          provider.formatDocumentEdits(document),
      },
    ),
  );
  return {
    renderWithNativeMarkdown: (source, uri) =>
      provider.renderWithNativeMarkdown(source, uri),
    extendMarkdownIt,
  };
}

export function deactivate(): void {
  // All resources are owned by the provider and disposed through the context.
}

/**
 * VS Code's Markdown extension calls this contribution when it creates its
 * native MarkdownIt instance. The parser wrapper keeps the original source on
 * the token stream; the renderer wrapper sends that source through the same
 * profile-aware safe renderer used by the dedicated preview. Native line
 * anchors are restored on the resulting block elements for editor navigation.
 */
export function extendMarkdownIt(markdownIt: MarkdownIt): MarkdownIt {
  if (nativePatchInstalled.has(markdownIt)) return markdownIt;
  nativePatchInstalled.add(markdownIt);

  type Parser = (source: string, env?: unknown) => unknown[];
  type Renderer = (tokens: unknown[], options: unknown, env: unknown) => string;
  const instance = markdownIt as unknown as {
    parse: Parser;
    renderer: { render: Renderer };
  };
  const originalParse = instance.parse.bind(instance);
  const originalRender = instance.renderer.render.bind(instance.renderer);
  instance.parse = (source, env) => {
    const tokens = originalParse(source, env);
    if (Array.isArray(tokens)) {
      Object.defineProperty(tokens, nativeSourceKey, {
        value: source,
        configurable: true,
      });
      const first = tokens[0];
      if (first && typeof first === "object") {
        const token = first as Record<string, unknown>;
        const meta =
          token.meta && typeof token.meta === "object"
            ? { ...(token.meta as Record<string, unknown>) }
            : {};
        meta.markdownMintSource = source;
        token.meta = meta;
      }
    }
    return tokens;
  };
  instance.renderer.render = (tokens, options, env) => {
    const source = nativeSourceFrom(tokens);
    if (!source) return originalRender(tokens, options, env);
    try {
      const uri = nativeDocumentUri(env);
      const profile = profileForNativeUri(uri);
      return rewriteNativeImageUris(
        decorateNativeHtml(renderMarkdown(source, profile), tokens),
        env,
      );
    } catch {
      // Keep VS Code's preview usable if the optional core adapter cannot parse
      // an extension-provided construct; the native renderer remains a safe
      // compatibility fallback for that one document.
      return originalRender(tokens, options, env);
    }
  };
  return markdownIt;
}

/**
 * Owns the bridge between VS Code TextDocuments and the webview editor.
 *
 * The provider deliberately keeps no editable document model of its own. A
 * candidate from the webview is validated, converted to a minimal WorkspaceEdit,
 * and then acknowledged only from the resulting TextDocument change.
 */
export class MarkdownMintEditorProvider
  implements vscode.CustomTextEditorProvider, vscode.Disposable
{
  private readonly states = new Map<string, DocumentState>();
  private readonly sessions = new Map<vscode.WebviewPanel, PanelSession>();
  private readonly previewPanels = new Map<string, vscode.WebviewPanel>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;
  private readonly workspaceFileSearch = new WorkspaceFileSearchHost();
  private lastDocumentUri: vscode.Uri | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("Markdown Mint");
    this.subscriptions.push(this.workspaceFileSearch);
    this.subscriptions.push(
      this.output,
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.onDocumentChanged(event),
      ),
      vscode.workspace.onDidChangeConfiguration((event) =>
        this.onConfigurationChanged(event),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document && isMarkdownDocument(editor.document))
          this.lastDocumentUri = editor.document.uri;
      }),
      vscode.workspace.onWillSaveTextDocument((event) =>
        this.onWillSave(event),
      ),
    );
  }

  public dispose(): void {
    for (const disposable of this.subscriptions.splice(0)) disposable.dispose();
    for (const session of this.sessions.values()) {
      for (const disposable of session.disposables.splice(0))
        disposable.dispose();
    }
    this.sessions.clear();
    this.previewPanels.clear();
    this.states.clear();
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.lastDocumentUri = document.uri;
    const state = this.getOrCreateState(document);
    const session = this.attachPanel(document, webviewPanel, state, "editor");
    this.sendDocumentIfVisible(session, "initial");
  }

  public async openPreview(uri?: vscode.Uri): Promise<void> {
    const document = await this.resolveTargetDocument(uri);
    if (!document) {
      void vscode.window.showInformationMessage(
        "Open a Markdown document before opening its preview.",
      );
      return;
    }
    this.lastDocumentUri = document.uri;
    const state = this.getOrCreateState(document);
    const key = state.key;
    const existing = this.previewPanels.get(key);
    if (existing) {
      existing.reveal(existing.viewColumn, true);
      const session = this.sessions.get(existing);
      if (session) {
        this.sendDocumentIfVisible(session, "external");
        this.requestPreviewRender(session);
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PREVIEW_VIEW_TYPE,
      `Markdown Preview: ${path.basename(document.uri.fsPath || document.uri.path || "document.md")}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.previewPanels.set(key, panel);
    this.attachPanel(document, panel, state, "preview");
    // The ready handshake sends the initial document and drains the first
    // preview render. Posting before the webview is ready can otherwise cause
    // the same snapshot to be sent twice.
  }

  public async openSource(
    uri?: vscode.Uri,
    viewColumn?: vscode.ViewColumn,
  ): Promise<void> {
    const document = await this.resolveTargetDocument(uri);
    if (!document) {
      void vscode.window.showInformationMessage(
        "Open a Markdown document before opening its source.",
      );
      return;
    }
    this.lastDocumentUri = document.uri;
    const targetColumn =
      viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
    const options: vscode.TextDocumentShowOptions = {
      preview: false,
      preserveFocus: false,
      ...(targetColumn === undefined ? {} : { viewColumn: targetColumn }),
    };
    await vscode.commands.executeCommand(
      "vscode.openWith",
      document.uri,
      "default",
      options,
    );
  }

  public async formatActiveDocument(uri?: vscode.Uri): Promise<void> {
    const document = await this.resolveTargetDocument(uri);
    if (!document) {
      void vscode.window.showInformationMessage(
        "Open a Markdown document before formatting.",
      );
      return;
    }
    const state = this.getOrCreateState(document);
    const operationId = createOperationId("format");
    await this.enqueue(state, () =>
      this.handleFormat(undefined, state, document.version, operationId),
    );
  }

  /** Formatting provider entry point; VS Code applies these edits to the
   * active TextDocument and therefore owns their native undo history. */
  public async formatDocumentEdits(
    document: vscode.TextDocument,
  ): Promise<vscode.TextEdit[]> {
    if (!isMarkdownDocument(document)) return [];
    const edits = await this.formatForSave(document);
    return edits;
  }

  /**
   * Exposes VS Code's Markdown API for integration checks and clients that need
   * the native renderer. The dedicated preview continues to use the safe core
   * renderer so both surfaces share parsing and profile selection.
   */
  public async renderWithNativeMarkdown(
    source: string,
    uri?: vscode.Uri,
  ): Promise<string> {
    if (source.length > MAX_MARKDOWN_LENGTH)
      throw new Error("Markdown source is too large.");
    const options = uri ? { document: uri, filePath: uri.fsPath } : undefined;
    const result = await vscode.commands.executeCommand<unknown>(
      "markdown.api.render",
      source,
      options,
    );
    return extractHtml(result);
  }

  private attachPanel(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    state: DocumentState,
    mode: PanelMode,
  ): PanelSession {
    const session: PanelSession = {
      panel,
      state,
      mode,
      disposables: [],
      ready: false,
      previewRenderGeneration: 0,
      previewDirty: mode === "preview",
    };
    state.panels.add(session);
    this.sessions.set(panel, session);
    panel.webview.options = this.webviewOptions(document.uri, panel.webview);
    panel.webview.html = this.webviewHtml(panel.webview, mode);
    session.disposables.push(
      panel.webview.onDidReceiveMessage(
        (value: unknown) => void this.onMessage(session, value),
      ),
      panel.onDidDispose(() => this.detachPanel(session)),
    );
    const panelWithViewState = panel as vscode.WebviewPanel & {
      onDidChangeViewState?: (listener: () => void) => vscode.Disposable;
    };
    if (panelWithViewState.onDidChangeViewState) {
      session.disposables.push(
        panelWithViewState.onDidChangeViewState(() => {
          if (session.mode === "preview" && this.previewPanelVisible(session))
            this.requestPreviewRender(session);
        }),
      );
    }
    return session;
  }

  private detachPanel(session: PanelSession): void {
    if (session.mode === "preview") {
      session.ready = false;
      session.previewRenderGeneration += 1;
    }
    this.sessions.delete(session.panel);
    session.state.panels.delete(session);
    for (const disposable of session.disposables.splice(0))
      disposable.dispose();
    if (
      session.mode === "preview" &&
      this.previewPanels.get(session.state.key) === session.panel
    ) {
      this.previewPanels.delete(session.state.key);
    }
  }

  private getOrCreateState(document: vscode.TextDocument): DocumentState {
    const key = documentKey(document.uri);
    let state = this.states.get(key);
    if (!state) {
      state = {
        key,
        uri: document.uri,
        document,
        version: document.version,
        eol: document.eol,
        profile: this.profileFor(document.uri),
        queue: Promise.resolve(),
        panels: new Set(),
        pending: new Map(),
      };
      this.states.set(key, state);
    } else {
      state.document = document;
      state.version = document.version;
      state.eol = document.eol;
    }
    return state;
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (!isMarkdownDocument(event.document)) return;
    const existingState = this.states.get(documentKey(event.document.uri));
    const state = existingState ?? this.getOrCreateState(event.document);
    const previousVersion = state.version;
    const previousText = state.document.getText();
    const previousEol = state.eol;
    state.document = event.document;
    state.version = event.document.version;
    state.eol = event.document.eol;
    const text = event.document.getText();
    if (
      event.contentChanges.length === 0 &&
      previousVersion === event.document.version &&
      previousText === text &&
      previousEol === event.document.eol
    ) {
      return;
    }
    const pending = [...state.pending.values()].find(
      (candidate) =>
        candidate.baseVersion < event.document.version &&
        (candidate.targetMarkdown === text ||
          candidate.intermediateMarkdown === text),
    );
    if (pending) {
      if (pending.targetMarkdown !== text) {
        // VS Code may report the replacement and setEndOfLine portions of a
        // WorkspaceEdit as separate document events. Keep the pending edit
        // alive until the final target snapshot arrives.
        return;
      }
      state.pending.delete(pending.operationId);
      this.broadcastDocument(state, {
        reason: pending.action === "edit" ? "ack" : pending.action,
        operationId: pending.operationId,
      });
      return;
    }

    // An external edit can land while applyEdit is waiting for its change
    // event. Retain the submitted draft for the originating panel, but never
    // replay it on top of the newer TextDocument. The webview can then merge
    // independent changes against the exact submitted base.
    for (const candidate of [...state.pending.values()]) {
      state.pending.delete(candidate.operationId);
      if (candidate.action === "format") {
        this.rejectFormat(
          candidate.session,
          candidate.operationId,
          "stale",
          "The Markdown document changed while formatting was being applied.",
        );
      } else if (candidate.session) {
        this.rejectEdit(
          candidate.session,
          candidate.operationId,
          "stale",
          "The Markdown document changed while the edit was being applied.",
          candidate.targetMarkdown,
        );
      }
    }

    const pendingCommand = state.pendingCommand;
    if (pendingCommand && pendingCommand.baseVersion < event.document.version) {
      const historyReason =
        pendingCommand.action === "undo"
          ? vscode.TextDocumentChangeReason.Undo
          : vscode.TextDocumentChangeReason.Redo;
      if (event.reason === historyReason) {
        delete state.pendingCommand;
        this.broadcastDocument(state, {
          reason: pendingCommand.action,
          operationId: pendingCommand.operationId,
        });
        return;
      }
      // An unrelated source change arrived while a native command was
      // pending. Do not attribute it to Undo/Redo; the native change is the
      // authoritative snapshot and the command request is no longer valid.
      delete state.pendingCommand;
    }

    // Any unrecognized change came from VS Code or another panel. There is no
    // parallel snapshot stack to reconcile; the native VS Code undo service is
    // authoritative for source edits and this panel receives the new snapshot.
    const reason: HostDocumentReason =
      event.reason === vscode.TextDocumentChangeReason.Undo
        ? "undo"
        : event.reason === vscode.TextDocumentChangeReason.Redo
          ? "redo"
          : "external";
    this.broadcastDocument(state, { reason });
  }

  private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    for (const state of this.states.values()) {
      const profileChanged = event.affectsConfiguration(
        "markdownMint.profile",
        state.uri,
      );
      const typographyChanged = [
        "markdown.preview.fontFamily",
        "markdown.preview.fontSize",
        "markdown.preview.lineHeight",
      ].some((section) => event.affectsConfiguration(section, state.uri));
      if (!profileChanged && !typographyChanged) {
        continue;
      }
      if (profileChanged) state.profile = this.profileFor(state.uri);
      this.broadcastDocument(state, { reason: "external" });
    }
  }

  private onWillSave(event: vscode.TextDocumentWillSaveEvent): void {
    if (!isMarkdownDocument(event.document)) return;
    const enabled = vscode.workspace
      .getConfiguration("markdownMint", event.document.uri)
      .get<boolean>("formatOnSave", false);
    if (!enabled) return;
    event.waitUntil(this.formatForSave(event.document));
  }

  private async formatForSave(
    document: vscode.TextDocument,
  ): Promise<vscode.TextEdit[]> {
    const edits: vscode.TextEdit[] = [];
    const before = document.getText();
    const version = document.version;
    const state = this.getOrCreateState(document);
    try {
      const formatter = await this.formatterOptions(
        document.uri,
        state.profile,
      );
      if (formatter.ignored) {
        this.reportFormatSkip(
          document,
          "Formatting was skipped because .prettierignore matches this file.",
        );
        return edits;
      }
      await this.validateMarkdown(before, state.profile, true);
      const formatted = await this.callFormat(before, {
        ...formatter.options,
      });
      if (formatted.length > MAX_MARKDOWN_LENGTH) {
        this.reportFormatSkip(document, "The formatted Markdown is too large.");
        return edits;
      }
      await this.validateMarkdown(formatted, state.profile, true);
      if (document.version !== version) return edits;
      const change = minimalChange(document, formatted);
      if (change)
        edits.push(vscode.TextEdit.replace(change.range, change.text));
      const endOfLine = endOfLineForFormatter(formatter.options);
      if (endOfLine !== undefined)
        edits.push(vscode.TextEdit.setEndOfLine(endOfLine));
    } catch (error) {
      this.reportFormatSkip(
        document,
        errorMessage(error, "Markdown formatting could not be validated."),
      );
    }
    return edits;
  }

  private async onMessage(
    session: PanelSession,
    value: unknown,
  ): Promise<void> {
    const message = parseWebviewMessage(value);
    if (!message) {
      this.post(
        session,
        this.errorMessage("Malformed or unsupported webview message."),
      );
      return;
    }
    if (!session.ready && message.type !== "ready") {
      this.post(
        session,
        this.errorMessage(
          "The webview must complete its ready handshake first.",
        ),
      );
      return;
    }
    if (
      session.mode === "preview" &&
      message.type !== "ready" &&
      message.type !== "preview" &&
      message.type !== "clipboard-write" &&
      message.type !== "notify"
    ) {
      this.post(
        session,
        this.errorMessage("The dedicated preview is read-only."),
      );
      return;
    }
    switch (message.type) {
      case "ready":
        session.ready = true;
        this.sendDocumentIfVisible(session, "initial");
        if (session.mode === "preview") this.requestPreviewRender(session);
        return;
      case "edit":
        await this.enqueue(session.state, () =>
          this.handleEdit(session, message),
        );
        return;
      case "clipboard-write":
        await this.handleClipboardWrite(session, message);
        return;
      case "open-link":
        await this.handleOpenLink(session, message);
        return;
      case "workspace-file-search":
        await this.handleWorkspaceFileSearch(session, message);
        return;
      case "workspace-file-search-warmup":
        this.workspaceFileSearch.warmup(
          session.state.uri,
          vscode.workspace.getWorkspaceFolder(session.state.uri),
        );
        return;
      case "image-import":
        await this.enqueue(session.state, () =>
          this.handleImageImport(session, message),
        );
        return;
      case "image-import-uri":
        await this.enqueue(session.state, () =>
          this.handleImageImportUri(session, message),
        );
        return;
      case "notify":
        this.notifyUser(message);
        return;
      case "recoverDraft":
        await this.enqueue(session.state, () =>
          this.handleRecoverDraft(session, message),
        );
        return;
      case "undo":
        await this.enqueue(session.state, () =>
          this.handleUndoRedo(
            session,
            message.type,
            message.baseVersion,
            message.operationId,
          ),
        );
        return;
      case "redo":
        await this.enqueue(session.state, () =>
          this.handleUndoRedo(
            session,
            message.type,
            message.baseVersion,
            message.operationId,
          ),
        );
        return;
      case "format":
        await this.enqueue(session.state, () =>
          this.handleFormat(
            session,
            session.state,
            message.baseVersion,
            message.operationId,
          ),
        );
        return;
      case "save":
        await this.enqueue(session.state, () =>
          this.handleSave(session, message),
        );
        return;
      case "set-profile":
        await this.enqueue(session.state, () =>
          this.handleSetProfile(session, message),
        );
        return;
      case "source":
        try {
          await this.openSource(session.state.uri, session.panel.viewColumn);
        } catch (error) {
          this.post(
            session,
            this.errorMessage(
              errorMessage(
                error,
                "The standard source editor could not be opened.",
              ),
              message.operationId,
            ),
          );
        }
        return;
      case "preview":
        await this.openPreview(session.state.uri);
        return;
    }
  }

  private async handleEdit(
    session: PanelSession,
    message: Extract<WebviewMessage, { type: "edit" }>,
  ): Promise<void> {
    const state = session.state;
    const document = await this.currentDocument(state);
    if (document.version !== message.baseVersion) {
      this.rejectEdit(
        session,
        message.operationId,
        "stale",
        "The Markdown document changed before this edit arrived.",
        message.markdown,
      );
      if (session) this.sendDocumentIfVisible(session, "external");
      return;
    }
    await this.applyCandidate(
      session,
      state,
      document,
      message.markdown,
      message.operationId,
      "edit",
      message.baseVersion,
    );
  }

  private async handleClipboardWrite(
    session: PanelSession,
    message: ClipboardWriteMessage,
  ): Promise<void> {
    const result: ClipboardResultMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "clipboard-result",
      requestId: message.requestId,
      success: false,
    };
    try {
      await vscode.env.clipboard.writeText(message.text);
      this.post(session, { ...result, success: true });
    } catch (error) {
      this.post(session, {
        ...result,
        message: errorMessage(
          error,
          "VS Code could not write to the clipboard.",
        ).slice(0, 1_024),
      });
    }
  }

  private async handleOpenLink(
    session: PanelSession,
    message: Extract<WebviewMessage, { type: "open-link" }>,
  ): Promise<void> {
    if (!isSafeLinkHref(message.href)) {
      void vscode.window.showWarningMessage("The link could not be opened.");
      return;
    }

    const target = classifyLinkNavigation(
      message.href,
      session.state.uri,
      vscode.workspace.getWorkspaceFolder(session.state.uri),
    );
    if (target.kind === "fragment") return;
    if (target.kind === "invalid") {
      const text =
        target.reason === "workspace-required"
          ? `The link target could not be resolved outside a workspace: ${message.href}`
          : target.reason === "unsupported-scheme" ||
              target.reason === "network-path"
            ? `The link target is not allowed: ${message.href}`
            : `The link target could not be opened: ${message.href}`;
      void vscode.window.showWarningMessage(text);
      return;
    }

    if (target.kind === "external") {
      try {
        const opened = await vscode.env.openExternal(target.uri);
        if (!opened)
          void vscode.window.showWarningMessage(
            `The link target could not be opened: ${message.href}`,
          );
      } catch {
        void vscode.window.showWarningMessage(
          `The link target could not be opened: ${message.href}`,
        );
      }
      return;
    }

    const fileUri = target.uri.with({ query: "", fragment: "" });
    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      void vscode.window.showWarningMessage(
        `Link target was not found: ${message.href}`,
      );
      return;
    }
    try {
      await vscode.commands.executeCommand("vscode.open", target.uri);
    } catch {
      void vscode.window.showWarningMessage(
        `The link target could not be opened: ${message.href}`,
      );
    }
  }

  private async handleWorkspaceFileSearch(
    session: PanelSession,
    message: WorkspaceFileSearchMessage,
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      session.state.uri,
    );
    const candidates = await this.workspaceFileSearch.searchFiles(
      session.state.uri,
      workspaceFolder,
      message.query,
      message.filter,
    );
    const result: WorkspaceFileSearchResultMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "workspace-file-search-result",
      requestId: message.requestId,
      candidates,
    };
    if (this.sessions.get(session.panel) === session)
      this.post(session, result);
  }

  private async handleImageImport(
    session: PanelSession,
    message: ImageImportMessage,
  ): Promise<void> {
    const result = await saveImageImport(session.state.uri, message, {
      fs: vscode.workspace.fs,
      joinPath: (base, ...parts) => vscode.Uri.joinPath(base, ...parts),
    });
    const response: HostMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: message.requestId,
      ...(result.success
        ? { success: true, relativePath: result.relativePath }
        : { success: false, message: result.message.slice(0, 1_024) }),
    };
    this.post(session, response);
  }

  private async handleImageImportUri(
    session: PanelSession,
    message: ImageImportUriMessage,
  ): Promise<void> {
    const result = await saveImageImportUri(
      session.state.uri,
      message.resourceUri,
      message.requestId,
      {
        fs: vscode.workspace.fs,
        resource: vscode.workspace.fs,
        joinPath: (base, ...parts) => vscode.Uri.joinPath(base, ...parts),
        parseUri: (value) => {
          try {
            return vscode.Uri.parse(value);
          } catch {
            return undefined;
          }
        },
        isWorkspaceResource: (uri) =>
          Boolean(vscode.workspace.getWorkspaceFolder(uri)),
      },
    );
    const response: HostMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: message.requestId,
      ...(result.success
        ? { success: true, relativePath: result.relativePath }
        : { success: false, message: result.message.slice(0, 1_024) }),
    };
    this.post(session, response);
  }

  private notifyUser(message: UserNotificationMessage): void {
    const method =
      message.level === "error"
        ? "showErrorMessage"
        : message.level === "warning"
          ? "showWarningMessage"
          : "showInformationMessage";
    const show = (
      vscode.window as unknown as Record<
        string,
        ((value: string) => Thenable<unknown>) | undefined
      >
    )[method];
    if (show)
      void show.call(vscode.window, `Markdown Mint: ${message.message}`);
  }

  private async handleRecoverDraft(
    session: PanelSession,
    message: RecoverDraftMessage,
  ): Promise<void> {
    const state = session.state;
    const document = await this.currentDocument(state);
    if (document.version !== message.baseVersion) {
      this.rejectEdit(
        session,
        message.operationId,
        "stale",
        "The Markdown document changed before the draft could be opened.",
        message.markdown,
      );
      this.sendDocumentIfVisible(session, "external");
      return;
    }
    try {
      await this.validateMarkdown(message.markdown, state.profile);
      const draft = await vscode.workspace.openTextDocument({
        content: message.markdown,
        language: "markdown",
      });
      await vscode.window.showTextDocument(draft, { preview: false });
      const opened: HostMessage = {
        protocolVersion: PROTOCOL_VERSION,
        type: "recovery-opened",
        operationId: message.operationId,
        currentMarkdown: document.getText(),
        currentVersion: document.version,
        profile: state.profile,
        draftUri: draft.uri.toString(true),
      };
      this.post(session, opened);
      // The original panel remains bound to its TextDocument. The UI reloads
      // this authoritative snapshot after the separate draft is opened.
      this.sendDocumentIfVisible(session, "recovery");
    } catch (error) {
      this.rejectEdit(
        session,
        message.operationId,
        "invalid",
        errorMessage(error, "The recovery draft could not be opened."),
        message.markdown,
      );
    }
  }

  private async handleSetProfile(
    session: PanelSession,
    message: SetProfileMessage,
  ): Promise<void> {
    const state = session.state;
    const document = await this.currentDocument(state);
    if (document.version !== message.baseVersion) {
      this.post(
        session,
        this.errorMessage(
          "The Markdown document changed before the profile selection arrived.",
          message.operationId,
        ),
      );
      this.sendDocumentIfVisible(session, "external");
      return;
    }

    try {
      const configuration = vscode.workspace.getConfiguration(
        "markdownMint",
        document.uri,
      );
      const target = vscode.workspace.getWorkspaceFolder(document.uri)
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.ConfigurationTarget.Global;
      await configuration.update("profile", message.profile, target);

      const latest = await this.currentDocument(state);
      if (latest.version !== message.baseVersion) {
        this.post(
          session,
          this.errorMessage(
            "The Markdown document changed while the profile was being saved.",
            message.operationId,
          ),
        );
        this.sendDocumentIfVisible(session, "external");
        return;
      }
      state.profile = this.profileFor(latest.uri);
      if (state.profile !== message.profile) {
        throw new Error(
          "VS Code did not persist the selected Markdown profile.",
        );
      }
      for (const panelSession of state.panels) {
        const isRequester = panelSession === session;
        this.sendDocumentIfVisible(
          panelSession,
          isRequester ? "ack" : "external",
          isRequester ? message.operationId : undefined,
        );
        if (panelSession.mode === "preview")
          this.requestPreviewRender(panelSession);
      }
    } catch (error) {
      this.post(
        session,
        this.errorMessage(
          errorMessage(error, "The Markdown profile could not be saved."),
          message.operationId,
        ),
      );
    }
  }

  private async handleFormat(
    session: PanelSession | undefined,
    state: DocumentState,
    baseVersion: number,
    operationId: string,
  ): Promise<void> {
    const document = await this.currentDocument(state);
    if (document.version !== baseVersion) {
      this.rejectFormat(
        session,
        operationId,
        "stale",
        "The Markdown document changed before formatting started.",
      );
      if (session) this.sendDocumentIfVisible(session, "external");
      return;
    }
    const before = document.getText();
    try {
      const formatter = await this.formatterOptions(
        document.uri,
        state.profile,
      );
      if (formatter.ignored) {
        this.reportFormatSkip(
          document,
          "Formatting was skipped because .prettierignore matches this file.",
        );
        this.rejectFormat(
          session,
          operationId,
          "ignored",
          "Formatting was skipped because .prettierignore matches this file.",
        );
        return;
      }
      await this.validateMarkdown(before, state.profile, true);
      const formatted = await this.callFormat(before, {
        ...formatter.options,
      });
      if (formatted.length > MAX_MARKDOWN_LENGTH) {
        this.rejectFormat(
          session,
          operationId,
          "too-large",
          "The formatted Markdown is too large.",
        );
        return;
      }
      await this.validateMarkdown(formatted, state.profile, true);
      await this.applyCandidate(
        session,
        state,
        document,
        formatted,
        operationId,
        "format",
        baseVersion,
        formatter.options.endOfLine,
      );
    } catch (error) {
      this.reportFormatSkip(
        document,
        errorMessage(error, "Markdown formatting could not be validated."),
      );
      this.rejectFormat(
        session,
        operationId,
        "invalid",
        errorMessage(error, "Markdown formatting could not be validated."),
      );
    }
  }

  /**
   * Save is serialized with edits and formatting so Cmd/Ctrl+S cannot flush a
   * stale webview draft. The TextDocument remains the sole source of truth;
   * the result reports the version and dirty state observed after VS Code's
   * complete save pipeline (including onWillSave format-on-save edits).
   */
  private async handleSave(
    session: PanelSession,
    message: SaveMessage,
  ): Promise<void> {
    const state = session.state;
    const document = await this.currentDocument(state);
    if (document.version !== message.baseVersion) {
      this.reportSaveFailure(
        document,
        "The Markdown document changed before it could be saved.",
      );
      this.postSaveResult(
        session,
        message.operationId,
        false,
        document,
        message.baseVersion,
        "The Markdown document changed before it could be saved.",
      );
      this.sendDocumentIfVisible(session, "external");
      return;
    }

    let saved = false;
    let failure: string | undefined;
    try {
      saved = await document.save();
    } catch (error) {
      failure = errorMessage(
        error,
        "VS Code could not save the Markdown document.",
      );
    }

    const latest = await this.currentDocument(state);
    if (!saved) {
      const messageText =
        failure ?? "VS Code did not save the Markdown document.";
      this.reportSaveFailure(latest, messageText);
      this.postSaveResult(
        session,
        message.operationId,
        false,
        latest,
        message.baseVersion,
        messageText,
      );
      return;
    }

    this.postSaveResult(
      session,
      message.operationId,
      true,
      latest,
      message.baseVersion,
    );
    this.broadcastDocument(state, {
      reason: "save",
      operationId: message.operationId,
    });
  }

  private postSaveResult(
    session: PanelSession,
    operationId: string,
    saved: boolean,
    document: vscode.TextDocument,
    requestedVersion: number,
    message?: string,
  ): void {
    const result: SaveResultMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "save-result",
      operationId,
      saved,
      requestedVersion,
      ...(saved && !document.isDirty ? { savedVersion: document.version } : {}),
      version: document.version,
      isDirty: document.isDirty,
      ...(message
        ? { message: message.slice(0, MAX_OPERATION_ID_LENGTH) }
        : {}),
    };
    this.post(session, result);
  }

  private async handleUndoRedo(
    session: PanelSession,
    action: "undo" | "redo",
    baseVersion: number | undefined,
    operationId: string,
  ): Promise<void> {
    const state = session.state;
    const document = await this.currentDocument(state);
    if (baseVersion !== undefined && document.version !== baseVersion) {
      this.rejectEdit(
        session,
        operationId,
        "stale",
        "The Markdown document changed before undo/redo started.",
      );
      return;
    }
    // Custom editors are backed by VS Code's resource undo service. Make the
    // requested panel active so the built-in command resolves the same resource
    // that originated the request, then wait for TextDocument's authoritative
    // change event before acknowledging it.
    if (!session.panel.active)
      session.panel.reveal(session.panel.viewColumn, false);
    if (!session.panel.active) {
      this.rejectEdit(
        session,
        operationId,
        "apply-failed",
        "The Markdown editor is not active for undo/redo.",
      );
      return;
    }
    state.pendingCommand = {
      operationId,
      baseVersion: document.version,
      action,
    };
    try {
      await vscode.commands.executeCommand(action);
    } catch (error) {
      delete state.pendingCommand;
      this.rejectEdit(
        session,
        operationId,
        "apply-failed",
        errorMessage(error, `VS Code could not ${action} the document.`),
      );
      return;
    }
    const after = await this.currentDocument(state);
    if (state.pendingCommand && after.version === document.version) {
      // No native history entry was available. An acknowledgement with the
      // unchanged authoritative snapshot keeps every panel in sync.
      delete state.pendingCommand;
      this.broadcastDocument(state, { reason: action, operationId });
    }
  }

  private async applyCandidate(
    session: PanelSession | undefined,
    state: DocumentState,
    document: vscode.TextDocument,
    candidate: string,
    operationId: string,
    action: EditAction,
    expectedVersion?: number,
    endOfLineOption?: unknown,
  ): Promise<void> {
    if (candidate.length > MAX_MARKDOWN_LENGTH) {
      this.rejectEdit(
        session,
        operationId,
        "too-large",
        "The Markdown source is too large.",
        candidate,
      );
      return;
    }
    if (expectedVersion !== undefined && document.version !== expectedVersion) {
      this.rejectEdit(
        session,
        operationId,
        "stale",
        "The Markdown document changed before this edit was applied.",
        candidate,
      );
      return;
    }
    const before = document.getText();
    if (candidate === before) {
      this.broadcastDocument(state, {
        reason: action === "edit" ? "ack" : action,
        operationId,
      });
      return;
    }
    try {
      await this.validateMarkdown(candidate, state.profile);
    } catch (error) {
      this.rejectEdit(
        session,
        operationId,
        "invalid",
        errorMessage(error, "The Markdown candidate is invalid."),
        candidate,
      );
      return;
    }
    const latest = await this.currentDocument(state);
    if (expectedVersion !== undefined && latest.version !== expectedVersion) {
      this.rejectEdit(
        session,
        operationId,
        "stale",
        "The Markdown document changed while this edit was validated.",
        candidate,
      );
      return;
    }
    document = latest;
    if (document.getText() === candidate) {
      this.broadcastDocument(state, {
        reason: action === "edit" ? "ack" : action,
        operationId,
      });
      return;
    }
    const eol = endOfLineForFormatter(endOfLineOption);
    const intermediateMarkdown =
      eol === undefined
        ? undefined
        : normalizeLineEndings(candidate, document.eol);
    const pending: PendingEdit = {
      operationId,
      baseVersion: document.version,
      targetMarkdown: candidate,
      action,
      ...(session ? { session } : {}),
      ...(intermediateMarkdown && intermediateMarkdown !== candidate
        ? { intermediateMarkdown }
        : {}),
    };
    state.pending.set(operationId, pending);
    const edit = new vscode.WorkspaceEdit();
    const change = minimalChange(document, candidate);
    if (!change) {
      state.pending.delete(operationId);
      this.broadcastDocument(state, {
        reason: action === "edit" ? "ack" : action,
        operationId,
      });
      return;
    }
    if (eol === undefined)
      edit.replace(document.uri, change.range, change.text);
    else {
      edit.set(document.uri, [
        vscode.TextEdit.replace(change.range, change.text),
        vscode.TextEdit.setEndOfLine(eol),
      ]);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      state.pending.delete(operationId);
      this.rejectEdit(
        session,
        operationId,
        "apply-failed",
        "VS Code did not apply the Markdown edit.",
        candidate,
      );
      return;
    }

    // Usually onDidChangeTextDocument has already committed the pending entry.
    // The fallback covers hosts that report applyEdit before dispatching the event.
    const current = await this.currentDocument(state);
    if (current.getText() === candidate && state.pending.delete(operationId)) {
      state.version = current.version;
      this.broadcastDocument(state, {
        reason: action === "edit" ? "ack" : action,
        operationId,
      });
    } else if (
      current.getText() !== candidate &&
      state.pending.has(operationId)
    ) {
      state.pending.delete(operationId);
      this.rejectEdit(
        session,
        operationId,
        "stale",
        "The document changed while the edit was being applied.",
        candidate,
      );
    }
  }

  private previewPanelVisible(session: PanelSession): boolean {
    const panel = session.panel as vscode.WebviewPanel & {
      visible?: boolean;
    };
    return panel.visible !== false;
  }

  private previewStateKey(
    session: PanelSession,
    document: vscode.TextDocument = session.state.document,
  ): string {
    const resource = this.resourceInfo(document.uri, session.panel.webview);
    const typography = this.typographyFor(document.uri);
    return JSON.stringify([
      document.getText(),
      session.state.profile,
      resource.baseUrl ?? "",
      typography.fontFamily,
      typography.fontSize,
      typography.lineHeight,
    ]);
  }

  private requestPreviewRender(session: PanelSession): void {
    if (session.mode !== "preview") return;
    if (!session.ready || !this.previewPanelVisible(session)) {
      session.previewDirty = true;
      return;
    }
    const key = this.previewStateKey(session);
    if (session.previewRenderKey === key) {
      session.previewDirty = false;
      return;
    }
    session.previewDirty = true;
    const generation = ++session.previewRenderGeneration;
    void this.renderIntoPanel(session, generation);
  }

  private async renderIntoPanel(
    session: PanelSession,
    generation: number,
  ): Promise<void> {
    if (
      session.mode !== "preview" ||
      !session.ready ||
      !this.previewPanelVisible(session)
    )
      return;
    const document = await this.currentDocument(session.state);
    const markdown = document.getText();
    const version = document.version;
    const profile = session.state.profile;
    const resource = this.resourceInfo(document.uri, session.panel.webview);
    const typography = this.typographyFor(document.uri);
    const key = JSON.stringify([
      markdown,
      profile,
      resource.baseUrl ?? "",
      typography.fontFamily,
      typography.fontSize,
      typography.lineHeight,
    ]);
    if (session.previewRenderKey === key) {
      session.previewDirty = false;
      return;
    }
    try {
      const rendered = await Promise.resolve(renderMarkdown(markdown, profile));
      const html = rewriteNativeImageUris(extractHtml(rendered), {
        currentDocument: document.uri,
        resourceProvider: {
          asWebviewUri: (uri: vscode.Uri) =>
            session.panel.webview.asWebviewUri(uri),
        },
      });
      if (
        generation !== session.previewRenderGeneration ||
        !this.previewPanelVisible(session) ||
        session.state.profile !== profile ||
        session.state.document.version !== version ||
        session.state.document.getText() !== markdown
      ) {
        session.previewDirty = true;
        return;
      }
      const message: HostMessage = {
        protocolVersion: PROTOCOL_VERSION,
        type: "preview",
        markdown,
        html,
        version,
        profile,
        clipboardAvailable: true,
        typography,
        ...(resource.baseUrl ? { resourceBaseUrl: resource.baseUrl } : {}),
      };
      this.post(session, message);
      session.previewRenderKey = key;
      session.previewDirty = false;
    } catch (error) {
      if (generation !== session.previewRenderGeneration) return;
      this.post(
        session,
        this.errorMessage(errorMessage(error, "Preview rendering failed.")),
      );
    }
  }

  private sendDocumentIfVisible(
    session: PanelSession,
    reason: HostDocumentReason,
    operationId?: string,
    draftMarkdown?: string,
  ): void {
    if (session.mode === "preview" && !this.previewPanelVisible(session)) {
      // A retained preview can be stale while hidden. Do not make its webview
      // parse or replace DOM for a snapshot the user cannot see; the next
      // visibility event requests the current source/profile/resource state.
      session.previewDirty = true;
      session.previewRenderGeneration += 1;
      return;
    }
    this.sendDocument(session, reason, operationId, draftMarkdown);
  }

  private sendDocument(
    session: PanelSession,
    reason: HostDocumentReason,
    operationId?: string,
    draftMarkdown?: string,
  ): void {
    const document = session.state.document;
    const resource = this.resourceInfo(document.uri, session.panel.webview);
    const message: DocumentMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: document.getText(),
      version: document.version,
      profile: session.state.profile,
      documentId: session.state.key,
      reason,
      mode: session.mode,
      clipboardAvailable: true,
      typography: this.typographyFor(document.uri),
      ...(operationId ? { operationId } : {}),
      ...(resource.baseUrl ? { resourceBaseUrl: resource.baseUrl } : {}),
      ...(draftMarkdown === undefined ? {} : { draftMarkdown }),
    };
    this.post(session, message);
  }

  private broadcastDocument(
    state: DocumentState,
    details: {
      reason: HostDocumentReason;
      operationId?: string;
      draftMarkdown?: string;
    },
  ): void {
    for (const session of state.panels) {
      this.sendDocumentIfVisible(
        session,
        details.reason,
        details.operationId,
        details.draftMarkdown,
      );
      if (session.mode === "preview") this.requestPreviewRender(session);
    }
  }

  private rejectEdit(
    session: PanelSession | undefined,
    operationId: string,
    reason: EditRejectedMessage["reason"],
    message: string,
    draftMarkdown?: string,
  ): void {
    const state = session?.state;
    if (!state) return;
    const rejection: EditRejectedMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "edit-rejected",
      operationId,
      reason,
      message,
      currentMarkdown: state.document.getText(),
      currentVersion: state.document.version,
      ...(draftMarkdown === undefined ? {} : { draftMarkdown }),
    };
    this.post(session, rejection);
  }

  private rejectFormat(
    session: PanelSession | undefined,
    operationId: string,
    reason: FormatRejectedMessage["reason"],
    message: string,
  ): void {
    if (!session) return;
    const rejection: FormatRejectedMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "format-rejected",
      operationId,
      reason,
      message,
      currentMarkdown: session.state.document.getText(),
      currentVersion: session.state.document.version,
    };
    this.post(session, rejection);
  }

  private post(session: PanelSession, message: HostMessage): void {
    void session.panel.webview.postMessage(message);
  }

  private errorMessage(message: string, operationId?: string): ErrorMessage {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      message,
      ...(operationId ? { operationId } : {}),
    };
  }

  private async currentDocument(
    state: DocumentState,
  ): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument(state.uri);
    state.document = document;
    state.version = document.version;
    state.eol = document.eol;
    return document;
  }

  private async resolveTargetDocument(
    uri?: vscode.Uri,
  ): Promise<vscode.TextDocument | undefined> {
    const candidate =
      uri ??
      this.lastDocumentUri ??
      vscode.window.activeTextEditor?.document.uri;
    if (!candidate) return undefined;
    try {
      const document = await vscode.workspace.openTextDocument(candidate);
      return isMarkdownDocument(document) ? document : undefined;
    } catch {
      return undefined;
    }
  }

  private profileFor(uri: vscode.Uri): MarkdownProfile {
    const configured = vscode.workspace
      .getConfiguration("markdownMint", uri)
      .get<string>("profile", "github");
    return isMarkdownProfile(configured) ? configured : "github";
  }

  private async formatterOptions(
    uri: vscode.Uri,
    profile: MarkdownProfile,
  ): Promise<FormatterConfigResult> {
    const extensionOptions = this.explicitPrettierOptions(uri);
    let project: FormatterConfigResult = {
      options: {},
      ignored: false,
      diagnostics: [],
    };
    const workspaceFs = (
      vscode.workspace as unknown as {
        fs?: { readFile(uri: vscode.Uri): Thenable<Uint8Array> };
      }
    ).fs;
    if (uri.scheme === "file" && workspaceFs) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      const fileSystem = {
        readFile: async (filePath: string): Promise<string | undefined> => {
          try {
            const bytes = await workspaceFs.readFile(vscode.Uri.file(filePath));
            return new TextDecoder().decode(bytes);
          } catch {
            return undefined;
          }
        },
      };
      project = await loadFormatterConfig(uri.fsPath, fileSystem, {
        isTrusted: vscode.workspace.isTrusted,
        ...(workspaceFolder?.uri.fsPath
          ? { workspaceRoot: workspaceFolder.uri.fsPath }
          : {}),
        resolver: {
          // Prettier identifies the nearest config using its own search rules;
          // the config is read through workspace.fs below so remote and
          // sandboxed extension hosts never receive an arbitrary Node stream.
          resolveConfigFile: async (filePath) => {
            try {
              const prettier = await import("prettier");
              const resolved = await prettier.resolveConfigFile(filePath);
              return resolved ?? undefined;
            } catch {
              return undefined;
            }
          },
          resolveTrustedConfig: async (filePath) => {
            if (!vscode.workspace.isTrusted) return undefined;
            const prettier = await import("prettier");
            const resolved = await prettier.resolveConfig(filePath, {
              editorconfig: false,
            });
            return isRecord(resolved) ? resolved : undefined;
          },
        },
      });
    }
    for (const diagnostic of project.diagnostics)
      this.output.appendLine(`[formatter] ${diagnostic}`);
    const options = {
      ...project.options,
      ...extensionOptions,
      markdownProfile: profile,
    };
    return { ...project, options };
  }

  private explicitPrettierOptions(uri: vscode.Uri): Record<string, unknown> {
    const configuration = vscode.workspace.getConfiguration(
      "markdownMint",
      uri,
    );
    const inspect = (
      configuration as unknown as {
        inspect?: <T>(section: string) =>
          | {
              globalLanguageValue?: T;
              globalValue?: T;
              workspaceLanguageValue?: T;
              workspaceValue?: T;
              workspaceFolderLanguageValue?: T;
              workspaceFolderValue?: T;
            }
          | undefined;
      }
    ).inspect;
    const inspected = inspect?.call(configuration, "prettierOptions");
    const values = inspected
      ? [
          inspected.globalLanguageValue,
          inspected.globalValue,
          inspected.workspaceLanguageValue,
          inspected.workspaceValue,
          inspected.workspaceFolderLanguageValue,
          inspected.workspaceFolderValue,
        ]
      : [configuration.get<Record<string, unknown>>("prettierOptions", {})];
    const result: Record<string, unknown> = {};
    for (const value of values) {
      if (value && typeof value === "object" && !Array.isArray(value))
        Object.assign(result, value);
    }
    return result;
  }

  private reportFormatSkip(
    document: vscode.TextDocument,
    reason: string,
  ): void {
    const location = document.uri.toString(true);
    this.output.appendLine(`[format] ${location}: ${reason}`);
  }

  private reportSaveFailure(
    document: vscode.TextDocument,
    reason: string,
  ): void {
    const location = document.uri.toString(true);
    const message = `Markdown Mint: ${reason}`;
    this.output.appendLine(`[save] ${location}: ${reason}`);
    const showErrorMessage = (
      vscode.window as unknown as {
        showErrorMessage?: (value: string) => Thenable<unknown>;
      }
    ).showErrorMessage;
    if (showErrorMessage) void showErrorMessage(message);
  }

  private typographyFor(uri: vscode.Uri): PreviewTypography {
    const configuration = vscode.workspace.getConfiguration(
      "markdown.preview",
      uri,
    );
    const fontFamily = configuration.get<string>(
      "fontFamily",
      "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, sans-serif",
    );
    const fontSize = boundedNumber(
      configuration.get<number>("fontSize", 14),
      14,
      1,
      96,
    );
    const lineHeight = boundedNumber(
      configuration.get<number>("lineHeight", 1.6),
      1.6,
      0.1,
      8,
    );
    return {
      fontFamily: fontFamily.slice(0, 1_024),
      fontSize,
      lineHeight,
    };
  }

  private async validateMarkdown(
    source: string,
    profile: MarkdownProfile,
    strict = false,
  ): Promise<void> {
    if (source.length > MAX_MARKDOWN_LENGTH)
      throw new Error("Markdown source is too large.");
    let parsed: unknown;
    try {
      parsed = await Promise.resolve(parseMarkdown(source, profile));
    } catch (error) {
      const reason = errorMessage(error, "Markdown parsing failed.");
      this.output.appendLine(`[parse] ${reason}`);
      if (strict) throw error;
      // A parser limitation must not prevent the TextDocument from accepting
      // ordinary source edits. Formatting remains strict because applying a
      // formatter result that cannot be parsed would be an unsafe transform.
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      const reason = "The Markdown parser returned no document.";
      this.output.appendLine(`[parse] ${reason}`);
      if (strict) throw new Error(reason);
      return;
    }
    const candidate = parsed as CoreParseResult;
    if (candidate.valid === false) {
      if (!strict) {
        this.output.appendLine(
          "[parse] The Markdown candidate failed validation.",
        );
        return;
      }
      throw new Error("The Markdown candidate failed validation.");
    }
    if (candidate.errors && candidate.errors.length > 0) {
      if (!strict) {
        this.output.appendLine(
          `[parse] ${candidate.errors.map((entry) => String(entry)).join("; ")}`,
        );
        return;
      }
      throw new Error(
        candidate.errors.map((entry) => String(entry)).join("; "),
      );
    }
  }

  private async callFormat(
    source: string,
    options: Record<string, unknown>,
  ): Promise<string> {
    const result = await Promise.resolve(formatMarkdown(source, options));
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const candidate = result as CoreFormatResult;
      if (typeof candidate.source === "string") return candidate.source;
      if (typeof candidate.markdown === "string") return candidate.markdown;
    }
    throw new Error("The Markdown formatter returned no source.");
  }

  private webviewOptions(
    documentUri: vscode.Uri,
    webview: vscode.Webview,
  ): vscode.WebviewOptions {
    const resources = this.resourceInfo(documentUri, webview);
    return {
      enableScripts: true,
      localResourceRoots: resources.roots,
    };
  }

  private resourceInfo(
    documentUri: vscode.Uri,
    webview: vscode.Webview,
  ): ResourceInfo {
    const roots: vscode.Uri[] = [
      vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      vscode.Uri.joinPath(this.context.extensionUri, "media"),
    ];
    if (documentUri.scheme !== "file") return { roots };
    const documentDirectory = vscode.Uri.file(path.dirname(documentUri.fsPath));
    roots.push(documentDirectory);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (workspaceFolder) roots.push(workspaceFolder.uri);
    return {
      roots,
      baseUrl: `${webview.asWebviewUri(documentDirectory).toString()}/`,
    };
  }

  private webviewHtml(webview: vscode.Webview, mode: PanelMode): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const stylesheetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "document.css"),
    );
    const katexStylesheetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "katex",
        "katex.css",
      ),
    );
    const mermaidScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "mermaid.js"),
    );
    const uiStylesheetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"),
    );
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(webviewContentSecurityPolicy(webview.cspSource, nonce))}">
  <link rel="stylesheet" href="${escapeAttribute(stylesheetUri.toString())}">
  <link rel="stylesheet" href="${escapeAttribute(katexStylesheetUri.toString())}">
  <link rel="stylesheet" href="${escapeAttribute(uiStylesheetUri.toString())}">
  <title>Markdown Mint</title>
</head>
<body data-markdown-mint-mode="${mode}">
  <main id="app" aria-label="Markdown Mint"></main>
  <script nonce="${nonce}" src="${escapeAttribute(mermaidScriptUri.toString())}"></script>
  <script nonce="${nonce}" src="${escapeAttribute(scriptUri.toString())}"></script>
</body>
</html>`;
  }

  private enqueue<T>(state: DocumentState, task: () => Promise<T>): Promise<T> {
    const next = state.queue.then(task, task);
    state.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return (
    document.languageId === "markdown" ||
    /\.(?:md|markdown|mdown)$/i.test(document.fileName)
  );
}

function documentKey(uri: vscode.Uri): string {
  return uri.toString(true);
}

function createOperationId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `${prefix}:${Date.now().toString(36)}:${random}`;
}

function createNonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1)
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return nonce;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNumber(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function endOfLineForFormatter(value: unknown): vscode.EndOfLine | undefined {
  if (value === "crlf") return vscode.EndOfLine.CRLF;
  if (value === "lf") return vscode.EndOfLine.LF;
  return undefined;
}

function normalizeLineEndings(
  source: string,
  endOfLine: vscode.EndOfLine,
): string {
  const separator = endOfLine === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  return source.replace(/\r\n|\r|\n/g, separator);
}

function extractHtml(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const candidate = value as CoreRenderResult;
    if (typeof candidate.html === "string") return candidate.html;
  }
  return "";
}

function nativeSourceFrom(tokens: unknown[]): string | undefined {
  const attached = (tokens as unknown as { [nativeSourceKey]?: unknown })[
    nativeSourceKey
  ];
  if (typeof attached === "string") return attached;
  const first = tokens[0];
  if (first && typeof first === "object") {
    const meta = (first as { meta?: unknown }).meta;
    if (meta && typeof meta === "object") {
      const source = (meta as { markdownMintSource?: unknown })
        .markdownMintSource;
      if (typeof source === "string") return source;
    }
  }
  return undefined;
}

function nativeDocumentUri(env: unknown): vscode.Uri | undefined {
  if (!env || typeof env !== "object") return undefined;
  const value = (env as { currentDocument?: unknown }).currentDocument;
  if (value instanceof vscode.Uri) return value;
  if (typeof value === "string") {
    try {
      return vscode.Uri.parse(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function profileForNativeUri(uri: vscode.Uri | undefined): MarkdownProfile {
  const configured = vscode.workspace
    .getConfiguration("markdownMint", uri)
    .get<string>("profile", "github");
  return isMarkdownProfile(configured) ? configured : "github";
}

function decorateNativeHtml(html: string, tokens: unknown[]): string {
  const lineStarts = tokens
    .filter(
      (value): value is { nesting?: unknown; map?: unknown } =>
        typeof value === "object" && value !== null,
    )
    .filter(
      (value) =>
        value.nesting === 1 &&
        Array.isArray(value.map) &&
        typeof value.map[0] === "number",
    )
    .map((value) => Number((value.map as unknown[])[0]));
  if (lineStarts.length === 0) return html;

  let index = 0;
  return html.replace(
    /<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g,
    (tag, name: string, attributes: string) => {
      if (
        index >= lineStarts.length ||
        /\bdata-line\s*=/.test(attributes) ||
        name.toLowerCase() === "script"
      )
        return tag;
      const line = lineStarts[index];
      index += 1;
      return `<${name}${attributes} data-line="${line}">`;
    },
  );
}

function rewriteNativeImageUris(html: string, env: unknown): string {
  if (!env || typeof env !== "object") return html;
  const provider = (env as { resourceProvider?: unknown }).resourceProvider;
  if (!provider || typeof provider !== "object") return html;
  const asWebviewUri = (provider as { asWebviewUri?: unknown }).asWebviewUri;
  if (typeof asWebviewUri !== "function") return html;
  const documentUri = nativeDocumentUri(env);
  return html.replace(
    /(<img\b[^>]*\bsrc=")([^"]+)(")/gi,
    (whole, prefix: string, source: string, suffix: string) => {
      const resolved = resolveNativeImageUri(source, documentUri);
      if (!resolved) return whole;
      try {
        const webviewUri = (
          asWebviewUri as (uri: vscode.Uri) => vscode.Uri
        ).call(provider, resolved);
        return `${prefix}${escapeAttribute(webviewUri.toString(true))}${suffix}`;
      } catch {
        return whole;
      }
    },
  );
}

function resolveNativeImageUri(
  source: string,
  documentUri: vscode.Uri | undefined,
): vscode.Uri | undefined {
  if (/^(?:https?:|data:|blob:|vscode:|vscode-webview-resource:)/i.test(source))
    return undefined;
  if (/^file:/i.test(source)) {
    try {
      return vscode.Uri.parse(source);
    } catch {
      return undefined;
    }
  }
  if (!documentUri || documentUri.scheme !== "file") return undefined;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  if (source.startsWith("/")) {
    return workspaceFolder
      ? vscode.Uri.joinPath(workspaceFolder.uri, source.slice(1))
      : vscode.Uri.file(source);
  }
  return vscode.Uri.joinPath(
    vscode.Uri.file(path.dirname(documentUri.fsPath)),
    source,
  );
}

function minimalChange(
  document: vscode.TextDocument,
  next: string,
): { range: vscode.Range; text: string } | undefined {
  const before = document.getText();
  if (before === next) return undefined;
  let start = 0;
  const maxPrefix = Math.min(before.length, next.length);
  while (
    start < maxPrefix &&
    before.charCodeAt(start) === next.charCodeAt(start)
  )
    start += 1;

  let beforeEnd = before.length;
  let nextEnd = next.length;
  while (
    beforeEnd > start &&
    nextEnd > start &&
    before.charCodeAt(beforeEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    beforeEnd -= 1;
    nextEnd -= 1;
  }
  return {
    range: new vscode.Range(
      document.positionAt(start),
      document.positionAt(beforeEnd),
    ),
    text: next.slice(start, nextEnd),
  };
}
