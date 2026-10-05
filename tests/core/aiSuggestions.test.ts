import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "../../src/core";
import {
  matchCompletionInput,
  planCompletionInsertion,
} from "../../src/core/inlineCompletion";
import {
  buildMarkdownPositionMap,
  MarkdownPositionMapCache,
} from "../../src/core/markdownPositionMap";

function pmPositionFor(
  doc: ReturnType<typeof parseMarkdown>["doc"],
  text: string,
  offset: number,
  occurrence = 0,
): number {
  let position: number | undefined;
  let seen = 0;
  doc.descendants((node, start) => {
    if (!node.isText || !node.text) return;
    const index = node.text.indexOf(text);
    if (index >= 0 && node.text.indexOf(text, index + text.length) < 0) {
      if (seen === occurrence && position === undefined)
        position = start + index + offset;
      seen += 1;
    }
  });
  if (position === undefined)
    throw new Error(`Could not find unique text ${JSON.stringify(text)}`);
  return position;
}

describe("AI suggestion Markdown source positions", () => {
  it("reuses only maps for the exact snapshot, version, profile, and bridge", () => {
    const source = "A sentence";
    const snapshot = parseMarkdown(source, "github");
    const bridge = { parseMarkdown, serializeMarkdown };
    const cache = new MarkdownPositionMapCache();
    const get = (
      patch: {
        source?: string;
        doc?: typeof snapshot.doc;
        profile?: "github" | "gitlab" | "commonmark";
        bridge?: typeof bridge;
        previousSnapshot?: unknown;
        version?: number;
      } = {},
    ) =>
      cache.get(
        patch.source ?? source,
        patch.doc ?? snapshot.doc,
        patch.profile ?? "github",
        patch.bridge ?? bridge,
        patch.previousSnapshot ?? snapshot,
        patch.version ?? 1,
      );
    const first = get();
    expect(get()).toBe(first);
    expect(get({ version: 2 })).not.toBe(first);
    const secondVersion = get({ version: 2 });
    expect(get({ version: 2 })).toBe(secondVersion);
    expect(get({ profile: "gitlab", version: 2 })).not.toBe(secondVersion);
    const otherDoc = parseMarkdown(source, "github").doc;
    expect(get({ doc: otherDoc, version: 2 })).not.toBe(secondVersion);
    expect(get({ source: "A different sentence", version: 2 })).not.toBe(
      secondVersion,
    );
    expect(get({ previousSnapshot: { ...snapshot }, version: 2 })).not.toBe(
      secondVersion,
    );
    const otherBridge = { parseMarkdown, serializeMarkdown };
    expect(get({ bridge: otherBridge, version: 2 })).not.toBe(secondVersion);
    cache.clear();
    expect(get()).not.toBe(first);
  });

  it("maps UTF-16 positions through Japanese, emoji, emphasis, links, and nested lists", () => {
    const source =
      "日本語🌿 **bold** and [link](https://example.test)\n\n- parent\n  - child";
    const snapshot = parseMarkdown(source, "github");
    const map = buildMarkdownPositionMap(
      source,
      snapshot.doc,
      "github",
      {
        parseMarkdown,
        serializeMarkdown,
      },
      snapshot,
    );

    const cases = [
      {
        text: "日本語🌿",
        textOffset: "日本語🌿".length,
        sourceOffset: "日本語🌿".length,
      },
      { text: "bold", textOffset: 2, sourceOffset: source.indexOf("bold") + 2 },
      { text: "link", textOffset: 2, sourceOffset: source.indexOf("link") + 2 },
      {
        text: "child",
        textOffset: 3,
        sourceOffset: source.indexOf("child") + 3,
      },
    ];
    for (const test of cases) {
      const pmPosition = pmPositionFor(
        snapshot.doc,
        test.text,
        test.textOffset,
      );
      const mappedSource = map.pmPositionToSourceOffset(pmPosition);
      const mappedPosition = map.sourceOffsetToPmPosition(test.sourceOffset);
      expect(mappedSource).toBe(test.sourceOffset);
      expect(mappedPosition).toBe(pmPosition);
    }
  });

  it("keeps CRLF and repeated-text offsets anchored to the selected occurrence", () => {
    const source = "first echo\r\n\r\nsecond echo";
    const snapshot = parseMarkdown(source, "github");
    const map = buildMarkdownPositionMap(
      source,
      snapshot.doc,
      "github",
      {
        parseMarkdown,
        serializeMarkdown,
      },
      snapshot,
    );
    const pmPosition = pmPositionFor(snapshot.doc, "echo", 2, 1);
    const sourceOffset = source.lastIndexOf("echo") + 2;
    expect(map.pmPositionToSourceOffset(pmPosition)).toBe(sourceOffset);
    expect(map.sourceOffsetToPmPosition(sourceOffset)).toBe(pmPosition);
  });

  it("rejects source offsets that split a surrogate pair or CRLF", () => {
    const source = "A🌿\r\nB";
    const snapshot = parseMarkdown(source, "github");
    const map = buildMarkdownPositionMap(
      source,
      snapshot.doc,
      "github",
      {
        parseMarkdown,
        serializeMarkdown,
      },
      snapshot,
    );
    expect(map.sourceOffsetToPmPosition(2)).toBeUndefined();
    expect(map.sourceOffsetToPmPosition(source.indexOf("\n"))).toBeUndefined();
  });
});

