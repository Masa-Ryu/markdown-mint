import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { EditorState } from "prosemirror-state";
import { detailsTagRanges } from "../../src/core/details";
import {
  parseDetailsSource,
  parseMarkdown,
  renderMarkdownDocument,
  schema,
  serializeMarkdown,
  type Profile,
} from "../../src/core/index";

describe("structured source-preserving Details", () => {
  const source =
    '<details data-custom="a > b" open="open">\r\n<summary class="title"><strong>More</strong> &amp; **notes**</summary>\r\n\r\nFirst paragraph\r\n\r\n- item\r\n- second\r\n\r\n~~~~ts meta=true\r\n  const x = `</details>`;\r\n~~~~\r\n\r\n<custom data-unknown="preserve">value</custom>\r\n\r\n<details data-nested="yes">\r\n<summary>Inner</summary>\r\n\r\nInside\r\n</details>\r\n\r\n</details>\r\n';

  it("parses nested paragraphs, lists, code and Details as structured content", () => {
    const snapshot = parseMarkdown(source);
    const details = snapshot.doc.firstChild!;
    expect(details.type.name).toBe("details");
    expect(
      Array.from(
        { length: details.childCount },
        (_, index) => details.child(index).type.name,
      ),
    ).toEqual([
      "paragraph",
      "bullet_list",
      "code_block",
      "paragraph",
      "details",
    ]);
    expect(details.child(2).textContent).toBe("  const x = `</details>`;");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("changes only the exact summary source while retaining body, attributes, nesting, fences and CRLF", () => {
    const snapshot = parseMarkdown(source);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    const title = "<strong>Changed</strong> &amp; **notes**";
    const transaction = state.tr.setNodeMarkup(0, undefined, {
      ...state.doc.firstChild!.attrs,
      summarySource: title,
    });
    expect(serializeMarkdown(transaction.doc, snapshot)).toBe(
      source.replace("<strong>More</strong> &amp; **notes**", title),
    );
  });

  it("retains mixed line endings in an untouched body during a heading update", () => {
    const mixed = source.replace("First paragraph\r\n", "First paragraph\n");
    const snapshot = parseMarkdown(mixed);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    const transaction = state.tr.setNodeMarkup(0, undefined, {
      ...state.doc.firstChild!.attrs,
      summarySource: "New",
    });
    expect(serializeMarkdown(transaction.doc, snapshot)).toBe(
      mixed.replace("<strong>More</strong> &amp; **notes**", "New"),
    );
  });

  it("edits one paragraph without regenerating sibling code, unknown HTML or nested Details", () => {
    const snapshot = parseMarkdown(source);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    const transaction = state.tr.insertText("Updated ", 2);
    expect(serializeMarkdown(transaction.doc, snapshot)).toBe(
      source.replace("First paragraph", "Updated First paragraph"),
    );
  });

  it("changes a nested summary without touching its parent header or sibling source", () => {
    const snapshot = parseMarkdown(source);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    let nestedPosition = -1;
    state.doc.descendants((node, pos) => {
      if (node.type.name === "details" && pos > 0) nestedPosition = pos;
    });
    const nested = state.doc.nodeAt(nestedPosition)!;
    const transaction = state.tr.setNodeMarkup(nestedPosition, undefined, {
      ...nested.attrs,
      summarySource: "Nested changed",
    });
    expect(serializeMarkdown(transaction.doc, snapshot)).toBe(
      source.replace(
        "<summary>Inner</summary>",
        "<summary>Nested changed</summary>",
      ),
    );
  });

  it("allows an empty heading and safe rendering while retaining source HTML", () => {
    const snapshot = parseMarkdown(source);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    const transaction = state.tr.setNodeMarkup(0, undefined, {
      ...state.doc.firstChild!.attrs,
      summarySource: "",
    });
    expect(serializeMarkdown(transaction.doc, snapshot)).toBe(
      source.replace("<strong>More</strong> &amp; **notes**", ""),
    );
    expect(renderMarkdownDocument(transaction.doc)).toContain(
      "<details open><summary></summary>",
    );
  });

  it("keeps an empty body transient until typing and retains valid block boundaries", () => {
    const original =
      "<details open>\r\n<summary></summary>\r\n\r\n</details>\r\n";
    const snapshot = parseMarkdown(original);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    expect(state.doc.firstChild!.firstChild!.type.name).toBe("paragraph");
    expect(serializeMarkdown(state.doc, snapshot)).toBe(original);
    const transaction = state.tr.insertText("Typed", 2);
    expect(serializeMarkdown(transaction.doc, snapshot)).toBe(
      original.replace("</details>", "Typed\r\n\r\n</details>"),
    );
  });

  it("retains unsupported headers as raw Details instead of dropping unknown structure", () => {
    const unsupported =
      '<details data-x="1">\n<p>Custom header</p>\n<summary>Title</summary>\n\nBody\n</details>\n';
    const snapshot = parseMarkdown(unsupported);
    expect(snapshot.doc.firstChild!.type.name).toBe("raw_block");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(unsupported);
  });

  it("does not interpret quoted attributes, comments or fenced/inline code as outer closing tags", () => {
    const parts = parseDetailsSource(source);
    expect(parts?.open).toBe(true);
    expect(parts?.body).toContain("`</details>`");
    const commented =
      "<details>\n<!-- </details> -->\n<summary>T</summary>\n\nLiteral `</details>`\n</details>\n";
    expect(parseMarkdown(commented).doc.firstChild!.type.name).toBe("details");
    expect(serializeMarkdown(parseMarkdown(commented).doc)).toBe(commented);
    expect(
      parseDetailsSource(
        '<details data-note=" open "><summary>T</summary>Body</details>',
      )?.open,
    ).toBe(false);
  });

  it.each([
    ["inline code", "`<!--` starts a comment. `</details>` ends Details."],
    ["long inline code", "``<!-- ` </details>``"],
    ["backtick fence", "```html\n<!--\n</details>\n```"],
    ["tilde fence", "~~~~html\n<!--\n</details>\n~~~~~"],
  ])("keeps comment syntax inside %s literal", (_name, literal) => {
    const body = `\n\n<!-- Actual comment: </details> -->\n\n${literal}\n\nAfter the literal.\n\n`;
    const original = `<details>\n<summary>HTML comments</summary>${body}</details>\n`;
    expect(
      detailsTagRanges(original).map(({ start, end }) =>
        original.slice(start, end),
      ),
    ).toEqual(["<details>", "</details>"]);
    expect(parseDetailsSource(original)?.body).toBe(body);
    const snapshot = parseMarkdown(original);
    expect(snapshot.doc.firstChild!.type.name).toBe("details");
    expect(snapshot.doc.childCount).toBe(1);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(original);
  });

  it("keeps code delimiters inside real comments from masking later Details tags", () => {
    const body =
      "\n\n<!-- Actual comment with an unmatched fence:\n```\n</details>\n-->\n\n`<!--` remains literal.\n\n";
    const original = `<details>\n<summary>T</summary>${body}</details>\n`;
    expect(detailsTagRanges(original)).toHaveLength(2);
    expect(parseDetailsSource(original)?.body).toBe(body);
    const snapshot = parseMarkdown(original);
    expect(snapshot.doc.firstChild!.type.name).toBe("details");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(original);
  });

  it("changes code language without rewriting a tilde fence, metadata, indentation or line endings", () => {
    const original =
      'Before\r\n\r\n  ~~~~custom-language  title="A B"  \r\n    first\r\n  \tsecond\r\n  \r\n  ~~~~~\r\n\r\nAfter\r\n';
    const snapshot = parseMarkdown(original);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    const position = state.doc.firstChild!.nodeSize;
    const code = state.doc.nodeAt(position)!;
    const transaction = state.tr.setNodeMarkup(position, undefined, {
      ...code.attrs,
      params: 'typescript  title="A B"',
    });
    expect(serializeMarkdown(transaction.doc, snapshot)).toBe(
      original.replace("custom-language", "typescript"),
    );
  });
});

describe("Details scanner backslash escapes", () => {
  const markdownIt = new MarkdownIt("commonmark");
  const opening = '<details data-note="a > b">';
  const details = `${opening}\n<summary>Summary</summary>\n\nBody\n\n</details>`;
  const scannedTags = (source: string) =>
    detailsTagRanges(source).map(({ start, end }) => source.slice(start, end));
  const inlineTokens = (source: string) =>
    markdownIt.parseInline(source, {})[0]!.children!;

  function expectStructured(source: string, block = details): void {
    const start = source.indexOf(block);
    const closing = start + block.lastIndexOf("</details>");
    expect(detailsTagRanges(source)).toEqual([
      { start, end: start + opening.length, closing: false },
      { start: closing, end: closing + "</details>".length, closing: true },
    ]);
    const parts = parseDetailsSource(
      source.slice(start, closing + "</details>".length),
    );
    expect(parts?.summary).toBe("Summary");
    expect(parts?.body).toContain("Body");
    expect(
      parts &&
        parts.beforeSummary +
          parts.summary +
          parts.afterSummary +
          parts.body +
          parts.closing,
    ).toBe(block);
    const snapshot = parseMarkdown(source, "commonmark");
    const structured: string[] = [];
    snapshot.doc.forEach((node) => {
      if (node.type.name === "details")
        structured.push(String(node.attrs.source));
    });
    expect(structured).toHaveLength(1);
    expect(structured[0]!.trimEnd()).toBe(block);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  }

  it.each([1, 3])(
    "keeps Details between backticks escaped by %i backslashes",
    (count) => {
      const literal = "\\".repeat(count) + "`";
      const source = `${literal}\n\n${details}\n\n${literal}`;
      expect(inlineTokens(literal).map((token) => token.type)).toEqual([
        "text",
      ]);
      expectStructured(source);
    },
  );

  it("keeps an escaped backtick separate from a later real code span", () => {
    const realCode = "`real inline code: <!-- </details>`";
    const source = `\\\`\n\n${details}\n\n${realCode}`;
    expect(inlineTokens(realCode)[0]!.type).toBe("code_inline");
    expectStructured(source);
  });

  it.each([1, 3])(
    "keeps Details after a comment opener escaped by %i backslashes",
    (count) => {
      const literal = "\\".repeat(count) + "<!--";
      expect(inlineTokens(literal).map((token) => token.type)).toEqual([
        "text",
      ]);
      expectStructured(`${literal}\n\n${details}`);
    },
  );

  it.each(["\n\n", "\r\n\r\n", "\r\r", "\r\n \t\r\n", "\r\n\r", "\n\r\n"])(
    "does not join unmatched backticks across a paragraph boundary %j",
    (boundary) => {
      const source = "\\\\`" + boundary + details + boundary + "`";
      const tokens = markdownIt.parse(source, {});
      expect(
        tokens.filter((token) => token.type === "html_block"),
      ).toHaveLength(2);
      expect(
        tokens
          .flatMap((token) => token.children ?? [])
          .some((token) => token.type === "code_inline"),
      ).toBe(false);
      expectStructured(source);
    },
  );

  it.each([1, 2, 3, 4])(
    "matches CommonMark inline code parity for %i backslashes",
    (count) => {
      const source = "\\".repeat(count) + "`<details></details>`";
      const expected = count % 2 ? ["<details>", "</details>"] : [];
      expect(scannedTags(source)).toEqual(expected);
      expect(
        inlineTokens(source)
          .filter((token) => token.type === "html_inline")
          .map((token) => token.content),
      ).toEqual(expected);
      expect(
        inlineTokens(source).some((token) => token.type === "code_inline"),
      ).toBe(count % 2 === 0);
    },
  );

  it.each([1, 2, 3, 4])(
    "matches CommonMark comment opener parity for %i backslashes",
    (count) => {
      const source = "\\".repeat(count) + "<!-- <details></details> -->";
      const expected = count % 2 ? ["<details>", "</details>"] : [];
      expect(scannedTags(source)).toEqual(expected);
      const html = inlineTokens(source)
        .filter((token) => token.type === "html_inline")
        .map((token) => token.content);
      expect(html).toEqual(
        count % 2 ? expected : ["<!-- <details></details> -->"],
      );
    },
  );

  it.each([1, 2, 3, 4])(
    "matches CommonMark tag escape parity for %i backslashes",
    (count) => {
      const slash = "\\".repeat(count);
      const source = `${slash}<details> ${slash}</details>`;
      const expected = count % 2 ? [] : ["<details>", "</details>"];
      expect(scannedTags(source)).toEqual(expected);
      expect(
        inlineTokens(source)
          .filter((token) => token.type === "html_inline")
          .map((token) => token.content),
      ).toEqual(expected);
    },
  );

  it("does not structure an escaped opening tag or close an outer Details at an escaped tag", () => {
    const escaped = "\\" + details;
    expect(parseDetailsSource(escaped)).toBeNull();
    const snapshot = parseMarkdown(escaped);
    expect(
      snapshot.doc.content.content.some((node) => node.type.name === "details"),
    ).toBe(false);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(escaped);
    const body = "\\<details>\n\n\\</details>\n\nBody";
    const outer = details.replace("Body", body);
    expect(markdownIt.render(outer)).toContain("<p>&lt;/details&gt;</p>");
    expectStructured(outer, outer);
    expect(parseDetailsSource(outer)?.body).toBe(`\n\n${body}\n\n`);
  });

  it("rescans the remaining backticks after escaping only the first one in a run", () => {
    const source = "\\``<details></details>`";
    expect(inlineTokens(source).map((token) => token.type)).toEqual([
      "text",
      "code_inline",
    ]);
    expect(scannedTags(source)).toEqual([]);
  });

  it("does not apply escapes to a code span closing backtick or a real comment's terminator", () => {
    for (const prefix of ["`code\\` ", "<!-- unmatched ``` and \\--> "]) {
      const source = prefix + "<details></details>";
      expect(scannedTags(source)).toEqual(["<details>", "</details>"]);
      expect(
        inlineTokens(source)
          .filter((token) => token.type === "html_inline")
          .slice(-2)
          .map((token) => token.content),
      ).toEqual(["<details>", "</details>"]);
    }
  });

  it.each(["\n", "\r\n", "\r"])(
    "keeps a single %j line ending inside a real code span",
    (ending) => {
      const source = "`before" + ending + "literal <!-- <details></details>`";
      expect(scannedTags(source)).toEqual([]);
      const tokens = markdownIt
        .parse(source, {})
        .flatMap((token) => token.children ?? []);
      expect(tokens.map((token) => token.type)).toEqual(["code_inline"]);
    },
  );
});

describe("Details scanner Markdown block contexts", () => {
  const markdownIt = new MarkdownIt("commonmark");
  const scannedTags = (source: string) =>
    detailsTagRanges(source).map(({ start, end }) => source.slice(start, end));
  const realDetails =
    "<details>\n<summary>Real</summary>\n\nBody\n\n</details>";

  function expectSourcePreservingEdits(
    source: string,
    summary: string,
    bodyText = "Body",
    detailsCount = 1,
  ): void {
    const tags = detailsTagRanges(source);
    const start = tags[0]!.start;
    const end = tags.at(-1)!.end;
    const block = source.slice(start, end);
    const parts = parseDetailsSource(block)!;
    expect(parts).not.toBeNull();
    expect(parts.summary).toBe(summary);
    expect(
      parts.beforeSummary +
        parts.summary +
        parts.afterSummary +
        parts.body +
        parts.closing,
    ).toBe(block);
    expect(parts.body).toBe(
      block.slice(
        parts.beforeSummary.length + summary.length + parts.afterSummary.length,
        block.lastIndexOf("</details>"),
      ),
    );
    const snapshot = parseMarkdown(source);
    let outerPosition = -1;
    let count = 0;
    let paragraphPosition = -1;
    snapshot.doc.descendants((node, position) => {
      if (node.type.name === "details") {
        count += 1;
        if (outerPosition < 0) outerPosition = position;
      }
      if (node.type.name === "paragraph" && node.textContent === bodyText)
        paragraphPosition = position;
    });
    expect(count).toBe(detailsCount);
    expect(outerPosition).toBeGreaterThanOrEqual(0);
    expect(paragraphPosition).toBeGreaterThanOrEqual(0);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    const outer = state.doc.nodeAt(outerPosition)!;
    const headingChange = state.tr.setNodeMarkup(outerPosition, undefined, {
      ...outer.attrs,
      summarySource: "Changed title",
    });
    const summaryStart = start + parts.beforeSummary.length;
    expect(serializeMarkdown(headingChange.doc, snapshot)).toBe(
      source.slice(0, summaryStart) +
        "Changed title" +
        source.slice(summaryStart + summary.length),
    );
    const bodyChange = state.tr.insertText("Edited ", paragraphPosition + 1);
    const bodyStart = source.lastIndexOf(bodyText);
    expect(serializeMarkdown(bodyChange.doc, snapshot)).toBe(
      source.slice(0, bodyStart) + "Edited " + source.slice(bodyStart),
    );
  }

  it.each([
    [
      "A: summary code after an unmatched backtick",
      "`unmatched\n<details>\n<summary>`heading code`</summary>\nBody\n</details>",
      "`heading code`",
    ],
    [
      "B: quoted attributes after an unmatched backtick",
      '`unmatched\n<details data-test="a > b" open>\n<summary>Summary</summary>\nBody\n</details>',
      "Summary",
    ],
    [
      "C: script body",
      '<details>\n<summary>Summary</summary>\n<script>\nconst value = "</details>";\n</script>\nBody\n</details>',
      "Summary",
    ],
    [
      "D: style body",
      '<details>\n<summary>Summary</summary>\n<style>\n.example::after { content: "</details>"; }\n</style>\nBody\n</details>',
      "Summary",
    ],
    [
      "E: pre body",
      "<details>\n<summary>Summary</summary>\n<pre>\n</details>\n</pre>\nBody\n</details>",
      "Summary",
    ],
    [
      "F: textarea body",
      "<details>\n<summary>Summary</summary>\n<textarea>\n</details>\n</textarea>\nBody\n</details>",
      "Summary",
    ],
    [
      "G: fake nested Details in script",
      '<details>\n<summary>Summary</summary>\n<script>\nconst value = "<details><summary>fake</summary></details>";\n</script>\nBody\n</details>',
      "Summary",
    ],
  ])(
    "preserves structured parse and exact edits for %s",
    (_name, source, summary) => {
      expect(scannedTags(source)).toEqual([
        source.startsWith("`unmatched\n<details data")
          ? '<details data-test="a > b" open>'
          : "<details>",
        "</details>",
      ]);
      if (source.startsWith("`unmatched")) {
        const tokens = markdownIt.parse(source, {});
        expect(tokens.find((token) => token.type === "inline")?.map).toEqual([
          0, 1,
        ]);
        expect(
          tokens.find((token) => token.type === "html_block")?.map,
        ).toEqual([1, 5]);
      }
      expectSourcePreservingEdits(source, summary);
    },
  );

  it("H: retains real nested Details without requiring blank lines", () => {
    const source =
      "<details>\n<summary>Outer</summary>\n<details>\n<summary>Inner</summary>\nInside\n</details>\n</details>";
    expect(scannedTags(source)).toEqual([
      "<details>",
      "<details>",
      "</details>",
      "</details>",
    ]);
    expectSourcePreservingEdits(source, "Outer", "Inside", 2);
    const snapshot = parseMarkdown(source);
    expect(snapshot.doc.firstChild!.firstChild!.type.name).toBe("details");
    expect(snapshot.doc.firstChild!.firstChild!.attrs.summarySource).toBe(
      "Inner",
    );
  });

  it.each([
    ["ATX heading", "# Heading", "heading_open", [1, 2]],
    ["blockquote", "> Quoted", "blockquote_open", [1, 3]],
    ["bullet list", "- Item", "bullet_list_open", [1, 3]],
    ["ordered list starting at one", "1. Item", "ordered_list_open", [1, 3]],
    ["thematic break", "***", "hr", [1, 2]],
    ["fenced code", "```text\n<details></details>\n```", "fence", [1, 4]],
    [
      "script block",
      "<script>\n<details></details>\n</script>",
      "html_block",
      [1, 4],
    ],
  ] as const)(
    "ends unmatched code at the actual %s boundary",
    (_name, boundary, type, map) => {
      const source = `\`before\n${boundary}\nliteral <details></details>\``;
      const tokens = markdownIt.parse(source, {});
      expect(tokens.find((token) => token.type === "inline")?.map).toEqual([
        0, 1,
      ]);
      expect(tokens.find((token) => token.type === type)?.map).toEqual(map);
      expect(
        tokens
          .flatMap((token) => token.children ?? [])
          .filter((token) => token.type === "html_inline")
          .map((token) => token.content),
      ).toEqual(["<details>", "</details>"]);
      expect(scannedTags(source)).toEqual(["<details>", "</details>"]);
      const expectedStart = source.lastIndexOf("<details>");
      expect(detailsTagRanges(source)[0]?.start).toBe(expectedStart);
    },
  );

  it("keeps an ordered marker starting at two inside the existing paragraph", () => {
    const source = "`before\n2. Item\nliteral <details></details>`";
    const tokens = markdownIt.parse(source, {});
    expect(tokens.find((token) => token.type === "inline")?.map).toEqual([
      0, 3,
    ]);
    expect(tokens.some((token) => token.type === "ordered_list_open")).toBe(
      false,
    );
    expect(
      tokens
        .flatMap((token) => token.children ?? [])
        .map((token) => token.type),
    ).toEqual(["code_inline"]);
    expect(scannedTags(source)).toEqual([]);
  });

  it("keeps a type 7 HTML opener inside an existing paragraph and code span", () => {
    const source = "`before\n<custom-widget>\nliteral <details></details>`";
    const tokens = markdownIt.parse(source, {});
    expect(tokens.find((token) => token.type === "inline")?.map).toEqual([
      0, 3,
    ]);
    expect(tokens.some((token) => token.type === "html_block")).toBe(false);
    expect(
      tokens
        .flatMap((token) => token.children ?? [])
        .map((token) => token.type),
    ).toEqual(["code_inline"]);
    expect(scannedTags(source)).toEqual([]);
  });

  it("uses setext heading boundaries without consuming the following paragraph", () => {
    const source = "`before\n---\nliteral <details></details>`";
    const tokens = markdownIt.parse(source, {});
    expect(tokens.find((token) => token.type === "heading_open")?.map).toEqual([
      0, 2,
    ]);
    expect(scannedTags(source)).toEqual(["<details>", "</details>"]);
  });

  const rawHtmlBlocks = [
    ["type 1 script", '<script>\n"<details></details>"\n</script>'],
    ["type 1 style", '<style>\n"<details></details>"\n</style>'],
    ["type 1 pre", "<pre>\n<details></details>\n</pre>"],
    ["type 1 textarea", "<textarea>\n<details></details>\n</textarea>"],
    ["type 2 comment", "<!-- unmatched ```\n\n<details></details>\n-->"],
    ["type 3 processing instruction", "<?process\n<details></details>\n?>"],
    ["type 4 declaration", "<!DOCTYPE\n<details></details>>"],
    ["type 5 CDATA", "<![CDATA[\n<details></details>\n]]>"],
    [
      "type 6 div",
      "<div>\n<details>\n<summary>Fake</summary>\n</details>\n</div>",
    ],
    ["type 6 standalone summary", "<summary>\n<details></details>\n</summary>"],
    [
      "type 7 custom element",
      '<custom-widget data-x="a > b">\n<details></details>\n</custom-widget>',
    ],
  ];

  it.each(rawHtmlBlocks)(
    "keeps %s opaque before an actual Details block",
    (_name, raw) => {
      const source = `${raw}\n\n${realDetails}`;
      const token = markdownIt.parse(source, {})[0]!;
      expect(token.type).toBe("html_block");
      expect(token.map).toEqual([0, raw.split("\n").length]);
      expect(scannedTags(source)).toEqual(["<details>", "</details>"]);
      expect(detailsTagRanges(source)[0]?.start).toBe(raw.length + 2);
      const snapshot = parseMarkdown(source);
      expect(
        snapshot.doc.content.content.filter(
          (node) => node.type.name === "details",
        ),
      ).toHaveLength(1);
      expect(snapshot.doc.lastChild!.attrs.summarySource).toBe("Real");
      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
    },
  );

  it.each(["> <details>", "- <details>"])(
    "does not let unmatched Details in %j expose an unrelated summary HTML block",
    (prefix) => {
      const raw =
        "<summary>\n<details>\n<summary>Fake</summary>\nBody\n</details>\n</summary>";
      const source = `${prefix}\n\n${raw}\n\n${realDetails}`;
      const rawStart = prefix.split("\n").length + 1;
      expect(
        markdownIt
          .parse(source, {})
          .find(
            (token) =>
              token.type === "html_block" && token.map?.[0] === rawStart,
          )?.content,
      ).toBe(raw + "\n");
      const fakeStart = source.indexOf("<details>", prefix.length);
      const fakeEnd = source.indexOf("</summary>\n\n", fakeStart);
      expect(
        detailsTagRanges(source).filter(
          (tag) => tag.start >= fakeStart && tag.start < fakeEnd,
        ),
      ).toEqual([]);
      const snapshot = parseMarkdown(source);
      const summaries: string[] = [];
      snapshot.doc.descendants((node) => {
        if (node.type.name === "details")
          summaries.push(String(node.attrs.summarySource));
      });
      expect(summaries).toEqual(["Real"]);
      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "keeps %j source offsets, unknown HTML, and quoted attributes during both edits",
    (ending) => {
      const source =
        '<details data-unknown="a > b" open="open">\n<summary class="title"><strong>Summary</strong></summary>\n<script data-x="&copy;">\nconst value = "</details>";\n</script>\n\n<custom-widget keep="  spaced  ">raw &amp; text</custom-widget>\n\nBody\n</details>\n'.replace(
          /\n/g,
          ending,
        );
      expect(scannedTags(source)).toEqual([
        '<details data-unknown="a > b" open="open">',
        "</details>",
      ]);
      expect(detailsTagRanges(source).at(-1)?.start).toBe(
        source.lastIndexOf("</details>"),
      );
      expectSourcePreservingEdits(source, "<strong>Summary</strong>");
    },
  );
});

describe.each<Profile>(["commonmark", "github", "gitlab"])(
  "Details source parsing with the %s block profile",
  (profile) => {
    it.each(["<details>", "</details>", "<details>\n</details>"])(
      "preserves display math containing %j through summary/body edits and rendering",
      (literal) => {
        const math = `$$\n${literal}\n$$`;
        const source = `<details data-preserve="a > b" open>\n<summary>Original</summary>\n\n${math}\n\nBody\n\n</details>\n`;
        const snapshot = parseMarkdown(source, profile);
        const outer = snapshot.doc.firstChild!;
        expect(snapshot.doc.childCount).toBe(1);
        expect(outer.type.name).toBe("details");
        expect(outer.childCount).toBe(2);
        expect(outer.firstChild!.attrs.kind).toBe("math-block");
        expect(outer.firstChild!.attrs.source).toContain(math);
        const state = EditorState.create({ schema, doc: snapshot.doc });
        const changed = state.tr.setNodeMarkup(0, undefined, {
          ...outer.attrs,
          summarySource: "Changed",
        });
        const expected = source.replace(
          "<summary>Original</summary>",
          "<summary>Changed</summary>",
        );
        expect(serializeMarkdown(changed.doc, snapshot)).toBe(expected);
        expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
        const root = document.createElement("div");
        root.innerHTML = renderMarkdownDocument(changed.doc, profile, snapshot);
        expect(root.querySelectorAll("details")).toHaveLength(1);
        expect(root.querySelector("details")?.open).toBe(true);
        expect(root.querySelector("details > summary")?.textContent).toBe(
          "Changed",
        );
        expect(root.querySelector("details")?.textContent).toContain("Body");
        let bodyPosition = -1;
        snapshot.doc.descendants((node, position) => {
          if (node.type.name === "paragraph" && node.textContent === "Body")
            bodyPosition = position;
        });
        expect(bodyPosition).toBeGreaterThan(0);
        const bodyChange = state.tr.insertText("Edited ", bodyPosition + 1);
        expect(serializeMarkdown(bodyChange.doc, snapshot)).toBe(
          source.replace("\nBody\n", "\nEdited Body\n"),
        );
        const reparsed = parseMarkdown(expected, profile).doc.firstChild!;
        expect(reparsed.attrs.summarySource).toBe("Changed");
        expect(reparsed.firstChild!.attrs.source).toBe(
          outer.firstChild!.attrs.source,
        );
      },
    );
  },
);

describe.each<Profile>(["github", "gitlab"])(
  "Details source parsing with %s tables",
  (profile) => {
    it.each(["<details>", "</details>"])(
      "saves summary edits when a table contains a backtick cell and literal %s",
      (literal) => {
        const table = `| A | B |\n| - | - |\n| \` | ${literal} |`;
        const source = `<details open>\n<summary>Summary</summary>\n\n${table}\n\nBody\n\n</details>`;
        const snapshot = parseMarkdown(source, profile);
        const outer = snapshot.doc.firstChild!;
        expect(snapshot.doc.childCount).toBe(1);
        expect(outer.type.name).toBe("details");
        expect(outer.childCount).toBe(2);
        expect(outer.firstChild!.type.name).toBe("table");
        expect(parseDetailsSource(source, profile)?.body).toBe(
          `\n\n${table}\n\nBody\n\n`,
        );
        const state = EditorState.create({ schema, doc: snapshot.doc });
        const changed = state.tr.setNodeMarkup(0, undefined, {
          ...outer.attrs,
          summarySource: "Changed",
        });
        expect(serializeMarkdown(changed.doc, snapshot)).toBe(
          source.replace(
            "<summary>Summary</summary>",
            "<summary>Changed</summary>",
          ),
        );
        expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
        const root = document.createElement("div");
        root.innerHTML = renderMarkdownDocument(changed.doc, profile, snapshot);
        expect(root.querySelector("details")?.open).toBe(true);
        expect(root.querySelector("details > summary")?.textContent).toBe(
          "Changed",
        );
        expect(root.querySelectorAll("table")).toHaveLength(1);
        expect(changed.doc.firstChild!.firstChild).toBe(outer.firstChild);
      },
    );
  },
);

it("keeps edits and open rendering exact when revisiting a large Details document", () => {
  const panels = Array.from(
    { length: 80 },
    (_, index) =>
      `<details data-panel="${index}" open>\n<summary>Panel ${index}</summary>\n\n$$\n</details>\n$$\n\nBody ${index}\n\n</details>`,
  );
  const source = panels.join("\n\n");
  const snapshot = parseMarkdown(source, "gitlab");
  expect(snapshot.doc.childCount).toBe(panels.length);
  const initial = document.createElement("div");
  initial.innerHTML = renderMarkdownDocument(snapshot.doc, "gitlab", snapshot);
  expect(initial.querySelectorAll("details[open]")).toHaveLength(panels.length);

  // Visit another large document, then return to the immutable original state.
  const otherSource = source.replace(/Panel /g, "Other panel ");
  const other = parseMarkdown(otherSource, "github");
  expect(serializeMarkdown(other.doc, other)).toBe(otherSource);
  renderMarkdownDocument(other.doc, "github", other);

  const state = EditorState.create({ schema, doc: snapshot.doc });
  const lastPosition = state.doc.content.size - state.doc.lastChild!.nodeSize;
  const changed = state.tr
    .setNodeMarkup(0, undefined, {
      ...state.doc.firstChild!.attrs,
      summarySource: "First changed",
    })
    .setNodeMarkup(lastPosition, undefined, {
      ...state.doc.lastChild!.attrs,
      summarySource: "Last changed",
    });
  let firstBodyPosition = -1;
  state.doc.descendants((node, position) => {
    if (node.type.name === "paragraph" && node.textContent === "Body 0")
      firstBodyPosition = position;
  });
  expect(firstBodyPosition).toBeGreaterThan(0);
  changed.insertText("Edited ", firstBodyPosition + 1);
  const expected = source
    .replace("<summary>Panel 0</summary>", "<summary>First changed</summary>")
    .replace("<summary>Panel 79</summary>", "<summary>Last changed</summary>")
    .replace("\nBody 0\n", "\nEdited Body 0\n");
  expect(serializeMarkdown(changed.doc, snapshot)).toBe(expected);
  expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  const rendered = document.createElement("div");
  rendered.innerHTML = renderMarkdownDocument(changed.doc, "gitlab", snapshot);
  expect(rendered.querySelectorAll("details[open]")).toHaveLength(
    panels.length,
  );
  const summaries = rendered.querySelectorAll("details > summary");
  expect(summaries[0]!.textContent).toBe("First changed");
  expect(summaries[summaries.length - 1]!.textContent).toBe("Last changed");
  expect(rendered.querySelector("details")?.textContent).toContain(
    "Edited Body 0",
  );
});
