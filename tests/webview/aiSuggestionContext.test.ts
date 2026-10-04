import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { parseMarkdown } from "../../src/core";
import { getSuggestionTarget } from "../../src/webview/aiSuggestionContext";

function state(source: string, offset: number) {
  const doc = parseMarkdown(source, "github").doc;
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, offset),
  });
}
function sourcePosition(source: string, text: string, at = 0): number {
  const parsed = parseMarkdown(source, "github").doc;
  let found = -1;
  parsed.descendants((node, position) => {
    if (node.isText && node.text) {
      const local = node.text.indexOf(text, at);
      if (local >= 0 && found < 0) found = position + local;
    }
  });
  if (found < 0) throw new Error("Text not found in parsed fixture");
  return found;
}

describe("suggestion cursor targets", () => {
  it.each([
    ["body paragraph", "An ordinary paragraph.", "ordinary".length + 1],
    ["heading", "# A heading with text", 5],
    ["bullet list", "- A list item", 5],
    ["numbered list", "1. A list item", 5],
    ["task list", "- [ ] A task item", 9],
  ])("accepts a midline %s target", (_name, source, position) => {
    expect(getSuggestionTarget(state(source, position))).toBeDefined();
  });
  it("allows link labels and prose adjacent to inline code", () => {
    const linked = "[label text](https://example.test)";
    const labelPosition = sourcePosition(linked, "label") + 3;
    expect(getSuggestionTarget(state(linked, labelPosition))).toBeDefined();
    const tick = String.fromCharCode(96);
    const mixed = "Before " + tick + "code" + tick + " after";
    expect(
      getSuggestionTarget(state(mixed, sourcePosition(mixed, "Before") + 2)),
    ).toBeDefined();
    expect(
      getSuggestionTarget(state(mixed, sourcePosition(mixed, "code") + 1)),
    ).toBeUndefined();
    expect(
      getSuggestionTarget(state(mixed, sourcePosition(mixed, "after") + 2)),
    ).toBeDefined();
  });
  it.each([
    ["table", "| A | B |\n|---|---|\n| one | two |", 1],
    ["fenced code", "\x60\x60\x60ts\nconst value = 1;\n\x60\x60\x60", 5],
    ["raw HTML", "<details>\n<summary>x</summary>\n</details>", 2],
  ])("rejects %s content", (_name, source, position) => {
    expect(getSuggestionTarget(state(source, position))).toBeUndefined();
  });
  it("rejects non-empty selections and supports contextual empty paragraphs", () => {
    const doc = parseMarkdown("Before.\n\nAfter.", "github").doc;
    const emptyParagraph = doc.content.child(1);
    const position = doc.content.child(0).nodeSize + 1;
    const selection = EditorState.create({
      doc,
      selection: TextSelection.create(doc, position),
    });
    expect(emptyParagraph.type.name).toBe("paragraph");
    expect(getSuggestionTarget(selection)).toBeDefined();
    const selected = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2, 4),
    });
    expect(getSuggestionTarget(selected)).toBeUndefined();
    expect(getSuggestionTarget(state("", 1))).toBeUndefined();
  });
});
