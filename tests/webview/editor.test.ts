import { beforeEach, describe, expect, it, vi } from "vitest";
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
): message is { type: "edit"; markdown: string; baseVersion: number } {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as {
    type?: unknown;
    markdown?: unknown;
    baseVersion?: unknown;
  };
  return (
    candidate.type === "edit" &&
    typeof candidate.markdown === "string" &&
    typeof candidate.baseVersion === "number"
  );
}

function lastEditMarkdown(messages: unknown[]): string {
  return messages.filter(isEditMessage).at(-1)?.markdown ?? "";
}

function openImageDialog(root: HTMLElement): HTMLDialogElement {
  const button = root.querySelector<HTMLButtonElement>(
    '[data-testid="toolbar-image"]',
  );
  if (!button) throw new Error("image toolbar button is not rendered");
  button.click();
  const dialog = root.querySelector<HTMLDialogElement>(
    '[aria-labelledby="mm-image-dialog-title"]',
  );
  if (!dialog) throw new Error("image dialog is not rendered");
  return dialog;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function chooseCodeLanguage(
  root: HTMLElement,
  query: string,
  optionIdentifier: string,
): void {
  const trigger = root.querySelector<HTMLButtonElement>(
    ".mm-code-language-trigger",
  );
  if (!trigger)
    throw new Error(`code language trigger is not rendered: ${root.innerHTML}`);
  trigger.click();
  const input = root.querySelector<HTMLInputElement>(
    ".mm-code-language-inline",
  );
  if (!input) throw new Error("code language picker is not rendered");
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const option = Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-mm-language-option]"),
  ).find(
    (candidate) => candidate.dataset.mmLanguageOption === optionIdentifier,
  );
  if (!option)
    throw new Error(`language option ${optionIdentifier} is not rendered`);
  option.click();
}

function makeApp(
  markdown?: string,
  api?: VSCodeApiLike,
  clipboardAvailable = false,
  documentId?: string,
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
    initialDocument: {
      ...documentFixture(markdown, clipboardAvailable),
      ...(documentId === undefined ? {} : { documentId }),
    },
  });
  return { app, root, messages, vscode };
}

function codeBlockPosition(
  app: ReturnType<typeof makeApp>["app"],
  occurrence = 0,
): number {
  let found = -1;
  let seen = 0;
  app.view.state.doc.descendants((node, position) => {
    if (node.type.name === "code_block") {
      if (seen === occurrence) {
        found = position;
        return false;
      }
      seen += 1;
    }
    return true;
  });
  if (found < 0) throw new Error(`code block ${occurrence} is not present`);
  return found;
}

function selectCodeBlockText(
  app: ReturnType<typeof makeApp>["app"],
  offset: number,
  occurrence = 0,
): number {
  const position = codeBlockPosition(app, occurrence);
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.create(app.view.state.doc, position + 1 + offset),
    ),
  );
  return position;
}

type TestKeyboardEventInit = KeyboardEventInit & {
  keyCode?: number;
  isComposing?: boolean;
};

