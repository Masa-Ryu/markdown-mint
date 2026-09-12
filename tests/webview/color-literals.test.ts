import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { history, redo, undo } from "prosemirror-history";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  parseMarkdown,
  schema,
  serializeMarkdown,
  type Profile,
} from "../../src/core";
import * as colorLiterals from "../../src/webview/colorLiterals";
import { createRenderingPlugin } from "../../src/webview/rendering";

interface ColorRange {
  from: number;
  literal: string;
  to: number;
}

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
  document.body.replaceChildren();
});

function renderingState(
  markdown: string,
  profile: Profile = "github",
  withHistory = false,
): {
  plugin: ReturnType<typeof createRenderingPlugin>;
  snapshot: ReturnType<typeof parseMarkdown>;
  state: EditorState;
} {
  const snapshot = parseMarkdown(markdown, profile);
  const plugin = createRenderingPlugin(() => profile);
  const state = EditorState.create({
    schema,
    doc: snapshot.doc,
    plugins: withHistory ? [history(), plugin] : [plugin],
  });
  return { plugin, snapshot, state };
}

function colorRanges(
  plugin: ReturnType<typeof createRenderingPlugin>,
  state: EditorState,
): ColorRange[] {
  return (
    plugin
      .getState(state)
      ?.decorations.find()
      .flatMap((decoration) => {
        const literal = (decoration.spec as Record<string, unknown>)[
          "data-mm-color-literal"
        ];
        return typeof literal === "string"
          ? [{ from: decoration.from, literal, to: decoration.to }]
          : [];
      }) ?? []
  );
}

function ancestorNames(doc: PMNode, position: number): string[] {
  const resolved = doc.resolve(position);
  return Array.from(
    { length: resolved.depth + 1 },
    (_, depth) => resolved.node(depth).type.name,
  );
}

function marksAt(doc: PMNode, position: number): string[] {
  let names: string[] = [];
  doc.descendants((node, nodePosition) => {
    if (
      node.isText &&
      nodePosition <= position &&
      position < nodePosition + node.nodeSize
    ) {
      names = node.marks.map((mark) => mark.type.name);
      return false;
    }
    return true;
  });
  return names;
}

function mount(state: EditorState): EditorView {
  const element = document.createElement("div");
  document.body.append(element);
  const view = new EditorView(element, { state });
  views.push(view);
  return view;
}

