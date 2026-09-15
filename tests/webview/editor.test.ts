import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import {
  MAX_CLIPBOARD_TEXT_LENGTH,
  MAX_MARKDOWN_LENGTH,
  PROTOCOL_VERSION,
} from "../../src/shared/protocol";
import { BlockBoundarySelection } from "../../src/webview/blockBoundary";
import {
  imageImportPluginKey,
  parseImageImportUriList,
} from "../../src/webview/imageImport";
import {
  createEditorApp,
  type EditorInitialDocument,
  type VSCodeApiLike,
} from "../../src/webview/editor";

function documentFixture(
  markdown = "# Title\n\nParagraph",
  clipboardAvailable = false,
  profile: EditorInitialDocument["profile"] = "github",
): EditorInitialDocument {
  return {
    markdown,
    version: 1,
    profile,
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

function isWorkspaceFileSearchMessage(
  message: unknown,
): message is { type: "workspace-file-search"; requestId: string } {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { type?: unknown; requestId?: unknown };
  return (
    candidate.type === "workspace-file-search" &&
    typeof candidate.requestId === "string"
  );
}

function hasMessageType(messages: unknown[], type: string): boolean {
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === type,
  );
}

function dispatchPaste(
  app: ReturnType<typeof makeApp>["app"],
  data: Record<string, string>,
  target: EventTarget = app.view.dom,
): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (kind: string) => data[kind] ?? "",
      setData: () => undefined,
    },
  });
  if (!(target instanceof EventTarget))
    throw new Error("paste target is not an EventTarget");
  target.dispatchEvent(event);
  return event;
}

function selectText(
  app: ReturnType<typeof makeApp>["app"],
  element: Element,
  from: number,
  to = from,
): void {
  const position = app.view.posAtDOM(element, 0);
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.create(app.view.state.doc, position + from, position + to),
    ),
  );
}

function imageFile(
  name: string,
  type = "image/png",
  bytes = new Uint8Array([0]),
  arrayBuffer: () => Promise<ArrayBuffer> = async () => bytes.buffer,
): File {
  return { name, type, size: bytes.byteLength, arrayBuffer } as File;
}

function dispatchImageDrop(
  app: ReturnType<typeof makeApp>["app"],
  files: readonly File[],
  position: number,
  uriList?: string,
): DragEvent {
  const event = new Event("drop", {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: {
      files,
      types: uriList === undefined ? [] : ["text/uri-list"],
      getData: (format: string) =>
        format === "text/uri-list" ? (uriList ?? "") : "",
    },
  });
  Object.defineProperty(event, "shiftKey", { value: true });
  Object.defineProperty(event, "clientX", { value: 40 });
  Object.defineProperty(event, "clientY", { value: 20 });
  const originalPosAtCoords = app.view.posAtCoords;
  app.view.posAtCoords = (() => ({
    pos: position,
    inside: -1,
  })) as typeof app.view.posAtCoords;
  app.view.dom.dispatchEvent(event);
  app.view.posAtCoords = originalPosAtCoords;
  return event;
}