function dispatchCodeKey(
  root: HTMLElement,
  key: string,
  occurrence = 0,
  init: TestKeyboardEventInit = {},
): KeyboardEvent {
  const code = root.querySelectorAll<HTMLElement>(
    ".mm-code-block-view .mm-code-block-pre code",
  )[occurrence];
  if (!code) throw new Error(`code block ${occurrence} is not rendered`);
  const { keyCode, isComposing, ...keyboardInit } = init;
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...keyboardInit,
    key,
  });
  if (keyCode !== undefined)
    Object.defineProperty(event, "keyCode", { value: keyCode });
  if (isComposing !== undefined)
    Object.defineProperty(event, "isComposing", { value: isComposing });
  code.dispatchEvent(event);
  return event;
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

  it("shows labels only while retaining searchable language identifiers", () => {
    const { app, root } = makeApp("```ts\nvalue\n```");
    root.querySelector<HTMLButtonElement>(".mm-code-language-trigger")?.click();
    const input = root.querySelector<HTMLInputElement>(
      ".mm-code-language-inline",
    )!;

    const findOption = (identifier: string): HTMLButtonElement | undefined =>
      Array.from(
        root.querySelectorAll<HTMLButtonElement>("[data-mm-language-option]"),
      ).find((option) => option.dataset.mmLanguageOption === identifier);

    const expectLabel = (
      query: string,
      identifier: string,
      label: string,
    ): void => {
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const option = findOption(identifier);
      expect(option?.textContent).toBe(label);
      expect(
        option?.querySelector(".mm-code-language-option-badge"),
      ).toBeNull();
      expect(option?.querySelector(".mm-code-language-option-id")).toBeNull();
      expect(option?.querySelector(".mm-code-language-option-help")).toBeNull();
    };

    expectLabel("", "", "Language not specified");
    expectLabel("", "plaintext", "Plain Text");
    expectLabel("ts", "ts", "TypeScript");
    expectLabel("py", "py", "Python");
    expectLabel("bash", "bash", "Shell");
    expectLabel("sh", "sh", "Shell");
    expectLabel("csharp", "csharp", "C#");
    expectLabel("cpp", "cpp", "C++");

    input.value = "acme-dsl";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const custom = findOption("acme-dsl");
    expect(
      custom?.querySelector(".mm-code-language-option-text")?.textContent,
    ).toBe("Use “acme-dsl”");
    expect(
      custom?.querySelector(".mm-code-language-option-help")?.textContent,
    ).toBe("Highlighting is unavailable; the language name will be preserved.");
    expect(custom?.querySelector(".mm-code-language-option-badge")).toBeNull();
    expect(custom?.querySelector(".mm-code-language-option-id")).toBeNull();
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

  it("keeps shared highlight grammars from collapsing explicit language identities", () => {
    const cases = [
      ["ts", "TypeScript", "ts", "ts"],
      ["typescript", "ts", "typescript", "typescript"],
      ["tsx", "TypeScript", "typescript", "typescript"],
      ["html", "XML", "xml", "xml"],
      ["xml", "HTML", "html", "html"],
      ["toml", "INI", "ini", "ini"],
      ["ini", "TOML", "toml", "toml"],
      ["javascript", "JSX", "jsx", "jsx"],
      ["jsx", "JavaScript", "javascript", "javascript"],
    ] as const;

    for (const [current, query, option, expected] of cases) {
      const { app, root } = makeApp(`\`\`\`${current}\nvalue\n\`\`\``);
      chooseCodeLanguage(root, query, option);
      expect(app.view.state.doc.firstChild?.attrs.params).toBe(expected);
      app.destroy();
    }

    const suffix = makeApp('```tsx title="component.tsx"\nvalue\n```');
    chooseCodeLanguage(suffix.root, "TypeScript", "typescript");
    expect(suffix.app.view.state.doc.firstChild?.attrs.params).toBe(
      'typescript title="component.tsx"',
    );
    suffix.app.destroy();
  });

  it("confirms metadata loss before removing a language identifier", () => {
    const cases = [
      ['ts title="example.ts"', 'title="example.ts"'],
      ["acme-dsl custom=value", "custom=value"],
    ] as const;

    for (const [params, visibleSuffix] of cases) {
      const { app, root, messages } = makeApp(`\`\`\`${params}\nvalue\n\`\`\``);
      chooseCodeLanguage(root, "", "");
      const dialog = root.querySelector<HTMLDialogElement>(
        ".mm-code-language-confirm-dialog",
      );
      expect(dialog?.textContent).toContain(visibleSuffix);
      expect(app.view.state.doc.firstChild?.attrs.params).toBe(params);
      expect(
        messages.filter((message: any) => message.type === "edit"),
      ).toHaveLength(0);

      dialog
        ?.querySelector<HTMLButtonElement>("button:not([type='submit'])")
        ?.click();
      expect(root.querySelector(".mm-code-language-confirm-dialog")).toBeNull();
      expect(app.view.state.doc.firstChild?.attrs.params).toBe(params);
      expect(
        messages.filter((message: any) => message.type === "edit"),
      ).toHaveLength(0);

      chooseCodeLanguage(root, "", "");
      const confirmDialog = root.querySelector<HTMLDialogElement>(
        ".mm-code-language-confirm-dialog",
      );
      confirmDialog
        ?.querySelector<HTMLButtonElement>("button[type='submit']")
        ?.click();
      expect(app.view.state.doc.firstChild?.attrs.params).toBe("");
      expect(
        messages.filter((message: any) => message.type === "edit"),
      ).toHaveLength(1);
      expect(lastEditMarkdown(messages)).not.toContain(params);
      app.destroy();
    }
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
    expect(root.querySelector(".mm-code-language-confirm-dialog")).toBeNull();
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
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    app.destroy();
  });

  it("selects code non-editing areas while preserving controls and text selection", () => {
    const source =
      'Before\n\n```ts title="example.ts"\nconst value = 1;\n```\n\nAfter';
    const { app, root, messages } = makeApp(source);
    const card = root.querySelector<HTMLElement>(".mm-code-block")!;
    const header = card.querySelector<HTMLElement>(".mm-code-block-header")!;
    const lineNumbers = card.querySelector<HTMLElement>(
      ".mm-code-line-numbers",
    )!;
    const code = card.querySelector<HTMLElement>(".mm-code-block-pre code")!;

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, codeBlockPosition(app) + 1),
      ),
    );
    code.click();
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);

    header.click();
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.type.name).toBe(
      "code_block",
    );
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, codeBlockPosition(app) + 1),
      ),
    );
    lineNumbers.click();
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, codeBlockPosition(app) + 1),
      ),
    );
    card.click();
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, codeBlockPosition(app) + 1),
      ),
    );
    const trigger = card.querySelector<HTMLButtonElement>(
      ".mm-code-language-trigger",
    )!;
    trigger.click();
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    root
      .querySelector<HTMLButtonElement>(
        '.mm-code-block [data-mm-code-action="copy"]',
      )!
      .click();
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    app.destroy();
  });

  it.each(["Delete", "Backspace"])(
    "deletes a selected code block with %s and restores exact source through undo",
    (key) => {
      const source =
        'Before\n\n```ts title="example.ts"\nconst value = 1;\n```\n\nAfter';
      const { app, root, messages } = makeApp(source);
      root.querySelector<HTMLElement>(".mm-code-block-header")!.click();
      expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      app.view.dom.dispatchEvent(event);
      expect(serializeMarkdown(app.view.state.doc)).not.toContain("```ts");
      expect(serializeMarkdown(app.view.state.doc)).toContain("After");
      expect(messages.filter(isEditMessage)).toHaveLength(1);
      app.destroy();
    },
  );
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
  it("keeps lazy continuation lines in the alert editor when the body changes", () => {
    const source = "> [!TIP]\r\n> First\r\ncontinued\r\n> Last\r\n\r\nNext\r\n";
    const { app, root, messages } = makeApp(source);
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    expect(bodyEditor.value).toBe("First\ncontinued\nLast");

    bodyEditor.value = "First\ncontinued\nChanged";
    bodyEditor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(app.view.state.doc.firstChild?.attrs.source).toContain(
      "> continued",
    );
    expect(app.view.state.doc.firstChild?.attrs.source).toContain("> Changed");
    expect(lastEditMarkdown(messages)).toBe(
      "> [!TIP]\r\n> First\r\n> continued\r\n> Changed\r\n\r\nNext\r\n",
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
  it("moves directly between consecutive alert bodies and synchronizes the owning selection", () => {
    const { app, root } = makeApp(
      "Before\n\n> [!NOTE]\n> First\n\n> [!TIP]\n> Second\n\nAfter",
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
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);

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
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
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
  it("keeps alert boundary keys inert for the textarea's composition lifecycle", () => {
    const { app, root } = makeApp("> [!NOTE]\n> Alert");
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    bodyEditor.focus();
    bodyEditor.setSelectionRange(
      bodyEditor.value.length,
      bodyEditor.value.length,
    );

    bodyEditor.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    for (const key of ["ArrowRight", "ArrowLeft", "Enter"]) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      });
      bodyEditor.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(bodyEditor);
    }
    bodyEditor.dispatchEvent(new Event("compositionend", { bubbles: true }));

    const exit = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    bodyEditor.dispatchEvent(exit);
    expect(exit.defaultPrevented).toBe(true);
    expect(root.querySelector(".mm-alert-body-editor")).not.toBeNull();
    app.destroy();
  });
  it("routes alert history shortcuts through the host undo service", () => {
    const { app, root, messages } = makeApp("> [!NOTE]\n> abc");
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    bodyEditor.focus();

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
  it("accepts relative image paths from the insertion dialog", () => {
    const source = "replace me";
    const { app, root, messages } = makeApp(source);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 1 + source.length),
      ),
    );

    const dialog = openImageDialog(root);
    const [pathInput, altInput] = Array.from(
      dialog.querySelectorAll<HTMLInputElement>("input"),
    );
    expect(pathInput?.type).toBe("text");
    expect(pathInput?.getAttribute("type")).toBe("text");
    expect(pathInput?.validity.typeMismatch).toBe(false);
    expect(pathInput?.placeholder).toBe("./images/example.png");
    expect(dialog.textContent).toContain("Image path or URL");

    pathInput!.value = "./images/sample.png";
    expect(pathInput!.checkValidity()).toBe(true);
    altInput!.value = "sample";
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    expect(app.view.state.doc.firstChild?.firstChild?.attrs.src).toBe(
      "./images/sample.png",
    );
    expect(lastEditMarkdown(messages)).toBe("![sample](./images/sample.png)");
    expect(lastEditMarkdown(messages)).not.toContain(
      "vscode-webview-resource:",
    );
    app.destroy();
  });

  it.each([
    ["images/my image.png", "![sample](<images/my image.png>)"],
    ["../assets/banner.webp", "![sample](../assets/banner.webp)"],
  ])(
    "preserves image path %s through Markdown serialization",
    (path, expected) => {
      const source = "replace me";
      const { app, root, messages } = makeApp(source);
      app.view.dispatch(
        app.view.state.tr.setSelection(
          TextSelection.create(app.view.state.doc, 1, 1 + source.length),
        ),
      );

      const dialog = openImageDialog(root);
      const [pathInput, altInput] = Array.from(
        dialog.querySelectorAll<HTMLInputElement>("input"),
      );
      pathInput!.value = path;
      altInput!.value = "sample";
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

      expect(app.view.state.doc.firstChild?.firstChild?.attrs.src).toBe(path);
      expect(lastEditMarkdown(messages)).toBe(expected);
      app.destroy();
    },
  );

  it.each([
    [
      "https://example.com/image.png",
      "![sample](https://example.com/image.png)",
    ],
    ["http://example.com/image.png", "![sample](http://example.com/image.png)"],
  ])(
    "keeps absolute image URL %s supported by the insertion dialog",
    (path, expected) => {
      const source = "replace me";
      const { app, root, messages } = makeApp(source);
      app.view.dispatch(
        app.view.state.tr.setSelection(
          TextSelection.create(app.view.state.doc, 1, 1 + source.length),
        ),
      );

      const dialog = openImageDialog(root);
      const [pathInput, altInput] = Array.from(
        dialog.querySelectorAll<HTMLInputElement>("input"),
      );
      pathInput!.value = path;
      altInput!.value = "sample";
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

      expect(app.view.state.doc.firstChild?.firstChild?.attrs.src).toBe(path);
      expect(lastEditMarkdown(messages)).toBe(expected);
      app.destroy();
    },
  );
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

describe("code block vertical boundaries", () => {
  it("moves from the first visual row to the previous text block", () => {
    const markdown = [
      "Before paragraph",
      "",
      "```ts",
      "line 1",
      "line 2",
      "```",
      "",
      "After paragraph",
    ].join("\n");
    const { app, root, messages } = makeApp(markdown);
    const codePosition = selectCodeBlockText(app, 2);
    const selectionBefore = app.view.state.selection;
    expect(selectionBefore.$from.parent.type.name).toBe("code_block");
    expect(selectionBefore.$from.parentOffset).toBe(2);
    const endOfTextblock = vi
      .spyOn(app.view, "endOfTextblock")
      .mockReturnValue(true);

    const event = dispatchCodeKey(root, "ArrowUp");

    expect(endOfTextblock).toHaveBeenCalledWith("up");
    expect(event.defaultPrevented).toBe(true);
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(app.view.state.selection.$from.parent.textContent).toBe(
      "Before paragraph",
    );
    expect(app.view.state.selection.from).toBe(codePosition - 1);
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    expect(app.view.state.doc).toBe(selectionBefore.$from.doc);

    endOfTextblock.mockRestore();
    app.destroy();
  });

  it("uses the visual boundary result for wrapped and later logical lines", () => {
    const markdown = [
      "Before",
      "",
      "```ts",
      "a very long logical line that can wrap across visual rows",
      "second logical line",
      "```",
      "",
      "After",
    ].join("\n");
    const { app, root, messages } = makeApp(markdown);
    const codePosition = codeBlockPosition(app);
    const endOfTextblock = vi
      .spyOn(app.view, "endOfTextblock")
      .mockReturnValue(false);

    selectCodeBlockText(app, 12);
    const wrappedRow = dispatchCodeKey(root, "ArrowUp");
    expect(wrappedRow.defaultPrevented).toBe(false);
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    selectCodeBlockText(app, 0);
    endOfTextblock.mockReturnValue(true);
    const firstRow = dispatchCodeKey(root, "ArrowUp");
    expect(firstRow.defaultPrevented).toBe(true);
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Before");
    expect(app.view.state.selection.from).toBe(codePosition - 1);
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    endOfTextblock.mockRestore();
    app.destroy();
  });

  it("moves from the last displayed code row to the next body", () => {
    const { app, root, messages } = makeApp(
      ["Before", "", "```ts", "first", "second", "```", "", "After"].join("\n"),
    );
    selectCodeBlockText(app, "first\nsecond".length);
    const endOfTextblock = vi
      .spyOn(app.view, "endOfTextblock")
      .mockReturnValue(true);

    const event = dispatchCodeKey(root, "ArrowDown");

    expect(event.defaultPrevented).toBe(true);
    expect(endOfTextblock).toHaveBeenCalledWith("down");
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    endOfTextblock.mockRestore();
    app.destroy();
  });

  it("moves to the previous code block and supports nested containers", () => {
    const consecutive = makeApp(
      ["```js", "one", "```", "", "```ts", "two", "```"].join("\n"),
    );
    const consecutiveEndOfTextblock = vi
      .spyOn(consecutive.app.view, "endOfTextblock")
      .mockReturnValue(true);
    selectCodeBlockText(consecutive.app, 0, 1);
    const consecutiveEvent = dispatchCodeKey(consecutive.root, "ArrowUp", 1);
    expect(consecutiveEvent.defaultPrevented).toBe(true);
    expect(consecutive.app.view.state.selection.$from.parent.type.name).toBe(
      "code_block",
    );
    expect(consecutive.app.view.state.selection.$from.parent.textContent).toBe(
      "one",
    );
    expect(consecutive.app.view.state.selection.$from.parentOffset).toBe(
      consecutive.app.view.state.selection.$from.parent.content.size,
    );
    expect(consecutive.app.view.state.selection).not.toBeInstanceOf(
      NodeSelection,
    );
    expect(consecutive.messages.filter(isEditMessage)).toHaveLength(0);
    consecutiveEndOfTextblock.mockRestore();
    consecutive.app.destroy();

    for (const markdown of [
      ["> Before", ">", "> ```ts", "> code", "> ```"].join("\n"),
      ["- Before", "", "  ```ts", "  code", "  ```"].join("\n"),
    ]) {
      const nested = makeApp(markdown);
      const nestedEndOfTextblock = vi
        .spyOn(nested.app.view, "endOfTextblock")
        .mockReturnValue(true);
      selectCodeBlockText(nested.app, 0);
      const nestedEvent = dispatchCodeKey(nested.root, "ArrowUp");
      expect(nestedEvent.defaultPrevented).toBe(true);
      expect(nested.app.view.state.selection.$from.parent.type.name).toBe(
        "paragraph",
      );
      expect(nested.app.view.state.selection.$from.parent.textContent).toBe(
        "Before",
      );
      expect(nested.app.view.state.selection.$from.depth).toBeGreaterThan(1);
      expect(nested.messages.filter(isEditMessage)).toHaveLength(0);
      nestedEndOfTextblock.mockRestore();
      nested.app.destroy();
    }
  });

  it("leaves the document unchanged when no previous text position exists", () => {
    const { app, root, messages } = makeApp(
      ["```ts", "first", "second", "```"].join("\n"),
    );
    selectCodeBlockText(app, 2);
    const originalDoc = app.view.state.doc;
    const originalSelection = app.view.state.selection;
    const endOfTextblock = vi
      .spyOn(app.view, "endOfTextblock")
      .mockReturnValue(true);

    const event = dispatchCodeKey(root, "ArrowUp");

    expect(event.defaultPrevented).toBe(false);
    expect(app.view.state.doc).toBe(originalDoc);
    expect(app.view.state.selection.eq(originalSelection)).toBe(true);
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    endOfTextblock.mockRestore();
    app.destroy();
  });

  it("does not intercept modifiers, non-empty selections, or IME keys", () => {
    const { app, root, messages } = makeApp(
      ["Before", "", "```ts", "first", "second", "```"].join("\n"),
    );
    const endOfTextblock = vi
      .spyOn(app.view, "endOfTextblock")
      .mockReturnValue(true);
    const cases: TestKeyboardEventInit[] = [
      { shiftKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { isComposing: true },
      { keyCode: 229 },
    ];

    for (const init of cases) {
      selectCodeBlockText(app, 2);
      const event = dispatchCodeKey(root, "ArrowUp", 0, init);
      expect(event.defaultPrevented).toBe(false);
      expect(app.view.state.selection.$from.parent.type.name).toBe(
        "code_block",
      );
    }

    selectCodeBlockText(app, 2);
    const nonEmpty = app.view.state.selection.from;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, nonEmpty, nonEmpty + 2),
      ),
    );
    const selectedEvent = dispatchCodeKey(root, "ArrowUp");
    expect(selectedEvent.defaultPrevented).toBe(false);
    expect(app.view.state.selection.empty).toBe(false);
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    expect(endOfTextblock).not.toHaveBeenCalled();

    endOfTextblock.mockRestore();
    app.destroy();
  });

  it("keeps code-block controls and expanded mode out of boundary navigation", () => {
    const { app, root, messages } = makeApp(
      ["Before", "", "```ts", "first", "second", "```"].join("\n"),
    );
    selectCodeBlockText(app, 2);
    const endOfTextblock = vi
      .spyOn(app.view, "endOfTextblock")
      .mockReturnValue(true);
    const input = root.querySelector<HTMLInputElement>(
      ".mm-code-language-inline",
    )!;
    root.querySelector<HTMLButtonElement>(".mm-code-language-trigger")!.click();
    const pickerEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowUp",
    });
    input.dispatchEvent(pickerEvent);
    expect(pickerEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(endOfTextblock).not.toHaveBeenCalled();
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
    const more = root.querySelector<HTMLButtonElement>(
      '[data-mm-code-action="more"]',
    )!;
    more.click();
    const menuItem = root.querySelector<HTMLButtonElement>(
      '[data-mm-code-menu-option="wrap"]',
    )!;
    const menuEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    menuItem.dispatchEvent(menuEvent);
    expect(menuEvent.defaultPrevented).toBe(true);
    expect(endOfTextblock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      root.querySelector('[data-mm-code-menu-option="line-numbers"]'),
    );

    root
      .querySelector<HTMLButtonElement>('[data-mm-code-action="expand"]')!
      .click();
    app.view.focus();
    const expandedEvent = dispatchCodeKey(root, "ArrowUp");
    expect(expandedEvent.defaultPrevented).toBe(true);
    expect(
      root
        .querySelector<HTMLElement>(".mm-code-block")
        ?.classList.contains("mm-code-block-expanded"),
    ).toBe(true);
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    endOfTextblock.mockRestore();
    app.destroy();
  });

  it("focuses an adjacent Alert body and synchronizes its owning raw atom", () => {
    const source = [
      "> [!NOTE]",
      "> Alert body",
      "",
      "```ts",
      "code",
      "```",
    ].join("\n");
    const { app, root, messages } = makeApp(source);
    selectCodeBlockText(app, 0);
    const endOfTextblock = vi
      .spyOn(app.view, "endOfTextblock")
      .mockReturnValue(true);

    const event = dispatchCodeKey(root, "ArrowUp");
    const body = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(body);
    expect(body.selectionStart).toBe(body.value.length);
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    endOfTextblock.mockRestore();
    app.destroy();
  });
});

