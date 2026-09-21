import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import {
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
  type Profile,
} from "../../src/core/index";
import type { Node as PMNode } from "prosemirror-model";

function paragraph(...children: PMNode[]) {
  return schema.nodes.paragraph!.create(null, children);
}

function documentWithParagraph(...children: PMNode[]): PMNode {
  return schema.topNodeType.create(null, [paragraph(...children)]);
}

function replaceText(
  document: PMNode,
  value: string,
  replacement: string,
): PMNode {
  let from = -1;
  let marks: PMNode["marks"] = [];
  document.descendants((node, position) => {
    if (!node.isText || from >= 0 || !node.text?.includes(value)) return;
    from = position + node.text.indexOf(value);
    marks = node.marks;
  });
  if (from < 0) throw new Error(`Text not found: ${value}`);
  return EditorState.create({ schema, doc: document }).tr.replaceWith(
    from,
    from + value.length,
    schema.text(replacement, marks),
  ).doc;
}

function expectExactRoundTrip(
  document: PMNode,
  expectedSource: string,
  profile: Profile = "commonmark",
): void {
  const serialized = serializeMarkdown(document);
  expect(serialized).toBe(expectedSource);
  expect(parseMarkdown(serialized, profile).doc.eq(document)).toBe(true);
}

function expectNormalizedRoundTrip(
  document: PMNode,
  expectedSource: string,
  expectedDocument: PMNode,
  profile: Profile = "commonmark",
): void {
  const serialized = serializeMarkdown(document);
  expect(serialized).toBe(expectedSource);
  expect(parseMarkdown(serialized, profile).doc.eq(expectedDocument)).toBe(
    true,
  );
}

function expectHtmlMarkFallback(
  document: PMNode,
  expectedSource: string,
  expectedHtml: string,
  profile: Profile,
): void {
  const serialized = serializeMarkdown(document);
  expect(serialized).toBe(expectedSource);

  // Check the generated fallback with a separate CommonMark parser as well as
  // Markdown Mint's profile parser. The PM representation is an HTML source
  // atom for this intentionally unrepresentable delimiter boundary, so the
  // rendered mark is the semantic round-trip contract here.
  const commonmarkHtml = new MarkdownIt("commonmark", { html: true }).render(
    serialized,
  );
  expect(commonmarkHtml).toContain(expectedHtml);
  expect(renderMarkdown(serialized, profile)).toContain(expectedHtml);
}

