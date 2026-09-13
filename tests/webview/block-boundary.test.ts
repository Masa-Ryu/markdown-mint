import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeSelection, TextSelection } from "prosemirror-state";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import { BlockBoundarySelection } from "../../src/webview/blockBoundary";
import { createEditorApp } from "../../src/webview/editor";

const apps: ReturnType<typeof createEditorApp>[] = [];

beforeEach(() => {
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

afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
  document.body.replaceChildren();
});

function setup(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const messages: unknown[] = [];
  const app = createEditorApp({
    root,
    vscode: { postMessage: (message) => messages.push(message) },
    core: { schema, parseMarkdown, serializeMarkdown, renderMarkdown },
    initialDocument: { markdown, profile: "github", version: 1 },
  });
  apps.push(app);
  const select = (text: string, edge: "start" | "end"): void => {
    let position = -1;
    app.view.state.doc.descendants((node, offset) => {
      if (node.isTextblock && node.textContent === text)
        position = offset + 1 + (edge === "end" ? node.content.size : 0);
    });
    expect(position).toBeGreaterThanOrEqual(0);
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, position),
      ),
    );
    app.view.focus();
  };
  const key = (
    key: string,
    target: HTMLElement = app.view.dom,
  ): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { app, root, messages, select, key };
}

function editMessages(messages: unknown[]): Array<{ markdown: string }> {
  return messages.filter(
    (message): message is { markdown: string } =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "edit",
  );
}

describe("top-level block boundary navigation", () => {
  it("walks code, Alert, Details and rendered blocks as actual arrow targets", () => {
    const source = [
      "Before",
      "",
      "```ts",
      "code",
      "```",
      "",
      "> [!NOTE]",
      "> alert",
      "",
      "<details open>",
      "<summary>Details</summary>",
      "Body",
      "</details>",
      "",
      "$$",
      "x^2",
      "$$",
      "",
      "After",
    ].join("\n");
    const { app, root, messages, select, key } = setup(source);
    const originalDoc = app.view.state.doc;
    select("code", "end");
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.attrs.kind).toBe(
      "alert",
    );
    const body = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    body.setSelectionRange(body.value.length, body.value.length);
    key("ArrowRight", body);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Body");
    select("Body", "end");
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.attrs.kind).toBe(
      "math-block",
    );
    expect(app.view.state.doc).toBe(originalDoc);
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("crosses the boundary directly for vertical movement and preserves desired X state", () => {
    const { app, select, key } = setup("Before\n\n```ts\ncode\n```\n\nAfter");
    const endOfTextblock = app.view.endOfTextblock.bind(app.view);
    app.view.endOfTextblock = () => true;
    select("code", "end");
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    key("ArrowUp");
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");
    app.view.endOfTextblock = endOfTextblock;
  });

  it("does not mutate the document or history while crossing boundaries", () => {
    const source = "Before\n\n```ts\ncode\n```\n\nAfter";
    const { app, messages, select, key } = setup(source);
    const original = app.view.state.doc;
    select("Before", "end");
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowLeft");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(app.view.state.doc).toBe(original);
    expect(
      serializeMarkdown(app.view.state.doc, parseMarkdown(source, "github")),
    ).toBe(source);
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("keeps CRLF source bytes unchanged during boundary navigation", () => {
    const source = "Before\r\n\r\n```ts\r\ncode\r\n```\r\n\r\nAfter";
    const { app, messages, select, key } = setup(source);
    const original = app.view.state.doc;
    select("Before", "end");
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowLeft");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(app.view.state.doc).toBe(original);
    expect(
      (app as unknown as { currentMarkdown: () => string }).currentMarkdown(),
    ).toBe(source);
    expect(editMessages(messages)).toHaveLength(0);
  });

  it("keeps insertion affordances on explicit boundaries while arrows skip them", () => {
    const { app, messages, select, key } = setup(
      "Before\n\n```ts\ncode\n```\n\nAfter",
    );
    select("code", "end");
    const boundaryPosition =
      app.view.state.doc.child(0)!.nodeSize +
      app.view.state.doc.child(1)!.nodeSize;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        new BlockBoundarySelection(
          app.view.state.doc.resolve(boundaryPosition),
        ),
      ),
    );
    expect(key("Backspace").defaultPrevented).toBe(true);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    expect(
      app.view.someProp("handleTextInput", (handler) =>
        handler(
          app.view,
          app.view.state.selection.from,
          app.view.state.selection.to,
          "Hello",
          () => app.view.state.tr,
        ),
      ),
    ).toBe(true);
    expect(app.view.state.selection.$from.parent.textContent).toBe("Hello");
    expect(editMessages(messages).at(-1)?.markdown).toContain("Hello");

    app.view.dispatch(
      app.view.state.tr.setSelection(
        new BlockBoundarySelection(
          app.view.state.doc.resolve(boundaryPosition),
        ),
      ),
    );
    key("Enter");
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(app.view.state.selection.$from.parent.textContent).toBe("");
  });

  it("opens the shared Insert block popup from a boundary without editing first", () => {
    const source = "Before\n\n```ts\ncode\n```\n\nAfter";
    const { app, root, messages, select } = setup(source);
    select("code", "end");
    const boundaryPosition =
      app.view.state.doc.child(0)!.nodeSize +
      app.view.state.doc.child(1)!.nodeSize;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        new BlockBoundarySelection(
          app.view.state.doc.resolve(boundaryPosition),
        ),
      ),
    );
    const originalDoc = app.view.state.doc;
    const handled = app.view.someProp("handleTextInput", (handler) =>
      handler(
        app.view,
        app.view.state.selection.from,
        app.view.state.selection.to,
        "/",
        () => app.view.state.tr,
      ),
    );

    expect(handled).toBe(true);
    expect(app.view.state.doc).not.toBe(originalDoc);
    expect(
      (app as unknown as { currentMarkdown: () => string }).currentMarkdown(),
    ).toBe(source);
    expect(editMessages(messages)).toHaveLength(0);
    expect(
      root.querySelector<HTMLElement>(".mm-empty-line-popup")?.hidden,
    ).toBe(false);
  });

  it("materializes before native composition input without duplicating text", () => {
    const { app, select } = setup("Before\n\n```ts\ncode\n```\n\nAfter");
    select("code", "end");
    const position = app.view.state.selection.head;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        new BlockBoundarySelection(app.view.state.doc.resolve(position + 1)),
      ),
    );
    app.view.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertCompositionText",
        data: "あ",
      }),
    );
    expect(app.view.state.selection).toBeInstanceOf(TextSelection);
    expect(app.view.state.selection.$from.parent.type.name).toBe("paragraph");
    app.view.dispatch(app.view.state.tr.insertText("あ"));
    expect(app.view.state.selection.$from.parent.textContent).toBe("あ");
  });

  it("keeps modified arrows and table-cell navigation outside the boundary graph", () => {
    const { app, select, key } = setup("Before\n\n```ts\ncode\n```\n\nAfter");
    select("code", "end");
    expect(key("ArrowRight", app.view.dom).defaultPrevented).toBe(true);
    select("code", "end");
    const modified = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
      shiftKey: true,
    });
    app.view.dom.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);
  });
});
