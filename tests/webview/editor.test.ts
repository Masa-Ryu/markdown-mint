import { beforeEach, describe, expect, it } from "vitest";
import { NodeSelection, TextSelection } from "prosemirror-state";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import {
  createEditorApp,
  type EditorInitialDocument,
  type VSCodeApiLike,
} from "../../src/webview/editor";

function documentFixture(
  markdown = "# Title\n\nParagraph",
  clipboardAvailable = false,
): EditorInitialDocument {
  return {
    markdown,
    version: 1,
    profile: "github",
    ...(clipboardAvailable ? { clipboardAvailable: true } : {}),
  };
}

function isEditMessage(
  message: unknown,
): message is { type: "edit"; markdown: string } {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { type?: unknown; markdown?: unknown };
  return candidate.type === "edit" && typeof candidate.markdown === "string";
}

function lastEditMarkdown(messages: unknown[]): string {
  return messages.filter(isEditMessage).at(-1)?.markdown ?? "";
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function makeApp(
  markdown?: string,
  api?: VSCodeApiLike,
  clipboardAvailable = false,
) {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const vscode = api ?? {
    postMessage: (message: unknown) => messages.push(message),
    getState: () => undefined,
    setState: () => undefined,
  };
  const app = createEditorApp({
    root,
    vscode,
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: documentFixture(markdown, clipboardAvailable),
  });
  return { app, root, messages, vscode };
}

beforeEach(() => {
  document.body.replaceChildren();
  // ProseMirror scrolls to the new selection after list commands. jsdom does
  // not implement layout ranges, so provide the zero-sized geometry browser
  // implementations expose before the command tests run.
  if (!Range.prototype.getClientRects)
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  if (!Range.prototype.getBoundingClientRect)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
      }),
    });
  if (typeof Text !== "undefined" && !("getClientRects" in Text.prototype))
    Object.defineProperty(Text.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
});

