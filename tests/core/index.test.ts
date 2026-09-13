import { describe, expect, it } from "vitest";
import { DOMSerializer, type Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import {
  formatMarkdown,
  inspectCompatibility,
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeCodeBlockMarkdown,
  serializeMarkdown,
  alertSourceParts,
  alertSourceWithBody,
  alertSourceWithType,
  MAX_MATERIALIZED_EMPTY_PARAGRAPHS,
  type Profile,
} from "../../src/core/index";

function replaceTopLevel(
  snapshot: ReturnType<typeof parseMarkdown>,
  index: number,
  replacement: PMNode,
): PMNode {
  const children: PMNode[] = [];
  snapshot.doc.forEach((child) => children.push(child));
  children[index] = replacement;
  return schema.topNodeType.create(null, children);
}

function removeTopLevel(
  snapshot: ReturnType<typeof parseMarkdown>,
  index: number,
): PMNode {
  const children = childrenOf(snapshot.doc);
  children.splice(index, 1);
  return schema.topNodeType.create(null, children);
}

function childrenOf(node: PMNode): PMNode[] {
  const children: PMNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

function reparseMarkdown(source: string, profile: Profile = "github") {
  // parseMarkdown keeps a one-entry cache for render/compatibility sharing.
  // Evict the target source so round-trip assertions exercise a real parse.
  parseMarkdown("cache-bust", profile);
  return parseMarkdown(source, profile);
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

function mathAtoms(doc: PMNode): PMNode[] {
  const atoms: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === "raw_inline" && node.attrs.kind === "math_inline")
      atoms.push(node);
  });
  return atoms;
}

