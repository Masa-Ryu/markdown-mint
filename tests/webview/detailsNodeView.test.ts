import { afterEach, describe, expect, it, vi } from "vitest";
import { history, redo, undo } from "prosemirror-history";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown, schema, serializeMarkdown } from "../../src/core/index";
import { createDetailsNodeView } from "../../src/webview/detailsNodeView";

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.replaceChildren();
});

function fixture(
  source = '<details data-x="keep">\n<summary><strong>More</strong></summary>\n\nBody\n\n</details>\n',
) {
  const root = document.createElement("div");
  document.body.append(root);
  const snapshot = parseMarkdown(source);
  const preserveDraft = vi.fn();
  const composition = vi.fn();
  let allowed = true;
  const view = new EditorView(root, {
    handleScrollToSelection: () => true,
    state: EditorState.create({
      schema,
      doc: snapshot.doc,
      plugins: [history()],
    }),
    nodeViews: {
      details: (node, editor, getPos) =>
        createDetailsNodeView(node, editor, getPos, {
          getProfile: () => "github",
          canEdit: () => allowed,
          preserveDraft,
          composition,
        }),
    },
  });
  views.push(view);
  const title = (): HTMLButtonElement =>
    root.querySelector(".mm-details-summary")!;
  const input = (): HTMLInputElement =>
    root.querySelector(".mm-details-summary-input")!;
  const toggle = (): HTMLButtonElement =>
    root.querySelector(".mm-details-toggle")!;
  const body = (): HTMLElement => root.querySelector(".mm-details-body")!;
  const key = (name: string): void => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: name,
        bubbles: true,
        cancelable: true,
      }),
    );
  };
  const markdown = (): string => serializeMarkdown(view.state.doc, snapshot);
  return {
    root,
    view,
    source,
    preserveDraft,
    composition,
    title,
    input,
    toggle,
    body,
    key,
    markdown,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
  };
}

