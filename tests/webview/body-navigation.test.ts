import { afterEach, describe, expect, it, vi } from "vitest";
import { Fragment } from "prosemirror-model";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { BlockBoundarySelection } from "../../src/webview/blockBoundary";
import {
  isStructuralNavigationTarget,
  shouldStopAtStructuralGap,
  type NavigationTarget,
} from "../../src/webview/bodyNavigation";
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
  it("classifies structural gaps from actual top-level targets", () => {
    const doc = parseMarkdown(
      [
        "Paragraph",
        "",
        "```ts",
        "code",
        "```",
        "",
        "| H1 | H2 |",
        "| --- | --- |",
        "| A1 | A2 |",
        "",
        "> [!NOTE]",
        "> alert",
        "",
        "After",
      ].join("\n"),
      "github",
    ).doc;
    const targets: NavigationTarget[] = [];
    doc.forEach((node, position) => targets.push({ node, position }));

    expect(targets.map(({ node }) => node.type.name)).toEqual([
      "paragraph",
      "code_block",
      "table",
      "raw_block",
      "paragraph",
    ]);
    expect(
      targets.map(({ node }) => isStructuralNavigationTarget(node)),
    ).toEqual([false, true, true, true, false]);
    expect(shouldStopAtStructuralGap(targets[0]!, targets[1]!)).toBe(false);
    expect(shouldStopAtStructuralGap(targets[1]!, targets[2]!)).toBe(true);
    expect(shouldStopAtStructuralGap(targets[2]!, targets[3]!)).toBe(true);
    expect(shouldStopAtStructuralGap(targets[3]!, targets[4]!)).toBe(false);
  });

  it("moves flow content directly without virtual vertical stops", () => {
    const { app, select, key } = setup(
      [
        "Paragraph A",
        "# Heading",
        "Paragraph B",
        "> Quote",
        "- first item\n- final item",
        "Paragraph C",
      ].join("\n\n"),
    );
    app.view.endOfTextblock = () => true;

    select("Paragraph A", "end");
    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect(app.view.state.selection.$from.parent.textContent).toBe("Heading");
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);

    select("Heading", "end");
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe(
      "Paragraph B",
    );

    select("Paragraph B", "end");
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Quote");

    select("Quote", "end");
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe(
      "first item",
    );

    select("final item", "end");
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe(
      "Paragraph C",
    );

    select("Paragraph C", "start");
    key("ArrowUp");
    expect(app.view.state.selection.$from.parent.textContent).toBe(
      "final item",
    );
  });

  it("visits consecutive empty flow paragraphs one at a time", () => {
    const { app, messages, select, key } = setup("P\n\nQ");
    const paragraph = schema.nodes.paragraph!;
    const insertAt = app.view.state.doc.child(0).nodeSize;
    app.view.dispatch(
      app.view.state.tr.insert(
        insertAt,
        Fragment.fromArray([paragraph.create(), paragraph.create()]),
      ),
    );
    messages.splice(0);
    app.view.endOfTextblock = () => true;

    select("P", "end");
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("");
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("");
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Q");

    select("Q", "start");
    key("ArrowUp");
    expect(app.view.state.selection.$from.parent.textContent).toBe("");
    key("ArrowUp");
    expect(app.view.state.selection.$from.parent.textContent).toBe("");
    key("ArrowUp");
    expect(app.view.state.selection.$from.parent.textContent).toBe("P");

    select("P", "end");
    key("ArrowRight");
    expect(app.view.state.selection.$from.parent.textContent).toBe("");
    key("ArrowRight");
    expect(app.view.state.selection.$from.parent.textContent).toBe("");
    key("ArrowRight");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Q");
    select("Q", "start");
    key("ArrowLeft");
    expect(app.view.state.selection.$from.parent.textContent).toBe("");
    key("ArrowLeft");
    expect(app.view.state.selection.$from.parent.textContent).toBe("");
    key("ArrowLeft");
    expect(app.view.state.selection.$from.parent.textContent).toBe("P");
    expect(messages).toEqual([]);
  });

  it("handles every arrow at document edges without changing selection", () => {
    const { app, select, key } = setup("Top\n\nBottom");
    app.view.endOfTextblock = () => true;

    for (const [text, edge, arrow] of [
      ["Top", "start", "ArrowLeft"],
      ["Top", "start", "ArrowUp"],
      ["Bottom", "end", "ArrowRight"],
      ["Bottom", "end", "ArrowDown"],
    ] as const) {
      select(text, edge);
      const original = app.view.state.selection;
      const event = key(arrow);
      expect(event.defaultPrevented).toBe(true);
      expect(app.view.state.selection.eq(original)).toBe(true);
      expect(app.view.state.selection).not.toBeInstanceOf(
        BlockBoundarySelection,
      );
    }
  });

  it("leaves an existing boundary in one key without creating another", () => {
    const { app, select, key } = setup("Before\n\n```ts\ncode\n```\n\nAfter");
    app.view.endOfTextblock = () => true;
    const boundary = app.view.state.doc.child(0)!.nodeSize;
    app.view.dispatch(
      app.view.state.tr.setSelection(
        new BlockBoundarySelection(app.view.state.doc.resolve(boundary)),
      ),
    );
    expect(key("ArrowRight").defaultPrevented).toBe(true);
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);

    for (const arrow of ["ArrowLeft", "ArrowUp"] as const) {
      app.view.dispatch(
        app.view.state.tr.setSelection(
          new BlockBoundarySelection(app.view.state.doc.resolve(boundary)),
        ),
      );
      expect(key(arrow).defaultPrevented).toBe(true);
      expect(app.view.state.selection.$from.parent.textContent).toBe("Before");
      expect(app.view.state.selection).not.toBeInstanceOf(
        BlockBoundarySelection,
      );
    }

    select("Before", "end");
    app.view.dispatch(
      app.view.state.tr.setSelection(
        new BlockBoundarySelection(app.view.state.doc.resolve(boundary)),
      ),
    );
    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);
  });

  it("uses editable targets for code and Alert without editing", () => {
    const { app, root, messages, select, key } = setup(
      "Before\n\n```ts\ncode\n```\n\n> [!NOTE]\n> alert\n\nAfter",
    );
    app.view.endOfTextblock = () => true;
    const original = app.view.state.doc;

    select("Before", "end");
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.type.name).toBe("code_block");
    select("code", "end");
    key("ArrowDown");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowDown");
    expect(document.activeElement).toBe(
      root.querySelector(".mm-alert-body-editor"),
    );
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);

    const textarea = root.querySelector<HTMLTextAreaElement>(
      ".mm-alert-body-editor",
    )!;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    expect(key("ArrowRight", {}, textarea).defaultPrevented).toBe(true);
    expect(key("ArrowDown", {}, app.view.dom).defaultPrevented).toBe(true);
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    expect(app.view.state.doc).toBe(original);
    expect(
      messages.filter(
        (message) => (message as { type?: unknown }).type === "edit",
      ),
    ).toEqual([]);
  });

  it("treats open and collapsed Details as direct vertical targets", () => {
    const { app, root, select, key } = setup(
      [
        "Before",
        "<details open>",
        "<summary>Open</summary>",
        "Open body",
        "</details>",
        "<details>",
        "<summary>Closed</summary>",
        "Hidden body",
        "</details>",
        "After",
      ].join("\n\n"),
    );
    app.view.endOfTextblock = () => true;

    select("Before", "end");
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Open body");

    select("Open body", "end");
    key("ArrowDown");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowDown");
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.type.name).toBe(
      "details",
    );
    expect(root.querySelector('[data-mm-details-open="false"]')).not.toBeNull();

    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
  });

  it("treats atomic blocks as stops and boundaries only between structural targets", () => {
    const { app, select, key } = setup("Before\n\n---\n\n$$\nx^2\n$$\n\nAfter");
    app.view.endOfTextblock = () => true;

    select("Before", "end");
    key("ArrowDown");
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.type.name).toBe(
      "horizontal_rule",
    );
    key("ArrowDown");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowDown");
    expect(app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect((app.view.state.selection as NodeSelection).node.attrs.kind).toBe(
      "math-block",
    );
    key("ArrowDown");
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");

    key("ArrowUp");
    expect((app.view.state.selection as NodeSelection).node.attrs.kind).toBe(
      "math-block",
    );
    key("ArrowUp");
    expect(app.view.state.selection).toBeInstanceOf(BlockBoundarySelection);
    key("ArrowUp");
    expect((app.view.state.selection as NodeSelection).node.type.name).toBe(
      "horizontal_rule",
    );
    key("ArrowUp");
    expect(app.view.state.selection.$from.parent.textContent).toBe("Before");

    const image = setup(
      "Before\n\n![image](https://example.com/image.png)\n\nAfter",
    );
    image.app.view.endOfTextblock = () => true;
    image.select("Before", "end");
    image.key("ArrowDown");
    expect(image.app.view.state.selection).toBeInstanceOf(NodeSelection);
    expect(
      (image.app.view.state.selection as NodeSelection).node.type.name,
    ).toBe("image");
    image.key("ArrowDown");
    expect(image.app.view.state.selection.$from.parent.textContent).toBe(
      "After",
    );
    image.key("ArrowUp");
    expect(
      (image.app.view.state.selection as NodeSelection).node.type.name,
    ).toBe("image");
    image.key("ArrowUp");
    expect(image.app.view.state.selection.$from.parent.textContent).toBe(
      "Before",
    );

    image.select("Before", "end");
    image.key("ArrowRight");
    expect(image.app.view.state.selection).toBeInstanceOf(NodeSelection);
    image.key("ArrowRight");
    expect(image.app.view.state.selection.$from.parent.textContent).toBe(
      "After",
    );
    image.key("ArrowLeft");
    expect(image.app.view.state.selection).toBeInstanceOf(NodeSelection);
    image.key("ArrowLeft");
    expect(image.app.view.state.selection.$from.parent.textContent).toBe(
      "Before",
    );

    const imageMath = setup(
      "Before\n\n![image](https://example.com/image.png)\n\n$$\nx^2\n$$\n\nAfter",
    );
    imageMath.app.view.endOfTextblock = () => true;
    imageMath.select("Before", "end");
    imageMath.key("ArrowDown");
    expect(imageMath.app.view.state.selection).toBeInstanceOf(NodeSelection);
    imageMath.key("ArrowDown");
    expect(imageMath.app.view.state.selection).toBeInstanceOf(
      BlockBoundarySelection,
    );
    imageMath.key("ArrowDown");
    expect(
      (imageMath.app.view.state.selection as NodeSelection).node.attrs.kind,
    ).toBe("math-block");
  });

  it("handles the document-end Details edge without exposing a boundary", () => {
    const source =
      "<details open>\n<summary>End</summary>\n\nLast body\n\n</details>";
    const { app, root, messages, select, key } = setup(source);
    const details = app.view.state.doc.firstChild;
    select("Last body", "end");
    const originalSelection = app.view.state.selection;
    expect(key("ArrowRight").defaultPrevented).toBe(true);
    expect(app.view.state.doc.firstChild).toBe(details);
    expect(app.view.state.doc.lastChild).toBe(details);
    expect(app.view.state.selection.eq(originalSelection)).toBe(true);
    expect(app.view.state.selection).not.toBeInstanceOf(BlockBoundarySelection);
    expect(root.querySelector(".mm-block-boundary-cursor")).toBeNull();
    expect(
      messages.filter(
        (message) => (message as { type?: unknown }).type === "edit",
      ),
    ).toEqual([]);
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

  it("crosses paragraph, code and Alert block edges in both horizontal directions without editing", () => {
    const { app, root, messages, select, key } = setup(
      "Before\n\n```ts\ncode\n```\n\n> [!NOTE]\n> alert\n\nAfter",
    );
    const original = app.view.state.doc;
    select("Before", "end");
    expect(key("ArrowRight").defaultPrevented).toBe(true);
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
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    expect(app.view.state.selection.$from.parentOffset).toBe(0);
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
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
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

  it("uses displayed textblock boundaries without exposing insertion stops", () => {
    // The real-layout suite separately verifies wrapping; this test verifies
    // that the editor honors ProseMirror's layout boundary decision while the
    // vertical target skips the insertion boundary in one key press.
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
    expect(app.view.state.selection.$from.parent.textContent).toBe("After");
    expect(key("ArrowUp").defaultPrevented).toBe(true);
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