describe("inline mark serialization", () => {
  it("keeps strong and code content, including boundary whitespace", () => {
    const strong = schema.marks.strong!.create();
    const code = schema.marks.code!.create();
    const whitespaceDocument = documentWithParagraph(
      schema.text("Before "),
      schema.text(" a ", [strong, code]),
      schema.text(" after."),
    );
    const whitespaceSource = "Before **`  a  `** after\\.";
    expectExactRoundTrip(whitespaceDocument, whitespaceSource);
    const whitespaceReparsed = parseMarkdown(whitespaceSource).doc.firstChild!;
    expect(whitespaceReparsed.child(1).text).toBe(" a ");
    expect(
      whitespaceReparsed.child(1).marks.map((mark) => mark.type.name),
    ).toEqual(["strong", "code"]);

    const document = documentWithParagraph(
      schema.text("Before "),
      schema.text("  a`b  ", [strong, code]),
      schema.text(" after."),
    );
    const expectedSource = "Before **``   a`b   ``** after\\.";

    expectExactRoundTrip(document, expectedSource);
    const reparsed = parseMarkdown(expectedSource).doc.firstChild!;
    expect(reparsed.child(1).text).toBe("  a`b  ");
    expect(reparsed.child(1).marks.map((mark) => mark.type.name)).toEqual([
      "strong",
      "code",
    ]);
  });

  it.each(["commonmark", "github", "gitlab"] as const)(
    "keeps strong emphasis around Japanese punctuation parseable for %s",
    (profile) => {
      expectHtmlMarkFallback(
        documentWithParagraph(
          schema.text("これは"),
          schema.text("「重要」", [schema.marks.strong!.create()]),
          schema.text("です"),
        ),
        "これは<strong>「重要」</strong>です",
        "<strong>「重要」</strong>",
        profile,
      );
    },
  );

  it("keeps trailing whitespace outside strong emphasis", () => {
    const strong = schema.marks.strong!.create();
    expectNormalizedRoundTrip(
      documentWithParagraph(schema.text("foo ", [strong]), schema.text("bar")),
      "**foo** bar",
      documentWithParagraph(schema.text("foo", [strong]), schema.text(" bar")),
    );
  });

  it("uses a safe fallback for emphasis with Japanese punctuation", () => {
    expectHtmlMarkFallback(
      documentWithParagraph(
        schema.text("a"),
        schema.text("「重要」", [schema.marks.em!.create()]),
        schema.text("b"),
      ),
      "a<em>「重要」</em>b",
      "<em>「重要」</em>",
      "commonmark",
    );
  });

  it("uses nested safe fallbacks for strong and emphasis", () => {
    expectHtmlMarkFallback(
      documentWithParagraph(
        schema.text("a"),
        schema.text("「重要」", [
          schema.marks.strong!.create(),
          schema.marks.em!.create(),
        ]),
        schema.text("b"),
      ),
      "a<em><strong>「重要」</strong></em>b",
      "<em><strong>「重要」</strong></em>",
      "commonmark",
    );
  });

  it("uses a safe fallback for parentheses at a mark boundary", () => {
    expectHtmlMarkFallback(
      documentWithParagraph(
        schema.text("a"),
        schema.text("(重要)", [schema.marks.strong!.create()]),
        schema.text("b"),
      ),
      "a<strong>\\(重要\\)</strong>b",
      "<strong>(重要)</strong>",
      "commonmark",
    );
  });

  it("uses a safe fallback for strikethrough with Japanese punctuation", () => {
    expectHtmlMarkFallback(
      documentWithParagraph(
        schema.text("a"),
        schema.text("「重要」", [schema.marks.strike!.create()]),
        schema.text("b"),
      ),
      "a<del>「重要」</del>b",
      "<del>「重要」</del>",
      "github",
    );
  });

  it("uses a valid fallback for a mark containing punctuation only", () => {
    expectHtmlMarkFallback(
      documentWithParagraph(
        schema.text("a"),
        schema.text("「」", [schema.marks.strong!.create()]),
        schema.text("b"),
      ),
      "a<strong>「」</strong>b",
      "<strong>「」</strong>",
      "commonmark",
    );
  });

  it("keeps leading and trailing whitespace outside strong emphasis", () => {
    const strong = schema.marks.strong!.create();
    expectNormalizedRoundTrip(
      documentWithParagraph(
        schema.text("a"),
        schema.text(" foo ", [strong]),
        schema.text("b"),
      ),
      "a **foo** b",
      documentWithParagraph(
        schema.text("a "),
        schema.text("foo", [strong]),
        schema.text(" b"),
      ),
    );
  });

  it("keeps a newly opened mark after a newline parseable", () => {
    const strong = schema.marks.strong!.create();
    expectNormalizedRoundTrip(
      documentWithParagraph(
        schema.text("a"),
        schema.text("foo\n", [strong]),
        schema.text("bar"),
      ),
      "a**foo**\nbar",
      documentWithParagraph(
        schema.text("a"),
        schema.text("foo", [strong]),
        schema.text("\nbar"),
      ),
    );
  });

  it("keeps an ASCII text mark between alphanumerics exact", () => {
    expectExactRoundTrip(
      documentWithParagraph(
        schema.text("a"),
        schema.text("important", [schema.marks.strong!.create()]),
        schema.text("b"),
      ),
      "a**important**b",
    );
  });

  it("keeps punctuation marks with whitespace context exact", () => {
    expectExactRoundTrip(
      documentWithParagraph(
        schema.text("a "),
        schema.text("「重要」", [schema.marks.strong!.create()]),
        schema.text(" b"),
      ),
      "a **「重要」** b",
    );
  });

  it("moves unsafe surrounding marks inside a link label", () => {
    const link = schema.marks.link!.create({ href: "https://example.com" });

    expectExactRoundTrip(
      documentWithParagraph(
        schema.text("a"),
        schema.text("「重要」", [schema.marks.strong!.create(), link]),
        schema.text("b"),
      ),
      "a[**「重要」**](https://example.com)b",
    );
  });

  it("keeps code with an unsafe delimiter boundary rendered and intact", () => {
    const strong = schema.marks.strong!.create();
    const code = schema.marks.code!.create();
    expectHtmlMarkFallback(
      documentWithParagraph(
        schema.text("a"),
        schema.text("  a`b  ", [strong, code]),
        schema.text("b"),
      ),
      "a<strong><code>  a\\`b  </code></strong>b",
      "<strong><code>  a`b  </code></strong>",
      "commonmark",
    );
  });

  it.each(["commonmark", "github", "gitlab"] as const)(
    "re-escapes literal syntax when grouping fallback HTML pairs for %s",
    (profile) => {
      const pair = String.raw`<strong>「\*重要\*」 \&copy; \_literal\_ \\\.</strong>`;
      const document = documentWithParagraph(
        schema.text("a"),
        schema.text(String.raw`「*重要*」 &copy; _literal_ \.`, [
          schema.marks.strong!.create(),
        ]),
        schema.text("b"),
      );

      const serialized = serializeMarkdown(document);
      expect(serialized).toBe(`a${pair}b`);
      const reparsed = parseMarkdown(serialized, profile).doc;
      expect(reparsed.firstChild!.child(1).attrs.source).toBe(pair);

      const expectedHtml = String.raw`<strong>「*重要*」 &amp;copy; _literal_ \.</strong>`;
      expect(
        new MarkdownIt("commonmark", { html: true }).render(serialized),
      ).toContain(expectedHtml);
      expect(renderMarkdown(serialized, profile)).toContain(expectedHtml);
      expect(renderMarkdown(serialized, profile)).not.toContain("<em>");
    },
  );

  it.each(["commonmark", "github", "gitlab"] as const)(
    "preserves a literal backslash and asterisk in a code fallback for %s",
    (profile) => {
      const pair = String.raw`<strong><code>\\\*</code></strong>`;
      const document = documentWithParagraph(
        schema.text("a"),
        schema.text(String.raw`\*`, [
          schema.marks.strong!.create(),
          schema.marks.code!.create(),
        ]),
        schema.text("b"),
      );

      const serialized = serializeMarkdown(document);
      expect(serialized).toBe(`a${pair}b`);
      const reparsed = parseMarkdown(serialized, profile).doc;
      expect(reparsed.firstChild!.child(1).attrs.source).toBe(pair);

      const expectedHtml = String.raw`<strong><code>\*</code></strong>`;
      expect(
        new MarkdownIt("commonmark", { html: true }).render(serialized),
      ).toContain(expectedHtml);
      expect(renderMarkdown(serialized, profile)).toContain(expectedHtml);
      expect(renderMarkdown(serialized, profile)).not.toContain("<em>");
    },
  );

  it("keeps marks adjacent to images parseable", () => {
    const image = schema.nodes.image!.create({
      src: "image.png",
      alt: "picture",
      title: null,
      width: null,
      height: null,
    });

    expectExactRoundTrip(
      documentWithParagraph(
        schema.text("a"),
        schema.text("important", [schema.marks.strong!.create()]),
        image,
        schema.text("b"),
      ),
      "a**important**![picture](image.png)b",
    );
  });

  it.each(["commonmark", "github", "gitlab"] as const)(
    "keeps a punctuation mark in a table cell rendered for %s",
    (profile) => {
      const cellAttrs = {
        colspan: 1,
        rowspan: 1,
        colwidth: null,
        alignment: null,
      };
      const table = schema.nodes.table!.create(null, [
        schema.nodes.table_row!.create(null, [
          schema.nodes.table_header!.create(
            cellAttrs,
            paragraph(schema.text("A")),
          ),
          schema.nodes.table_header!.create(
            cellAttrs,
            paragraph(schema.text("B")),
          ),
        ]),
        schema.nodes.table_row!.create(null, [
          schema.nodes.table_cell!.create(
            cellAttrs,
            paragraph(
              schema.text("これは"),
              schema.text("「重要」", [schema.marks.strong!.create()]),
              schema.text("です"),
            ),
          ),
          schema.nodes.table_cell!.create(
            cellAttrs,
            paragraph(
              schema.text("foo ", [schema.marks.em!.create()]),
              schema.text("bar"),
            ),
          ),
        ]),
      ]);

      const document = schema.topNodeType.create(null, [table]);
      const serialized = serializeMarkdown(document);
      expect(serialized).toBe(
        "| A | B |\n| --- | --- |\n| これは<strong>「重要」</strong>です | *foo* bar |",
      );
      const commonmarkHtml = new MarkdownIt("commonmark", {
        html: true,
      }).render(serialized);
      expect(commonmarkHtml).toContain("<strong>「重要」</strong>");
      expect(renderMarkdown(serialized, profile)).toContain(
        "<strong>「重要」</strong>",
      );
    },
  );

  it("splits a surrounding mark safely around an adjacent link", () => {
    const link = schema.marks.link!.create({ href: "https://example.com" });
    const document = documentWithParagraph(
      schema.text("a"),
      schema.text("foo", [schema.marks.strong!.create()]),
      schema.text("bar", [schema.marks.strong!.create(), link]),
      schema.text("b"),
    );

    expectExactRoundTrip(document, "a**foo**[**bar**](https://example.com)b");
  });

  it.each(["commonmark", "github", "gitlab"] as const)(
    "keeps a continued strong mark valid before a code fallback for %s",
    (profile) => {
      const strong = schema.marks.strong!.create();
      const code = schema.marks.code!.create();
      const document = documentWithParagraph(
        schema.text("foo ", [strong]),
        schema.text("bar", [strong, code]),
        schema.text("x"),
      );
      const expectedSource = "**foo** <strong><code>bar</code></strong>x";
      const expectedHtml =
        "<strong>foo</strong> <strong><code>bar</code></strong>x";

      const serialized = serializeMarkdown(document);
      expect(serialized).toBe(expectedSource);
      const reparsed = parseMarkdown(serialized, profile).doc.firstChild!;
      expect(reparsed.child(0).text).toBe("foo");
      expect(reparsed.child(0).marks.map((mark) => mark.type.name)).toEqual([
        "strong",
      ]);
      expect(reparsed.child(2).attrs.source).toBe(
        "<strong><code>bar</code></strong>",
      );
      expect(
        new MarkdownIt("commonmark", { html: true }).render(serialized),
      ).toContain(expectedHtml);
      expect(renderMarkdown(serialized, profile)).toContain(expectedHtml);
    },
  );

  it.each([
    { markName: "strong", delimiter: "**", tag: "strong" },
    { markName: "em", delimiter: "*", tag: "em" },
    { markName: "strike", delimiter: "~~", tag: "del" },
  ] as const)(
    "detaches whitespace before a continued %s mark fallback",
    ({ markName, delimiter, tag }) => {
      const mark = schema.marks[markName]!.create();
      const document = documentWithParagraph(
        schema.text("foo ", [mark]),
        schema.text("bar", [mark, schema.marks.code!.create()]),
        schema.text("x"),
      );
      const expectedSource = `${delimiter}foo${delimiter} <${tag}><code>bar</code></${tag}>x`;
      const expectedHtml = `<${tag}>foo</${tag}> <${tag}><code>bar</code></${tag}>x`;
      const expectedParserHtml =
        markName === "strike"
          ? `<s>foo</s> <del><code>bar</code></del>x`
          : expectedHtml;
      const parserPreset = markName === "strike" ? "default" : "commonmark";
      const renderProfile = markName === "strike" ? "github" : "commonmark";

      const serialized = serializeMarkdown(document);
      expect(serialized).toBe(expectedSource);
      expect(
        new MarkdownIt(parserPreset, { html: true }).render(serialized),
      ).toContain(expectedParserHtml);
      expect(renderMarkdown(serialized, renderProfile)).toContain(expectedHtml);
    },
  );

  it.each(["commonmark", "github", "gitlab"] as const)(
    "keeps a source edit and a neighboring re-edit valid after fallback (%s)",
    (profile) => {
      const source = "**foo `bar`** x";
      const expectedBeforeNeighborEdit =
        "**foo** <strong><code>bar</code></strong>x";
      const expectedAfterNeighborEdit =
        "**foo** <strong><code>bar</code></strong>y";
      const expectedBeforeHtml =
        "<strong>foo</strong> <strong><code>bar</code></strong>x";
      const expectedAfterHtml =
        "<strong>foo</strong> <strong><code>bar</code></strong>y";

      const snapshot = parseMarkdown(source, profile);
      const changed = replaceText(snapshot.doc, " x", "x");
      const serialized = serializeMarkdown(changed, snapshot);
      expect(serialized).toBe(expectedBeforeNeighborEdit);
      expect(
        new MarkdownIt("commonmark", { html: true }).render(serialized),
      ).toContain(expectedBeforeHtml);
      expect(renderMarkdown(serialized, profile)).toContain(expectedBeforeHtml);

      const reparsedSnapshot = parseMarkdown(serialized, profile);
      const editedAgain = replaceText(reparsedSnapshot.doc, "x", "y");
      const serializedAgain = serializeMarkdown(editedAgain, reparsedSnapshot);
      expect(serializedAgain).toBe(expectedAfterNeighborEdit);
      expect(
        new MarkdownIt("commonmark", { html: true }).render(serializedAgain),
      ).toContain(expectedAfterHtml);
      expect(renderMarkdown(serializedAgain, profile)).toContain(
        expectedAfterHtml,
      );
    },
  );

  it.each(["github", "gitlab"] as const)(
    "keeps a continued strong mark valid in a table cell for %s",
    (profile) => {
      const cellAttrs = {
        colspan: 1,
        rowspan: 1,
        colwidth: null,
        alignment: null,
      };
      const strong = schema.marks.strong!.create();
      const code = schema.marks.code!.create();
      const table = schema.nodes.table!.create(null, [
        schema.nodes.table_row!.create(null, [
          schema.nodes.table_header!.create(
            cellAttrs,
            paragraph(schema.text("A")),
          ),
        ]),
        schema.nodes.table_row!.create(null, [
          schema.nodes.table_cell!.create(
            cellAttrs,
            paragraph(
              schema.text("foo ", [strong]),
              schema.text("bar", [strong, code]),
              schema.text("x"),
            ),
          ),
        ]),
      ]);
      const document = schema.topNodeType.create(null, [table]);
      const serialized = serializeMarkdown(document);
      const expectedSource =
        "| A |\n| --- |\n| **foo** <strong><code>bar</code></strong>x |";
      const expectedHtml =
        "<strong>foo</strong> <strong><code>bar</code></strong>x";

      expect(serialized).toBe(expectedSource);
      expect(renderMarkdown(serialized, profile)).toContain(expectedHtml);
      expect(
        new MarkdownIt("default", { html: true }).render(serialized),
      ).toContain(expectedHtml);
    },
  );
});
