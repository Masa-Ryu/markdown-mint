import { describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { parseMarkdown, schema } from "../../src/core";
import { AI_LIMITS } from "../../src/shared/aiSuggestions";
import {
  buildSuggestionContext,
  getSuggestionTarget,
  isSuggestionSnapshotCurrent,
} from "../../src/webview/aiSuggestionContext";

function state(
  source: string,
  kind = "paragraph",
  occurrence = 0,
): EditorState {
  const doc = parseMarkdown(source, "gitlab").doc;
  let position = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === kind && occurrence-- === 0)
      position = pos + node.nodeSize - 1;
  });
  if (position < 0) throw new Error(`No ${kind} in fixture`);
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, position),
  });
}
describe("bounded AI prose context", () => {
  it.each([
    "Body",
    "# Heading",
    "- Item",
    "1. Item",
    "- [ ] Task",
    "- [x] Task",
  ])("supports prose/list ends: %s", (source) => {
    const editor = state(
      source,
      source.startsWith("#") ? "heading" : "paragraph",
    );
    expect(getSuggestionTarget(editor)).toBeDefined();
  });
  it.each([
    "[link](https://example.com)",
    "`code`",
    "> quote",
    "| A |\n|---|\n| B |",
    "<details>\n<summary>Title</summary>\n\nBody\n\n</details>",
  ])("excludes protected contexts: %s", (source) => {
    expect(getSuggestionTarget(state(source))).toBeUndefined();
  });
  it("excludes code, selections, and interior carets", () => {
    expect(
      getSuggestionTarget(state("```ts\nvalue\n```", "code_block")),
    ).toBeUndefined();
    const editor = state("Hello");
    expect(
      getSuggestionTarget(
        editor.apply(
          editor.tr.setSelection(TextSelection.create(editor.doc, 2)),
        ),
      ),
    ).toBeUndefined();
    expect(
      getSuggestionTarget(
        editor.apply(
          editor.tr.setSelection(TextSelection.create(editor.doc, 1, 6)),
        ),
      ),
    ).toBeUndefined();
  });
  it("gets previous prose for an empty paragraph and surrounding headings/following text", () => {
    const editor = state(
      "# Topic\n\nPrevious\n\n<!-- spacer -->\n\nCurrent\n\nFollowing",
      "paragraph",
      1,
    );
    const target = getSuggestionTarget(editor)!;
    expect(buildSuggestionContext(editor, target)).toEqual({
      before: "Topic\nPrevious\nCurrent",
      after: "Following",
      heading: "Topic",
    });
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("Previous")),
      schema.nodes.paragraph!.create(),
    ]);
    const empty = EditorState.create({
      doc,
      selection: TextSelection.create(doc, doc.content.size - 1),
    });
    expect(
      buildSuggestionContext(empty, getSuggestionTarget(empty)!)?.before,
    ).toBe("Previous");
    const blank = EditorState.create({ schema });
    expect(
      buildSuggestionContext(blank, getSuggestionTarget(blank)!),
    ).toBeUndefined();
  });
  it("bounds text and skips giant structural content without recursive traversal", () => {
    const editor = state(
      `# ${"🌿".repeat(600)}\n\n${"x".repeat(8000)}\n\n${"y".repeat(3000)}`,
    );
    const context = buildSuggestionContext(
      editor,
      getSuggestionTarget(editor)!,
    )!;
    expect(context.before.length).toBeLessThanOrEqual(AI_LIMITS.before);
    expect(context.after.length).toBe(AI_LIMITS.after);
    expect(context.heading.length).toBeLessThanOrEqual(AI_LIMITS.heading);
    const tableEditor = state(
      "Before\n\n| A |\n|---|\n" + "| huge |\n".repeat(2000) + "\nEnd",
      "paragraph",
      2002,
    );
    const target = getSuggestionTarget(tableEditor)!;
    const spy = vi.spyOn(tableEditor.doc.child(1), "child");
    expect(buildSuggestionContext(tableEditor, target)?.before).toBe(
      "Before\nEnd",
    );
    expect(spy).not.toHaveBeenCalled();
  });
  it("rejects changed document, selection, and target node snapshots", () => {
    const editor = state("Hello");
    const target = getSuggestionTarget(editor)!;
    expect(isSuggestionSnapshotCurrent(editor, target)).toBe(true);
    expect(
      isSuggestionSnapshotCurrent(
        editor.apply(editor.tr.insertText("!")),
        target,
      ),
    ).toBe(false);
    expect(
      isSuggestionSnapshotCurrent(
        editor.apply(
          editor.tr.setSelection(TextSelection.create(editor.doc, 1)),
        ),
        target,
      ),
    ).toBe(false);
  });
});
