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