function receiveHostMessage(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

function selectTableCellText(
  app: ReturnType<typeof makeApp>["app"],
  cell: Element,
  from: number,
  to = from,
): void {
  const cellPos = app.view.posAtDOM(cell, 0);
  app.view.dispatch(
    app.view.state.tr.setSelection(
      TextSelection.create(
        app.view.state.doc,
        cellPos + 1 + from,
        cellPos + 1 + to,
      ),
    ),
  );
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

function openLinkPicker(root: HTMLElement): HTMLElement {
  const button = root.querySelector<HTMLButtonElement>(
    '[data-testid="toolbar-link"]',
  );
  if (!button) throw new Error("link toolbar button is not rendered");
  button.click();
  const picker = root.querySelector<HTMLElement>(
    '[data-testid="link-selection-picker"]',
  );
  if (!picker || picker.hidden) throw new Error("link picker is not rendered");
  return picker;
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
  profile: EditorInitialDocument["profile"] = "github",
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
      ...documentFixture(markdown, clipboardAvailable, profile),
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
  if (!document.elementFromPoint)
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => null,
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

  it("opens the language picker without an active candidate", () => {
    const { app, root, messages } = makeApp("```javascript\nvalue\n```");
    root.querySelector<HTMLButtonElement>(".mm-code-language-trigger")!.click();
    const input = root.querySelector<HTMLInputElement>(
      ".mm-code-language-inline",
    )!;
    const menu = input.closest<HTMLElement>(".mm-code-language-menu")!;
    const javascript = root.querySelector<HTMLButtonElement>(
      '[data-mm-language-option="javascript"]',
    )!;
    const unspecified = root.querySelector<HTMLButtonElement>(
      '[data-mm-language-option=""]',
    )!;

    expect(document.activeElement).toBe(input);
    expect(menu.dataset.inputModality).toBe("pointer");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(menu.querySelector(".is-active")).toBeNull();
    expect(javascript.getAttribute("aria-selected")).toBe("true");
    expect(unspecified.getAttribute("aria-selected")).toBe("false");
    expect(app.view.state.doc.firstChild?.attrs.params).toBe("javascript");
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    app.destroy();
  });

  it("switches language picker modality and clears keyboard indication on pointer input", () => {
    const { app, root } = makeApp("```javascript\nvalue\n```");
    root.querySelector<HTMLButtonElement>(".mm-code-language-trigger")!.click();
    const input = root.querySelector<HTMLInputElement>(
      ".mm-code-language-inline",
    )!;
    const menu = input.closest<HTMLElement>(".mm-code-language-menu")!;
    const options = (): HTMLButtonElement[] =>
      Array.from(
        menu.querySelectorAll<HTMLButtonElement>("[data-mm-language-option]"),
      );

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowUp",
      }),
    );
    expect(menu.dataset.inputModality).toBe("keyboard");
    expect(menu.querySelector(".is-active")).toBe(options()[0]);
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0]?.id);

    input.value = "java";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const filteredFirst = menu.querySelector<HTMLButtonElement>(
      "[data-mm-language-option]",
    )!;
    expect(menu.dataset.inputModality).toBe("keyboard");
    expect(menu.querySelector(".is-active")).toBe(filteredFirst);
    expect(input.getAttribute("aria-activedescendant")).toBe(filteredFirst.id);

    filteredFirst.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(menu.dataset.inputModality).toBe("pointer");
    expect(menu.querySelector(".is-active")).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    input.value = "java";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const pointerDownTarget = menu.querySelector<HTMLButtonElement>(
      "[data-mm-language-option]",
    )!;
    pointerDownTarget.dispatchEvent(
      new Event("pointerdown", { bubbles: true }),
    );
    expect(menu.dataset.inputModality).toBe("pointer");
    expect(menu.querySelector(".is-active")).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    app.destroy();
  });

  it("does not remove a language on empty Enter without an active candidate", () => {
    const { app, root, messages } = makeApp("```javascript\nvalue\n```");
    const trigger = root.querySelector<HTMLButtonElement>(
      ".mm-code-language-trigger",
    )!;
    trigger.click();
    const input = root.querySelector<HTMLInputElement>(
      ".mm-code-language-inline",
    )!;
    const menu = input.closest<HTMLElement>(".mm-code-language-menu")!;
    const emptyEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    input.dispatchEvent(emptyEnter);

    expect(emptyEnter.defaultPrevented).toBe(true);
    expect(app.view.state.doc.firstChild?.attrs.params).toBe("javascript");
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    expect(menu.hidden).toBe(true);

    trigger.click();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
      }),
    );
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    expect(
      root.querySelector<HTMLButtonElement>(
        `[id="${input.getAttribute("aria-activedescendant")}"]`,
      )?.dataset.mmLanguageOption,
    ).toBe("");
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    expect(app.view.state.doc.firstChild?.attrs.params).toBe("");
    expect(messages.filter(isEditMessage)).toHaveLength(1);
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
  it("uses a boundary stop between consecutive alert bodies", () => {
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
    expect(document.activeElement).toBe(app.view.dom);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);

    app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
      }),
    );
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
    expect(document.activeElement).toBe(app.view.dom);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);

    app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowLeft",
      }),
    );
    expect(document.activeElement).toBe(first);
    expect(first.selectionStart).toBe(first.value.length);
    expect(first.selectionEnd).toBe(first.value.length);
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    app.destroy();
  });
  it("opens and closes the document-end boundary for a final Alert", () => {
    const source = "> [!NOTE]\n> End";
    const { app, root, messages } = makeApp(source);
    const bodyEditor = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    Object.defineProperty(bodyEditor, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 40,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
      }),
    });
    bodyEditor.focus();
    bodyEditor.setSelectionRange(
      bodyEditor.value.length,
      bodyEditor.value.length,
    );
    const exit = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    bodyEditor.dispatchEvent(exit);
    expect(exit.defaultPrevented).toBe(true);
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(0);
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")?.value,
    ).toBe(source);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    expect(app.view.state.selection.head).toBe(app.view.state.doc.content.size);
    expect(app.view.state.doc.lastChild?.type.name).toBe("raw_block");

    app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowUp",
      }),
    );
    expect(document.activeElement).toBe(bodyEditor);
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect(root.querySelector(".mm-block-boundary-cursor")).toBeNull();

    bodyEditor.setSelectionRange(
      bodyEditor.value.length,
      bodyEditor.value.length,
    );
    bodyEditor.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
      }),
    );
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    const handled = app.view.someProp("handleTextInput", (handler) =>
      handler(
        app.view,
        app.view.state.selection.from,
        app.view.state.selection.to,
        "After alert",
        () => app.view.state.tr,
      ),
    );
    expect(handled).toBe(true);
    expect(
      root.querySelector<HTMLTextAreaElement>(".mm-source-textarea")?.value,
    ).toContain("After alert");
    expect(messages.filter(isEditMessage)).toHaveLength(1);
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

  it("uses the selected-text link picker and applies the active candidate", async () => {
    const source = "replace me";
    const { app, root, messages } = makeApp(source);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 1 + source.length),
      ),
    );
    const picker = openLinkPicker(root);
    const linkInput = picker.querySelector<HTMLInputElement>("input");
    expect(linkInput).not.toBeNull();
    expect(
      picker.querySelector('input[placeholder="Selected text"]'),
    ).toBeNull();
    expect(picker.querySelector('button[type="submit"]')).toBeNull();
    expect(
      root.querySelector<HTMLDialogElement>(
        '[aria-labelledby="mm-link-dialog-title"]',
      )?.open,
    ).toBe(false);
    linkInput!.value = "ho";
    linkInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    const request = messages.find(
      (message: any) => message.type === "workspace-file-search",
    ) as any;
    expect(request).toMatchObject({ filter: "all", query: "ho" });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "workspace-file-search-result",
          requestId: request.requestId,
          candidates: [
            {
              fileName: "hoge manual.pdf",
              directory: "specs/",
              relativePath: "../specs/hoge%20manual.pdf",
            },
            {
              fileName: "hoge-design.md",
              directory: "docs/",
              relativePath: "../docs/hoge-design.md",
            },
          ],
        },
      }),
    );
    const options = picker.querySelectorAll<HTMLButtonElement>(
      ".mm-file-autocomplete-option",
    );
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain("hoge manual.pdf");
    expect(linkInput!.getAttribute("aria-controls")).toMatch(
      /^mm-file-autocomplete-/,
    );
    expect(linkInput!.getAttribute("aria-activedescendant")).toBe(
      options[0]?.id,
    );

    const beforeEdits = messages.filter(isEditMessage).length;
    linkInput!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    linkInput!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(linkInput!.value).toBe("../docs/hoge-design.md");
    expect(
      picker.querySelector<HTMLElement>(".mm-file-autocomplete")?.hidden,
    ).toBe(true);
    expect(messages.filter(isEditMessage)).toHaveLength(beforeEdits + 1);
    expect(picker.hidden).toBe(true);
    expect(lastEditMarkdown(messages)).toBe(
      "[replace me](../docs/hoge-design.md)",
    );
    app.destroy();
  });

  it("keeps selected link text unchanged for Escape and IME paths", () => {
    const source = "replace me";
    const { app, root, messages } = makeApp(source);
    const selection = TextSelection.create(
      app.view.state.doc,
      1,
      1 + source.length,
    );
    app.view.dispatch(app.view.state.tr.setSelection(selection));
    const picker = openLinkPicker(root);
    const input = picker.querySelector<HTMLInputElement>("input")!;
    input.value = "../docs/guide.md";
    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEnter, "isComposing", { value: true });
    input.dispatchEvent(composingEnter);
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    expect(picker.hidden).toBe(false);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(picker.hidden).toBe(true);
    expect(app.view.state.selection.from).toBe(selection.from);
    expect(app.view.state.selection.to).toBe(selection.to);
    expect(app.view.state.doc.textContent).toBe(source);
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    app.destroy();
  });

  it("ignores stale workspace search results without replacing the loading state", () => {
    const source = "replace me";
    const { app, root, messages } = makeApp(source);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 1 + source.length),
      ),
    );
    const picker = openLinkPicker(root);
    const input = picker.querySelector<HTMLInputElement>("input")!;
    input.value = "h";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "ho";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const requests = messages.filter(isWorkspaceFileSearchMessage);
    expect(requests).toHaveLength(2);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "workspace-file-search-result",
          requestId: requests[0]!.requestId,
          candidates: [
            {
              fileName: "stale.md",
              directory: "docs/",
              relativePath: "./stale.md",
            },
          ],
        },
      }),
    );
    expect(
      picker.querySelector<HTMLElement>(".mm-file-autocomplete")?.dataset,
    ).toMatchObject({ searchState: "loading" });
    expect(picker.querySelector(".mm-file-autocomplete-option")).toBeNull();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "workspace-file-search-result",
          requestId: requests[1]!.requestId,
          candidates: [
            {
              fileName: "fresh.md",
              directory: "docs/",
              relativePath: "./fresh.md",
            },
          ],
        },
      }),
    );
    expect(
      picker.querySelector<HTMLElement>(
        ".mm-file-autocomplete-option .mm-file-autocomplete-name",
      )?.textContent,
    ).toBe("fresh.md");
    app.destroy();
  });

  it("keeps image autocomplete image-only and leaves Alt text untouched", async () => {
    const source = "replace me";
    const { app, root, messages } = makeApp(source);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 1 + source.length),
      ),
    );
    const dialog = openImageDialog(root);
    const [imageInput, altInput] = Array.from(
      dialog.querySelectorAll<HTMLInputElement>("input"),
    );
    altInput!.value = "Keep this alt text";
    imageInput!.value = "lo";
    imageInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    const request = messages.find(
      (message: any) => message.type === "workspace-file-search",
    ) as any;
    expect(request).toMatchObject({ filter: "image", query: "lo" });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "workspace-file-search-result",
          requestId: request.requestId,
          candidates: [
            {
              fileName: "logo.png",
              directory: "assets/",
              relativePath: "../assets/logo.png",
            },
          ],
        },
      }),
    );
    expect(
      dialog.querySelectorAll(".mm-file-autocomplete-option"),
    ).toHaveLength(1);
    imageInput!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(imageInput!.value).toBe("../assets/logo.png");
    expect(altInput!.value).toBe("Keep this alt text");
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    await flush();
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    expect(app.view.state.doc.firstChild?.firstChild?.attrs.src).toBe(
      "../assets/logo.png",
    );
    expect(app.view.state.doc.firstChild?.firstChild?.attrs.alt).toBe(
      "Keep this alt text",
    );
    expect(lastEditMarkdown(messages)).toBe(
      "![Keep this alt text](../assets/logo.png)",
    );
    app.destroy();
  });

  it("cancels Link and Image dialogs on Escape through the dialog fallback", () => {
    const source = "replace me";
    const { app, root, messages } = makeApp(source);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1),
      ),
    );

    const linkButton = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-link"]',
    )!;
    linkButton.click();
    const linkDialog = root.querySelector<HTMLDialogElement>(
      '[aria-labelledby="mm-link-dialog-title"]',
    )!;
    const linkInput = linkDialog.querySelector<HTMLInputElement>("input")!;
    linkInput.value = "./changed.md";
    const linkEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    linkInput.dispatchEvent(linkEscape);

    expect(linkEscape.defaultPrevented).toBe(true);
    expect(linkDialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(linkButton);
    expect(app.view.state.doc.textContent).toBe(source);
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    const imageButton = root.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-image"]',
    )!;
    imageButton.click();
    const imageDialog = root.querySelector<HTMLDialogElement>(
      '[aria-labelledby="mm-image-dialog-title"]',
    )!;
    const imageInput = imageDialog.querySelector<HTMLInputElement>("input")!;
    imageInput.value = "./changed.png";
    const imageEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    imageInput.dispatchEvent(imageEscape);

    expect(imageEscape.defaultPrevented).toBe(true);
    expect(imageDialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(imageButton);
    expect(app.view.state.doc.textContent).toBe(source);
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    app.destroy();
  });

  it("keeps external URLs manual and Escape restores the selected link", async () => {
    const source = "replace me";
    const { app, root, messages } = makeApp(source);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 1 + "replace me".length),
      ),
    );
    const picker = openLinkPicker(root);
    const linkInput = picker.querySelector<HTMLInputElement>("input");
    linkInput!.value = "ho";
    linkInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    const request = messages.find(
      (message: any) => message.type === "workspace-file-search",
    ) as any;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: PROTOCOL_VERSION,
          type: "workspace-file-search-result",
          requestId: request.requestId,
          candidates: [
            {
              fileName: "hoge.pdf",
              directory: "docs/",
              relativePath: "./hoge.pdf",
            },
          ],
        },
      }),
    );
    expect(
      picker.querySelector<HTMLElement>(".mm-file-autocomplete")?.hidden,
    ).toBe(false);
    linkInput!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(picker.hidden).toBe(true);
    expect(app.view.state.selection.from).toBe(1);
    expect(app.view.state.selection.to).toBe(1 + source.length);
    expect(messages.filter(isEditMessage)).toHaveLength(0);

    const reopenedPicker = openLinkPicker(root);
    const reopenedInput =
      reopenedPicker.querySelector<HTMLInputElement>("input");
    reopenedInput!.value = "https://example.com";
    reopenedInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(
      messages.filter(
        (message: any) => message.type === "workspace-file-search",
      ),
    ).toHaveLength(1);
    reopenedInput!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(lastEditMarkdown(messages)).toBe(
      "[replace me](https://example.com)",
    );
    expect(reopenedPicker.hidden).toBe(true);
    app.destroy();
  });

  it.each([
    ["docs/guide.md", "[text](docs/guide.md)"],
    ["./docs/guide.md", "[text](./docs/guide.md)"],
    ["../README.md", "[text](../README.md)"],
    ["/docs/guide.md", "[text](/docs/guide.md)"],
    ["#section", "[text](#section)"],
    ["https://example.com", "[text](https://example.com)"],
    ["mailto:user@example.com", "[text](mailto:user@example.com)"],
  ])("accepts link destination %s without normalization", (href, expected) => {
    const source = "text";
    const { app, root, messages } = makeApp(source);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 1 + source.length),
      ),
    );

    const picker = openLinkPicker(root);
    const linkInput = picker.querySelector<HTMLInputElement>("input");
    expect(linkInput?.type).toBe("text");
    expect(linkInput?.getAttribute("type")).toBe("text");
    expect(linkInput?.placeholder).toBe(
      "./docs/example.md or https://example.com",
    );
    expect(linkInput?.spellcheck).toBe(false);
    expect(linkInput?.autocapitalize).toBe("off");
    expect(linkInput?.inputMode).toBe("url");
    expect(picker.textContent).toContain("Search / URL");

    linkInput!.value = href;
    expect(linkInput!.checkValidity()).toBe(true);
    linkInput!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(
      app.view.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href,
    ).toBe(href);
    expect(lastEditMarkdown(messages)).toBe(expected);
    app.destroy();
  });

  it("loads and reapplies an existing relative link without changing its href", () => {
    const source = "[text](../README.md)";
    const { app, root } = makeApp(source);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 1 + "text".length),
      ),
    );

    const picker = openLinkPicker(root);
    const linkInput = picker.querySelector<HTMLInputElement>("input");
    expect(linkInput?.value).toBe("../README.md");
    expect(linkInput?.checkValidity()).toBe(true);
    linkInput!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(
      app.view.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href,
    ).toBe("../README.md");
    expect(
      serializeMarkdown(app.view.state.doc, parseMarkdown(source, "github")),
    ).toBe(source);
    app.destroy();
  });

  it("removes an existing link from the selected-text picker", () => {
    const source = "[text](../README.md)";
    const { app, root, messages } = makeApp(source);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, 1, 1 + "text".length),
      ),
    );
    const picker = openLinkPicker(root);
    const remove = picker.querySelector<HTMLButtonElement>(
      ".mm-link-picker-remove",
    );
    expect(remove?.hidden).toBe(false);
    remove!.click();

    expect(picker.hidden).toBe(true);
    expect(app.view.state.doc.firstChild?.firstChild?.marks).toHaveLength(0);
    expect(lastEditMarkdown(messages)).toBe("text");
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

  it("intercepts PNG drops and waits for the host result before inserting", async () => {
    const { app, root, messages } = makeApp("before after");
    const event = dispatchImageDrop(app, [imageFile("architecture.png")], 7);

    expect(event.defaultPrevented).toBe(true);
    await flush();
    const request = messages.find(
      (message: any) => message.type === "image-import",
    ) as any;
    expect(request).toMatchObject({
      type: "image-import",
      fileName: "architecture.png",
      mimeType: "image/png",
      base64: "AA==",
    });
    expect(root.querySelector(".mm-image-importing")).not.toBeNull();
    expect(messages.some((message: any) => message.type === "edit")).toBe(
      false,
    );

    receiveHostMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: request.requestId,
      success: true,
      relativePath: "./images/architecture.png",
    });

    expect(root.querySelector(".mm-image-importing")).toBeNull();
    expect(lastEditMarkdown(messages)).toBe(
      "before![architecture](./images/architecture.png) after",
    );
    const image = root.querySelector<HTMLImageElement>(".ProseMirror img");
    expect(image).not.toBeNull();
    expect(
      app.view.state.doc.nodeAt(app.view.posAtDOM(image!, 0))?.attrs.src,
    ).toBe("./images/architecture.png");
    app.destroy();
  });

  it("imports an SVG file as the existing image node without inlining SVG markup", async () => {
    const { app, root, messages } = makeApp("before after");
    const event = dispatchImageDrop(
      app,
      [imageFile("diagram.svg", "image/svg+xml", new Uint8Array([60, 62]))],
      7,
    );

    expect(event.defaultPrevented).toBe(true);
    await flush();
    const request = messages.find(
      (message: any) => message.type === "image-import",
    ) as any;
    expect(request).toMatchObject({
      type: "image-import",
      fileName: "diagram.svg",
      mimeType: "image/svg+xml",
    });

    receiveHostMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: request.requestId,
      success: true,
      relativePath: "./images/diagram.svg",
    });

    expect(lastEditMarkdown(messages)).toBe(
      "before![diagram](./images/diagram.svg) after",
    );
    expect(root.querySelector(".ProseMirror svg")).toBeNull();
    expect(
      root.querySelector<HTMLImageElement>(".ProseMirror img"),
    ).not.toBeNull();
    app.destroy();
  });

  it("parses URI-list comments, empty lines, line endings, and encoded basenames", () => {
    expect(
      parseImageImportUriList(
        "# Finder comment\r\n\r\nfile:///workspace/assets/sample%20image.png\n" +
          "file:///workspace/assets/notes.txt\r\n" +
          "vscode-remote://ssh-remote+host/workspace/two.webp\n" +
          "/workspace/assets/path.png",
      ),
    ).toEqual([
      {
        resourceUri: "file:///workspace/assets/sample%20image.png",
        fileName: "sample image.png",
      },
      {
        resourceUri: "vscode-remote://ssh-remote+host/workspace/two.webp",
        fileName: "two.webp",
      },
      {
        resourceUri: "/workspace/assets/path.png",
        fileName: "path.png",
      },
    ]);
  });

  it("consumes a VS Code Explorer URI image drop without inserting the raw URI", async () => {
    const { app, root, messages } = makeApp("before after");
    const event = dispatchImageDrop(
      app,
      [],
      7,
      "# Explorer comment\r\n\r\nfile:///workspace/assets/sample.png\r\n",
    );

    expect(event.defaultPrevented).toBe(true);
    await flush();
    const request = messages.find(
      (message: any) => message.type === "image-import-uri",
    ) as any;
    expect(request).toMatchObject({
      type: "image-import-uri",
      resourceUri: "file:///workspace/assets/sample.png",
    });
    expect(
      messages.some((message: any) => message.type === "image-import"),
    ).toBe(false);
    expect(root.querySelector(".mm-image-importing")).not.toBeNull();
    expect(messages.some(isEditMessage)).toBe(false);

    receiveHostMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: request.requestId,
      success: true,
      relativePath: "./images/sample.png",
    });

    expect(root.querySelector(".mm-image-importing")).toBeNull();
    expect(lastEditMarkdown(messages)).toBe(
      "before![sample](./images/sample.png) after",
    );
    expect(lastEditMarkdown(messages)).not.toContain("/workspace/");
    app.destroy();
  });

  it("consumes a VS Code Explorer SVG URI drop and inserts the existing image node", async () => {
    const { app, root, messages } = makeApp("before after");
    const event = dispatchImageDrop(
      app,
      [],
      7,
      "file:///workspace/assets/diagram.svg",
    );

    expect(event.defaultPrevented).toBe(true);
    await flush();
    const request = messages.find(
      (message: any) => message.type === "image-import-uri",
    ) as any;
    expect(request).toMatchObject({
      type: "image-import-uri",
      resourceUri: "file:///workspace/assets/diagram.svg",
    });

    receiveHostMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: request.requestId,
      success: true,
      relativePath: "./images/diagram.svg",
    });

    expect(lastEditMarkdown(messages)).toBe(
      "before![diagram](./images/diagram.svg) after",
    );
    expect(root.querySelector(".ProseMirror svg")).toBeNull();
    app.destroy();
  });

  it("consumes image-looking path and remote URI strings instead of inserting them", async () => {
    for (const resourceUri of [
      "/workspace/assets/sample.png",
      "vscode-remote://ssh-remote+host/workspace/sample.png",
    ]) {
      const { app, messages } = makeApp("before after");
      const event = dispatchImageDrop(app, [], 7, resourceUri);

      expect(event.defaultPrevented).toBe(true);
      await flush();
      const request = messages.find(
        (message: any) => message.type === "image-import-uri",
      ) as any;
      expect(request.resourceUri).toBe(resourceUri);
      receiveHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "image-import-result",
        requestId: request.requestId,
        success: false,
        message: "The resource was rejected.",
      });
      expect(messages.some(isEditMessage)).toBe(false);
      expect(lastEditMarkdown(messages)).not.toContain(resourceUri);
      app.destroy();
    }
  });

  it("keeps multiple URI image imports ordered and consumes mixed non-image resources", async () => {
    const { app, messages } = makeApp("before after");
    const event = dispatchImageDrop(
      app,
      [imageFile("notes.txt", "text/plain")],
      7,
      "file:///workspace/one.png\n" +
        "file:///workspace/readme.txt\r\n" +
        "# ignored\n" +
        "file:///workspace/two.webp",
    );

    expect(event.defaultPrevented).toBe(true);
    await flush();
    const requests = messages.filter(
      (message: any) => message.type === "image-import-uri",
    ) as any[];
    expect(requests.map((message) => message.resourceUri)).toEqual([
      "file:///workspace/one.png",
      "file:///workspace/two.webp",
    ]);
    expect(messages.some(isEditMessage)).toBe(false);

    for (const [index, request] of requests.entries())
      receiveHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "image-import-result",
        requestId: request.requestId,
        success: true,
        relativePath: `./images/${index === 0 ? "one" : "two"}.${
          index === 0 ? "png" : "webp"
        }`,
      });

    const firstEdit = messages.filter(isEditMessage)[0] as any;
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: firstEdit.markdown,
      version: 2,
      profile: "github",
      operationId: firstEdit.operationId,
      reason: "ack",
    });
    await flush();
    expect(lastEditMarkdown(messages)).toBe(
      "before![one](./images/one.png)![two](./images/two.webp) after",
    );
    expect(lastEditMarkdown(messages)).not.toContain("/workspace/");
    app.destroy();
  });

  it("lets a URI-list drop with only non-images fall through", () => {
    const { app, messages } = makeApp("before after");
    dispatchImageDrop(app, [], 7, "file:///workspace/readme.txt\n# comment\n");

    // The existing ProseMirror text-drop handler may consume a non-image URI
    // resource; the image importer itself must not claim or send it.
    expect(
      messages.some((message: any) => message.type === "image-import-uri"),
    ).toBe(false);
    app.destroy();
  });

  it("lets non-image drops fall through to ProseMirror", () => {
    const { app, messages } = makeApp("before after");
    const event = dispatchImageDrop(
      app,
      [imageFile("notes.txt", "text/plain")],
      7,
    );

    expect(event.defaultPrevented).toBe(false);
    expect(
      messages.some((message: any) => message.type === "image-import"),
    ).toBe(false);
    app.destroy();
  });

  it("rejects a code block drop before sending an image import request", async () => {
    const { app, root, messages } = makeApp(
      "before\n\n```ts\nconst value = 1;\n```\n\nafter",
    );
    const event = dispatchImageDrop(
      app,
      [imageFile("architecture.png")],
      codeBlockPosition(app) + 2,
    );

    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(
      messages.some((message: any) => message.type === "image-import"),
    ).toBe(false);
    expect(root.querySelector(".mm-image-importing")).toBeNull();
    expect(
      messages.some(
        (message: any) =>
          message.type === "notify" &&
          message.level === "error" &&
          message.message.includes("cannot be placed"),
      ),
    ).toBe(true);
    app.destroy();
  });

  it.each([
    [
      "zero-byte image",
      imageFile("empty.png", "image/png", new Uint8Array()),
      "empty",
    ],
    [
      "generic MIME image",
      imageFile("architecture.png", "application/octet-stream"),
      "MIME type",
    ],
  ])(
    "clears pending state after the host semantically rejects a %s",
    async (_, file, message) => {
      const { app, root, messages } = makeApp("before after");
      dispatchImageDrop(app, [file], 7);
      await flush();
      const request = messages.find(
        (candidate: any) => candidate.type === "image-import",
      ) as any;

      expect(request).toBeDefined();
      expect(root.querySelector(".mm-image-importing")).not.toBeNull();
      receiveHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "image-import-result",
        requestId: request.requestId,
        success: false,
        message: `The dropped image ${message}.`,
      });

      expect(root.querySelector(".mm-image-importing")).toBeNull();
      expect(
        imageImportPluginKey.getState(app.view.state)?.pending,
      ).toHaveLength(0);
      expect(messages.some((candidate: any) => candidate.type === "edit")).toBe(
        false,
      );
      expect(
        messages.some(
          (candidate: any) =>
            candidate.type === "notify" &&
            candidate.level === "error" &&
            candidate.message.includes(message),
        ),
      ).toBe(true);
      app.destroy();
    },
  );

  it("clears an image pending request when a correlated generic host error arrives", async () => {
    const { app, root, messages } = makeApp("before after");
    dispatchImageDrop(app, [imageFile("architecture.png")], 7);
    await flush();
    const request = messages.find(
      (candidate: any) => candidate.type === "image-import",
    ) as any;

    receiveHostMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      operationId: request.requestId,
      message: "The image import request was rejected.",
    });

    expect(root.querySelector(".mm-image-importing")).toBeNull();
    expect(imageImportPluginKey.getState(app.view.state)?.pending).toHaveLength(
      0,
    );
    expect(messages.some((candidate: any) => candidate.type === "edit")).toBe(
      false,
    );
    app.destroy();
  });

  it("maps the pending drop position through an edit made during import", async () => {
    let releaseRead!: (value: ArrayBuffer) => void;
    const file = imageFile(
      "architecture.png",
      "image/png",
      new Uint8Array([0]),
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          releaseRead = resolve;
        }),
    );
    const { app, messages } = makeApp("before after");
    dispatchImageDrop(app, [file], 7);
    await flush();
    app.view.dispatch(app.view.state.tr.insertText("prefix ", 1));
    const textEdit = messages.filter(isEditMessage).at(-1) as any;
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: textEdit.markdown,
      version: 2,
      profile: "github",
      operationId: textEdit.operationId,
      reason: "ack",
    });
    releaseRead(new Uint8Array([0]).buffer);
    await flush();
    const request = messages.find(
      (message: any) => message.type === "image-import",
    ) as any;
    receiveHostMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: request.requestId,
      success: true,
      relativePath: "./images/architecture.png",
    });

    expect(lastEditMarkdown(messages)).toBe(
      "prefix before![architecture](./images/architecture.png) after",
    );
    app.destroy();
  });

  it("keeps a deleted pending anchor at its mapped boundary until the result arrives", async () => {
    const { app, root, messages } = makeApp("before after");
    dispatchImageDrop(app, [imageFile("architecture.png")], 7);
    await flush();
    const request = messages.find(
      (message: any) => message.type === "image-import",
    ) as any;

    app.view.dispatch(
      app.view.state.tr.delete(1, app.view.state.doc.content.size - 1),
    );
    expect(
      imageImportPluginKey.getState(app.view.state)?.pending[0],
    ).toMatchObject({ anchorDeleted: true });
    expect(root.querySelector(".mm-image-importing")).not.toBeNull();

    receiveHostMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: request.requestId,
      success: true,
      relativePath: "./images/architecture.png",
    });

    expect(root.querySelector(".mm-image-importing")).toBeNull();
    expect(app.view.state.doc.firstChild?.firstChild?.type.name).toBe("image");
    const deletionEdit = messages.filter(isEditMessage).at(-1) as any;
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: deletionEdit.markdown,
      version: 2,
      profile: "github",
      operationId: deletionEdit.operationId,
      reason: "ack",
    });
    await flush();
    expect(lastEditMarkdown(messages)).toBe(
      "![architecture](./images/architecture.png)",
    );
    app.destroy();
  });

  it("URL-encodes an imported basename while preserving image serializer round trips", async () => {
    const { app, messages } = makeApp("before after");
    dispatchImageDrop(app, [imageFile("architecture #2%?.png")], 7);
    await flush();
    const request = messages.find(
      (message: any) => message.type === "image-import",
    ) as any;
    expect(request.fileName).toBe("architecture #2%?.png");
    receiveHostMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: request.requestId,
      success: true,
      relativePath: "./images/architecture%20%232%25%3F.png",
    });

    const markdown = lastEditMarkdown(messages);
    expect(markdown).toBe(
      "before![architecture #2%?](./images/architecture%20%232%25%3F.png) after",
    );
    expect(
      serializeMarkdown(app.view.state.doc, parseMarkdown(markdown, "github")),
    ).toBe(markdown);
    app.destroy();
  });

  it("keeps multiple image imports in DataTransfer order", async () => {
    const { app, messages } = makeApp("before after");
    dispatchImageDrop(app, [imageFile("one.png"), imageFile("two.png")], 7);
    await flush();
    const requests = messages.filter(
      (message: any) => message.type === "image-import",
    ) as any[];
    expect(requests.map((message) => message.fileName)).toEqual([
      "one.png",
      "two.png",
    ]);

    for (const [index, request] of requests.entries())
      receiveHostMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "image-import-result",
        requestId: request.requestId,
        success: true,
        relativePath: `./images/${index === 0 ? "one" : "two"}.png`,
      });

    const firstEdit = messages.filter(isEditMessage)[0] as any;
    app.receiveDocument({
      protocolVersion: PROTOCOL_VERSION,
      type: "document",
      markdown: firstEdit.markdown,
      version: 2,
      profile: "github",
      operationId: firstEdit.operationId,
      reason: "ack",
    });

    expect(lastEditMarkdown(messages)).toBe(
      "before![one](./images/one.png)![two](./images/two.png) after",
    );
    app.destroy();
  });

  it("reports a failed import without changing or serializing temporary state", async () => {
    const { app, root, messages } = makeApp("before after");
    dispatchImageDrop(app, [imageFile("architecture.png")], 7);
    await flush();
    const request = messages.find(
      (message: any) => message.type === "image-import",
    ) as any;
    receiveHostMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "image-import-result",
      requestId: request.requestId,
      success: false,
      message: "The dropped image exceeds the 10 MB size limit.",
    });

    expect(root.querySelector(".mm-image-importing")).toBeNull();
    expect(messages.some((message: any) => message.type === "edit")).toBe(
      false,
    );
    expect(
      messages.some(
        (message: any) =>
          message.type === "notify" &&
          message.level === "error" &&
          message.message.includes("10 MB"),
      ),
    ).toBe(true);
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

  it("does not render SVG data URIs as image sources", () => {
    const { app, root } = makeApp(
      "![diagram](data:image/svg+xml;base64,PHN2Zy8+)",
    );
    expect(root.querySelector(".ProseMirror img")).toBeNull();
    expect(root.querySelector(".ProseMirror svg")).toBeNull();
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
      root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-strike"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="toolbar-task-list"]',
      ),
    ).toHaveProperty("disabled", true);
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-task-list"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]'),
    ).toHaveProperty("disabled", true);
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-testid="toolbar-table"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    app.destroy();
  });
});

