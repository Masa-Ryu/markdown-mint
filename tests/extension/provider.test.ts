import { describe, expect, it, vi } from "vitest";
import MarkdownIt from "markdown-it";

const vscode = vi.hoisted(() => {
  type Listener = (...args: never[]) => void;
  class Disposable {
    public constructor(
      public readonly disposeHandler: () => void = () => undefined,
    ) {}
    public dispose(): void {
      this.disposeHandler();
    }
  }
  class Uri {
    public readonly scheme: string;
    public readonly fsPath: string;
    public readonly path: string;
    private constructor(value: string) {
      this.scheme = value.includes(":")
        ? value.slice(0, value.indexOf(":"))
        : "file";
      this.fsPath =
        this.scheme === "file" ? value.replace(/^file:\/\//, "") : value;
      this.path = this.fsPath;
    }
    public static file(value: string): Uri {
      return new Uri(value);
    }
    public static parse(value: string): Uri {
      return new Uri(value);
    }
    public static joinPath(base: Uri, ...parts: string[]): Uri {
      return new Uri(
        `${base.scheme === "file" ? "file://" : ""}${[base.fsPath, ...parts].join("/")}`,
      );
    }
    public toString(): string {
      return this.scheme === "file" ? `file://${this.fsPath}` : this.fsPath;
    }
  }
  class Position {
    public constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }
  class Range {
    public constructor(
      public readonly start: Position,
      public readonly end: Position,
    ) {}
  }
  class TextEdit {
    private constructor(
      public readonly range: Range,
      public readonly text: string,
    ) {}
    public static replace(range: Range, text: string): TextEdit {
      return new TextEdit(range, text);
    }
    public static setEndOfLine(_eol: number): TextEdit {
      return new TextEdit(
        new Range(new Position(0, 0), new Position(0, 0)),
        "",
      );
    }
  }
  class WorkspaceEdit {
    public readonly entries: Array<{ uri: Uri; range: Range; text: string }> =
      [];
    public replace(uri: Uri, range: Range, text: string): void {
      this.entries.push({ uri, range, text });
    }
    public set(uri: Uri, edits: readonly TextEdit[]): void {
      for (const edit of edits) {
        if (edit.text.length > 0) this.replace(uri, edit.range, edit.text);
      }
    }
  }
  class TextDocument {
    public languageId = "markdown";
    public isDirty = false;
    public eol = 1;
    public constructor(
      public readonly uri: Uri,
      private text: string,
      public version = 1,
      public readonly fileName = uri.fsPath,
    ) {}
    public getText(): string {
      return this.text;
    }
    public positionAt(offset: number): Position {
      const prefix = this.text.slice(0, offset);
      const lines = prefix.split(/\r?\n/);
      return new Position(lines.length - 1, lines.at(-1)?.length ?? 0);
    }
    public replaceText(value: string): void {
      this.text = value;
      this.version += 1;
      this.isDirty = true;
    }
    public async save(): Promise<boolean> {
      this.isDirty = false;
      return true;
    }
    public reset(value: string, nextVersion = 1): void {
      this.text = value;
      this.version = nextVersion;
      this.isDirty = false;
    }
  }
  type TextDocumentChangeEvent = {
    document: TextDocument;
    reason?: number;
    contentChanges: readonly unknown[];
  };
  class Webview {
    public cspSource = "https://webview.test";
    public options: unknown;
    public html = "";
    public readonly messages: unknown[] = [];
    private listener: ((value: unknown) => void) | undefined;
    public onDidReceiveMessage(listener: (value: unknown) => void): Disposable {
      this.listener = listener;
      return new Disposable(() => {
        this.listener = undefined;
      });
    }
    public asWebviewUri(uri: Uri): Uri {
      return uri;
    }
    public async postMessage(value: unknown): Promise<boolean> {
      this.messages.push(value);
      return true;
    }
    public receive(value: unknown): void {
      this.listener?.(value);
    }
  }
  class WebviewPanel {
    public readonly webview = new Webview();
    public active = true;
    public viewColumn = 2;
    private disposeListener: Listener | undefined;
    public onDidDispose(listener: Listener): Disposable {
      this.disposeListener = listener;
      return new Disposable(() => {
        this.disposeListener = undefined;
      });
    }
    public reveal(): void {
      this.active = true;
    }
    public dispose(): void {
      this.disposeListener?.();
    }
  }

  const documentUri = Uri.file("/workspace/doc.md");
  const document = new TextDocument(documentUri, "# Original");
  const textDocumentListeners: Array<(event: TextDocumentChangeEvent) => void> =
    [];
  const saveListeners: Array<
    (event: {
      document: TextDocument;
      waitUntil(value: Promise<unknown>): void;
    }) => void
  > = [];
  const configurationListeners: Array<
    (event: {
      affectsConfiguration(section: string, uri: Uri): boolean;
    }) => void
  > = [];
  const activeEditorListeners: Array<
    (editor: { document: TextDocument } | undefined) => void
  > = [];
  const workspaceState = {
    formatOnSave: false,
    profile: "github" as string,
    prettierOptions: {} as Record<string, unknown>,
  };
  const previousTexts: string[] = [];
  const redoTexts: string[] = [];
  const panel = new WebviewPanel();
  const outputLines: string[] = [];
  const userNotifications: Array<{
    level: "info" | "warning" | "error";
    message: string;
  }> = [];
  const configurationUpdates: Array<{
    section: string;
    key: string;
    value: unknown;
    target: number;
  }> = [];
  const window = {
    activeTextEditor: { document },
    onDidChangeActiveTextEditor(
      listener: (editor: { document: TextDocument } | undefined) => void,
    ): Disposable {
      activeEditorListeners.push(listener);
      return new Disposable(() => {
        const index = activeEditorListeners.indexOf(listener);
        if (index >= 0) activeEditorListeners.splice(index, 1);
      });
    },
    async showTextDocument(
      value: TextDocument,
    ): Promise<{ document: TextDocument }> {
      window.activeTextEditor = { document: value };
      return { document: value };
    },
    createWebviewPanel(): WebviewPanel {
      return new WebviewPanel();
    },
    async showInformationMessage(
      message?: string,
    ): Promise<string | undefined> {
      if (message) userNotifications.push({ level: "info", message });
      return undefined;
    },
    async showWarningMessage(message: string): Promise<string | undefined> {
      userNotifications.push({ level: "warning", message });
      return undefined;
    },
    async showErrorMessage(message: string): Promise<string | undefined> {
      userNotifications.push({ level: "error", message });
      return undefined;
    },
    createOutputChannel(name: string): {
      name: string;
      appendLine(value: string): void;
      dispose(): void;
    } {
      return {
        name,
        appendLine(value: string): void {
          outputLines.push(value);
        },
        dispose(): void {
          return undefined;
        },
      };
    },
    setStatusBarMessage(): Disposable {
      return new Disposable();
    },
    registerCustomEditorProvider(): Disposable {
      return new Disposable();
    },
    tabGroups: {
      activeTabGroup: {
        viewColumn: 2,
      },
    },
  };
  const workspace = {
    isTrusted: true,
    fs: {
      async readFile(): Promise<Uint8Array> {
        throw new Error("test file does not exist");
      },
    },
    textDocuments: [document],
    onDidChangeTextDocument(
      listener: (event: TextDocumentChangeEvent) => void,
    ): Disposable {
      textDocumentListeners.push(listener);
      return new Disposable(() => {
        const index = textDocumentListeners.indexOf(listener);
        if (index >= 0) textDocumentListeners.splice(index, 1);
      });
    },
    onWillSaveTextDocument(
      listener: (event: {
        document: TextDocument;
        waitUntil(value: Promise<unknown>): void;
      }) => void,
    ): Disposable {
      saveListeners.push(listener);
      return new Disposable(() => {
        const index = saveListeners.indexOf(listener);
        if (index >= 0) saveListeners.splice(index, 1);
      });
    },
    onDidChangeConfiguration(
      listener: (event: {
        affectsConfiguration(section: string, uri: Uri): boolean;
      }) => void,
    ): Disposable {
      configurationListeners.push(listener);
      return new Disposable(() => {
        const index = configurationListeners.indexOf(listener);
        if (index >= 0) configurationListeners.splice(index, 1);
      });
    },
    async openTextDocument(
      value: Uri | { content: string; language: string },
    ): Promise<TextDocument> {
      if (value instanceof Uri) return document;
      const draft = new TextDocument(
        Uri.parse("untitled:recovery.md"),
        value.content,
        1,
        "recovery.md",
      );
      workspace.textDocuments.push(draft);
      return draft;
    },
    async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
      for (const entry of edit.entries) {
        previousTexts.push(document.getText());
        const lines = document.getText().split(/\r?\n/);
        const offsetAt = (position: Position): number => {
          let offset = 0;
          for (let index = 0; index < position.line; index += 1) {
            offset += (lines[index]?.length ?? 0) + 1;
          }
          return offset + position.character;
        };
        const before = document.getText();
        const start = offsetAt(entry.range.start);
        const end = offsetAt(entry.range.end);
        document.replaceText(
          before.slice(0, start) + entry.text + before.slice(end),
        );
      }
      redoTexts.length = 0;
      for (const listener of textDocumentListeners)
        listener({ document, contentChanges: [{}] });
      return true;
    },
    getConfiguration(section: string): {
      get<T>(key: string, fallback?: T): T;
      inspect<T>(key: string):
        | {
            workspaceFolderValue?: T;
          }
        | undefined;
      update<T>(key: string, value: T, target: number): Promise<void>;
    } {
      return {
        get<T>(key: string, fallback?: T): T {
          const value =
            section === "markdownMint"
              ? workspaceState[key as keyof typeof workspaceState]
              : undefined;
          return (value === undefined ? fallback : value) as T;
        },
        inspect<T>(key: string): { workspaceFolderValue?: T } | undefined {
          if (section !== "markdownMint" || key !== "prettierOptions")
            return undefined;
          return { workspaceFolderValue: workspaceState.prettierOptions as T };
        },
        async update<T>(key: string, value: T, target: number): Promise<void> {
          configurationUpdates.push({ section, key, value, target });
          if (section === "markdownMint" && key === "profile") {
            workspaceState.profile = String(value);
          }
        },
      };
    },
    getWorkspaceFolder(): undefined {
      return undefined;
    },
  };
  const TextDocumentChangeReason = { Undo: 1, Redo: 2 } as const;
  const commandCalls: Array<{
    command: string;
    args: readonly unknown[];
  }> = [];
  let openWithError: Error | undefined;
  const commands = {
    async executeCommand(
      command: string,
      ...args: unknown[]
    ): Promise<unknown> {
      commandCalls.push({ command, args });
      if (command === "vscode.openWith" && openWithError) {
        throw openWithError;
      }
      if (command === "undo" && previousTexts.length) {
        redoTexts.push(document.getText());
        document.replaceText(previousTexts.pop() ?? document.getText());
        for (const listener of textDocumentListeners)
          listener({
            document,
            reason: TextDocumentChangeReason.Undo,
            contentChanges: [{}],
          });
      } else if (command === "redo" && redoTexts.length) {
        previousTexts.push(document.getText());
        document.replaceText(redoTexts.pop() ?? document.getText());
        for (const listener of textDocumentListeners)
          listener({
            document,
            reason: TextDocumentChangeReason.Redo,
            contentChanges: [{}],
          });
      }
      return undefined;
    },
    registerCommand(): Disposable {
      return new Disposable();
    },
  };
  const languages = {
    registerDocumentFormattingEditProvider(): Disposable {
      return new Disposable();
    },
  };
  const emitExternal = (value: string): void => {
    document.replaceText(value);
    for (const listener of textDocumentListeners)
      listener({ document, contentChanges: [{}] });
  };
  const emitDirtyState = (): void => {
    document.isDirty = !document.isDirty;
    for (const listener of textDocumentListeners)
      listener({ document, contentChanges: [] });
  };
  const emitEolChange = (): void => {
    document.eol = document.eol === 1 ? 2 : 1;
    for (const listener of textDocumentListeners)
      listener({ document, contentChanges: [] });
  };
  const emitTextChangeWithoutChanges = (value: string): void => {
    document.replaceText(value);
    for (const listener of textDocumentListeners)
      listener({ document, contentChanges: [] });
  };
  const emitNativeHistory = (reason: number, value: string): void => {
    document.replaceText(value);
    for (const listener of textDocumentListeners)
      listener({ document, reason, contentChanges: [{}] });
  };
  const emitConfiguration = (section: string): void => {
    for (const listener of configurationListeners)
      listener({
        affectsConfiguration(candidate: string): boolean {
          return candidate === section;
        },
      });
  };
  const runSave = async (): Promise<unknown> => {
    let result: unknown;
    for (const listener of saveListeners)
      listener({
        document,
        waitUntil(value) {
          result = value;
        },
      });
    return result === undefined ? undefined : await result;
  };
  const reset = (): void => {
    document.reset("# Original");
    document.save = TextDocument.prototype.save.bind(document);
    document.eol = 1;
    previousTexts.length = 0;
    redoTexts.length = 0;
    panel.webview.messages.length = 0;
    window.activeTextEditor = { document };
    workspaceState.formatOnSave = false;
    workspaceState.profile = "github";
    workspaceState.prettierOptions = {};
    outputLines.length = 0;
    userNotifications.length = 0;
    configurationUpdates.length = 0;
    commandCalls.length = 0;
    openWithError = undefined;
  };
  return {
    Disposable,
    Uri,
    Position,
    Range,
    TextEdit,
    WorkspaceEdit,
    TextDocument,
    EndOfLine: { LF: 1, CRLF: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    WebviewPanel,
    ViewColumn: { Beside: 2 },
    window,
    workspace,
    commands,
    languages,
    TextDocumentChangeReason,
    __state: {
      document,
      panel,
      emitExternal,
      emitDirtyState,
      emitEolChange,
      emitTextChangeWithoutChanges,
      emitNativeHistory,
      emitConfiguration,
      runSave,
      reset,
      workspaceState,
      outputLines,
      userNotifications,
      configurationUpdates,
      commandCalls,
      get openWithError(): Error | undefined {
        return openWithError;
      },
      set openWithError(value: Error | undefined) {
        openWithError = value;
      },
    },
  };
});

vi.mock("vscode", () => vscode);

const {
  MarkdownMintEditorProvider,
  extendMarkdownIt,
  webviewContentSecurityPolicy,
} = await import("../../src/extension/extension");

function context(): {
  extensionUri: unknown;
  subscriptions: unknown[];
} {
  return { extensionUri: vscode.Uri.file("/extension"), subscriptions: [] };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("MarkdownMintEditorProvider", () => {
  it("allows KaTeX style attributes without broadening script or network policy", () => {
    const policy = webviewContentSecurityPolicy("vscode-resource:", "nonce");
    expect(policy).toContain("style-src vscode-resource:");
    expect(policy).toContain("style-src-elem vscode-resource:");
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy).toContain("script-src 'nonce-nonce'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("applies a validated edit and acknowledges the resulting TextDocument version", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    await flush();
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "edit",
      baseVersion: document.version,
      operationId: "edit:test",
      markdown: "# Changed",
    });
    await flush();
    expect(document.getText()).toBe("# Changed");
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "document",
        reason: "ack",
        operationId: "edit:test",
        version: document.version,
      }),
    );
    provider.dispose();
  });

  it("opens the standard source editor in the custom editor's group", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    await flush();

    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "source",
    });
    await flush();

    const openWithCall = [...vscode.__state.commandCalls]
      .reverse()
      .find((call) => call.command === "vscode.openWith");
    expect(openWithCall).toEqual({
      command: "vscode.openWith",
      args: [
        expect.objectContaining({ fsPath: "/workspace/doc.md" }),
        "default",
        expect.objectContaining({
          viewColumn: 2,
          preview: false,
          preserveFocus: false,
        }),
      ],
    });
    provider.dispose();
  });

  it("reports a standard source editor failure with its operation id", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    await flush();

    vscode.__state.openWithError = new Error("openWith failed");
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "source",
      operationId: "source:failed",
    });
    await flush();

    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        operationId: "source:failed",
        message: "openWith failed",
      }),
    );
    provider.dispose();
  });

  it.each(["gitlab", "commonmark"] as const)(
    "persists a %s profile and acknowledges its authoritative snapshot",
    async (profile) => {
      vscode.__state.reset();
      const provider = new MarkdownMintEditorProvider(context() as never);
      const document = vscode.__state.document;
      await provider.resolveCustomTextEditor(
        document as never,
        vscode.__state.panel as never,
        {} as never,
      );
      vscode.__state.panel.webview.receive({
        protocolVersion: 1,
        type: "ready",
      });
      await flush();
      const baseVersion = document.version;
      const operationId = `profile:${profile}`;
      vscode.__state.panel.webview.receive({
        protocolVersion: 1,
        type: "set-profile",
        profile,
        baseVersion,
        operationId,
      });
      await flush();

      expect(vscode.__state.workspaceState.profile).toBe(profile);
      expect(vscode.__state.configurationUpdates).toContainEqual({
        section: "markdownMint",
        key: "profile",
        value: profile,
        target: vscode.ConfigurationTarget.Global,
      });
      expect(vscode.__state.panel.webview.messages).toContainEqual(
        expect.objectContaining({
          type: "document",
          reason: "ack",
          operationId,
          profile,
          version: document.version,
        }),
      );
      provider.dispose();
    },
  );

  it("rejects a stale profile request without changing configuration", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    await flush();
    const staleVersion = document.version;
    vscode.__state.emitExternal("# External");
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "set-profile",
      profile: "gitlab",
      baseVersion: staleVersion,
      operationId: "profile:stale",
    });
    await flush();

    expect(vscode.__state.workspaceState.profile).toBe("github");
    expect(vscode.__state.configurationUpdates).toHaveLength(0);
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        operationId: "profile:stale",
      }),
    );
    provider.dispose();
  });

  it("suppresses unchanged dirty-only events but broadcasts real text and EOL changes", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    await flush();

    const beforeDirtyOnly = vscode.__state.panel.webview.messages.length;
    vscode.__state.emitDirtyState();
    expect(vscode.__state.panel.webview.messages.length).toBe(beforeDirtyOnly);

    vscode.__state.emitExternal("# Changed");
    const afterTextChange = vscode.__state.panel.webview.messages.length;
    expect(vscode.__state.panel.webview.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "document",
        reason: "external",
        markdown: "# Changed",
      }),
    );
    vscode.__state.emitDirtyState();
    expect(vscode.__state.panel.webview.messages.length).toBe(afterTextChange);

    vscode.__state.emitEolChange();
    expect(vscode.__state.panel.webview.messages.length).toBeGreaterThan(
      afterTextChange,
    );
    expect(vscode.__state.panel.webview.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "document",
        reason: "external",
      }),
    );
    const afterEolChange = vscode.__state.panel.webview.messages.length;
    vscode.__state.emitTextChangeWithoutChanges(
      "# Text changed without payload",
    );
    expect(vscode.__state.panel.webview.messages.length).toBeGreaterThan(
      afterEolChange,
    );
    expect(vscode.__state.panel.webview.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "document",
        reason: "external",
        markdown: "# Text changed without payload",
      }),
    );
    provider.dispose();
  });

  it("preserves untagged native Undo and Redo reasons in document snapshots", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    await flush();

    vscode.__state.emitNativeHistory(
      vscode.TextDocumentChangeReason.Undo,
      "# Native undo",
    );
    expect(vscode.__state.panel.webview.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "document",
        reason: "undo",
        markdown: "# Native undo",
      }),
    );
    vscode.__state.emitNativeHistory(
      vscode.TextDocumentChangeReason.Redo,
      "# Native redo",
    );
    expect(vscode.__state.panel.webview.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "document",
        reason: "redo",
        markdown: "# Native redo",
      }),
    );
    provider.dispose();
  });

  it("rejects a stale edit without overwriting the external source", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    const staleVersion = document.version;
    vscode.__state.emitExternal("# External");
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "edit",
      baseVersion: staleVersion,
      operationId: "edit:stale",
      markdown: "# Lost",
    });
    await flush();
    expect(document.getText()).toBe("# External");
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "edit-rejected",
        reason: "stale",
        draftMarkdown: "# Lost",
      }),
    );
    provider.dispose();
  });

  it("opens recovery drafts as separate untitled documents", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    const original = document.getText();
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "recoverDraft",
      baseVersion: document.version,
      operationId: "recover:test",
      markdown: "# Separate draft",
    });
    await flush();
    expect(document.getText()).toBe(original);
    expect(vscode.window.activeTextEditor?.document.uri.toString()).toBe(
      "untitled:recovery.md",
    );
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "recovery-opened",
        operationId: "recover:test",
      }),
    );
    provider.dispose();
  });

  it("uses the VS Code undo service for host undo and redo requests", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    const baseVersion = document.version;
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "edit",
      baseVersion,
      operationId: "edit:undo",
      markdown: "# Undo me",
    });
    await flush();
    const undoBaseVersion = document.version;
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "undo",
      baseVersion: undoBaseVersion,
      operationId: "undo:test",
    });
    await flush();
    expect(document.getText()).toBe("# Original");
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "document",
        reason: "undo",
        operationId: "undo:test",
      }),
    );
    const redoBaseVersion = document.version;
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "redo",
      baseVersion: redoBaseVersion,
      operationId: "redo:test",
    });
    await flush();
    expect(document.getText()).toBe("# Undo me");
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "document",
        reason: "redo",
        operationId: "redo:test",
      }),
    );
    provider.dispose();
  });

  it("serializes a save request and reports the authoritative dirty state", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    const baseVersion = document.version;
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "edit",
      baseVersion,
      operationId: "edit:save",
      markdown: "# Save me",
    });
    await flush();
    expect(document.isDirty).toBe(true);
    const saveVersion = document.version;
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "save",
      baseVersion: saveVersion,
      operationId: "save:test",
    });
    await flush();
    expect(document.isDirty).toBe(false);
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "save-result",
        operationId: "save:test",
        saved: true,
        version: document.version,
        isDirty: false,
      }),
    );
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "document",
        reason: "save",
        operationId: "save:test",
      }),
    );
    provider.dispose();
  });

  it("keeps a successful save distinct from input that lands while it is running", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    await flush();

    let markStarted!: () => void;
    let releaseSave!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    document.save = async (): Promise<boolean> => {
      document.isDirty = false;
      markStarted();
      await saveGate;
      return true;
    };
    const requestedVersion = document.version;
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "save",
      baseVersion: requestedVersion,
      operationId: "save:during-edit",
    });
    await started;

    vscode.__state.emitTextChangeWithoutChanges("# Typed during save");
    releaseSave();
    await flush();
    await flush();

    const result = vscode.__state.panel.webview.messages.find(
      (message: any) =>
        message.type === "save-result" &&
        message.operationId === "save:during-edit",
    ) as any;
    expect(document.getText()).toBe("# Typed during save");
    expect(result).toMatchObject({
      type: "save-result",
      operationId: "save:during-edit",
      saved: true,
      requestedVersion,
      version: document.version,
      isDirty: true,
    });
    expect(result.savedVersion).toBeUndefined();
    expect(vscode.__state.userNotifications).toHaveLength(0);
    provider.dispose();
  });

  it("reports a real save failure without claiming that the source was saved", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    await flush();
    document.replaceText("# Still unsaved");
    const requestedVersion = document.version;
    document.save = async (): Promise<boolean> => false;
    vscode.__state.panel.webview.receive({
      protocolVersion: 1,
      type: "save",
      baseVersion: requestedVersion,
      operationId: "save:failed",
    });
    await flush();

    expect(document.getText()).toBe("# Still unsaved");
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "save-result",
        operationId: "save:failed",
        saved: false,
        requestedVersion,
        isDirty: true,
      }),
    );
    expect(
      vscode.__state.userNotifications.some(
        (entry: { level: string; message: string }) =>
          entry.level === "error" && entry.message.includes("did not save"),
      ),
    ).toBe(true);
    expect(
      vscode.__state.outputLines.some((line: string) =>
        line.startsWith("[save]"),
      ),
    ).toBe(true);
    provider.dispose();
  });

  it("returns safe save formatting edits only when format-on-save is enabled", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    vscode.__state.workspaceState.formatOnSave = true;
    document.replaceText("# Unfinished");
    const edits = await vscode.__state.runSave();
    expect(Array.isArray(edits)).toBe(true);
    provider.dispose();
  });

  it("rebroadcasts typography changes without changing the Markdown profile", async () => {
    vscode.__state.reset();
    const provider = new MarkdownMintEditorProvider(context() as never);
    const document = vscode.__state.document;
    await provider.resolveCustomTextEditor(
      document as never,
      vscode.__state.panel as never,
      {} as never,
    );
    vscode.__state.panel.webview.receive({ protocolVersion: 1, type: "ready" });
    const before = vscode.__state.panel.webview.messages.length;
    vscode.__state.emitConfiguration("markdown.preview.fontSize");
    expect(vscode.__state.panel.webview.messages.length).toBeGreaterThan(
      before,
    );
    expect(vscode.__state.panel.webview.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "document",
        reason: "external",
        profile: "github",
      }),
    );
    provider.dispose();
  });

  it("resolves nested local image paths in the native MarkdownIt adapter", () => {
    const markdownIt = extendMarkdownIt(new MarkdownIt());
    const env = {
      currentDocument: vscode.__state.document.uri,
      resourceProvider: {
        asWebviewUri(uri: unknown): unknown {
          return vscode.Uri.parse(
            `vscode-resource:${(uri as { fsPath: string }).fsPath}`,
          );
        },
      },
    };
    const tokens = markdownIt.parse("![alt](assets/images/icon.png)", env);
    const html = markdownIt.renderer.render(tokens, markdownIt.options, env);
    expect(html).toContain(
      'src="vscode-resource:/workspace/assets/images/icon.png"',
    );
  });
});