describe("AI suggestion insertion plans", () => {
  it("keeps only the unmatched remainder after a matching typed prefix", () => {
    expect(matchCompletionInput(" wonderful world", " wonder")).toEqual({
      acceptedLength: 7,
      remaining: "ful world",
    });
    expect(
      matchCompletionInput(" wonderful world", " unrelated"),
    ).toBeUndefined();
  });

  it("adds an inline completion while preserving the exact prefix and suffix", () => {
    const source = "Hello world";
    const doc = parseMarkdown(source, "github").doc;
    const position = pmPositionFor(doc, "Hello world", 6);
    const plan = planCompletionInsertion(
      source,
      doc,
      6,
      position,
      "wonderful ",
      "github",
      {
        parseMarkdown,
      },
    );
    expect(plan).toBeDefined();
    const result = doc.replace(position, position, plan!.slice);
    expect(
      result.eq(parseMarkdown("Hello wonderful world", "github").doc),
    ).toBe(true);
  });

  it("rejects insertions that change the existing suffix marks or block structure", () => {
    const source = "hello world**";
    const doc = parseMarkdown(source, "github").doc;
    const position = pmPositionFor(doc, source, 6);
    expect(
      planCompletionInsertion(source, doc, 6, position, "**", "github", {
        parseMarkdown,
      }),
    ).toBeUndefined();
  });

  it("accepts a paragraph-end multi-line continuation as a normal structural slice", () => {
    const source = "First paragraph.";
    const doc = parseMarkdown(source, "github").doc;
    const position = pmPositionFor(doc, source, source.length);
    const plan = planCompletionInsertion(
      source,
      doc,
      source.length,
      position,
      "\n\nSecond paragraph.",
      "github",
      {
        parseMarkdown,
      },
    );
    expect(plan).toBeDefined();
    expect(
      doc
        .replace(position, position, plan!.slice)
        .eq(parseMarkdown(`${source}\n\nSecond paragraph.`, "github").doc),
    ).toBe(true);
  });

  it("accepts code insertions inside the same fenced block and preserves language and suffix", () => {
    const source = "```ts\nconst value = 1;\nreturn value;\n```";
    const doc = parseMarkdown(source, "github").doc;
    const position = pmPositionFor(doc, "const value = 1;", 16);
    const sourceOffset = source.indexOf("const value") + 16;
    const plan = planCompletionInsertion(
      source,
      doc,
      sourceOffset,
      position,
      "\nconst next = value + 1;",
      "github",
      { parseMarkdown },
    );
    expect(plan).toBeDefined();
    const result = doc.replace(position, position, plan!.slice);
    const expected = parseMarkdown(
      "```ts\nconst value = 1;\nconst next = value + 1;\nreturn value;\n```",
      "github",
    ).doc;
    expect(result.eq(expected)).toBe(true);
  });

  it("rejects code insertions that escape or close their original fence", () => {
    const source = "```js\nconst value = 1;\n```";
    const doc = parseMarkdown(source, "github").doc;
    const position = pmPositionFor(doc, "const value", 5);
    const sourceOffset = source.indexOf("const value") + 5;
    expect(
      planCompletionInsertion(
        source,
        doc,
        sourceOffset,
        position,
        "\n```\n# outside code",
        "github",
        { parseMarkdown },
      ),
    ).toBeUndefined();
  });
});
