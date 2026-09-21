import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import {
  codeBlockFenceFor,
  codeFenceFor,
  serializeCodeBlockMarkdown,
} from "../../src/core/codeBlockSerialization";
import { parseMarkdown, schema, serializeMarkdown } from "../../src/core/index";

describe("code fence serialization", () => {
  it("finds the longest run without spreading every match into arguments", () => {
    const body = "` ".repeat(150_000);

    expect(() => codeFenceFor(body)).not.toThrow();
    expect(codeFenceFor(body)).toBe("```");
  });

  it.each([
    ["no backticks", "plain", "```", "```"],
    ["long single run", "`````", "```", "``````"],
    ["preferred inline fence", "plain", "`", "`"],
    ["inline content containing a backtick", "a`b", "`", "``"],
    ["normal block fence", "````", "```", "`````"],
    ["preferred tilde fence", "plain", "~~~", "~~~"],
    ["long tilde run", "~~~~", "~~~", "~~~~~"],
  ])("keeps fence sizing for %s", (_name, body, preferred, expected) => {
    expect(codeFenceFor(body, preferred)).toBe(expected);
  });

  it.each([
    ["plain info keeps backticks", "plain", "text", "```", "```"],
    ["backtick info requires tildes", "plain", "a`b", "```", "~~~"],
    ["tilde preference is retained", "plain", "text", "~~~~", "~~~~"],
    ["body tilde run grows the fence", "~~~~", "text", "~~~", "~~~~~"],
  ])(
    "chooses a safe block fence for %s",
    (_name, body, info, preferred, expected) => {
      expect(codeBlockFenceFor(body, info, preferred)).toBe(expected);
    },
  );

  it("roundtrips a large edited code block body", () => {
    const body = "` ".repeat(150_000);
    const source = `~~~text\n${body}\n~~~`;
    expect(source.length).toBeLessThan(2_000_000);
    const snapshot = parseMarkdown(source);
    const codeBlock = snapshot.doc.child(0);
    expect(codeBlock.type.name).toBe("code_block");
    const editedBody = `${body}edited`;
    const edited = schema.nodes.code_block!.create(
      { params: codeBlock.attrs.params },
      schema.text(editedBody),
    );
    const document = schema.topNodeType.create(null, [edited]);

    const serialized = serializeMarkdown(document);
    const reparsed = parseMarkdown(serialized);

    expect(reparsed.doc.child(0).textContent).toBe(editedBody);
  });

  it("serializes inline code with many short backtick runs", () => {
    const body = "`a".repeat(150_000);
    const paragraph = schema.nodes.paragraph!.create(
      null,
      schema.text(body, [schema.marks.code!.create()]),
    );

    const serialized = serializeMarkdown(
      schema.topNodeType.create(null, [paragraph]),
    );

    expect(parseMarkdown(serialized).doc.child(0).textContent).toBe(body);
  });

  it("serializes a code block with an explicitly chosen safe fence", () => {
    const body = "line with ```";

    expect(serializeCodeBlockMarkdown(body, "text")).toBe(
      "````text\nline with ```\n````",
    );
  });

  it("uses a tilde fence when the info string contains a backtick", () => {
    expect(serializeCodeBlockMarkdown("changed", "a`b")).toBe(
      "~~~a`b\nchanged\n~~~",
    );
    expect(serializeCodeBlockMarkdown("a\r\nb", "a`b")).toBe(
      "~~~a`b\r\na\r\nb\r\n~~~",
    );
  });

  it("keeps the original tilde fence through a ProseMirror body edit", () => {
    const source = "~~~~js\r\nhello\r\n~~~~\r\n";
    const snapshot = parseMarkdown(source);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    const edited = state.tr.replaceWith(1, 6, schema.text("changed")).doc;

    const serialized = serializeMarkdown(edited, snapshot);
    expect(serialized).toBe("~~~~js\r\nchanged\r\n~~~~\r\n");

    const reparsed = parseMarkdown(serialized);
    expect(reparsed.doc.child(0).type.name).toBe("code_block");
    expect(reparsed.doc.child(0).attrs.params).toBe("js");
    expect(reparsed.doc.child(0).textContent).toBe("changed");
  });

  it("keeps the original source slice for an info-only edit", () => {
    const source = '~~~old  title="A B"  \r\nhello\r\n~~~\r\n';
    const snapshot = parseMarkdown(source);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    const code = state.doc.firstChild!;
    const edited = state.tr.setNodeMarkup(0, undefined, {
      ...code.attrs,
      params: 'new  title="A B"',
    }).doc;

    expect(serializeMarkdown(edited, snapshot)).toBe(
      '~~~new  title="A B"  \r\nhello\r\n~~~\r\n',
    );
  });

  it("keeps an info backtick and grows a tilde fence around body candidates", () => {
    const source = "~~~a`b\nhello\n~~~";
    const snapshot = parseMarkdown(source);
    const state = EditorState.create({ schema, doc: snapshot.doc });
    const edited = state.tr.replaceWith(
      1,
      6,
      schema.text("contains ~~~~ and ```"),
    ).doc;

    const serialized = serializeMarkdown(edited, snapshot);
    expect(serialized.startsWith("~~~~~a`b\n")).toBe(true);
    const reparsed = parseMarkdown(serialized);
    expect(reparsed.doc.childCount).toBe(1);
    expect(reparsed.doc.child(0).attrs.params).toBe("a`b");
    expect(reparsed.doc.child(0).textContent).toBe("contains ~~~~ and ```");
  });
});