describe("rich editor rendering", () => {
  it("renders a dedicated preview snapshot without requiring a Preview toolbar button", () => {
    const { app, root } = makeApp("# 見出し\n\n本文");
    expect(root.querySelector(".ProseMirror h1")?.textContent).toBe("見出し");
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "# 見出し\n\n本文",
      version: 2,
      profile: "github",
      mode: "preview",
      reason: "external",
    });
    expect(
      root.querySelector<HTMLElement>("[data-panel=preview]")?.hidden,
    ).toBe(false);
    expect(
      root.querySelector("[data-testid=preview-content] h1")?.textContent,
    ).toBe("見出し");
    app.destroy();
  });

  it("refreshes rich footnote bodies after reload and keeps them through edits", () => {
    const { app, root } = makeApp("A[^one]\n\n[^one]: first body");
    expect(root.querySelector(".mm-rich-footnotes")?.textContent).toContain(
      "first body",
    );

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "B[^two]\n\n[^two]: second body",
      version: 2,
      profile: "github",
      reason: "external",
    });
    const reloadedFootnotes = root.querySelector(".mm-rich-footnotes");
    expect(reloadedFootnotes?.textContent).toContain("second body");
    expect(reloadedFootnotes?.textContent).not.toContain("first body");

    app.view.dispatch(app.view.state.tr.insertText("!"));
    expect(root.querySelector(".mm-rich-footnotes")?.textContent).toContain(
      "second body",
    );
    app.destroy();
  });

  it("keeps the selection when a toolbar mark is clicked", () => {
    const { app, root } = makeApp("hello world");
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 6),
      ),
    );
    root
      .querySelector<HTMLButtonElement>('[data-testid="toolbar-bold"]')
      ?.click();
    const markdown = serializeMarkdown(
      app.view.state.doc,
      parseMarkdown("hello world", "github"),
    );
    expect(markdown).toContain("**hello**");
    app.destroy();
  });

  it("renders task list controls and serializes a checkbox toggle", () => {
    const { app, root, messages } = makeApp("- [ ] one\n- [x] two");
    const checkboxes =
      root.querySelectorAll<HTMLInputElement>(".mm-task-checkbox");
    expect(checkboxes).toHaveLength(2);
    checkboxes[0]!.click();
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(1);
    expect((messages.at(-1) as any).markdown).toContain("[x]");
    app.destroy();
  });

  it("creates a task list in one transaction", () => {
    const { app, root, messages } = makeApp("one");
    const taskButton = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-task-list"]',
    );
    taskButton?.click();
    const edits = messages.filter((message: any) => message.type === "edit");
    expect(edits).toHaveLength(1);
    expect((edits[0] as any).markdown).toContain("- [ ] one");
    app.destroy();
  });

  it("allows the code language field to receive focus and update the block", () => {
    const { app, root, messages } = makeApp("code");
    const code = schema.nodes.code_block!;
    app.view.dispatch(
      app.view.state.tr.setBlockType(0, app.view.state.doc.content.size, code),
    );
    const firstEdit = messages.find(
      (message: any) => message.type === "edit",
    ) as any;
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: firstEdit.markdown,
      version: 2,
      profile: "github",
      operationId: firstEdit.operationId,
      reason: "ack",
    });
    const trigger = root.querySelector<HTMLButtonElement>(
      ".mm-code-block-view .mm-code-language-trigger",
    )!;
    trigger.click();
    const language = root.querySelector<HTMLInputElement>(
      ".mm-code-block-view .mm-code-language",
    )!;
    expect(
      language.closest<HTMLElement>(".mm-code-language-menu")?.hidden,
    ).toBe(false);
    language.value = "ts";
    language.dispatchEvent(new Event("input", { bubbles: true }));
    language.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
    );
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(2);
    expect((messages.at(-1) as any).markdown).toContain("```ts");
    app.destroy();
  });

  it("preserves info-string suffixes and custom language identifiers", () => {
    const source = '```ts title="example.ts"\nconst value = 1;\n```';
    const { app, root, messages } = makeApp(source);
    const trigger = root.querySelector<HTMLButtonElement>(
      ".mm-code-language-trigger",
    )!;
    const input = root.querySelector<HTMLInputElement>(
      ".mm-code-language-inline",
    )!;
    const originalParams = app.view.state.doc.firstChild?.attrs.params;

    trigger.click();
    input.value = "acme-dsl";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-mm-language-option="acme-dsl"]',
      )?.textContent,
    ).toContain("Use");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );
    expect(app.view.state.doc.firstChild?.attrs.params).toBe(originalParams);
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(0);

    trigger.click();
    input.value = "acme-dsl";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    root
      .querySelector<HTMLButtonElement>('[data-mm-language-option="acme-dsl"]')
      ?.click();
    expect(app.view.state.doc.firstChild?.attrs.params).toBe(
      'acme-dsl title="example.ts"',
    );
    expect(lastEditMarkdown(messages)).toContain(
      '```acme-dsl title="example.ts"',
    );
    expect(root.querySelector(".mm-code-language-label")?.textContent).toBe(
      "acme-dsl",
    );
    app.destroy();
  });

  it("keeps no-language and explicit plaintext selections distinct", () => {
    const { app, root, messages } = makeApp("```ts\nvalue\n```");
    const trigger = root.querySelector<HTMLButtonElement>(
      ".mm-code-language-trigger",
    )!;
    trigger.click();
    root
      .querySelector<HTMLButtonElement>('[data-mm-language-option=""]')
      ?.click();
    expect(app.view.state.doc.firstChild?.attrs.params).toBe("");
    expect(
      root.querySelector<HTMLElement>(".mm-code-block")?.dataset,
    ).toMatchObject({ mmCodeLanguageKind: "unspecified" });
    const firstEdit = messages.find(
      (message: any) => message.type === "edit",
    ) as any;
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: firstEdit.markdown,
      version: 2,
      profile: "github",
      operationId: firstEdit.operationId,
      reason: "ack",
    });

    trigger.click();
    root
      .querySelector<HTMLButtonElement>('[data-mm-language-option="plaintext"]')
      ?.click();
    expect(app.view.state.doc.firstChild?.attrs.params).toBe("plaintext");
    expect(
      root.querySelector<HTMLElement>(".mm-code-block")?.dataset,
    ).toMatchObject({ mmCodeLanguageKind: "plain" });
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(2);
    app.destroy();
  });

  it("cancels language input on outside click and keeps display settings out of edits", () => {
    const source = "```ts\nfirst\nsecond\n```";
    const { app, root, messages } = makeApp(source);
    const trigger = root.querySelector<HTMLButtonElement>(
      ".mm-code-language-trigger",
    )!;
    const input = root.querySelector<HTMLInputElement>(
      ".mm-code-language-inline",
    )!;
    trigger.click();
    input.value = "python";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    expect(app.view.state.doc.firstChild?.attrs.params).toBe("ts");
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(0);

    const card = root.querySelector<HTMLElement>(".mm-code-block")!;
    card
      .querySelector<HTMLButtonElement>('[data-mm-code-action="more"]')
      ?.click();
    const editsBeforeMenu = messages.filter(
      (message: any) => message.type === "edit",
    ).length;
    card
      .querySelector<HTMLButtonElement>('[data-mm-code-menu-option="wrap"]')
      ?.click();
    card
      .querySelector<HTMLButtonElement>(
        '[data-mm-code-menu-option="line-numbers"]',
      )
      ?.click();
    expect(card.classList.contains("mm-code-wrap-lines")).toBe(true);
    expect(card.classList.contains("mm-code-hide-line-numbers")).toBe(true);
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(editsBeforeMenu);
    app.destroy();
  });

  it("does not treat IME Enter as a language commit and cancels on Tab", () => {
    const { app, root, messages } = makeApp("```ts\ncode\n```");
    const trigger = root.querySelector<HTMLButtonElement>(
      ".mm-code-language-trigger",
    )!;
    const input = root.querySelector<HTMLInputElement>(
      ".mm-code-language-inline",
    )!;
    trigger.click();
    input.value = "python";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const composingEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    Object.defineProperty(composingEnter, "isComposing", { value: true });
    input.dispatchEvent(composingEnter);
    expect(app.view.state.doc.firstChild?.attrs.params).toBe("ts");
    expect(composingEnter.defaultPrevented).toBe(false);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
      }),
    );
    expect(app.view.state.doc.firstChild?.attrs.params).toBe("ts");
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(0);
    app.destroy();
  });

  it("uses the host clipboard route for a dedicated editor copy", async () => {
    const messages: unknown[] = [];
    const api: VSCodeApiLike = {
      postMessage: (message: unknown) => messages.push(message),
      getState: () => undefined,
      setState: () => undefined,
    };
    const { app, root } = makeApp("```ts\nlatest\n```", api);
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "```ts\nlatest\n```",
      version: 2,
      profile: "github",
      reason: "external",
      clipboardAvailable: true,
    });
    const copy = root.querySelector<HTMLButtonElement>(
      '[data-mm-code-action="copy"]',
    )!;
    copy.click();
    await flush();
    const request = messages.find(
      (message: any) => message.type === "clipboard-write",
    ) as any;
    expect(request?.text).toBe("latest");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "clipboard-result",
          requestId: request.requestId,
          success: true,
        },
      }),
    );
    await flush();
    expect(copy.dataset.mmCopyState).toBe("success");
    app.destroy();
  });
  it("provides code card actions and keeps line numbers outside editable content", () => {
    const source = "```ts\nconst value = 1;\nreturn value;\n```";
    const { app, root, messages } = makeApp(source);
    const card = root.querySelector<HTMLElement>(
      ".mm-code-block-view .mm-code-block",
    );
    expect(card).not.toBeNull();
    expect(
      root.querySelectorAll(".mm-code-block-view .mm-code-line-numbers span"),
    ).toHaveLength(2);
    expect(
      root.querySelector(".mm-code-block-view .mm-code-line-numbers"),
    ).not.toBe(app.view.dom.querySelector(".mm-code-block-view code"));
    expect(
      root.querySelector<HTMLButtonElement>(
        '.mm-code-block-view [data-mm-code-action="copy"]',
      ),
    ).not.toBeNull();
    expect(
      root.querySelector<HTMLButtonElement>(
        '.mm-code-block-view [data-mm-code-action="expand"]',
      ),
    ).not.toBeNull();

    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => Promise.resolve((copied = value)),
      },
    });
    try {
      root
        .querySelector<HTMLButtonElement>(
          '.mm-code-block-view [data-mm-code-action="copy"]',
        )
        ?.click();
      expect(copied).toBe("const value = 1;\nreturn value;");

      const expand = root.querySelector<HTMLButtonElement>(
        '.mm-code-block-view [data-mm-code-action="expand"]',
      )!;
      expand.click();
      expect(card?.classList.contains("mm-code-block-expanded")).toBe(true);
      expand.click();
      expect(card?.classList.contains("mm-code-block-expanded")).toBe(false);
    } finally {
      if (originalClipboard)
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      else
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: undefined,
        });
    }
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(0);
    app.destroy();
  });
  it("edits alert content inline while preserving the raw atom and marker", () => {
    const source = "> [!WARNING]\n> Before";
    const { app, root, messages } = makeApp(source);
    const node = app.view.state.doc.firstChild;
    expect(node?.type.name).toBe("raw_block");
    expect(node?.attrs.kind).toBe("alert");

    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    );
    expect(bodyEditor).not.toBeNull();
    expect(bodyEditor?.value).toBe("Before");
    expect(root.querySelector(".mm-alert-edit-button")).toBeNull();
    expect(root.querySelector(".mm-alert-source-editor")).toBeNull();

    bodyEditor!.focus();
    bodyEditor!.setSelectionRange(
      bodyEditor!.value.length,
      bodyEditor!.value.length,
    );
    const originalBodyEditor = bodyEditor;
    bodyEditor!.value = "After\nSecond line";
    bodyEditor!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(root.querySelector(".mm-alert-body-editor")).toBe(
      originalBodyEditor,
    );
    expect(document.activeElement).toBe(bodyEditor);
    expect(bodyEditor?.selectionStart).toBe("After\nSecond line".length);
    expect(bodyEditor?.selectionEnd).toBe("After\nSecond line".length);
    expect(app.view.state.doc.firstChild?.type.name).toBe("raw_block");
    expect(app.view.state.doc.firstChild?.attrs.source).toBe(
      "> [!WARNING]\n> After\n> Second line",
    );
    expect(bodyEditor?.value).toContain("After");
    expect((messages.at(-1) as { markdown?: string })?.markdown).toContain(
      "> After",
    );
    app.destroy();
  });
  it("keeps Enter as a native newline inside alert content", () => {
    const { app, root } = makeApp("> [!NOTE]\n> Before");
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    );
    expect(bodyEditor).not.toBeNull();

    let bubbled = false;
    const onRootKeyDown = (): void => {
      bubbled = true;
    };
    root.addEventListener("keydown", onRootKeyDown);
    const enter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    bodyEditor!.dispatchEvent(enter);
    root.removeEventListener("keydown", onRootKeyDown);

    expect(enter.defaultPrevented).toBe(false);
    expect(bubbled).toBe(false);

    bodyEditor!.value = "Before\nAfter";
    bodyEditor!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(app.view.state.doc.firstChild?.attrs.source).toBe(
      "> [!NOTE]\n> Before\n> After",
    );
    app.destroy();
  });
  it("keeps lazy continuation lines in the editable alert body", () => {
    const source = "> [!TIP]\n> First\ncontinued\n> Last";
    const { app, root, messages } = makeApp(source);
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    expect(bodyEditor.value).toBe("First\ncontinued\nLast");

    bodyEditor.focus();
    bodyEditor.value = "Edited\ncontinued\nLast";
    bodyEditor.dispatchEvent(new Event("input", { bubbles: true }));

    expect(app.view.state.doc.firstChild?.attrs.source).toBe(
      "> [!TIP]\n> Edited\n> continued\n> Last",
    );
    expect(lastEditMarkdown(messages)).toContain("> continued\n> Last");
    app.destroy();
  });
  it("keeps quoted blank lines in alert bodies and excludes block separators", () => {
    const source = "> [!TIP]\n> first\n>\n> second\n\nNext";
    const { app, root, messages } = makeApp(source);
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    expect(bodyEditor.value).toBe("first\n\nsecond");

    bodyEditor.focus();
    bodyEditor.value = "first\n\nsecond\n";
    bodyEditor.dispatchEvent(new Event("input", { bubbles: true }));
    const edited = lastEditMarkdown(messages);
    expect(edited).toContain("> first\n> \n> second\n> ");
    expect(edited).toContain("\n\nNext");
    app.destroy();

    const separatorOnly = makeApp("> [!TIP]\n> first\n\nNext");
    expect(
      separatorOnly.root.querySelector<HTMLTextAreaElement>(
        ".mm-alert-body-editor",
      )?.value,
    ).toBe("first");
    separatorOnly.app.destroy();

    const reloaded = makeApp(edited);
    expect(
      reloaded.root.querySelector<HTMLTextAreaElement>(".mm-alert-body-editor")
        ?.value,
    ).toBe("first\n\nsecond\n");
    reloaded.app.destroy();
  });
  it("preserves CRLF while round-tripping quoted alert blank lines", () => {
    const source = "> [!TIP]\r\n> first\r\n>\r\n\r\nNext";
    const { app, root, messages } = makeApp(source);
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    expect(bodyEditor.value).toBe("first\n");
    bodyEditor.value = "first\n\nsecond";
    bodyEditor.dispatchEvent(new Event("input", { bubbles: true }));
    const edited = lastEditMarkdown(messages);
    expect(edited).toContain("> first\r\n> \r\n> second");
    expect(edited).not.toContain("> first\n>\n> second");
    app.destroy();
  });
  it("moves between paragraphs and adjacent alert bodies at their text boundaries", () => {
    const { app, root } = makeApp("Before\n\n> [!NOTE]\n> Alert\n\nAfter");
    const paragraphs =
      root.querySelectorAll<HTMLParagraphElement>(".ProseMirror > p");
    const firstParagraph = app.view.state.doc.child(0)!;
    const firstParagraphStart = 0;
    const firstParagraphEnd =
      firstParagraphStart + 1 + firstParagraph.content.size;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, firstParagraphEnd),
      ),
    );
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(app.view.state.selection.$from.depth).toBe(1);
    expect(app.view.state.selection.from).toBe(firstParagraphEnd);
    const intoAlert = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    paragraphs[0]!.dispatchEvent(intoAlert);
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    expect(intoAlert.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(bodyEditor);
    expect(bodyEditor.selectionStart).toBe(0);
    expect(bodyEditor.selectionEnd).toBe(0);

    bodyEditor.setSelectionRange(
      bodyEditor.value.length,
      bodyEditor.value.length,
    );
    const outOfAlert = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    bodyEditor.dispatchEvent(outOfAlert);
    expect(outOfAlert.defaultPrevented).toBe(true);
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");

    const last = paragraphs[1]!;
    const lastParagraph = app.view.state.doc.lastChild!;
    const lastParagraphPosition =
      app.view.state.doc.content.size - lastParagraph.nodeSize;
    const lastStart = lastParagraphPosition + 1;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, lastStart),
      ),
    );
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(app.view.state.selection.$from.depth).toBe(1);
    expect(app.view.state.selection.from).toBe(lastStart);
    const backIntoAlert = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
    });
    last.dispatchEvent(backIntoAlert);
    expect(backIntoAlert.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(bodyEditor);
    expect(bodyEditor.selectionStart).toBe(bodyEditor.value.length);
    expect(bodyEditor.selectionEnd).toBe(bodyEditor.value.length);

    bodyEditor.setSelectionRange(2, 2);
    const middle = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    bodyEditor.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(bodyEditor);
    app.destroy();
  });
  it("moves directly between consecutive alert body editors", () => {
    const { app, root } = makeApp(
      "Before\n\n> [!NOTE]\n> Alert A\n\n> [!TIP]\n> Alert B\n\nAfter",
    );
    const editors = Array.from(
      root.querySelectorAll<HTMLTextAreaElement>(".mm-alert-body-editor"),
    );
    expect(editors).toHaveLength(2);
    const [first, second] = editors as [
      HTMLTextAreaElement,
      HTMLTextAreaElement,
    ];

    first.focus();
    first.setSelectionRange(first.value.length, first.value.length);
    const right = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    first.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);
    expect(second.selectionStart).toBe(0);
    expect(second.selectionEnd).toBe(0);
    expect(app.view.state.selection).not.toBeInstanceOf(NodeSelection);

    second.setSelectionRange(0, 0);
    const left = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
    });
    second.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(first.selectionStart).toBe(first.value.length);
    expect(first.selectionEnd).toBe(first.value.length);
    expect(app.view.state.selection).not.toBeInstanceOf(NodeSelection);
    app.destroy();
  });
  it("uses a transient paragraph after a final alert without changing Markdown until typing", () => {
    const source = "> [!NOTE]\n> End";
    const { app, root, messages } = makeApp(source);
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    bodyEditor.focus();
    bodyEditor.setSelectionRange(
      bodyEditor.value.length,
      bodyEditor.value.length,
    );
    const exit = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    bodyEditor.dispatchEvent(exit);
    expect(exit.defaultPrevented).toBe(true);
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(0);
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")?.value,
    ).toBe(source);
    expect(app.view.state.doc.lastChild?.type.name).toBe("paragraph");

    app.view.dispatch(app.view.state.tr.insertText("Next"));
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(1);
    expect((messages.at(-1) as any).markdown).toContain("Next");
    app.destroy();
  });
  it("does not leave an alert while composing or while a selection is active", () => {
    const { app, root } = makeApp("> [!NOTE]\n> Alert");
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    bodyEditor.focus();
    bodyEditor.setSelectionRange(
      bodyEditor.value.length,
      bodyEditor.value.length,
    );
    const composing = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    Object.defineProperty(composing, "isComposing", { value: true });
    bodyEditor.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(bodyEditor);

    bodyEditor.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    const composingWithoutFlag = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    bodyEditor.dispatchEvent(composingWithoutFlag);
    expect(composingWithoutFlag.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(bodyEditor);

    const composingEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    bodyEditor.dispatchEvent(composingEnter);
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(bodyEditor);
    bodyEditor.dispatchEvent(new Event("compositionend", { bubbles: true }));

    bodyEditor.setSelectionRange(1, bodyEditor.value.length);
    const selected = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
    });
    bodyEditor.dispatchEvent(selected);
    expect(selected.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(bodyEditor);
    app.destroy();
  });
  it("routes alert textarea history shortcuts through host commands", () => {
    const { app, root, messages } = makeApp("> [!NOTE]\n> abc");
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;

    const undo = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "z",
    });
    bodyEditor.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    expect(messages.at(-1)).toMatchObject({ type: "undo" });

    const redo = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "y",
    });
    bodyEditor.dispatchEvent(redo);
    expect(redo.defaultPrevented).toBe(true);
    expect(messages.at(-1)).toMatchObject({ type: "redo" });
    app.destroy();
  });
  it("disables editing in a host preview and exposes the code language field in Mint", () => {
    const preview = makeApp("plain");
    const previewBold = preview.root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-bold"]',
    )!;
    preview.app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "plain",
      version: 2,
      profile: "github",
      mode: "preview",
      reason: "external",
    });
    expect(previewBold.disabled).toBe(true);
    expect(
      preview.root.querySelector<HTMLInputElement>(".mm-code-language"),
    ).toBeNull();
    preview.app.destroy();

    const { app, root } = makeApp("plain");
    const bold = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-bold"]',
    )!;
    const code = schema.nodes.code_block!;
    app.view.dispatch(
      app.view.state.tr.setBlockType(0, app.view.state.doc.content.size, code, {
        params: "ts",
      }),
    );
    const language = root.querySelector<HTMLInputElement>(
      ".mm-code-block-view .mm-code-language",
    );
    expect(language).not.toBeNull();
    expect(language?.value).toBe("ts");
    expect(language?.disabled).toBe(false);
    expect(bold.disabled).toBe(false);
    app.destroy();
  });
  it("resolves relative image URLs for display without changing Markdown attrs", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const source = "![icon](assets/icon.svg)";
    const app = createEditorApp({
      root,
      vscode: { postMessage: () => undefined },
      core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
      initialDocument: {
        markdown: source,
        version: 1,
        profile: "github",
        resourceBaseUrl: "https://example.test/docs/",
      },
    });
    const image = root.querySelector<HTMLImageElement>(".ProseMirror img")!;
    expect(image.getAttribute("src")).toBe(
      "https://example.test/docs/assets/icon.svg",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(app.view.state.doc.firstChild?.firstChild?.attrs.src).toBe(
      "assets/icon.svg",
    );
    expect(
      serializeMarkdown(app.view.state.doc, parseMarkdown(source, "github")),
    ).toBe(source);
    app.destroy();
  });

  it("handles hard break, list split, and list indentation shortcuts", () => {
    const hardBreak = makeApp("one");
    hardBreak.app.view.dispatch(
      hardBreak.app.view.state.tr.setSelection(
        TextSelection.create(hardBreak.app.view.state.doc, 4),
      ),
    );
    hardBreak.app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(hardBreak.app.view.state.doc.firstChild?.childCount).toBe(2);
    expect(hardBreak.app.view.state.doc.firstChild?.lastChild?.type.name).toBe(
      "hard_break",
    );
    hardBreak.app.destroy();

    const list = makeApp("- one\n- two");
    const listText = list.app.view.state.doc.textBetween(0, 7, "\n");
    expect(listText).toContain("one");
    list.app.view.dispatch(
      list.app.view.state.tr.setSelection(
        TextSelection.create(list.app.view.state.doc, 3),
      ),
    );
    list.app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    const listNode = list.app.view.state.doc.firstChild!;
    expect(listNode.type.name).toBe("bullet_list");
    expect(listNode.childCount).toBe(3);
    const secondItemParagraph = list.root.querySelectorAll("li p")[1]!;
    const secondItemPosition =
      list.app.view.posAtDOM(secondItemParagraph, 0) + 1;
    list.app.view.dispatch(
      list.app.view.state.tr.setSelection(
        TextSelection.create(list.app.view.state.doc, secondItemPosition),
      ),
    );
    list.app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(list.app.view.state.doc.textContent).toContain("one");
    expect(
      list.app.view.state.doc.firstChild?.firstChild?.childCount,
    ).toBeGreaterThan(1);
    list.app.destroy();
  });

  it("disables GFM-only controls for CommonMark", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const app = createEditorApp({
      root,
      vscode: { postMessage: () => undefined },
      core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
      initialDocument: { markdown: "plain", version: 1, profile: "commonmark" },
    });
    expect(root.querySelector('[data-testid="toolbar-strike"]')).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="toolbar-task-list"]',
      ),
    ).toHaveProperty("disabled", true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]'),
    ).toHaveProperty("disabled", true);
    app.destroy();
  });
});