describe("sync safety", () => {
  it("keeps the latest local draft after a stale rejection when changes are independent", () => {
    const { app, messages } = makeApp("Title\nBody");
    const end = TextSelection.atEnd(app.view.state.doc);
    app.view.dispatch(app.view.state.tr.setSelection(end).insertText(" local"));
    const first = messages.filter(isEditMessage).at(-1) as
      { operationId?: string; markdown?: string } | undefined;
    expect(first?.operationId).toBeDefined();

    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "Remote title\nBody",
      version: 2,
      profile: "github",
      reason: "external",
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "edit-rejected",
          operationId: first?.operationId,
          reason: "stale",
          message: "The document changed.",
          currentMarkdown: "Remote title\nBody",
          currentVersion: 2,
          draftMarkdown: first?.markdown,
        },
      }),
    );

    const rebased = messages.filter(isEditMessage).at(-1);
    expect(messages.filter(isEditMessage)).toHaveLength(2);
    expect(rebased?.baseVersion).toBe(2);
    expect(rebased?.markdown).toContain("Remote title");
    expect(rebased?.markdown).toContain("local");

    app.view.dispatch(app.view.state.tr.insertText("!"));
    expect(app.sync.queuedEdit?.markdown).toContain("!");
    app.destroy();
  });

  it("ignores a delayed acknowledgement for an older operation without losing newer input", () => {
    const { app, messages } = makeApp("base");
    app.view.dispatch(app.view.state.tr.insertText(" first"));
    const first = messages.filter(isEditMessage).at(-1)! as any;
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: first.markdown,
      version: 2,
      profile: "github",
      operationId: first.operationId,
      reason: "ack",
    });
    app.view.dispatch(app.view.state.tr.insertText(" second"));
    const second = messages.filter(isEditMessage).at(-1)! as any;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "document",
          markdown: first.markdown,
          version: 2,
          profile: "github",
          operationId: first.operationId,
          reason: "ack",
        },
      }),
    );
    expect(app.view.state.doc.textContent).toContain("first");
    expect(app.view.state.doc.textContent).toContain("second");
    expect(app.sync.inflight?.operationId).toBe(second.operationId);
    expect(messages.filter(isEditMessage)).toHaveLength(2);
    app.destroy();
  });

  it("applies a newer acknowledgement broadcast from another panel", () => {
    const source = makeApp("base");
    const end = TextSelection.atEnd(source.app.view.state.doc);
    source.app.view.dispatch(
      source.app.view.state.tr.setSelection(end).insertText(" update"),
    );
    const edit = source.messages.filter(isEditMessage).at(-1)! as any;

    const sibling = makeApp("base");
    sibling.app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: edit.markdown,
      version: 2,
      profile: "github",
      operationId: edit.operationId,
      reason: "ack",
    });

    expect(sibling.app.view.state.doc.textContent).toBe("base update");
    expect(sibling.app.sync.hasPending).toBe(false);
    sibling.app.destroy();
    source.app.destroy();
  });

  it("does not render an internal status footer", () => {
    const { app, root } = makeApp("hello");
    expect(root.querySelector(".mm-statusbar")).toBeNull();
    expect(root.querySelector(".mm-status")).toBeNull();
    expect(root.querySelector(".mm-recover")).toBeNull();
    expect(
      root.querySelector(".mm-toolbar-primary > .mm-compatibility"),
    ).not.toBeNull();
    app.destroy();
  });

  it("does not submit an empty replacement when serialization fails", () => {
    const messages: unknown[] = [];
    let recoveryState: unknown;
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
      vscode: {
        postMessage: (message) => messages.push(message),
        getState: () => recoveryState,
        setState: (next) => {
          recoveryState = next;
        },
      },
      core: throwingCore,
      initialDocument: {
        markdown: initial.source,
        version: 1,
        profile: "github",
      },
    });
    const before = messages.length;
    const beforeEdits = messages.filter(
      (message: any) => message.type === "edit",
    ).length;
    broken.view.dispatch(broken.view.state.tr.insertText("!"));
    expect(messages.length).toBeGreaterThan(before);
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(beforeEdits);
    expect(broken.view.editable).toBe(true);
    expect(broken.view.state.doc.textContent).toContain("hello");
    expect(root.querySelector(".mm-status")).toBeNull();
    expect(
      (recoveryState as { recoveryDocument?: unknown } | undefined)
        ?.recoveryDocument,
    ).toBeDefined();
    broken.destroy();
  });

  it("keeps parser failures in raw source and routes editing to the native source document", () => {
    const messages: unknown[] = [];
    const appRoot = document.createElement("div");
    document.body.append(appRoot);
    const app = createEditorApp({
      root: appRoot,
      vscode: { postMessage: (message) => messages.push(message) },
      core: {
        schema,
        parseMarkdown: (source, profile) => {
          if (source === "unrepresentable")
            throw new Error("unsupported parser input");
          return parseMarkdown(source, profile);
        },
        serializeMarkdown,
        renderMarkdown,
      },
      initialDocument: {
        markdown: "hello",
        version: 1,
        profile: "github",
        documentId: "file:///workspace/doc.md",
      },
    });
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: "unrepresentable",
      version: 2,
      profile: "github",
      documentId: "file:///workspace/doc.md",
      reason: "external",
    });

    expect(app.mode).toBe("source");
    expect(app.view.editable).toBe(false);
    expect(
      appRoot.querySelector<HTMLTextAreaElement>(".mm-source-textarea")?.value,
    ).toBe("unrepresentable");
    expect(messages.some((message: any) => message.type === "source")).toBe(
      true,
    );
    expect(appRoot.querySelector(".mm-statusbar")).toBeNull();
    expect(appRoot.querySelector(".mm-status")).toBeNull();
    app.destroy();
  });

  it("retains an overlapping stale draft without presenting a recovery control", () => {
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
    expect(app.view.state.doc.textContent).toContain("!?hello");
    expect(root.querySelector(".mm-recover")).toBeNull();
    expect(root.querySelector(".mm-statusbar")).toBeNull();
    expect(messages.some((message: any) => message.type === "notify")).toBe(
      true,
    );
    app.destroy();
  });

  it("automatically restores a same-document draft and keeps an empty draft valid", () => {
    let state: unknown = {
      documentId: "file:///workspace/doc.md",
      recoveryDraft: "local draft",
      recoveryBaseMarkdown: "authoritative",
      recoveryBaseVersion: 1,
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
    const { app, root } = makeApp(
      "authoritative",
      api,
      false,
      "file:///workspace/doc.md",
    );
    expect(app.view.state.doc.textContent).toContain("local draft");
    expect(
      messages.some(
        (message: any) =>
          message.type === "edit" && message.markdown === "local draft",
      ),
    ).toBe(true);
    expect(root.querySelector(".mm-recover")).toBeNull();
    expect(root.querySelector(".mm-recovery-dialog")).toBeNull();
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      documentId: "file:///workspace/doc.md",
      markdown: "authoritative",
      version: 1,
      profile: "github",
      reason: "initial",
    });
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(1);
    app.destroy();

    state = {
      documentId: "file:///workspace/doc.md",
      recoveryDraft: "",
      recoveryBaseMarkdown: "authoritative",
      recoveryBaseVersion: 1,
      recoveryProfile: "github",
    };
    const empty = makeApp(
      "authoritative",
      api,
      false,
      "file:///workspace/doc.md",
    );
    expect(empty.app.view.state.doc.textContent).toBe("");
    expect(
      messages.some(
        (message: any) => message.type === "edit" && message.markdown === "",
      ),
    ).toBe(true);
    expect(empty.root.querySelector(".mm-recover")).toBeNull();
    empty.app.destroy();

    state = {
      documentId: "file:///workspace/other.md",
      recoveryDraft: "old document draft",
      recoveryBaseMarkdown: "authoritative",
      recoveryBaseVersion: 1,
      recoveryProfile: "github",
    };
    const wrongDocument = makeApp(
      "authoritative",
      api,
      false,
      "file:///workspace/doc.md",
    );
    expect(wrongDocument.app.view.state.doc.textContent).toBe("authoritative");
    expect(
      messages.some(
        (message: any) =>
          message.type === "edit" && message.markdown === "old document draft",
      ),
    ).toBe(false);
    wrongDocument.app.destroy();
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
