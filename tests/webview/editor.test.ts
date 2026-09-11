import { beforeEach, describe, expect, it } from "vitest";
import { TextSelection } from "prosemirror-state";
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
): EditorInitialDocument {
  return { markdown, version: 1, profile: "github" };
}

function makeApp(markdown?: string, api?: VSCodeApiLike) {
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
    initialDocument: documentFixture(markdown),
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
    const language =
      root.querySelector<HTMLInputElement>(".mm-code-block-view .mm-code-language")!;
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    language.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    language.value = "ts";
    language.dispatchEvent(new Event("change", { bubbles: true }));
    expect(
      messages.filter((message: any) => message.type === "edit"),
    ).toHaveLength(2);
    expect((messages.at(-1) as any).markdown).toContain("```ts");
    app.destroy();
  });
  it("disables editing in a host preview and exposes the code language field in Mint", () => {
    const preview = makeApp("plain");
    const previewBold = preview.root.querySelector<HTMLButtonElement>(
      "[data-testid=\"toolbar-bold\"]",
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
    expect(preview.root.querySelector<HTMLInputElement>(".mm-code-language")).toBeNull();
    preview.app.destroy();

    const { app, root } = makeApp("plain");
    const bold = root.querySelector<HTMLButtonElement>(
      "[data-testid=\"toolbar-bold\"]",
    )!;
    const code = schema.nodes.code_block!;
    app.view.dispatch(
      app.view.state.tr.setBlockType(0, app.view.state.doc.content.size, code, {
        params: "ts",
      }),
    );
    const language =
      root.querySelector<HTMLInputElement>(".mm-code-block-view .mm-code-language");
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
