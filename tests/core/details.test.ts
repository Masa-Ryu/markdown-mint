import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
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
