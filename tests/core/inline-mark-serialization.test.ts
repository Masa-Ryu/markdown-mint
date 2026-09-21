import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
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
});
