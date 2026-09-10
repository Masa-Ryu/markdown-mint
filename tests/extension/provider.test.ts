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
  const textDocumentListeners: Array<
    (event: { document: TextDocument; reason?: number }) => void
  > = [];
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
  const window = {
    activeTextEditor: { document },
    onDidChangeActiveTextEditor(
      listener: (editor: { document: TextDocument } | undefined) => void,
    ): Disposable {
      activeEditorListeners.push(listener);
      return new Disposable();
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
    async showInformationMessage(): Promise<string | undefined> {
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
      listener: (event: { document: TextDocument; reason?: number }) => void,
    ): Disposable {
      textDocumentListeners.push(listener);
      return new Disposable();
    },
    onWillSaveTextDocument(
      listener: (event: {
        document: TextDocument;
        waitUntil(value: Promise<unknown>): void;
      }) => void,
    ): Disposable {
      saveListeners.push(listener);
      return new Disposable();
    },
    onDidChangeConfiguration(
      listener: (event: {
        affectsConfiguration(section: string, uri: Uri): boolean;
      }) => void,
    ): Disposable {
      configurationListeners.push(listener);
      return new Disposable();
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
      for (const listener of textDocumentListeners) listener({ document });
      return true;
    },
    getConfiguration(section: string): {
      get<T>(key: string, fallback?: T): T;
      inspect<T>(key: string):
        | {
            workspaceFolderValue?: T;
          }
        | undefined;
    } {
      return {
        get<T>(key: string, fallback?: T): T {
          const value =
            section === "markdownWeaver"
              ? workspaceState[key as keyof typeof workspaceState]
              : undefined;
          return (value === undefined ? fallback : value) as T;
        },
        inspect<T>(key: string): { workspaceFolderValue?: T } | undefined {
          if (section !== "markdownWeaver" || key !== "prettierOptions")
            return undefined;
          return { workspaceFolderValue: workspaceState.prettierOptions as T };
        },
      };
    },
    getWorkspaceFolder(): undefined {
      return undefined;
    },
  };
  const TextDocumentChangeReason = { Undo: 1, Redo: 2 } as const;
  const commands = {
    async executeCommand(command: string): Promise<void> {
      if (command === "undo" && previousTexts.length) {
        redoTexts.push(document.getText());
        document.replaceText(previousTexts.pop() ?? document.getText());
        for (const listener of textDocumentListeners)
          listener({ document, reason: TextDocumentChangeReason.Undo });
      } else if (command === "redo" && redoTexts.length) {
        previousTexts.push(document.getText());
        document.replaceText(redoTexts.pop() ?? document.getText());
        for (const listener of textDocumentListeners)
          listener({ document, reason: TextDocumentChangeReason.Redo });
      }
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
    for (const listener of textDocumentListeners) listener({ document });
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
    previousTexts.length = 0;
    redoTexts.length = 0;
    panel.webview.messages.length = 0;
    window.activeTextEditor = { document };
    workspaceState.formatOnSave = false;
    workspaceState.prettierOptions = {};
    outputLines.length = 0;
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
      emitConfiguration,
      runSave,
      reset,
      workspaceState,
      outputLines,
    },
  };
});

vi.mock("vscode", () => vscode);

const { MarkdownWeaverEditorProvider, extendMarkdownIt } =
  await import("../../src/extension/extension");

function context(): {
  extensionUri: unknown;
  subscriptions: unknown[];
} {
  return { extensionUri: vscode.Uri.file("/extension"), subscriptions: [] };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("MarkdownWeaverEditorProvider", () => {
  it("applies a validated edit and acknowledges the resulting TextDocument version", async () => {
    vscode.__state.reset();
    const provider = new MarkdownWeaverEditorProvider(context() as never);
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

  it("rejects a stale edit without overwriting the external source", async () => {
    vscode.__state.reset();
    const provider = new MarkdownWeaverEditorProvider(context() as never);
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
    expect(vscode.__state.panel.webview.messages).toContainEqual(
      expect.objectContaining({
        type: "document",
        reason: "recovery",
        draftMarkdown: "# Lost",
      }),
    );
    provider.dispose();
  });

  it("opens recovery drafts as separate untitled documents", async () => {
    vscode.__state.reset();
    const provider = new MarkdownWeaverEditorProvider(context() as never);
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
    const provider = new MarkdownWeaverEditorProvider(context() as never);
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
    const provider = new MarkdownWeaverEditorProvider(context() as never);
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

  it("returns safe save formatting edits only when format-on-save is enabled", async () => {
    vscode.__state.reset();
    const provider = new MarkdownWeaverEditorProvider(context() as never);
    const document = vscode.__state.document;
    vscode.__state.workspaceState.formatOnSave = true;
    document.replaceText("# Unfinished");
    const edits = await vscode.__state.runSave();
    expect(Array.isArray(edits)).toBe(true);
    provider.dispose();
  });

  it("rebroadcasts typography changes without changing the Markdown profile", async () => {
    vscode.__state.reset();
    const provider = new MarkdownWeaverEditorProvider(context() as never);
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
