import { describe, expect, it, vi } from "vitest";
import type {
  TextDocument as VscodeTextDocument,
  Uri as VscodeUri,
} from "vscode";

const vscode = vi.hoisted(() => {
  class Disposable {
    public constructor(
      public readonly disposeHandler: () => void = () => undefined,
    ) {}

    public dispose(): void {
      this.disposeHandler();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    public readonly event = (listener: (value: T) => void): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };

    public fire(value?: T): void {
      for (const listener of this.listeners) listener(value as T);
    }

    public dispose(): void {
      this.listeners.clear();
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

  class CodeLens {
    public readonly isResolved: boolean;

    public constructor(
      public readonly range: Range,
      public readonly command?: {
        title: string;
        command: string;
        arguments?: readonly unknown[];
      },
    ) {
      this.isResolved = command !== undefined;
    }
  }

  class TabInputText {
    public constructor(public readonly uri: Uri) {}
  }

  class TabInputTextDiff {
    public constructor(
      public readonly original: Uri,
      public readonly modified: Uri,
    ) {}
  }

  class TabInputCustom {
    public constructor(
      public readonly uri: Uri,
      public readonly viewType: string,
    ) {}
  }

  class TextDocument {
    public languageId: string;
    public constructor(
      public readonly uri: Uri,
      private text: string,
      languageId = "markdown",
    ) {
      this.languageId = languageId;
    }

    public getText(): string {
      return this.text;
    }
  }

  const uri = Uri.file("/workspace/readme.md");
  const otherUri = Uri.file("/workspace/other.md");
  const document = new TextDocument(uri, "# Source\n");
  const otherDocument = new TextDocument(otherUri, "# Other\n");
  const activeEditorListeners: Array<() => void> = [];
  const visibleEditorListeners: Array<() => void> = [];
  const tabListeners: Array<() => void> = [];
  const tabGroupListeners: Array<() => void> = [];
  const activeGroup: {
    activeTab: { input: unknown } | undefined;
    tabs: Array<{ input: unknown }>;
  } = { activeTab: undefined, tabs: [] };
  const otherGroup: {
    activeTab: { input: unknown } | undefined;
    tabs: Array<{ input: unknown }>;
  } = { activeTab: undefined, tabs: [] };
  const window = {
    activeTextEditor: { document },
    onDidChangeActiveTextEditor(listener: () => void): Disposable {
      activeEditorListeners.push(listener);
      return new Disposable(() => {
        const index = activeEditorListeners.indexOf(listener);
        if (index >= 0) activeEditorListeners.splice(index, 1);
      });
    },
    onDidChangeVisibleTextEditors(listener: () => void): Disposable {
      visibleEditorListeners.push(listener);
      return new Disposable(() => {
        const index = visibleEditorListeners.indexOf(listener);
        if (index >= 0) visibleEditorListeners.splice(index, 1);
      });
    },
    tabGroups: {
      all: [activeGroup, otherGroup],
      activeTabGroup: activeGroup,
      onDidChangeTabs(listener: () => void): Disposable {
        tabListeners.push(listener);
        return new Disposable(() => {
          const index = tabListeners.indexOf(listener);
          if (index >= 0) tabListeners.splice(index, 1);
        });
      },
      onDidChangeTabGroups(listener: () => void): Disposable {
        tabGroupListeners.push(listener);
        return new Disposable(() => {
          const index = tabGroupListeners.indexOf(listener);
          if (index >= 0) tabGroupListeners.splice(index, 1);
        });
      },
    },
  };
  const commandCalls: Array<{ command: string; args: readonly unknown[] }> = [];
  const commands = {
    async executeCommand(
      command: string,
      ...args: readonly unknown[]
    ): Promise<void> {
      commandCalls.push({ command, args });
    },
  };

  const setActiveTab = (
    input: unknown,
    group: typeof activeGroup = activeGroup,
  ): void => {
    const tab = { input };
    group.activeTab = tab;
    group.tabs = [tab];
  };

  const reset = (): void => {
    document.languageId = "markdown";
    window.activeTextEditor = { document };
    activeGroup.activeTab = undefined;
    activeGroup.tabs = [];
    otherGroup.activeTab = undefined;
    otherGroup.tabs = [];
    commandCalls.length = 0;
  };

  return {
    Disposable,
    EventEmitter,
    Uri,
    Position,
    Range,
    CodeLens,
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    TextDocument,
    window,
    commands,
    __state: {
      uri,
      otherUri,
      document,
      otherDocument,
      activeGroup,
      otherGroup,
      commandCalls,
      activeEditorListeners,
      visibleEditorListeners,
      tabListeners,
      tabGroupListeners,
      setActiveTab,
      reset,
      emitActiveEditorChange: (): void => {
        for (const listener of [...activeEditorListeners]) listener();
      },
      emitVisibleEditorChange: (): void => {
        for (const listener of [...visibleEditorListeners]) listener();
      },
      emitTabChange: (): void => {
        for (const listener of [...tabListeners]) listener();
      },
      emitTabGroupChange: (): void => {
        for (const listener of [...tabGroupListeners]) listener();
      },
    },
  };
});

vi.mock("vscode", () => vscode);

const {
  MARKDOWN_MINT_VIEW_TYPE,
  OPEN_IN_MARKDOWN_MINT_COMMAND,
  OPEN_IN_MARKDOWN_MINT_TITLE,
  REOPEN_ACTIVE_EDITOR_WITH_COMMAND,
  MarkdownMintCodeLensProvider,
  openInMarkdownMint,
} = await import("../../src/extension/codeLens");

const token = { isCancellationRequested: false };

const asTextDocument = (value: unknown): VscodeTextDocument =>
  value as VscodeTextDocument;
const asUri = (value: unknown): VscodeUri => value as VscodeUri;

describe("MarkdownMintCodeLensProvider", () => {
  it("provides one exact first-line lens for a Markdown normal text tab", () => {
    vscode.__state.reset();
    vscode.__state.setActiveTab(new vscode.TabInputText(vscode.__state.uri));
    const provider = new MarkdownMintCodeLensProvider();

    const lenses = provider.provideCodeLenses(
      asTextDocument(vscode.__state.document),
      token as never,
    );

    expect(lenses).toHaveLength(1);
    expect(lenses[0]?.range).toEqual(
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
    );
    expect(lenses[0]?.command).toEqual({
      title: OPEN_IN_MARKDOWN_MINT_TITLE,
      command: OPEN_IN_MARKDOWN_MINT_COMMAND,
      arguments: [vscode.__state.uri],
    });
    provider.dispose();
  });

  it("refreshes when editor or tab visibility changes and disposes its listeners", () => {
    vscode.__state.reset();
    vscode.__state.setActiveTab(new vscode.TabInputText(vscode.__state.uri));
    const provider = new MarkdownMintCodeLensProvider();
    const changed = vi.fn();
    provider.onDidChangeCodeLenses?.(changed as never);

    vscode.__state.emitActiveEditorChange();
    vscode.__state.emitVisibleEditorChange();
    vscode.__state.emitTabChange();
    vscode.__state.emitTabGroupChange();
    expect(changed).toHaveBeenCalledTimes(4);

    provider.dispose();
    vscode.__state.emitActiveEditorChange();
    vscode.__state.emitVisibleEditorChange();
    vscode.__state.emitTabChange();
    vscode.__state.emitTabGroupChange();
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("only exposes the lens for Markdown normal text inputs", () => {
    vscode.__state.reset();
    const provider = new MarkdownMintCodeLensProvider();

    vscode.__state.setActiveTab(new vscode.TabInputText(vscode.__state.uri));
    expect(
      provider.provideCodeLenses(
        asTextDocument(vscode.__state.document),
        token as never,
      ),
    ).toHaveLength(1);

    vscode.__state.document.languageId = "plaintext";
    expect(
      provider.provideCodeLenses(
        asTextDocument(vscode.__state.document),
        token as never,
      ),
    ).toEqual([]);

    vscode.__state.document.languageId = "markdown";
    vscode.__state.setActiveTab(
      new vscode.TabInputCustom(vscode.__state.uri, MARKDOWN_MINT_VIEW_TYPE),
    );
    expect(
      provider.provideCodeLenses(
        asTextDocument(vscode.__state.document),
        token as never,
      ),
    ).toEqual([]);

    vscode.__state.setActiveTab(
      new vscode.TabInputTextDiff(vscode.__state.uri, vscode.__state.otherUri),
    );
    expect(
      provider.provideCodeLenses(
        asTextDocument(vscode.__state.document),
        token as never,
      ),
    ).toEqual([]);

    provider.dispose();
  });

  it("accepts a normal text tab in a visible split group but ignores hidden tabs", () => {
    vscode.__state.reset();
    const provider = new MarkdownMintCodeLensProvider();
    vscode.__state.setActiveTab(
      new vscode.TabInputTextDiff(vscode.__state.uri, vscode.__state.otherUri),
    );
    vscode.__state.setActiveTab(
      new vscode.TabInputText(vscode.__state.uri),
      vscode.__state.otherGroup,
    );

    expect(
      provider.provideCodeLenses(
        asTextDocument(vscode.__state.document),
        token as never,
      ),
    ).toHaveLength(1);

    vscode.__state.setActiveTab(
      new vscode.TabInputTextDiff(vscode.__state.uri, vscode.__state.otherUri),
      vscode.__state.otherGroup,
    );
    expect(
      provider.provideCodeLenses(
        asTextDocument(vscode.__state.document),
        token as never,
      ),
    ).toEqual([]);

    provider.dispose();
  });
});

describe("openInMarkdownMint", () => {
  it("reopens the active normal text tab in place without writing its document", async () => {
    vscode.__state.reset();
    vscode.__state.setActiveTab(new vscode.TabInputText(vscode.__state.uri));
    const before = vscode.__state.document.getText();

    await openInMarkdownMint(
      asUri(vscode.__state.uri),
      MARKDOWN_MINT_VIEW_TYPE,
    );

    expect(vscode.__state.commandCalls).toEqual([
      {
        command: REOPEN_ACTIVE_EDITOR_WITH_COMMAND,
        args: [MARKDOWN_MINT_VIEW_TYPE],
      },
    ]);
    expect(vscode.__state.activeGroup.tabs).toHaveLength(1);
    expect(vscode.__state.document.getText()).toBe(before);
  });

  it("ignores a delayed lens click after another document becomes active", async () => {
    vscode.__state.reset();
    vscode.__state.setActiveTab(
      new vscode.TabInputText(vscode.__state.otherUri),
    );
    vscode.window.activeTextEditor = {
      document: vscode.__state.otherDocument,
    };

    await openInMarkdownMint(
      asUri(vscode.__state.uri),
      MARKDOWN_MINT_VIEW_TYPE,
    );

    expect(vscode.__state.commandCalls).toEqual([]);
    expect(vscode.__state.document.getText()).toBe("# Source\n");
  });

  it("ignores custom and diff active tabs and can target the active document from the palette", async () => {
    vscode.__state.reset();
    vscode.__state.setActiveTab(
      new vscode.TabInputCustom(vscode.__state.uri, MARKDOWN_MINT_VIEW_TYPE),
    );

    await openInMarkdownMint(
      asUri(vscode.__state.uri),
      MARKDOWN_MINT_VIEW_TYPE,
    );
    expect(vscode.__state.commandCalls).toEqual([]);

    vscode.__state.setActiveTab(new vscode.TabInputText(vscode.__state.uri));
    await openInMarkdownMint(undefined, MARKDOWN_MINT_VIEW_TYPE);

    expect(vscode.__state.commandCalls).toEqual([
      {
        command: REOPEN_ACTIVE_EDITOR_WITH_COMMAND,
        args: [MARKDOWN_MINT_VIEW_TYPE],
      },
    ]);
  });
});
