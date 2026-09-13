import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { BlockBoundarySelection } from "../../src/webview/blockBoundary";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core";
import { createEditorApp } from "../../src/webview/editor";

const apps: ReturnType<typeof createEditorApp>[] = [];
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
  app.view.setProps({ handleScrollToSelection: () => true });
  const select = (text: string, edge: "start" | "end") => {
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
    name: string,
    init: KeyboardEventInit = {},
    target: HTMLElement = app.view.dom,
  ) => {
    const event = new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { app, root, messages, select, key };
}

describe("body navigation selection handoff", () => {
  it("keeps a document-end Details boundary virtual until text is entered", () => {
    const source =
      "<details open>\n<summary>End</summary>\n\nLast body\n\n</details>";
    const { app, messages, select, key } = setup(source);
    const details = app.view.state.doc.firstChild;
    select("Last body", "end");
    expect(key("ArrowRight").defaultPrevented).toBe(true);
    expect(app.view.state.doc.firstChild).toBe(details);
    expect(app.view.state.doc.lastChild).toBe(details);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    expect(
      messages.filter(
        (message) => (message as { type?: unknown }).type === "edit",
      ),
    ).toEqual([]);
    expect(
      app.view.someProp("handleTextInput", (handler) =>
        handler(
          app.view,
          app.view.state.selection.from,
          app.view.state.selection.to,
          "New tail",
          () => app.view.state.tr,
        ),
      ),
    ).toBe(true);
    expect(
      messages.filter(
        (message) => (message as { type?: unknown }).type === "edit",
      ),
    ).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining("</details>\n\nNew tail"),
      }),
    ]);
  });

  it("enters open structured Details and treats closed nested content as one visible stop", () => {
    const { app, root, select, key, messages } = setup(
      [
        "Before",
        "<details open>",
        "<summary>Outer</summary>",
        "Inside",
        "<details>",
        "<summary>Closed</summary>",
        "> [!NOTE]\n> Hidden alert",
        "</details>",
        "Last inside",
        "</details>",
        "After",
      ].join("\n\n"),
    );
    select("Before", "end");
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Inside");
    select("Inside", "end");
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.type.name).toBe(
      "details",
    );
    expect(document.activeElement).toBe(app.view.dom);
    expect(
      root.querySelectorAll('[data-mm-details-open="false"]'),
    ).toHaveLength(1);
    key("ArrowRight");
    expect(app.view.state.selection.$from.parent.textContent).toBe(
      "Last inside",
    );
    key("ArrowLeft");
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    key("ArrowLeft");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Inside");
    expect(
      messages.filter(
        (message) => (message as { type?: unknown }).type === "edit",
      ),
    ).toEqual([]);
  });

  it("crosses paragraph, code and Alert boundaries in both horizontal directions without editing", () => {
    const { app, root, messages, select, key } = setup(
      "Before\n\n```ts\ncode\n```\n\n> [!NOTE]\n> alert\n\nAfter",
    );
    const original = app.view.state.doc;
    select("Before", "end");
    expect(key("ArrowRight").defaultPrevented).toBe(true);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");
    expect(app.view.state.selection.$from.parentOffset).toBe(0);
    select("code", "end");
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    const textarea = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(0);
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.attrs.kind).toBe(
      "alert",
    );
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    key("ArrowRight", {}, textarea);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    expect(app.view.state.selection.$from.parentOffset).toBe(0);
    key("ArrowLeft");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowLeft");
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    textarea.setSelectionRange(0, 0);
    key("ArrowLeft", {}, textarea);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowLeft");
    expect(app.view.state.selection.$from.parent.textContent).toBe("code");
    expect(app.view.state.selection.$from.parentOffset).toBe(4);
    select("code", "start");
    key("ArrowLeft");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowLeft");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Before");
    expect(app.view.state.doc).toBe(original);
    expect(
      messages.filter(
        (message) => (message as { type?: unknown }).type === "edit",
      ),
    ).toEqual([]);
  });

  it("keeps successive rendered atoms reachable in both directions without opening a dialog", () => {
    const { app, root, messages, select, key } = setup(
      "Before\n\n$$\nx^2\n$$\n\n```mermaid\ngraph TD; A-->B\n```\n\nAfter",
    );
    const original = app.view.state.doc;
    select("Before", "end");
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.attrs.kind).toBe(
      "math-block",
    );
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.attrs.kind).toBe(
      "protected-fence",
    );
    key("ArrowRight");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowRight");
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    key("ArrowLeft");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowLeft");
    expect((app.view.state.selection as NodeSelection).node.attrs.kind).toBe(
      "protected-fence",
    );
    key("ArrowLeft");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowLeft");
    expect((app.view.state.selection as NodeSelection).node.attrs.kind).toBe(
      "math-block",
    );
    key("ArrowLeft");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowLeft");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Before");
    expect(root.querySelector("dialog[open]")).toBeNull();
    expect(app.view.state.doc).toBe(original);
    expect(
      messages.filter(
        (message) => (message as { type?: unknown }).type === "edit",
      ),
    ).toEqual([]);
  });

  it("does not intercept selections, IME, modifiers, or interior horizontal carets", () => {
    const { app, root, select, key } = setup(
      "Before\n\n> [!NOTE]\n> body\n\nAfter",
    );
    for (const init of [
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { isComposing: true },
    ]) {
      select("Before", "end");
      expect(key("ArrowRight", init).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(app.view.dom);
    }
    select("Before", "end");
    const end = app.view.state.selection.head;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        TextSelection.create(app.view.state.doc, end - 2, end),
      ),
    );
    expect(key("ArrowRight").defaultPrevented).toBe(false);
    expect(app.view.state.selection.empty).toBe(false);
    const textarea = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    textarea.focus();
    textarea.setSelectionRange(1, 1);
    expect(key("ArrowRight", {}, textarea).defaultPrevented).toBe(false);
    textarea.setSelectionRange(0, textarea.value.length);
    expect(key("ArrowDown", {}, textarea).defaultPrevented).toBe(false);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });

  it("uses displayed textblock boundaries in both vertical directions", () => {
    // The real-layout suite separately verifies wrapping; this test verifies
    // that the editor honors ProseMirror's layout boundary decision.
    const { app, select, key } = setup(
      "Before\n\n```ts\nwrapped code\n```\n\nAfter",
    );
    select("wrapped code", "start");
    const boundary = vi
      .spyOn(app.view, "endOfTextblock")
      .mockReturnValue(false);
    const posAtCoords = vi.spyOn(app.view, "posAtCoords");
    expect(key("ArrowDown").defaultPrevented).toBe(false);
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");
    expect(posAtCoords).not.toHaveBeenCalled();
    boundary.mockReturnValue(true);
    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    expect(key("ArrowUp").defaultPrevented).toBe(true);
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowUp");
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");
    expect(boundary).toHaveBeenCalledWith("down");
    expect(boundary).toHaveBeenCalledWith("up");
  });

  it("guards only displayed-row boundaries while code is expanded", () => {
    const body = "first\nsecond\nthird";
    const { app, root, messages, select, key } = setup(
      ["Before", "", "```text", body, "```", "", "After"].join("\n"),
    );
    root
      .querySelector<HTMLButtonElement>('[data-mm-code-action="expand"]')!
      .click();
    select(body, "start");
    const original = app.view.state.doc;
    const boundary = vi.spyOn(app.view, "endOfTextblock");
    for (const direction of ["ArrowUp", "ArrowDown"]) {
      boundary.mockReturnValue(false);
      // Without layout, an interior arrow remains available to the browser.
      expect(key(direction).defaultPrevented).toBe(false);
      boundary.mockReturnValue(true);
      const previous = app.view.state.selection;
      expect(key(direction).defaultPrevented).toBe(true);
      expect(app.view.state.selection.eq(previous)).toBe(true);
      expect(app.view.state.selection.$from.parent.type.name).toBe(
        "code_block",
      );
    }
    expect(boundary).toHaveBeenCalledWith("up");
    expect(boundary).toHaveBeenCalledWith("down");
    expect(app.view.state.doc).toBe(original);
    expect(
      messages.filter(
        (message) => (message as { type?: unknown }).type === "edit",
      ),
    ).toEqual([]);
  });
});