describe("rich-editor hexadecimal color literals", () => {
  it("decorates validated literals without normalizing their source spelling", () => {
    const { plugin, state } = renderingState(
      "#ff0000 #00FF00 #A1B2C3 #123456 ( #abcdef ) 色は#abcdefです",
    );

    expect(colorRanges(plugin, state).map(({ literal }) => literal)).toEqual([
      "#ff0000",
      "#00FF00",
      "#A1B2C3",
      "#123456",
      "#abcdef",
      "#abcdef",
    ]);
  });

  it.each([
    ["paragraph", "Paragraph #ff0000", "paragraph"],
    ["heading", "# Heading #00FF00", "heading"],
    ["blockquote", "> Quote #A1B2C3", "blockquote"],
    ["bullet list", "- Bullet #123456", "bullet_list"],
    ["ordered list", "1. Ordered #abcdef", "ordered_list"],
    ["table cell", "| Value |\n| --- |\n| #ABCDEF |", "table_cell"],
  ])("works in a %s", (_label, markdown, ancestor) => {
    const { plugin, state } = renderingState(markdown);
    const ranges = colorRanges(plugin, state);

    expect(ranges).toHaveLength(1);
    expect(ancestorNames(state.doc, ranges[0]!.from)).toContain(ancestor);
  });

  it.each([
    ["strong", "**#ff0000**", "strong"],
    ["emphasis", "*#00ff00*", "em"],
    ["strike", "~~#0000ff~~", "strike"],
  ])("composes with %s text", (_label, markdown, mark) => {
    const { plugin, state } = renderingState(markdown);
    const ranges = colorRanges(plugin, state);

    expect(ranges).toHaveLength(1);
    expect(marksAt(state.doc, ranges[0]!.from)).toContain(mark);
  });

  it("rejects unsupported lengths, digits, and ASCII token adjacency", () => {
    const { plugin, state } = renderingState(
      [
        "#fff",
        "#fffff",
        "#fffffff",
        "#ffffffff",
        "#gg0000",
        "abc#ff0000",
        "#ff0000abc",
        "abc_#123456",
        "#123456_xyz",
      ].join(" "),
    );

    expect(colorRanges(plugin, state)).toEqual([]);
  });

  it("checks token boundaries across adjacent marked text nodes", () => {
    const strong = schema.marks.strong!.create();
    const paragraph = schema.nodes.paragraph!.create(null, [
      schema.text("abc"),
      schema.text("#ff0000", [strong]),
      schema.text("xyz"),
    ]);
    const plugin = createRenderingPlugin();
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(null, paragraph),
      plugins: [plugin],
    });

    expect(colorRanges(plugin, state)).toEqual([]);
  });

  it("does not decorate inline code, fenced code, links, or raw atoms", () => {
    const parsed = renderingState(
      "`#ff0000` [#00ff00](https://example.com)\n\n```css\n#A1B2C3\n```",
    );
    expect(colorRanges(parsed.plugin, parsed.state)).toEqual([]);

    const rawInline = schema.nodes.raw_inline!.create({
      source: "#123456",
      kind: "html_inline",
    });
    const rawBlock = schema.nodes.raw_block!.create({
      source: "#abcdef",
      kind: "html_block",
    });
    const plugin = createRenderingPlugin();
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(null, [
        schema.nodes.paragraph!.create(null, rawInline),
        rawBlock,
      ]),
      plugins: [plugin],
    });
    expect(colorRanges(plugin, state)).toEqual([]);
  });

  it("uses only the validated literal in the inline style", () => {
    const { state } = renderingState(
      "#ff0000;background:url(javascript:alert(1))",
    );
    mount(state);

    const literal = document.querySelector<HTMLElement>(".mm-color-literal")!;
    expect(literal.dataset.mmColorLiteral).toBe("#ff0000");
    expect(literal.style.color).toBe("rgb(255, 0, 0)");
    expect(literal.getAttribute("style")).not.toContain("background");
  });

  it("appears at six digits, disappears at five, and updates its color", () => {
    const fixture = renderingState("#ff000");
    let state = fixture.state;
    expect(colorRanges(fixture.plugin, state)).toEqual([]);

    state = state.apply(state.tr.insertText("0", 7));
    expect(
      colorRanges(fixture.plugin, state).map(({ literal }) => literal),
    ).toEqual(["#ff0000"]);

    state = state.apply(state.tr.delete(7, 8));
    expect(colorRanges(fixture.plugin, state)).toEqual([]);

    state = state.apply(state.tr.insertText("0", 7));
    state = state.apply(state.tr.insertText("#00ff00", 1, 8));
    expect(
      colorRanges(fixture.plugin, state).map(({ literal }) => literal),
    ).toEqual(["#00ff00"]);
  });

  it("maps selection-only transactions without rescanning the document", () => {
    const scan = vi.spyOn(colorLiterals, "colorLiteralDecorations");
    const fixture = renderingState("Before #ff0000 after");
    scan.mockClear();

    const next = fixture.state.apply(
      fixture.state.tr.setSelection(TextSelection.create(fixture.state.doc, 2)),
    );

    expect(scan).not.toHaveBeenCalled();
    expect(colorRanges(fixture.plugin, next)).toEqual(
      colorRanges(fixture.plugin, fixture.state),
    );
  });

  it("follows document history without affecting undo or redo", () => {
    const fixture = renderingState("#ff000", "github", true);
    let state = fixture.state;
    const dispatch = (transaction: Parameters<typeof state.apply>[0]) => {
      state = state.apply(transaction);
    };

    dispatch(state.tr.insertText("0", 7));
    expect(colorRanges(fixture.plugin, state)).toHaveLength(1);
    expect(undo(state, dispatch)).toBe(true);
    expect(colorRanges(fixture.plugin, state)).toEqual([]);
    expect(redo(state, dispatch)).toBe(true);
    expect(
      colorRanges(fixture.plugin, state).map(({ literal }) => literal),
    ).toEqual(["#ff0000"]);
  });

  it("does not change Markdown serialization", () => {
    const source = "Color: #Aa12Ff";
    const fixture = renderingState(source);

    expect(serializeMarkdown(fixture.state.doc, fixture.snapshot)).toBe(source);
  });

  it.each<Profile>(["commonmark", "github", "gitlab"])(
    "provides the same authoring aid in the %s profile",
    (profile) => {
      const { plugin, state } = renderingState("Color: #A1B2C3", profile);
      expect(colorRanges(plugin, state).map(({ literal }) => literal)).toEqual([
        "#A1B2C3",
      ]);
    },
  );

  it("keeps heading, footnote, and code highlighting decorations", () => {
    const fixture = renderingState(
      '# Heading #ff0000\n\nReference[^one]\n\n```ts\nconst color = "#00ff00";\n```\n\n[^one]: Footnote',
    );
    mount(fixture.state);

    expect(document.querySelector("h1[data-mm-heading-id]")).not.toBeNull();
    expect(document.querySelectorAll(".mm-color-literal")).toHaveLength(1);
    expect(document.querySelector("pre .mm-color-literal")).toBeNull();
    expect(document.querySelector("[data-mm-syntax=true]")).not.toBeNull();
    expect(document.querySelector(".mm-rich-footnotes")).not.toBeNull();
  });
});
