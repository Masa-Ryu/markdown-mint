import { describe, expect, it } from "vitest";
import {
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
  ])("keeps fence sizing for %s", (_name, body, preferred, expected) => {
    expect(codeFenceFor(body, preferred)).toBe(expected);
  });

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
});
