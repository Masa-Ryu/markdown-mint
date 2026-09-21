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
    ["an inline link", "- [x](https://example.com) linked text"],
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

  it.each([
    ["without a reference definition", "- [x] linked text"],
    [
      "with a same-label reference definition",
      "[x]: https://example.com\n\n- [x] linked text",
    ],
  ] as const)(
    "recognizes a raw task marker before inline reference resolution (%s)",
    (_name, source) => {
      const snapshot = parseMarkdown(source, "github");
      const item = listItems(snapshot.doc)[0]!;

      expect(item.attrs.checked).toBe(true);
      expect(item.textContent).toBe("linked text");
    },
  );

  it("preserves a reference link in a task body after round-trip editing", () => {
    const source =
      "[x]: https://example.com\n[ref]: https://reference.example\n\n- [x] linked [ref]";
    const snapshot = parseMarkdown(source, "github");
    const original = listItems(snapshot.doc)[0]!;
    const originalLink = original
      .firstChild!.content.child(1)
      .marks.find((mark) => mark.type.name === "link");

    expect(original.attrs.checked).toBe(true);
    expect(originalLink?.attrs.href).toBe("https://reference.example");

    const edited = replaceText(snapshot.doc, "linked", "changed");
    const serialized = serializeMarkdown(edited, snapshot);
    const reparsed = listItems(reparse(serialized, "github"))[0]!;
    const reparsedLink = reparsed
      .firstChild!.content.child(1)
      .marks.find((mark) => mark.type.name === "link");

    expect(reparsed.attrs.checked).toBe(true);
    expect(reparsedLink?.attrs.href).toBe("https://reference.example");
  });
});