describe("Details header and structured content NodeView", () => {
  it("separates single-click title editing and collapse controls without updating Markdown", () => {
    const f = fixture();
    f.title().click();
    expect(f.input().hidden).toBe(false);
    expect(f.body().hidden).toBe(true);
    expect(f.input().value).toBe("<strong>More</strong>");
    expect(f.markdown()).toBe(f.source);
    f.key("Escape");
    f.toggle().click();
    expect(f.body().hidden).toBe(false);
    expect(f.input().hidden).toBe(true);
    expect(f.toggle().getAttribute("aria-expanded")).toBe("true");
    expect(f.markdown()).toBe(f.source);
    expect(undo(f.view.state)).toBe(false);
  });

  it("commits a heading once, keeps the body bytes, and undoes independently from body input", () => {
    const f = fixture();
    f.toggle().click();
    f.view.dispatch(f.view.state.tr.insertText("New ", 2));
    f.title().click();
    f.input().value = "<strong>Changed</strong>";
    f.key("Enter");
    expect(f.markdown()).toBe(
      f.source.replace("Body", "New Body").replace("More", "Changed"),
    );
    expect(f.body().hidden).toBe(false);
    expect(undo(f.view.state, f.view.dispatch)).toBe(true);
    expect(f.markdown()).toBe(f.source.replace("Body", "New Body"));
    expect(undo(f.view.state, f.view.dispatch)).toBe(true);
    expect(f.markdown()).toBe(f.source);
    expect(redo(f.view.state, f.view.dispatch)).toBe(true);
    expect(redo(f.view.state, f.view.dispatch)).toBe(true);
    expect(f.markdown()).toContain("Changed");
  });

  it("cancels only the current heading and cannot recommit on blur", () => {
    const f = fixture();
    f.title().click();
    f.input().value = "Canceled";
    f.key("Escape");
    f.input().dispatchEvent(new FocusEvent("blur"));
    expect(f.markdown()).toBe(f.source);
    expect(f.preserveDraft).not.toHaveBeenCalled();
    expect(undo(f.view.state)).toBe(false);
    f.title().click();
    f.key("Enter");
    expect(undo(f.view.state)).toBe(false);
  });

  it("commits blur without stealing the new focus, and leaves Tab handling native", () => {
    const f = fixture();
    const destination = document.createElement("button");
    document.body.append(destination);
    f.title().click();
    f.input().value = "Changed";
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    f.input().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    destination.focus();
    expect(document.activeElement).toBe(destination);
    expect(f.markdown()).toContain("<summary>Changed</summary>");
  });

  it("keeps composition and its immediately following Enter within the heading", () => {
    const f = fixture();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    f.title().click();
    f.input().dispatchEvent(new CompositionEvent("compositionstart"));
    f.input().value = "日本語";
    f.key("Enter");
    expect(f.input().hidden).toBe(false);
    f.input().dispatchEvent(new CompositionEvent("compositionend"));
    f.key("Enter");
    expect(f.input().hidden).toBe(false);
    expect(f.markdown()).toBe(f.source);
    now += 100;
    f.key("Enter");
    expect(f.markdown()).toContain("日本語");
    expect(f.composition.mock.calls).toEqual([[true], [false]]);
    f.title().click();
    f.input().dispatchEvent(new CompositionEvent("compositionstart"));
    f.input().value = "Canceled after composition";
    f.input().dispatchEvent(new CompositionEvent("compositionend"));
    f.key("Escape");
    f.input().dispatchEvent(new FocusEvent("blur"));
    expect(f.markdown()).not.toContain("Canceled after composition");
  });

  it("maps a saved body range after insertion before the block and before the range", () => {
    const f = fixture();
    f.toggle().click();
    f.view.dispatch(
      f.view.state.tr.setSelection(
        TextSelection.create(f.view.state.doc, 3, 5),
      ),
    );
    f.title().click();
    f.input().value = "Changed";
    f.view.dispatch(f.view.state.tr.insertText("X", 2));
    const prefix = schema.nodes.paragraph!.create(null, schema.text("Before"));
    f.view.dispatch(f.view.state.tr.insert(0, prefix));
    f.key("Enter");
    expect(f.view.state.selection.from).toBe(prefix.nodeSize + 4);
    expect(f.view.state.selection.to).toBe(prefix.nodeSize + 6);
    expect(f.markdown()).toContain("<summary>Changed</summary>");
    expect(f.preserveDraft).not.toHaveBeenCalled();
  });

  it("does not overwrite an externally changed heading or an identical replacement block", () => {
    const f = fixture();
    f.title().click();
    f.input().value = "Local draft";
    f.view.dispatch(
      f.view.state.tr.setNodeMarkup(0, undefined, {
        ...f.view.state.doc.firstChild!.attrs,
        summarySource: "Remote",
      }),
    );
    f.key("Enter");
    expect(f.markdown()).toContain("<summary>Remote</summary>");
    expect(f.preserveDraft).toHaveBeenCalledWith(
      "Local draft",
      expect.any(String),
    );
    const duplicate = fixture(f.source + "\n" + f.source);
    duplicate.title().click();
    duplicate.input().value = "Deleted draft";
    duplicate.view.dispatch(
      duplicate.view.state.tr.delete(
        0,
        duplicate.view.state.doc.firstChild!.nodeSize,
      ),
    );
    if (!duplicate.input().hidden) duplicate.key("Enter");
    expect(duplicate.markdown()).not.toContain("Deleted draft");
    expect(duplicate.preserveDraft).toHaveBeenCalledWith(
      "Deleted draft",
      expect.any(String),
    );
  });

  it("guards edit restrictions at both opening and commit, preserving a blocked draft", () => {
    const f = fixture();
    f.setAllowed(false);
    f.title().click();
    expect(f.input().hidden).toBe(true);
    f.setAllowed(true);
    f.title().click();
    f.input().value = "Draft";
    f.setAllowed(false);
    f.key("Enter");
    expect(f.markdown()).toBe(f.source);
    expect(f.preserveDraft).toHaveBeenCalledWith("Draft", expect.any(String));
  });

  it("keeps nested toggles independent and moves selection out of a collapsing body", () => {
    const f = fixture(
      "<details open>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nNested\n</details>\n\n</details>\n",
    );
    const toggles =
      f.root.querySelectorAll<HTMLButtonElement>(".mm-details-toggle");
    toggles[1]!.click();
    expect(toggles[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(toggles[1]!.getAttribute("aria-expanded")).toBe("true");
    f.view.dispatch(
      f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc, 3)),
    );
    f.toggle().click();
    expect(f.view.state.selection).toBeInstanceOf(NodeSelection);
    expect(f.view.state.selection.from).toBe(0);
    expect(document.activeElement).toBe(f.toggle());
    expect(f.markdown()).toBe(f.source);
  });
});
