import { describe, expect, it } from "vitest";
import {
  parseMarkdown,
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

function expectRoundTrip(
  document: PMNode,
  expectedSource: string,
  profile: Profile = "commonmark",
): void {
  const serialized = serializeMarkdown(document);
  expect(serialized).toBe(expectedSource);
  expect(
    parseMarkdown(serialized, profile).doc.eq(
      parseMarkdown(expectedSource, profile).doc,
    ),
  ).toBe(true);
  expect(parseMarkdown(serialized, profile).doc.textContent).toBe(
    document.textContent,
  );
}

describe("inline mark serialization", () => {
  it("keeps strong emphasis around Japanese punctuation parseable", () => {
    expectRoundTrip(
      documentWithParagraph(
        schema.text("これは"),
        schema.text("「重要」", [schema.marks.strong!.create()]),
        schema.text("です"),
      ),
      "これは「**重要**」です",
    );
  });

  it("keeps trailing whitespace outside strong emphasis", () => {
    expectRoundTrip(
      documentWithParagraph(
        schema.text("foo ", [schema.marks.strong!.create()]),
        schema.text("bar"),
      ),
      "**foo** bar",
    );
  });

  it.each([
    {
      name: "emphasis with Japanese punctuation",
      children: [
        schema.text("これは"),
        schema.text("「重要」", [schema.marks.em!.create()]),
        schema.text("です"),
      ],
      expected: "これは「*重要*」です",
    },
    {
      name: "nested strong and emphasis",
      children: [
        schema.text("a"),
        schema.text("「重要」", [
          schema.marks.strong!.create(),
          schema.marks.em!.create(),
        ]),
        schema.text("b"),
      ],
      expected: "a「***重要***」b",
    },
    {
      name: "leading and trailing whitespace",
      children: [
        schema.text("a"),
        schema.text(" foo ", [schema.marks.strong!.create()]),
        schema.text("b"),
      ],
      expected: "a **foo** b",
    },
    {
      name: "newlines at a mark boundary",
      children: [
        schema.text("a"),
        schema.text("foo\n", [schema.marks.strong!.create()]),
        schema.text("bar"),
      ],
      expected: "a**foo**\nbar",
    },
    {
      name: "parentheses at a mark boundary",
      children: [
        schema.text("a"),
        schema.text("(重要)", [schema.marks.strong!.create()]),
        schema.text("b"),
      ],
      expected: "a\\(**重要**\\)b",
    },
    {
      name: "ASCII text between alphanumerics",
      children: [
        schema.text("a"),
        schema.text("important", [schema.marks.strong!.create()]),
        schema.text("b"),
      ],
      expected: "a**important**b",
    },
    {
      name: "strikethrough with Japanese punctuation",
      children: [
        schema.text("a"),
        schema.text("「重要」", [schema.marks.strike!.create()]),
        schema.text("b"),
      ],
      expected: "a「~~重要~~」b",
    },
    {
      name: "punctuation with whitespace context",
      children: [
        schema.text("a "),
        schema.text("「重要」", [schema.marks.strong!.create()]),
        schema.text(" b"),
      ],
      expected: "a **「重要」** b",
    },
  ] as const)("roundtrips $name", ({ children, expected, name }) => {
    expectRoundTrip(
      documentWithParagraph(...children),
      expected,
      name === "strikethrough with Japanese punctuation"
        ? "github"
        : "commonmark",
    );
  });

  it("moves unsafe surrounding marks inside a link label", () => {
    const link = schema.marks.link!.create({ href: "https://example.com" });

    expectRoundTrip(
      documentWithParagraph(
        schema.text("a"),
        schema.text("「重要」", [schema.marks.strong!.create(), link]),
        schema.text("b"),
      ),
      "a[**「重要」**](https://example.com)b",
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

    expectRoundTrip(
      documentWithParagraph(
        schema.text("a"),
        schema.text("important", [schema.marks.strong!.create()]),
        image,
        schema.text("b"),
      ),
      "a**important**![picture](image.png)b",
    );
  });

  it("keeps mark boundaries parseable inside table cells", () => {
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

    const serialized = serializeMarkdown(
      schema.topNodeType.create(null, [table]),
    );
    expect(serialized).toBe(
      "| A | B |\n| --- | --- |\n| これは「**重要**」です | *foo* bar |",
    );
    expect(
      parseMarkdown(serialized).doc.eq(parseMarkdown(serialized).doc),
    ).toBe(true);
  });

  it("splits a surrounding mark safely around an adjacent link", () => {
    const link = schema.marks.link!.create({ href: "https://example.com" });
    const document = documentWithParagraph(
      schema.text("a"),
      schema.text("foo", [schema.marks.strong!.create()]),
      schema.text("bar", [schema.marks.strong!.create(), link]),
      schema.text("b"),
    );

    expectRoundTrip(document, "a**foo**[**bar**](https://example.com)b");
  });
});