describe("sync safety", () => {
  it("does not submit an empty replacement when serialization fails", () => {
    const messages: unknown[] = [];
    const initial = parseMarkdown("hello", "github");
    const { app } = makeApp("hello", {
      postMessage: (message) => messages.push(message),
    });
    const throwingCore = {
      schema,
      parseMarkdown,
      serializeMarkdown: () => {
        throw new Error("serializer failure");
      },
      renderMarkdown,
    };
    app.destroy();
    const root = document.createElement("div");
    document.body.append(root);
    const broken = createEditorApp({
      root,
      vscode: { postMessage: (message) => messages.push(message) },
      core: throwingCore,
      initialDocument: {
        markdown: initial.source,
        version: 1,
        profile: "github",
      },
    });
    const before = messages.length;
    broken.view.dispatch(broken.view.state.tr.insertText("!"));
    expect(messages.length).toBe(before);
    expect(root.querySelector(".mm-status")?.textContent).toContain(
      "Read-only",
    );
    broken.destroy();
  });

  it("freezes follow-up edits after a stale rejection while retaining the local draft", () => {
    const { app, root, messages } = makeApp("hello");
    app.view.dispatch(app.view.state.tr.insertText("!"));
    const editCount = messages.filter(
      (message: any) => message.type === "edit",
    ).length;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "edit-rejected",
          operationId: (messages.at(-1) as any).operationId,
          reason: "stale",
          message: "stale",
          currentMarkdown: "external",
          currentVersion: 2,
          draftMarkdown: "hello!",
        },
      }),
    );
    app.view.dispatch(app.view.state.tr.insertText("?"));
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(editCount);
    expect(root.querySelector<HTMLElement>(".mm-recover")?.hidden).toBe(false);
    app.destroy();
  });

  it("reloads the authoritative document after the host opens a recovery draft separately", () => {
    let state: unknown = {
      recoveryDraft: "local draft",
      recoveryVersion: 1,
      recoveryProfile: "github",
      recoveryTimestamp: Date.now(),
    };
    const messages: unknown[] = [];
    const api: VSCodeApiLike = {
      postMessage: (message) => messages.push(message),
      getState: () => state,
      setState: (next) => {
        state = next;
      },
    };
    const { app, root } = makeApp("authoritative", api);
    root.querySelector<HTMLButtonElement>(".mm-recover")!.click();
    const apply = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".mm-recovery-dialog button"),
    ).find((button) => button.textContent === "Apply draft");
    apply?.click();
    const recover = messages.find(
      (message: any) => message.type === "recoverDraft",
    ) as any;
    expect(recover?.markdown).toBe("local draft");
    expect(recover?.baseVersion).toBe(1);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "recovery-opened",
          operationId: recover.operationId,
          currentMarkdown: "authoritative",
          currentVersion: 1,
          profile: "github",
          draftUri: "untitled:markdown-mint-recovery.md",
        },
      }),
    );
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "authoritative",
      version: 1,
      profile: "github",
      reason: "recovery",
    });
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")?.value,
    ).toBe("authoritative");
    expect(root.querySelector<HTMLButtonElement>(".mm-recover")?.hidden).toBe(
      false,
    );
    app.destroy();
  });

  it("defers an external document until IME composition ends", () => {
    const { app, root } = makeApp("local");
    const editor = root.querySelector<HTMLElement>(".ProseMirror")!;
    editor.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "外部",
      version: 2,
      profile: "github",
      reason: "external",
    });
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")?.value,
    ).toBe("local");
    editor.dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")?.value,
    ).toBe("外部");
    app.destroy();
  });
});

describe("table clipboard integration", () => {
  it("pastes TSV into a clicked body cell and expands in one edit", () => {
    const markdown = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { app, root, messages } = makeApp(markdown);
    const bodyCell = root.querySelector<HTMLElement>("tbody td")!;
    const cellPos = app.view.posAtDOM(bodyCell, 0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.near(app.view.state.doc.resolve(cellPos + 1)),
      ),
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (kind: string) =>
          kind === "text/plain" ? "日本語\t\n追加\t値" : "",
        setData: () => undefined,
      },
    });
    app.view.dom.dispatchEvent(event);
    const edit = messages.filter((message: any) => message.type === "edit");
    expect(edit).toHaveLength(1);
    expect((edit[0] as any).markdown).toContain("日本語");
    expect((edit[0] as any).markdown).toContain("追加");
    app.destroy();
  });
});