describe("Rich Editor link navigation", () => {
  function dispatchPrimaryClick(
    anchor: HTMLAnchorElement,
    modifiers: Pick<MouseEventInit, "metaKey" | "ctrlKey"> = {},
  ): { mousedown: MouseEvent; click: MouseEvent } {
    const mousedown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...modifiers,
    });
    anchor.dispatchEvent(mousedown);
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...modifiers,
    });
    anchor.dispatchEvent(click);
    return { mousedown, click };
  }

  function setPlatform(value: string): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(
      Navigator.prototype,
      "platform",
    );
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value,
    });
    return () => {
      if (descriptor) Object.defineProperty(navigator, "platform", descriptor);
      else delete (navigator as { platform?: string }).platform;
    };
  }

  it.each([
    ["MacIntel", "metaKey"],
    ["Linux x86_64", "ctrlKey"],
  ] as const)(
    "opens an external link with the platform modifier on %s",
    (platform, modifier) => {
      const restorePlatform = setPlatform(platform);
      try {
        const { app, messages } = makeApp(
          "[open](https://example.com/a%20b?q=1#section)",
        );
        const anchor = app.view.dom.querySelector<HTMLAnchorElement>("a[href]");
        if (!anchor) throw new Error("link is not rendered");

        const { mousedown, click } = dispatchPrimaryClick(anchor, {
          [modifier]: true,
        });

        expect(mousedown.defaultPrevented).toBe(false);
        expect(click.defaultPrevented).toBe(true);
        expect(messages).toContainEqual({
          protocolVersion: PROTOCOL_VERSION,
          type: "open-link",
          href: "https://example.com/a%20b?q=1#section",
        });
        expect(hasMessageType(messages, "edit")).toBe(false);
        app.destroy();
      } finally {
        restorePlatform();
      }
    },
  );

  it.each([
    ["MacIntel", "metaKey"],
    ["Linux x86_64", "ctrlKey"],
  ] as const)(
    "preserves a raw relative href with the platform modifier on %s",
    (platform, modifier) => {
      const restorePlatform = setPlatform(platform);
      try {
        const { app, messages } = makeApp("[open](../README.md)");
        const anchor = app.view.dom.querySelector<HTMLAnchorElement>("a[href]");
        if (!anchor) throw new Error("link is not rendered");

        dispatchPrimaryClick(anchor, { [modifier]: true });

        expect(messages).toContainEqual({
          protocolVersion: PROTOCOL_VERSION,
          type: "open-link",
          href: "../README.md",
        });
        expect(hasMessageType(messages, "edit")).toBe(false);
        app.destroy();
      } finally {
        restorePlatform();
      }
    },
  );

  it("keeps an ordinary link click in the editor without posting a navigation message", () => {
    const restorePlatform = setPlatform("Linux x86_64");
    try {
      const { app, messages } = makeApp("[open](https://example.com)");
      const anchor = app.view.dom.querySelector<HTMLAnchorElement>("a[href]");
      if (!anchor) throw new Error("link is not rendered");
      let bubbled = false;
      app.view.dom.addEventListener("click", () => {
        bubbled = true;
      });

      const { click } = dispatchPrimaryClick(anchor);

      expect(click.defaultPrevented).toBe(true);
      expect(click.cancelBubble).toBe(false);
      expect(bubbled).toBe(true);
      expect(hasMessageType(messages, "open-link")).toBe(false);
      expect(hasMessageType(messages, "edit")).toBe(false);
      app.destroy();
    } finally {
      restorePlatform();
    }
  });

  it("scrolls to an existing heading id without changing source state", () => {
    const restorePlatform = setPlatform("Linux x86_64");
    try {
      const { app, messages } = makeApp("[jump](#target)\n\n# Target");
      const anchor = app.view.dom.querySelector<HTMLAnchorElement>("a[href]");
      const target = app.view.dom.querySelector<HTMLElement>("h1#target");
      if (!anchor || !target)
        throw new Error("fragment fixture is not rendered");
      const scrollIntoView = vi.fn();
      Object.defineProperty(target, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      });

      dispatchPrimaryClick(anchor, { ctrlKey: true });

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
      expect(hasMessageType(messages, "open-link")).toBe(false);
      expect(hasMessageType(messages, "edit")).toBe(false);
      app.destroy();
    } finally {
      restorePlatform();
    }
  });

  it("uses existing GitLab TOC and footnote ids for fragment navigation", () => {
    const restorePlatform = setPlatform("Linux x86_64");
    try {
      const toc = makeApp(
        "[[_TOC_]]\n\n# Target",
        undefined,
        false,
        undefined,
        "gitlab",
      );
      const tocAnchor = toc.app.view.dom.querySelector<HTMLAnchorElement>(
        ".table-of-contents a[href]",
      );
      const heading = toc.app.view.dom.querySelector<HTMLElement>("h1#target");
      if (!tocAnchor || !heading)
        throw new Error("TOC fixture is not rendered");
      const tocScroll = vi.fn();
      Object.defineProperty(heading, "scrollIntoView", {
        configurable: true,
        value: tocScroll,
      });
      dispatchPrimaryClick(tocAnchor, { ctrlKey: true });
      expect(tocScroll).toHaveBeenCalledWith({ block: "start" });
      expect(hasMessageType(toc.messages, "open-link")).toBe(false);
      toc.app.destroy();

      const footnote = makeApp("Reference[^one]\n\n[^one]: note");
      const footnoteAnchor =
        footnote.app.view.dom.querySelector<HTMLAnchorElement>(
          ".footnote-ref a[href]",
        );
      const footnoteTarget =
        footnote.app.view.dom.querySelector<HTMLElement>("#fn-one");
      if (!footnoteAnchor || !footnoteTarget)
        throw new Error("footnote fixture is not rendered");
      const footnoteScroll = vi.fn();
      Object.defineProperty(footnoteTarget, "scrollIntoView", {
        configurable: true,
        value: footnoteScroll,
      });
      dispatchPrimaryClick(footnoteAnchor, { ctrlKey: true });
      expect(footnoteScroll).toHaveBeenCalledWith({ block: "start" });
      expect(hasMessageType(footnote.messages, "open-link")).toBe(false);
      footnote.app.destroy();
    } finally {
      restorePlatform();
    }
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
    expect(consecutive.app.view.state.selection).toBeInstanceOf(
      BlockBoundarySelection,
    );
    consecutive.app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowUp",
      }),
    );
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

  it("opens a document-start boundary when no previous text position exists", () => {
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

    expect(event.defaultPrevented).toBe(true);
    expect(app.view.state.doc).toBe(originalDoc);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    expect(app.view.state.selection.head).toBe(0);
    expect(app.view.state.selection.eq(originalSelection)).toBe(false);
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
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    app.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowUp",
      }),
    );
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
  it("imports outside-table TSV as a header-first table and preserves text around the caret", () => {
    const { app, root, messages } = makeApp("BeforeAfter");
    const paragraph = root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(app, paragraph, "Before".length);

    const event = dispatchPaste(app, {
      "text/plain": "Name\tScore\r\nAlice\t90\r\nBob\t72",
    });

    expect(event.defaultPrevented).toBe(true);
    expect(app.view.state.doc.childCount).toBe(3);
    expect(app.view.state.doc.child(0).textContent).toBe("Before");
    expect(app.view.state.doc.child(1).type.name).toBe("table");
    expect(app.view.state.doc.child(1).child(0).child(0).type.name).toBe(
      "table_header",
    );
    expect(app.view.state.doc.child(1).child(1).child(0).type.name).toBe(
      "table_cell",
    );
    expect(app.view.state.doc.child(2).textContent).toBe("After");
    expect(lastEditMarkdown(messages)).toContain(
      "| Name | Score |\n| --- | --- |\n| Alice | 90 |\n| Bob | 72 |",
    );
    expect(messages.filter(isEditMessage)).toHaveLength(1);
    app.destroy();
  });

  it("imports a one-row TSV as a table with header cells", () => {
    const { app, root } = makeApp("Before");
    const paragraph = root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(app, paragraph, "Before".length);

    dispatchPaste(app, { "text/plain": "A\tB\tC" });

    const table = app.view.state.doc.child(1);
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(1);
    expect(table.firstChild?.childCount).toBe(3);
    expect(
      Array.from(
        { length: table.firstChild?.childCount ?? 0 },
        (_, index) => table.firstChild!.child(index).type.name,
      ),
    ).toEqual(["table_header", "table_header", "table_header"]);
    app.destroy();
  });

  it("prefers TSV display values over spreadsheet HTML and imports HTML-only columns", () => {
    const tsv = makeApp("Before");
    const tsvParagraph =
      tsv.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(tsv.app, tsvParagraph, "Before".length);
    dispatchPaste(tsv.app, {
      "text/plain": "TSV\tValue",
      "text/html":
        '<table style="background:red"><tr><td>HTML</td><td>Ignored</td></tr></table>',
    });
    expect(tsv.app.view.state.doc.child(1).textContent).toBe("TSVValue");
    expect(lastEditMarkdown(tsv.messages)).toContain("| TSV | Value |");
    tsv.app.destroy();

    const html = makeApp("Before");
    const htmlParagraph =
      html.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(html.app, htmlParagraph, "Before".length);
    dispatchPaste(html.app, {
      "text/html":
        '<table style="color:red"><tbody><tr><td>00123</td></tr><tr><td>2026/09/14</td></tr></tbody></table>',
    });
    const htmlTable = html.app.view.state.doc.child(1);
    expect(htmlTable.type.name).toBe("table");
    expect(htmlTable.childCount).toBe(2);
    expect(htmlTable.child(0).child(0).textContent).toBe("00123");
    expect(htmlTable.child(1).child(0).textContent).toBe("2026/09/14");
    expect(htmlTable.child(0).child(0).attrs).toMatchObject({
      alignment: null,
    });
    html.app.destroy();
  });

  it("keeps TSV ahead of HTML inside a table and treats multiline prose as native text", () => {
    const prioritized = makeApp(
      "| Header | Other |\n| --- | --- |\n| abc | def |",
    );
    const prioritizedCell =
      prioritized.root.querySelector<HTMLElement>("tbody td")!;
    selectTableCellText(prioritized.app, prioritizedCell, 1);
    dispatchPaste(prioritized.app, {
      "text/plain": "TSV\tValue",
      "text/html": "<table><tr><td>HTML</td><td>Ignored</td></tr></table>",
    });
    expect(
      prioritized.app.view.state.doc.firstChild?.child(1).child(0).textContent,
    ).toBe("TSV");
    expect(lastEditMarkdown(prioritized.messages)).toContain("| TSV | Value |");
    prioritized.app.destroy();

    const multiline = makeApp("| Header |\n| --- |\n| abcdef |");
    const multilineCell =
      multiline.root.querySelector<HTMLElement>("tbody td")!;
    selectTableCellText(multiline.app, multilineCell, 3);
    const event = dispatchPaste(multiline.app, {
      "text/plain": "Today\nTomorrow",
    });
    expect(event.defaultPrevented).toBe(true);
    const table = multiline.app.view.state.doc.firstChild!;
    expect(table.childCount).toBe(2);
    expect(multiline.app.view.state.doc.textContent).toContain("Today");
    expect(multiline.app.view.state.doc.textContent).toContain("Tomorrow");
    expect(multiline.messages.filter(isEditMessage)).toHaveLength(1);
    multiline.app.destroy();
  });

  it("keeps ordinary multiline text and one-cell HTML on the native paste path", () => {
    const plain = makeApp("Before");
    const plainParagraph =
      plain.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(plain.app, plainParagraph, "Before".length);
    dispatchPaste(plain.app, { "text/plain": "Today\nTomorrow" });
    let plainTables = 0;
    plain.app.view.state.doc.descendants((node) => {
      if (node.type.name === "table") plainTables += 1;
    });
    expect(plainTables).toBe(0);
    expect(plain.app.view.state.doc.textContent).toContain("Today");
    plain.app.destroy();

    const html = makeApp("Before");
    const htmlParagraph =
      html.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(html.app, htmlParagraph, "Before".length);
    dispatchPaste(html.app, {
      "text/plain": "Alice",
      "text/html": "<table><tr><td>Alice</td></tr></table>",
    });
    let htmlTables = 0;
    html.app.view.state.doc.descendants((node) => {
      if (node.type.name === "table") htmlTables += 1;
    });
    expect(htmlTables).toBe(0);
    expect(html.app.view.state.doc.textContent).toContain("Alice");
    html.app.destroy();
  });

  it("keeps spreadsheet paste as native text in CommonMark and code blocks", () => {
    const commonmark = makeApp(
      "Before",
      undefined,
      false,
      undefined,
      "commonmark",
    );
    const paragraph =
      commonmark.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(commonmark.app, paragraph, "Before".length);
    const commonmarkEvent = dispatchPaste(commonmark.app, {
      "text/plain": "A\tB",
      "text/html": "<table><tr><td>HTML</td><td>table</td></tr></table>",
    });
    expect(commonmarkEvent.defaultPrevented).toBe(true);
    expect(commonmark.app.view.state.doc.firstChild?.type.name).toBe(
      "paragraph",
    );
    expect(commonmark.app.view.state.doc.textContent).toContain("A\tB");
    commonmark.app.destroy();

    const code = makeApp("```text\nBefore\n```");
    const codeElement = code.root.querySelector<HTMLElement>(
      ".mm-code-block-pre code",
    )!;
    selectCodeBlockText(code.app, "Before".length);
    dispatchPaste(code.app, { "text/plain": "A\tB" }, codeElement);
    expect(code.app.view.state.doc.childCount).toBe(1);
    expect(code.app.view.state.doc.firstChild?.type.name).toBe("code_block");
    expect(code.app.view.state.doc.firstChild?.textContent).toContain("A\tB");
    code.app.destroy();
  });

  it("never routes CommonMark or custom-profile table HTML through native HTML paste", () => {
    const countTables = (app: ReturnType<typeof makeApp>["app"]): number => {
      let tables = 0;
      app.view.state.doc.descendants((node) => {
        if (node.type.name === "table") tables += 1;
      });
      return tables;
    };
    const oversizedHtml = `<table><tr>${Array.from(
      { length: 10_001 },
      () => "<td>oversized</td>",
    ).join("")}</tr></table>`;
    const commonmark = makeApp(
      "Before",
      undefined,
      false,
      undefined,
      "commonmark",
    );
    const commonmarkParagraph =
      commonmark.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(commonmark.app, commonmarkParagraph, "Before".length);
    const commonmarkBefore = commonmark.app.view.state.doc;
    const oversizedEvent = dispatchPaste(commonmark.app, {
      "text/html": oversizedHtml,
    });
    expect(oversizedEvent.defaultPrevented).toBe(true);
    expect(commonmark.app.view.state.doc).toBe(commonmarkBefore);
    expect(countTables(commonmark.app)).toBe(0);
    expect(commonmark.messages.filter(isEditMessage)).toHaveLength(0);
    expect(commonmark.messages).toContainEqual(
      expect.objectContaining({
        type: "notify",
        level: "warning",
      }),
    );
    commonmark.app.destroy();

    const commonmarkPlain = makeApp(
      "Before",
      undefined,
      false,
      undefined,
      "commonmark",
    );
    const plainParagraph =
      commonmarkPlain.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(commonmarkPlain.app, plainParagraph, "Before".length);
    const plainEvent = dispatchPaste(commonmarkPlain.app, {
      "text/plain": "fallback",
      "text/html": oversizedHtml,
    });
    expect(plainEvent.defaultPrevented).toBe(true);
    expect(countTables(commonmarkPlain.app)).toBe(0);
    expect(commonmarkPlain.app.view.state.doc.textContent).toContain(
      "Beforefallback",
    );
    commonmarkPlain.app.destroy();

    const validHtml = makeApp(
      "Before",
      undefined,
      false,
      undefined,
      "commonmark",
    );
    const validParagraph =
      validHtml.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(validHtml.app, validParagraph, "Before".length);
    const validEvent = dispatchPaste(validHtml.app, {
      "text/html": "<table><tr><td>A</td><td>B</td></tr></table>",
    });
    expect(validEvent.defaultPrevented).toBe(true);
    expect(countTables(validHtml.app)).toBe(0);
    expect(validHtml.app.view.state.doc.textContent).toContain("A\tB");
    validHtml.app.destroy();

    const malformedHtml = "<table><tbody></tbody></table>";
    for (const profile of ["github", "gitlab"] as const) {
      const custom = makeApp("Before", undefined, false, undefined, profile);
      const paragraph =
        custom.root.querySelector<HTMLElement>(".ProseMirror > p")!;
      selectText(custom.app, paragraph, "Before".length);
      const before = custom.app.view.state.doc;
      const event = dispatchPaste(custom.app, { "text/html": malformedHtml });
      expect(event.defaultPrevented).toBe(true);
      expect(custom.app.view.state.doc).toBe(before);
      expect(countTables(custom.app)).toBe(0);
      expect(custom.messages.filter(isEditMessage)).toHaveLength(0);
      expect(custom.messages).toContainEqual(
        expect.objectContaining({
          type: "notify",
          level: "warning",
        }),
      );
      custom.app.destroy();
    }
  });

  it("handles self-closing table starts through the clipboard safety path", () => {
    const html = "<table/><tr><td>A</td><td>B</td></tr>";
    const commonmark = makeApp(
      "Before",
      undefined,
      false,
      undefined,
      "commonmark",
    );
    const commonmarkParagraph =
      commonmark.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(commonmark.app, commonmarkParagraph, "Before".length);
    const commonmarkEvent = dispatchPaste(commonmark.app, {
      "text/plain": "",
      "text/html": html,
    });
    let commonmarkTables = 0;
    commonmark.app.view.state.doc.descendants((node) => {
      if (node.type.name === "table") commonmarkTables += 1;
    });
    expect(commonmarkEvent.defaultPrevented).toBe(true);
    expect(commonmark.app.view.state.doc.textContent).toContain("A\tB");
    expect(commonmarkTables).toBe(0);
    expect(commonmark.messages.filter(isEditMessage)).toHaveLength(1);
    commonmark.app.destroy();

    const github = makeApp("Before");
    const githubParagraph =
      github.root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(github.app, githubParagraph, "Before".length);
    const githubEvent = dispatchPaste(github.app, {
      "text/plain": "",
      "text/html": html,
    });
    expect(githubEvent.defaultPrevented).toBe(true);
    expect(github.app.view.state.doc.child(1).type.name).toBe("table");
    expect(github.messages.filter(isEditMessage)).toHaveLength(1);
    github.app.destroy();
  });

  it("imports a valid internal matrix with rich cell content and normalizes row types", () => {
    const rich = schema.nodes.table_header!.create(
      null,
      schema.nodes.paragraph!.create(
        null,
        schema.text("Header", [schema.marks.strong!.create()]),
      ),
    );
    const { app, root } = makeApp("Before");
    const paragraph = root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(app, paragraph, "Before".length);
    dispatchPaste(app, {
      ["application/x-markdown-mint-table"]: JSON.stringify({
        values: [
          ["Header", "Other"],
          ["Body", "Value"],
        ],
        cellJson: [
          [rich.toJSON(), { type: "not-a-real-node" }],
          [null, null],
        ],
      }),
      "text/plain": "Fallback\tValue\nBody\tValue",
    });

    const table = app.view.state.doc.child(1);
    expect(table.child(0).child(0).type.name).toBe("table_header");
    expect(table.child(1).child(0).type.name).toBe("table_cell");
    expect(table.child(0).child(0).firstChild?.firstChild?.marks).toHaveLength(
      1,
    );
    expect(table.child(0).child(1).textContent).toBe("Other");
    app.destroy();
  });

  it("inserts a spreadsheet table directly at a BlockBoundarySelection", () => {
    const { app, messages } = makeApp("First\n\nSecond");
    const boundary = app.view.state.doc.firstChild!.nodeSize;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        new BlockBoundarySelection(app.view.state.doc.resolve(boundary)),
      ),
    );

    const event = dispatchPaste(app, { "text/plain": "A\tB\n1\t2" });

    expect(event.defaultPrevented).toBe(true);
    expect(
      Array.from(
        { length: app.view.state.doc.childCount },
        (_, index) => app.view.state.doc.child(index).type.name,
      ),
    ).toEqual(["paragraph", "table", "paragraph"]);
    expect(messages.filter(isEditMessage)).toHaveLength(1);
    app.destroy();
  });

  it("keeps valid list and blockquote containers when splitting a paragraph", () => {
    const list = makeApp("- Before\n\n- After");
    const listParagraph =
      list.root.querySelector<HTMLElement>(".ProseMirror li p")!;
    selectText(list.app, listParagraph, "Before".length);
    dispatchPaste(list.app, { "text/plain": "A\tB\n1\t2" });
    expect(list.app.view.state.doc.firstChild?.type.name).toBe("bullet_list");
    expect(list.app.view.state.doc.firstChild?.firstChild?.childCount).toBe(3);
    expect(
      list.app.view.state.doc.firstChild?.firstChild?.child(1).type.name,
    ).toBe("table");
    list.app.destroy();

    const quote = makeApp("> Before\n>\n> After");
    const quoteParagraph = quote.root.querySelector<HTMLElement>(
      ".ProseMirror blockquote p",
    )!;
    selectText(quote.app, quoteParagraph, "Before".length);
    dispatchPaste(quote.app, { "text/plain": "A\tB\n1\t2" });
    expect(quote.app.view.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(quote.app.view.state.doc.firstChild?.child(1).type.name).toBe(
      "table",
    );
    quote.app.destroy();
  });

  it("rejects oversized spreadsheet paste without truncating it", () => {
    const { app, root, messages } = makeApp("Before");
    const paragraph = root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(app, paragraph, "Before".length);
    const cells = Array.from({ length: 10_001 }, (_, index) => String(index));

    const event = dispatchPaste(app, { "text/plain": cells.join("\t") });

    expect(event.defaultPrevented).toBe(true);
    expect(app.view.state.doc.childCount).toBe(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "notify",
        level: "warning",
        message:
          "Table paste is too large. Markdown Mint supports up to 10,000 pasted cells.",
      }),
    );
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    app.destroy();
  });

  it("rejects a 2x2 paste when the final serialized Markdown exceeds the limit", () => {
    const source = "x".repeat(MAX_MARKDOWN_LENGTH - 16);
    const { app, root, messages } = makeApp(source);
    const paragraph = root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(app, paragraph, source.length);
    const before = app.view.state.doc;

    const event = dispatchPaste(app, { "text/plain": "A\tB\nC\tD" });

    expect(event.defaultPrevented).toBe(true);
    expect(app.view.state.doc).toBe(before);
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "notify",
        level: "warning",
        message: expect.stringContaining("Markdown source limit"),
      }),
    );
    app.destroy();
  });

  it("checks final Markdown size after parsing a small but huge-text TSV", () => {
    const tsv = `${"x".repeat(MAX_CLIPBOARD_TEXT_LENGTH - 10)}\tB`;
    expect(tsv.length).toBeLessThanOrEqual(MAX_CLIPBOARD_TEXT_LENGTH);
    const { app, root, messages } = makeApp("Before");
    const paragraph = root.querySelector<HTMLElement>(".ProseMirror > p")!;
    selectText(app, paragraph, "Before".length);
    const before = app.view.state.doc;

    const event = dispatchPaste(app, { "text/plain": tsv });

    expect(event.defaultPrevented).toBe(true);
    expect(app.view.state.doc).toBe(before);
    expect(messages.filter(isEditMessage)).toHaveLength(0);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "notify",
        level: "warning",
        message: expect.stringContaining("Markdown source limit"),
      }),
    );
    app.destroy();
  });

  it("uses valid TSV without evaluating lower-priority oversized HTML", () => {
    const { app, root, messages } = makeApp(
      "| Header |\n| --- |\n| unchanged |",
    );
    const cell = root.querySelector<HTMLElement>("tbody td")!;
    selectTableCellText(app, cell, 1);
    const parseFromString = vi.spyOn(DOMParser.prototype, "parseFromString");
    const oversizedHtml = `<table><tr>${Array.from(
      { length: 10_001 },
      () => "<td>oversized</td>",
    ).join("")}</tr></table>`;
    try {
      const event = dispatchPaste(app, {
        "text/plain": "Safe\tValue",
        "text/html": oversizedHtml,
      });
      expect(event.defaultPrevented).toBe(true);
      expect(app.view.state.doc.firstChild?.child(1).child(0).textContent).toBe(
        "Safe",
      );
      expect(lastEditMarkdown(messages)).toContain("| Safe | Value |");
      expect(messages.filter(isEditMessage)).toHaveLength(1);
      expect(parseFromString).not.toHaveBeenCalled();
    } finally {
      parseFromString.mockRestore();
      app.destroy();
    }
  });

  it("delegates plain text paste at a cell cursor to ProseMirror", () => {
    const markdown = "| Header |\n| --- |\n| abcdef |";
    const { app, root, messages } = makeApp(markdown);
    const bodyCell = root.querySelector<HTMLElement>("tbody td")!;
    selectTableCellText(app, bodyCell, 3);

    const event = dispatchPaste(app, { "text/plain": "XYZ" });

    expect(event.defaultPrevented).toBe(true);
    expect(bodyCell.textContent).toBe("abcXYZdef");
    expect(lastEditMarkdown(messages)).toContain("abcXYZdef");
    app.destroy();
  });

  it("delegates plain text paste over a cell TextSelection to ProseMirror", () => {
    const markdown = "| Header |\n| --- |\n| abcdef |";
    const { app, root, messages } = makeApp(markdown);
    const bodyCell = root.querySelector<HTMLElement>("tbody td")!;
    selectTableCellText(app, bodyCell, 2, 4);

    const event = dispatchPaste(app, { "text/plain": "XYZ" });

    expect(event.defaultPrevented).toBe(true);
    expect(bodyCell.textContent).toBe("abXYZef");
    expect(lastEditMarkdown(messages)).toContain("abXYZef");
    app.destroy();
  });

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
    dispatchPaste(app, { "text/plain": "日本語\t\n追加\t値" });
    const edit = messages.filter((message: any) => message.type === "edit");
    expect(edit).toHaveLength(1);
    expect((edit[0] as any).markdown).toContain("日本語");
    expect((edit[0] as any).markdown).toContain("追加");
    app.destroy();
  });

  it("keeps CellSelection plain-text paste as whole-cell replacement", () => {
    const markdown = "| Header |\n| --- |\n| abcdef |";
    const { app, root, messages } = makeApp(markdown);
    const bodyCell = root.querySelector<HTMLElement>("tbody td")!;
    const cellPos = app.view.posAtDOM(bodyCell, 0) - 1;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        CellSelection.create(app.view.state.doc, cellPos),
      ),
    );

    dispatchPaste(app, { "text/plain": "XYZ" });

    expect(bodyCell.textContent).toBe("XYZ");
    expect(lastEditMarkdown(messages)).toContain("| XYZ |");
    app.destroy();
  });
});
