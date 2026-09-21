import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import {
  parseMarkdown,
  schema,
  serializeMarkdown,
  type Profile,
} from "../../src/core/index";

function listItems(doc: PMNode): PMNode[] {
  const items: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === "list_item") items.push(node);
  });
  return items;
}

function replaceText(doc: PMNode, value: string, replacement: string): PMNode {
  let from = -1;
  let marks: PMNode["marks"] = [];
  doc.descendants((node, position) => {
    if (!node.isText || from >= 0 || !node.text?.includes(value)) return;
    from = position + node.text.indexOf(value);
    marks = node.marks;
  });
  if (from < 0) throw new Error(`Text not found: ${value}`);
  return EditorState.create({ schema, doc }).tr.replaceWith(
    from,
    from + value.length,
    schema.text(replacement, marks),
  ).doc;
}

function reparse(source: string, profile: Profile): PMNode {
  parseMarkdown("task-marker-cache-bust", profile);
  return parseMarkdown(source, profile).doc;
}

describe("task marker parsing", () => {
  it.each(["github", "gitlab"] as const)(
    "keeps escaped marker text as an ordinary list in %s",
    (profile) => {
      const source =
        profile === "gitlab"
          ? "- \\[x\\] literal text, not a task\n- \\[~\\] another literal marker"
          : "- \\[x\\] literal text, not a task\n- \\[ \\] another literal marker";
      const snapshot = parseMarkdown(source, profile);
      const items = listItems(snapshot.doc);

      expect(items.map((item) => item.attrs.checked)).toEqual([null, null]);
      expect(items.map((item) => item.textContent)).toEqual(
        profile === "gitlab"
          ? ["[x] literal text, not a task", "[~] another literal marker"]
          : ["[x] literal text, not a task", "[ ] another literal marker"],
      );
      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);

      const edited = replaceText(snapshot.doc, "literal", "changed");
      const serialized = serializeMarkdown(edited, snapshot);
      expect(serialized).toContain("\\[x\\] changed text, not a task");
      expect(
        listItems(reparse(serialized, profile)).map(
          (item) => item.attrs.checked,
        ),
      ).toEqual([null, null]);
    },
  );

  it.each(["github", "gitlab"] as const)(
    "continues to recognize real task markers in %s",
    (profile) => {
      const source =
        profile === "gitlab"
          ? "> - [x] quoted\n\n- [~] mixed\n- [ ] open"
          : "> - [x] quoted\n\n1. [x] ordered\n- [ ] open";
      const snapshot = parseMarkdown(source, profile);
      const items = listItems(snapshot.doc);

      expect(items.map((item) => item.attrs.checked)).toEqual(
        profile === "gitlab" ? [true, "mixed", false] : [true, true, false],
      );
    },
  );

  it.each([
    ["code span", "- `[x] code`"],
    ["strong text", "- **[x] bold** text"],
    ["emphasized text", "- *[x] emphasis* text"],
    ["text after an image", "- ![image](image.png)[x] after"],
    ["a nested literal list item", "- parent\n  - \\[x\\] nested literal"],
    ["a marker on a later paragraph", "- first\n\n  [x] second"],
  ] as const)("does not detect %s as a task marker", (_name, source) => {
    const snapshot = parseMarkdown(source, "github");
    const items = listItems(snapshot.doc);

    expect(items.every((item) => item.attrs.checked === null)).toBe(true);
  });

  it("does not parse task markers in the CommonMark profile", () => {
    const snapshot = parseMarkdown("- [x] ordinary text", "commonmark");

    expect(listItems(snapshot.doc)[0]?.attrs.checked).toBeNull();
  });

  it("does not treat a reference link label as a task marker", () => {
    const source = "[x]: https://example.com\n\n- [x] linked text";
    const snapshot = parseMarkdown(source, "github");

    expect(listItems(snapshot.doc)[0]?.attrs.checked).toBeNull();
  });
});