describe("Markdown core", () => {
  it("parses common rich Markdown into the shared PM schema", () => {
    const snapshot = parseMarkdown(
      "# Heading\n\nText **bold** *em* ~~strike~~ `code` [link](https://example.com).\n\n- [ ] todo\n- [x] done\n\n![picture](image.png)\n",
    );
    expect(snapshot.doc.child(0).type.name).toBe("heading");
    expect(
      snapshot.doc
        .child(1)
        .child(1)
        .marks.map((mark) => mark.type.name),
    ).toContain("strong");
    expect(snapshot.doc.child(2).child(0).attrs.checked).toBe(false);
    expect(snapshot.doc.child(2).child(1).attrs.checked).toBe(true);
    expect(snapshot.doc.child(3).child(0).attrs.alt).toBe("picture");
    expect(snapshot.doc.child(1).textContent).toContain("code");
  });

  it("preserves a complete source on a no-op, including CRLF", () => {
    const source = "# Heading\r\n\r\nfirst\r\n\r\nsecond\r\n";
    const snapshot = parseMarkdown(source);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
    expect(snapshot.lineEnding).toBe("crlf");
  });

  it.each([
    {
      name: "LF",
      source: "one\n\n\n\ntwo",
      ending: "\n",
    },
    {
      name: "CRLF",
      source: "one\r\n\r\n\r\n\r\ntwo",
      ending: "\r\n",
    },
  ])(
    "materializes source-authored blank lines for $name",
    ({ source, ending }) => {
      const snapshot = parseMarkdown(source);
      const children = childrenOf(snapshot.doc);

      expect(
        children.filter(
          (node) => node.type.name === "paragraph" && node.content.size === 0,
        ),
      ).toHaveLength(2);
      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
      expect(serializeMarkdown(snapshot.doc)).toBe(source);

      const serialized = serializeMarkdown(snapshot.doc, snapshot);
      expect(serialized).toBe(source);
      expect(serialized.match(new RegExp(ending, "g"))?.length).toBe(4);
      expect(reparseMarkdown(serialized, "github").doc.eq(snapshot.doc)).toBe(
        true,
      );
    },
  );

  it("roundtrips empty paragraphs authored by the Rich document", () => {
    const document = schema.topNodeType.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("one")),
      schema.nodes.paragraph!.create(),
      schema.nodes.paragraph!.create(),
      schema.nodes.paragraph!.create(null, schema.text("two")),
    ]);

    const serialized = serializeMarkdown(document);
    expect(serialized).toBe("one\n\n\n\ntwo");
    expect(reparseMarkdown(serialized).doc.eq(document)).toBe(true);
  });

  it("renders materialized empty paragraphs as one visible line", () => {
    expect(renderMarkdown("one\n\n\ntwo")).toContain(
      "<p>one</p>\n<p><br></p>\n<p>two</p>",
    );
  });

  it("keeps the empty source starter document to one paragraph", () => {
    const snapshot = parseMarkdown("");
    expect(snapshot.doc.childCount).toBe(1);
    expect(snapshot.doc.firstChild?.type.name).toBe("paragraph");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe("");
  });

  it("preserves a source-authored separator when a neighboring block changes", () => {
    const source = "one\n\n\n\ntwo";
    const snapshot = parseMarkdown(source);
    const changed = replaceTopLevel(
      snapshot,
      3,
      schema.nodes.paragraph!.create(null, schema.text("changed")),
    );

    const serialized = serializeMarkdown(changed, snapshot);
    expect(serialized).toBe("one\n\n\n\nchanged");
    expect(parseMarkdown(serialized).doc.eq(changed)).toBe(true);
  });

  it("preserves CRLF source-authored separators when a neighboring block changes", () => {
    const source = "one\r\n\r\n\r\n\r\ntwo";
    const snapshot = parseMarkdown(source);
    const changed = replaceTopLevel(
      snapshot,
      3,
      schema.nodes.paragraph!.create(null, schema.text("changed")),
    );

    const serialized = serializeMarkdown(changed, snapshot);
    expect(serialized).toBe("one\r\n\r\n\r\n\r\nchanged");
    expect(reparseMarkdown(serialized).doc.eq(changed)).toBe(true);
  });

  it.each([
    {
      name: "LF",
      source: "one\n\n \n\t\ntwo",
      first: " \n",
      second: "\t\n",
    },
    {
      name: "CRLF",
      source: "one\r\n\r\n \r\n\t\r\ntwo",
      first: " \r\n",
      second: "\t\r\n",
    },
    {
      name: "mixed line endings",
      source: "one\n\r\n \n\t\r\ntwo",
      first: " \n",
      second: "\t\r\n",
    },
  ])(
    "keeps distinct source slices for consecutive materialized blanks after editing the first ($name)",
    ({ source, second }) => {
      const snapshot = parseMarkdown(source);
      expect(childrenOf(snapshot.doc)[1]?.type.name).toBe("paragraph");
      expect(childrenOf(snapshot.doc)[2]?.type.name).toBe("paragraph");

      const edited = replaceTopLevel(
        snapshot,
        1,
        schema.nodes.paragraph!.create(null, schema.text("x")),
      );
      const serialized = serializeMarkdown(edited, snapshot);

      expect(serialized.match(new RegExp(second, "g"))?.length).toBe(1);
      expect(reparseMarkdown(serialized).doc.eq(edited)).toBe(true);
    },
  );

  it.each([
    {
      name: "LF",
      source: "one\n\n \n\t\ntwo",
      first: " \n",
      second: "\t\n",
    },
    {
      name: "CRLF",
      source: "one\r\n\r\n \r\n\t\r\ntwo",
      first: " \r\n",
      second: "\t\r\n",
    },
    {
      name: "mixed line endings",
      source: "one\n\r\n \n\t\r\ntwo",
      first: " \n",
      second: "\t\r\n",
    },
  ])(
    "keeps the second source slice when the first materialized blank is deleted ($name)",
    ({ source, first, second }) => {
      const snapshot = parseMarkdown(source);
      const edited = removeTopLevel(snapshot, 1);
      const serialized = serializeMarkdown(edited, snapshot);

      expect(serialized).toContain(second);
      expect(serialized).not.toContain(first);
      expect(reparseMarkdown(serialized).doc.eq(edited)).toBe(true);
    },
  );

  it.each([
    {
      name: "LF",
      source: "one\n\n \n\t\ntwo",
      first: " \n",
      second: "\t\n",
    },
    {
      name: "CRLF",
      source: "one\r\n\r\n \r\n\t\r\ntwo",
      first: " \r\n",
      second: "\t\r\n",
    },
    {
      name: "mixed line endings",
      source: "one\n\r\n \n\t\r\ntwo",
      first: " \n",
      second: "\t\r\n",
    },
  ])(
    "keeps distinct source slices when editing or deleting the second materialized blank ($name)",
    ({ source, first, second }) => {
      const snapshot = parseMarkdown(source);
      const edited = replaceTopLevel(
        snapshot,
        2,
        schema.nodes.paragraph!.create(null, schema.text("x")),
      );
      const editedSource = serializeMarkdown(edited, snapshot);
      expect(editedSource.match(new RegExp(first, "g"))?.length).toBe(1);
      expect(reparseMarkdown(editedSource).doc.eq(edited)).toBe(true);

      const deleted = removeTopLevel(snapshot, 2);
      const deletedSource = serializeMarkdown(deleted, snapshot);
      expect(deletedSource).toContain(first);
      expect(deletedSource).not.toContain(second);
      expect(reparseMarkdown(deletedSource).doc.eq(deleted)).toBe(true);
    },
  );

  it("keeps leading and trailing empty paragraphs editable", () => {
    const leading = parseMarkdown("\n\none");
    const leadingEdit = replaceTopLevel(
      leading,
      0,
      schema.nodes.paragraph!.create(null, schema.text("zero")),
    );
    expect(serializeMarkdown(leadingEdit, leading)).toBe("zero\n\n\none");
    expect(
      parseMarkdown(serializeMarkdown(leadingEdit, leading)).doc.eq(
        leadingEdit,
      ),
    ).toBe(true);

    const trailing = parseMarkdown("one\n\n\n");
    const trailingEdit = replaceTopLevel(
      trailing,
      2,
      schema.nodes.paragraph!.create(null, schema.text("two")),
    );
    expect(serializeMarkdown(trailingEdit, trailing)).toBe("one\n\n\ntwo");
    expect(
      parseMarkdown(serializeMarkdown(trailingEdit, trailing)).doc.eq(
        trailingEdit,
      ),
    ).toBe(true);
  });

  it.each(["\n\none", "one\n\n\n", "\n\none\n\n\ntwo\n\n"])(
    "preserves leading and trailing blank paragraph shape for %j",
    (source) => {
      const snapshot = parseMarkdown(source);
      const serialized = serializeMarkdown(snapshot.doc);

      expect(serialized).toBe(source);
      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
      expect(parseMarkdown(serialized).doc.eq(snapshot.doc)).toBe(true);
    },
  );

  it.each([
    ["\none", 1],
    ["\n\none", 2],
    ["\r\none", 1],
    ["\r\n\r\none", 2],
    ["\n", 1],
    ["\n\n", 2],
    ["\n\n\n", 3],
    ["\r\n", 1],
    ["\r\n\r\n", 2],
  ] as const)(
    "materializes %d leading or blank-only line endings in %j",
    (source, expectedEmptyParagraphs) => {
      const snapshot = parseMarkdown(source);
      const children = childrenOf(snapshot.doc);

      expect(
        children.filter(
          (node) => node.type.name === "paragraph" && node.content.size === 0,
        ),
      ).toHaveLength(expectedEmptyParagraphs);
      expect(serializeMarkdown(snapshot.doc)).toBe(source);
      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
      expect(reparseMarkdown(source).doc.eq(snapshot.doc)).toBe(true);
    },
  );

  it("bounds a huge blank run without changing its source-preserving slice", () => {
    const source = `one${"\n".repeat(100_000)}two`;
    const snapshot = parseMarkdown(source);
    const children = childrenOf(snapshot.doc);
    const emptyParagraphs = children.filter(
      (node) => node.type.name === "paragraph" && node.content.size === 0,
    );
    const spacers = children.filter(
      (node) =>
        node.type.name === "raw_block" && node.attrs.kind === "blank-spacer",
    );

    expect(emptyParagraphs).toHaveLength(MAX_MATERIALIZED_EMPTY_PARAGRAPHS);
    expect(spacers).toHaveLength(1);
    expect(snapshot.doc.childCount).toBe(MAX_MATERIALIZED_EMPTY_PARAGRAPHS + 3);
    expect(serializeMarkdown(snapshot.doc)).toBe(source);
    expect(
      reparseMarkdown(serializeMarkdown(snapshot.doc)).doc.eq(snapshot.doc),
    ).toBe(true);
    const changed = replaceTopLevel(
      snapshot,
      children.length - 1,
      schema.nodes.paragraph!.create(null, schema.text("changed")),
    );
    const changedSource = serializeMarkdown(changed, snapshot);
    expect(changedSource).toBe(source.replace(/two$/u, "changed"));
    expect(parseMarkdown(changedSource).doc.eq(changed)).toBe(true);
  });

  it.each([
    ["table", "| A |\n| --- |\n| one |\n\n\n\ntwo"],
    ["code", "```ts\none\n```\n\n\n\ntwo"],
    ["Alert", "> [!NOTE]\n> one\n\n\n\ntwo"],
    [
      "Details",
      "<details open>\n<summary>Info</summary>\n\nbody\n\n</details>\n\n\n\ntwo",
    ],
    ["list", "- one\n- two\n\n\n\ntwo"],
    ["heading", "# one\n\n\n\ntwo"],
  ] as const)(
    "uses the same blank separator rule after %s",
    (_name, source) => {
      const snapshot = parseMarkdown(source, "github");
      const emptyParagraphs = childrenOf(snapshot.doc).filter(
        (node) => node.type.name === "paragraph" && node.content.size === 0,
      );

      expect(emptyParagraphs).toHaveLength(2);
      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
      expect(
        reparseMarkdown(serializeMarkdown(snapshot.doc), "github").doc.eq(
          snapshot.doc,
        ),
      ).toBe(true);
    },
  );

  it("reuses untouched top-level blocks when a neighboring block changes", () => {
    const source = 'before\n\n<div data-x="1">raw</div>\n\n# after\n';
    const snapshot = parseMarkdown(source);
    const replacement = schema.nodes.heading!.create(
      { level: 1 },
      schema.text("changed"),
    );
    const document = replaceTopLevel(snapshot, 2, replacement);
    const serialized = serializeMarkdown(document, snapshot);
    expect(serialized).toContain('<div data-x="1">raw</div>');
    expect(serialized).toContain("# changed");
    expect(serialized).toMatch(
      /^before\n\n<div data-x="1">raw<\/div>\n\n# changed\n$/,
    );
  });

  it("keeps table dimensions and pipes in text and code spans", () => {
    const source = "| A | B |\n| --- | --- |\n| a\\|b | `x\\|y` |\n";
    const snapshot = parseMarkdown(source);
    const table = snapshot.doc.child(0);
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(2);
    expect(table.child(0).childCount).toBe(2);
    expect(table.child(1).child(1).textContent).toBe("x|y");
    const serialized = serializeMarkdown(snapshot.doc);
    expect(parseMarkdown(serialized).doc.eq(snapshot.doc)).toBe(true);
    expect(serialized).toContain("`x\\|y`");
  });

  it("maps only the safe br spelling to a table hard break", () => {
    const snapshot = parseMarkdown(
      "| A | B |\n| --- | --- |\n| a | left<br>right |\n",
    );
    const cell = snapshot.doc.child(0).child(1).child(1);
    expect(cell.child(0).child(1).type.name).toBe("hard_break");
    expect(
      parseMarkdown(serializeMarkdown(snapshot.doc)).doc.eq(snapshot.doc),
    ).toBe(true);
    const inlineDocument = parseMarkdown("a <span>unsafe</span>\n").doc;
    expect(inlineDocument.child(0).child(1).type.name).toBe("raw_inline");
    expect(inlineDocument.child(0).child(1).attrs.kind).toBe("html");
  });

  it("roundtrips nested marks and ordered-list continuation indentation", () => {
    for (const source of [
      "A **bold *and italic* end** text.\n",
      "A *em **strong** end*.\n",
      "9. one\n\n   paragraph\n10. two\n",
    ]) {
      const snapshot = parseMarkdown(source);
      const serialized = serializeMarkdown(snapshot.doc);
      expect(parseMarkdown(serialized).doc.eq(snapshot.doc)).toBe(true);
    }
  });

  it("keeps edited paragraph text that resembles block syntax as text", () => {
    const value = "# heading\n- list\n1) ordered\n---\n$$math";
    const document = schema.topNodeType.create(null, [
      schema.nodes.paragraph!.create(null, schema.text(value)),
    ]);
    const serialized = serializeMarkdown(document);
    expect(parseMarkdown(serialized).doc.eq(document)).toBe(true);
  });

  it.each([
    {
      label: "strong",
      source: "Before **[$x$](https://example.com)** After",
      regularMarks: ["strong"],
      title: null,
      expected: "Changed **[$x$](https://example.com)** After",
    },
    {
      label: "em",
      source: "Before *[$x$](https://example.com)* After",
      regularMarks: ["em"],
      title: null,
      expected: "Changed *[$x$](https://example.com)* After",
    },
    {
      label: "strike",
      source: "Before ~~[$x$](https://example.com)~~ After",
      regularMarks: ["strike"],
      title: null,
      expected: "Changed ~~[$x$](https://example.com)~~ After",
    },
    {
      label: "strong and em",
      source: "Before ***[$x$](https://example.com)*** After",
      regularMarks: ["strong", "em"],
      title: null,
      expected: "Changed ***[$x$](https://example.com)*** After",
    },
    {
      label: "strong and strike",
      source: "Before **~~[$x$](https://example.com)~~** After",
      regularMarks: ["strong", "strike"],
      title: null,
      expected: "Changed **~~[$x$](https://example.com)~~** After",
    },
    {
      label: "link title",
      source: 'Before **[$x$](https://example.com "Math")** After',
      regularMarks: ["strong"],
      title: "Math",
      expected: 'Changed **[$x$](https://example.com "Math")** After',
    },
  ] as const)(
    "retains $label around a single-child linked inline Math atom",
    ({ source, regularMarks, title, expected }) => {
      const snapshot = parseMarkdown(source);
      const edited = replaceText(snapshot.doc, "Before", "Changed");
      const serialized = serializeMarkdown(edited);
      const reparsed = parseMarkdown(serialized).doc;
      const [math] = mathAtoms(reparsed);

      expect(serialized).toBe(expected);
      expect(reparsed.eq(edited)).toBe(true);
      expect(math).toBeDefined();
      expect(math!.attrs.source).toBe("$x$");
      expect(math!.marks.map((mark) => mark.type.name).sort()).toEqual(
        [...regularMarks, "link"].sort(),
      );
      const link = math!.marks.find((mark) => mark.type.name === "link")!;
      expect(link.attrs.href).toBe("https://example.com");
      expect(link.attrs.title).toBe(title);
    },
  );

  it("retains both linked Math atoms and their destinations after a generic edit", () => {
    const source =
      "Before **[$x$](https://a.example)** middle **[$x$](https://b.example)** After";
    const snapshot = parseMarkdown(source);
    const edited = replaceText(snapshot.doc, "Before", "Changed");
    const serialized = serializeMarkdown(edited);
    const reparsed = parseMarkdown(serialized).doc;
    const atoms = mathAtoms(reparsed);

    expect(reparsed.eq(edited)).toBe(true);
    expect(atoms).toHaveLength(2);
    expect(
      atoms.map(
        (node) =>
          node.marks.find((mark) => mark.type.name === "link")?.attrs.href,
      ),
    ).toEqual(["https://a.example", "https://b.example"]);
    expect(
      atoms.every((node) =>
        node.marks.some((mark) => mark.type.name === "strong"),
      ),
    ).toBe(true);
  });

  it.each([
    "**Before [$x$](https://example.com) After**",
    "[Before **$x$** After](https://example.com)",
    "[Before $x$ After](https://example.com)",
  ])("retains surrounding marks and links for %s", (source) => {
    const snapshot = parseMarkdown(source);
    const edited = replaceText(snapshot.doc, "Before", "Changed");
    const serialized = serializeMarkdown(edited);

    expect(parseMarkdown(serialized).doc.eq(edited)).toBe(true);
  });

  it("uses the original source slice when only linked inline Math changes", () => {
    const source = "Before **[$x$](https://example.com)** After";
    const snapshot = parseMarkdown(source);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    let position = -1;
    state.doc.descendants((node, currentPosition) => {
      if (position < 0 && node.type.name === "raw_inline")
        position = currentPosition;
    });
    const math = state.doc.nodeAt(position)!;
    const transaction = state.tr.setNodeMarkup(position, undefined, {
      ...math.attrs,
      source: "$y$",
    });

    expect(serializeMarkdown(transaction.doc, snapshot)).toBe(
      "Before **[$y$](https://example.com)** After",
    );
  });

  it.each([
    "Before **[![alt](https://image.example/image.png)](https://example.com)** After",
    "Before **[one<br>two](https://example.com)** After",
  ])("audits linked non-text inline nodes for %s", (source) => {
    const snapshot = parseMarkdown(source);
    const edited = replaceText(snapshot.doc, "Before", "Changed");
    const serialized = serializeMarkdown(edited);

    expect(parseMarkdown(serialized).doc.eq(edited)).toBe(true);
  });

  it("renders raw HTML and unsafe destinations as inert output", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script>\n\n[x](javascript:alert(1))\n",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(
      inspectCompatibility("[x](javascript:alert(1))\n").some(
        (entry) => entry.code === "unsafe-url",
      ),
    ).toBe(true);
  });

  it("keeps frontmatter and protected fences as source atoms", () => {
    const source =
      "---\ntitle: test\n---\n\n```mermaid\ngraph TD\n```\n\n# Heading\n";
    const snapshot = parseMarkdown(source);
    expect(snapshot.doc.child(0).type.name).toBe("raw_block");
    expect(snapshot.doc.child(0).attrs.kind).toBe("frontmatter");
    expect(snapshot.doc.child(1).attrs.kind).toBe("protected-fence");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("keeps fenced and nested details content through rendering", () => {
    const fencedSource =
      "<details>\n<summary>Example</summary>\n\n```html\n</details>\n```\n\n" +
      "After the fence\n</details>\n";
    const fencedSnapshot = parseMarkdown(fencedSource, "github");

    expect(fencedSnapshot.doc.childCount).toBe(1);
    expect(fencedSnapshot.doc.firstChild?.attrs.kind).toBe("details");
    expect(fencedSnapshot.doc.firstChild?.attrs.source).toBe(fencedSource);
    expect(serializeMarkdown(fencedSnapshot.doc, fencedSnapshot)).toBe(
      fencedSource,
    );
    const fencedHtml = renderMarkdown(fencedSource, "github");
    expect(fencedHtml).toContain("After the fence");
    expect(fencedHtml).toContain("&lt;/");

    const nestedSource =
      "<details>\n<summary>Outer</summary>\n\nOuter before\n\n" +
      "<details>\n<summary>Inner</summary>\n\nInner body\n</details>\n\n" +
      "Outer after\n</details>\n";
    const nestedSnapshot = parseMarkdown(nestedSource, "github");

    expect(nestedSnapshot.doc.childCount).toBe(1);
    expect(nestedSnapshot.doc.firstChild?.attrs.kind).toBe("details");
    expect(serializeMarkdown(nestedSnapshot.doc, nestedSnapshot)).toBe(
      nestedSource,
    );
    const nestedHtml = renderMarkdown(nestedSource, "github");
    expect(nestedHtml).toContain("Outer before");
    expect(nestedHtml).toContain("Inner body");
    expect(nestedHtml).toContain("Outer after");
  });

  it("preserves lazy alert continuations, quoted blanks, separators, and CRLF", () => {
    const cases = [
      {
        source: "> [!TIP]\n> First\ncontinued\n> Last",
        body: "First\ncontinued\nLast",
        lineEnding: "\n",
      },
      {
        source: "> [!TIP]\n> First\n>\n> Last\n\nNext",
        body: "First\n\nLast",
        lineEnding: "\n",
      },
      {
        source: "> [!TIP]\n> First\n\nNext",
        body: "First",
        lineEnding: "\n",
      },
      {
        source: "> [!TIP]\r\n> First\r\ncontinued\r\n> Last\r\n\r\nNext",
        body: "First\ncontinued\nLast",
        lineEnding: "\r\n",
      },
    ] as const;

    for (const testCase of cases) {
      const snapshot = parseMarkdown(testCase.source, "github");
      const alert = snapshot.doc.firstChild!;
      expect(alert.type.name).toBe("raw_block");
      expect(alert.attrs.kind).toBe("alert");
      const parts = alertSourceParts(String(alert.attrs.source));
      expect(parts.body).toBe(testCase.body);

      const editedSource = alertSourceWithBody(
        String(alert.attrs.source),
        `${testCase.body}\nEdited`,
      );
      const edited = alert.type.create({
        ...alert.attrs,
        source: editedSource,
      });
      const serialized = serializeMarkdown(
        replaceTopLevel(snapshot, 0, edited),
        snapshot,
      );
      expect(serialized).toContain("Edited");
      if (testCase.source.includes("Next"))
        expect(serialized).toContain("Next");
      expect(serialized).toContain(testCase.lineEnding);
      if (testCase.lineEnding === "\r\n")
        expect(serialized).not.toMatch(/(?<!\r)\n/);
      expect(renderMarkdown(serialized, "github")).toContain("Edited");
    }
  });

  it("changes only the alert marker when the type changes", () => {
    const source = "> [!TIP]\r\n> First\r\ncontinued\r\n> Last\r\n";
    expect(alertSourceWithType(source, "WARNING")).toBe(
      "> [!WARNING]\r\n> First\r\ncontinued\r\n> Last\r\n",
    );
  });

  it("keeps display math together when a line resembles a Setext underline", () => {
    const source =
      "$$\n\\sum_{n=1}^{100}\n\\frac{1}{n^2}\n=\n\\frac{\\pi^2}{6}\n$$\n";
    const snapshot = parseMarkdown(source, "github");

    expect(snapshot.doc.childCount).toBe(1);
    expect(snapshot.doc.firstChild?.type.name).toBe("raw_block");
    expect(snapshot.doc.firstChild?.attrs.kind).toBe("math-block");
    expect(snapshot.doc.firstChild?.attrs.source).toBe(source);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
    expect(renderMarkdown(source, "github")).toContain(
      'class="mm-math mm-math-block"',
    );
  });

  it("parses the complete multiline display and matrix stress cases", () => {
    const source = `## 14. Math Stress Test

Inline: $E = mc^2$

Inline complex:

$\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$

Block:

$$
\\sum_{n=1}^{100}
\\frac{1}{n^2}
=
\\frac{\\pi^2}{6}
$$

Matrix:

$$
A =
\\begin{bmatrix}
1 & 2 & 3 \\\\
4 & 5 & 6 \\\\
7 & 8 & 9
\\end{bmatrix}
$$
`;
    const snapshot = parseMarkdown(source, "github");
    const blocks = childrenOf(snapshot.doc).filter(
      (node) => node.attrs.kind === "math-block",
    );
    const headings = childrenOf(snapshot.doc).filter(
      (node) => node.type.name === "heading",
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.attrs.source).toContain("\n=\n");
    expect(blocks[1]?.attrs.source).toContain("\\begin{bmatrix}");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.attrs.level).toBe(2);
    const html = renderMarkdown(source, "github");
    expect(html.match(/katex-display/g) ?? []).toHaveLength(2);
    expect(html).toContain("mtable");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("keeps adjacent display math, following prose, and Setext headings distinct", () => {
    const source = "Title\n-----\n\n$$\na^2\n$$\n$$\nb^2\n$$\n\nAfter\n";
    const snapshot = parseMarkdown(source, "github");
    const children = childrenOf(snapshot.doc);
    expect(children.map((node) => node.type.name)).toEqual([
      "heading",
      "raw_block",
      "raw_block",
      "paragraph",
    ]);
    expect(children[0]?.attrs.level).toBe(2);
    expect(children[1]?.attrs.kind).toBe("math-block");
    expect(children[2]?.attrs.kind).toBe("math-block");
    expect(children[3]?.textContent).toBe("After");
  });

  it("preserves TeX escapes and excludes code or currency dollars", () => {
    const source =
      "`$code$` \\$5 and $x$ and $\\{x \\mid x > 0\\}$\n\n```markdown\n$x$\n$$\nnot math\n$$\n```\n";
    const snapshot = parseMarkdown(source, "github");
    const paragraph = snapshot.doc.firstChild!;
    const inlineMath = childrenOf(paragraph).filter(
      (node) => node.attrs.kind === "math_inline",
    );
    expect(inlineMath.map((node) => node.attrs.source)).toEqual([
      "$x$",
      "$\\{x \\mid x > 0\\}$",
    ]);
    expect(paragraph.textContent).toContain("$code$");
    expect(snapshot.doc.child(1).type.name).toBe("code_block");
    expect(snapshot.doc.child(1).textContent).toContain("$$");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("does not let an unclosed delimiter hide later Markdown", () => {
    const source = "$$\nunclosed\n\n# Next heading\n\nVisible paragraph\n";
    const snapshot = parseMarkdown(source, "github");
    const children = childrenOf(snapshot.doc);
    expect(children.some((node) => node.attrs.kind === "math-block")).toBe(
      false,
    );
    expect(children.some((node) => node.type.name === "heading")).toBe(true);
    expect(snapshot.doc.textContent).toContain("Visible paragraph");
  });

  it("keeps existing math fences available in every Markdown profile", () => {
    for (const profile of ["github", "gitlab", "commonmark"] as const) {
      const snapshot = parseMarkdown("```math\nx^2\n```\n", profile);
      expect(snapshot.doc.childCount).toBe(1);
      expect(snapshot.doc.firstChild?.type.name).toBe("raw_block");
      expect(snapshot.doc.firstChild?.attrs.kind).toBe("math-block");
      expect(renderMarkdown("```math\nx^2\n```\n", profile)).toContain(
        "katex-display",
      );
    }
  });

  it("keeps nested quote, list, table, and details parsing unchanged", () => {
    const source =
      "> $$\n> quoted\n> $$\n\n- $$\n  listed\n  $$\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<details>\n\n$$\ninside\n$$\n\n</details>\n";
    const snapshot = parseMarkdown(source, "github");
    const children = childrenOf(snapshot.doc);
    expect(children[0]?.type.name).toBe("blockquote");
    expect(children[0]?.textContent).toContain("$$");
    expect(children[1]?.type.name).toBe("bullet_list");
    expect(children[1]?.textContent).toContain("$$");
    expect(children[2]?.type.name).toBe("table");
    expect(children[3]?.attrs.kind).toBe("details");
    expect(renderMarkdown(source, "github")).toContain("inside");
  });

  it("preserves lazy alert continuations, quoted blanks, separators, and CRLF", () => {
    const source =
      "> [!TIP]\r\n> First\r\ncontinued\r\n> Last\r\n>\r\n> After blank\r\n\r\nNext\r\n";
    const snapshot = parseMarkdown(source, "github");
    const alert = snapshot.doc.firstChild!;
    expect(alert.type.name).toBe("raw_block");
    expect(alert.attrs.kind).toBe("alert");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);

    const html = renderMarkdown(source, "github");
    const alertStart = html.indexOf('<div class="markdown-alert');
    const alertEnd = html.indexOf("</div>", alertStart) + "</div>".length;
    const alertHtml = html.slice(alertStart, alertEnd);
    expect(alertHtml).toContain("First");
    expect(alertHtml).toContain("continued");
    expect(alertHtml).toContain("Last");
    expect(alertHtml).toContain("After blank");
    expect(alertHtml).not.toContain("Next");

    const changedAlert = schema.nodes.raw_block!.create({
      ...alert.attrs,
      source: String(alert.attrs.source).replace("continued", "Changed"),
    });
    const changed = replaceTopLevel(snapshot, 0, changedAlert);
    expect(serializeMarkdown(changed, snapshot)).toBe(
      source.replace("continued", "Changed"),
    );
  });

  it("keeps an unquoted blank outside an alert body", () => {
    const source = "> [!NOTE]\n> body\n\nParagraph after\n";
    const snapshot = parseMarkdown(source, "github");
    expect(snapshot.doc.childCount).toBe(2);
    expect(snapshot.doc.child(0).attrs.kind).toBe("alert");
    expect(snapshot.doc.child(1).textContent).toBe("Paragraph after");
    const html = renderMarkdown(source, "github");
    const alertEnd = html.indexOf("</div>") + "</div>".length;
    expect(html.slice(0, alertEnd)).not.toContain("Paragraph after");
  });

  it("preserves inline math before Markdown-it can reinterpret its contents", () => {
    const source =
      "Inline $a * b$ and escaped $x\\$y$; code `$z$`; unclosed $nope.\n";
    const snapshot = parseMarkdown(source, "github");
    const paragraph = snapshot.doc.firstChild!;
    const math = childrenOf(paragraph).filter(
      (node) =>
        node.type.name === "raw_inline" && node.attrs.kind === "math_inline",
    );

    expect(math.map((node) => node.attrs.source)).toEqual([
      "$a * b$",
      "$x\\$y$",
    ]);
    expect(
      childrenOf(paragraph).some(
        (node) => node.type.name === "text" && node.textContent.includes("$z$"),
      ),
    ).toBe(true);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("does not recognize an unmatched display delimiter or code math as math", () => {
    const source = "$$\nunclosed\n\n```markdown\n$x$\n```\n";
    const snapshot = parseMarkdown(source, "github");
    const nodes: PMNode[] = [];
    snapshot.doc.forEach((node) => nodes.push(node));

    expect(nodes[0]?.type.name).not.toBe("raw_block");
    expect(nodes[0]?.type.name).toBe("paragraph");
    expect(nodes[1]?.type.name).toBe("code_block");
    expect(nodes[1]?.textContent).toBe("$x$");
    expect(nodes.some((node) => node.attrs.kind === "math-block")).toBe(false);
  });

  it("keeps terminal line endings on raw atoms in canonical serialization", () => {
    for (const source of [
      "<div>raw</div>\n",
      "<div>raw</div>\r\n",
      "```mermaid\ngraph TD\n```\n",
      "$$\nmath\n$$\n",
    ]) {
      const snapshot = parseMarkdown(source);
      const serialized = serializeMarkdown(snapshot.doc);
      expect(parseMarkdown(serialized).doc.eq(snapshot.doc)).toBe(true);
    }
  });

  it("normalizes code block terminators without losing trailing blank lines", () => {
    const cases = [
      ["```\n\n```\n", "", "```\n\n```"],
      ["```js\na\n\n```\n", "a\n", "```js\na\n\n```"],
      ["~~~\na\n\n~~~\n", "a\n", "```\na\n\n```"],
      ["    a\n\n    b\n", "a\n\nb", "```\na\n\nb\n```"],
    ] as const;
    for (const [source, expectedText, expectedMarkdown] of cases) {
      const snapshot = parseMarkdown(source);
      expect(snapshot.doc.child(0).type.name).toBe("code_block");
      expect(snapshot.doc.child(0).textContent).toBe(expectedText);
      const serialized = serializeMarkdown(snapshot.doc);
      expect(serialized).toBe(expectedMarkdown);
      expect(parseMarkdown(serialized).doc.child(0).textContent).toBe(
        expectedText,
      );
    }
  });

  it("serializes copied code with preserved info and a safe fence", () => {
    const source = "line with ```\n\nfinal";
    expect(serializeCodeBlockMarkdown(source, 'ts title="example.ts"')).toBe(
      '````ts title="example.ts"\nline with ```\n\nfinal\n````',
    );
    expect(serializeCodeBlockMarkdown("a\r\nb", "ts")).toBe(
      "```ts\r\na\r\nb\r\n```",
    );
  });

  it("edits an empty fenced block while preserving surrounding Markdown", () => {
    const source = "before\n\n```\n\n```\n\nafter\n";
    const snapshot = parseMarkdown(source);
    const code = schema.nodes.code_block!.create(
      { params: "" },
      schema.text("edited\n"),
    );
    const children: PMNode[] = [];
    snapshot.doc.forEach((child) => children.push(child));
    children[1] = code;
    const serialized = serializeMarkdown(
      schema.topNodeType.create(null, children),
      snapshot,
    );
    expect(serialized).toBe("before\n\n```\nedited\n\n```\n\nafter\n");
    expect(parseMarkdown(serialized).doc.child(0).textContent).toBe("before");
    expect(parseMarkdown(serialized).doc.child(1).textContent).toBe("edited\n");
    expect(parseMarkdown(serialized).doc.child(2).textContent).toBe("after");
  });

  it("formats with the Markdown Prettier plugin while preserving PM semantics", async () => {
    const formatted = await formatMarkdown(
      "# title\n\nA paragraph with enough words to wrap.\n",
      {
        printWidth: 24,
        proseWrap: "always",
      },
    );
    expect(formatted).toContain("# title");
    expect(
      parseMarkdown(formatted).doc.child(1).textContent.replace(/\s+/g, " "),
    ).toContain("A paragraph with enough words to wrap.");
    expect(
      await formatMarkdown(formatted, { printWidth: 24, proseWrap: "always" }),
    ).toBe(formatted);
    await expect(
      formatMarkdown("[bad](javascript:alert(1))\n"),
    ).rejects.toThrow(/formatting was skipped/i);
  });

  it("leaves blank-line normalization to explicit formatting", async () => {
    const source = "one\n\n\n\ntwo";
    const snapshot = parseMarkdown(source);

    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
    const formatted = await formatMarkdown(source);
    expect(formatted).not.toMatch(/\n{3,}/u);
    expect(parseMarkdown(formatted).doc.childCount).toBe(2);
  });

  it("handles a long document with linear source matching", () => {
    const paragraphs = Array.from(
      { length: 5000 },
      (_, index) => `paragraph ${index}`,
    ).join("\n\n");
    const source = `${paragraphs}\n`;
    const snapshot = parseMarkdown(source);
    const children: PMNode[] = [];
    snapshot.doc.forEach((child) => children.push(child));
    children[2500] = schema.nodes.paragraph!.create(
      null,
      schema.text("changed"),
    );
    const serialized = serializeMarkdown(
      schema.topNodeType.create(null, children),
      snapshot,
    );
    expect(serialized).toContain("changed");
    expect(serialized).toContain("paragraph 4999");
  });

  it("preserves reference definitions when a block carrying their separator is removed", () => {
    for (const [source, expected] of [
      [
        "First\n\n[id]: https://example.org\n\nA [link][id].\n",
        "[id]: https://example.org\n\nA [link][id].\n",
      ],
      [
        "First\r\n\r\n[id]: https://example.org\r\n\r\nA [link][id].\r\n",
        "[id]: https://example.org\r\n\r\nA [link][id].\r\n",
      ],
    ] as const) {
      const snapshot = parseMarkdown(source);
      const remaining: PMNode[] = [];
      snapshot.doc.forEach((child) => remaining.push(child));
      const changed = schema.topNodeType.create(null, remaining.slice(1));
      const serialized = serializeMarkdown(changed, snapshot);
      expect(serialized).toBe(expected);
      expect(parseMarkdown(serialized).doc.eq(changed)).toBe(true);
    }
  });

  it("keeps duplicate block source slices valid when blocks are moved", () => {
    const snapshot = parseMarkdown("A\n\nB\n\nA\n");
    const original: PMNode[] = [];
    snapshot.doc.forEach((child) => original.push(child));
    const moved = schema.topNodeType.create(null, [
      original[2]!,
      original[0]!,
      original[1]!,
    ]);
    const serialized = serializeMarkdown(moved, snapshot);
    expect(serialized).toBe("A\n\nA\n\nB\n");
    expect(parseMarkdown(serialized).doc.eq(moved)).toBe(true);
  });

  it("bounds user supplied link and image destinations", () => {
    const link = schema.marks.link!.create({
      href: "https://example.org/a path/(part)|pipe\nnext",
    });
    const paragraph = schema.nodes.paragraph!.create(
      null,
      schema.text("link", [link]),
    );
    const image = schema.nodes.image!.create({
      src: "https://example.org/image path/(part)|pipe\nnext",
      alt: "picture",
      title: null,
    });
    const document = schema.topNodeType.create(null, [
      paragraph,
      schema.nodes.paragraph!.create(null, image),
    ]);
    const serialized = serializeMarkdown(document);
    expect(serialized).not.toMatch(/\]\([^)]*\r?\n/);
    expect(serialized).toContain(
      "<https://example.org/a path/(part)|pipe next>",
    );
    expect(serialized).toContain(
      "<https://example.org/image path/(part)|pipe next>",
    );
    expect(
      parseMarkdown(serialized).doc.child(0).child(0).marks[0]?.type.name,
    ).toBe("link");
    expect(parseMarkdown(serialized).doc.child(1).child(0).type.name).toBe(
      "image",
    );
  });

  it("roundtrips table alignment through ProseMirror DOM serialization", () => {
    const cell = schema.nodes.table_cell!.create(
      { colspan: 1, rowspan: 1, colwidth: null, alignment: "center" },
      schema.nodes.paragraph!.create(null, schema.text("value")),
    );
    const dom = DOMSerializer.fromSchema(schema).serializeNode(
      cell,
    ) as HTMLElement;
    expect(dom.style.textAlign).toBe("center");
    expect(dom.outerHTML).toContain("text-align: center");
  });

  it("does not put unsafe link or image URLs into the live editor DOM", () => {
    const link = schema.marks.link!.create({ href: "javascript:alert(1)" });
    const paragraph = schema.nodes.paragraph!.create(
      null,
      schema.text("open", [link]),
    );
    const image = schema.nodes.image!.create({
      src: "data:text/html,<script>alert(1)</script>",
      alt: "fallback",
      title: null,
    });
    const pmDocument = schema.topNodeType.create(null, [
      paragraph,
      schema.nodes.paragraph!.create(null, image),
    ]);
    const dom = globalThis.document.createElement("div");
    dom.appendChild(
      DOMSerializer.fromSchema(schema).serializeFragment(pmDocument.content),
    );
    expect(dom.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(dom.querySelector("img")?.hasAttribute("src")).toBe(false);
  });
});
