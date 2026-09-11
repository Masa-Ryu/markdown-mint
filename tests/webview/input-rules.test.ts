import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CellSelection, TableMap } from "prosemirror-tables";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown, schema, serializeMarkdown } from "../../src/core";
import {
  createStarterPlugin,
  getStarterState,
  prepareStarterDocument,
  serializeStarterSource,
} from "../../src/webview/starter";
import { createWritingInputRules } from "../../src/webview/input-rules";

type Profile = "github" | "gitlab" | "commonmark";

interface ViewFixture {
  inputRules: ReturnType<typeof createWritingInputRules>;
  mount: HTMLElement;
  parsed: ReturnType<typeof parseMarkdown>;
  transactions: Transaction[];
  view: EditorView;
}

const fixtures: ViewFixture[] = [];

function makeView(
  source = "",
  profile: Profile = "github",
  doc = parseMarkdown(source, profile).doc,
  extraPlugins: ReturnType<typeof createStarterPlugin>[] = [],
): ViewFixture {
  const parsed = parseMarkdown(source, profile);
  const inputRules = createWritingInputRules(schema);
  const state = EditorState.create({
    schema,
    doc,
    plugins: [inputRules, ...extraPlugins],
  });
  const mount = document.createElement("div");
  document.body.append(mount);
  const transactions: Transaction[] = [];
  let view!: EditorView;
  view = new EditorView(mount, {
    state,
    dispatchTransaction: (transaction) => {
      transactions.push(transaction);
      view.updateState(view.state.apply(transaction));
    },
  });
  const fixture = { inputRules, mount, parsed, transactions, view };
  fixtures.push(fixture);
  return fixture;
}

function typeText(
  fixture: ViewFixture,
  text: string,
  fallback = true,
): { handled: boolean; transactionCount: number } {
  const { inputRules, transactions, view } = fixture;
  const before = transactions.length;
  const { from, to } = view.state.selection;
  const handled =
    inputRules.props.handleTextInput?.call(
      inputRules,
      view,
      from,
      to,
      text,
      () => view.state.tr.insertText(text, from, to),
    ) === true;
  if (!handled && fallback)
    view.dispatch(view.state.tr.insertText(text, from, to));
  return { handled, transactionCount: transactions.length - before };
}

function markdown(fixture: ViewFixture): string {
  return serializeMarkdown(fixture.view.state.doc, fixture.parsed);
}

function startOfLastBlock(fixture: ViewFixture): number {
  const last = fixture.view.state.doc.lastChild!;
  return fixture.view.state.doc.content.size - last.nodeSize + 1;
}

function hasTableAncestor(selection: TextSelection): boolean {
  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    const node = selection.$from.node(depth);
    if (node.type.spec.tableRole) return true;
  }
  return false;
}

beforeEach(() => {
  document.body.replaceChildren();
  if (!Range.prototype.getClientRects)
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  if (!Range.prototype.getBoundingClientRect)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
      }),
    });
});

afterEach(() => {
  for (const fixture of fixtures) fixture.view.destroy();
  fixtures.length = 0;
  document.body.replaceChildren();
});

describe("writing input rules", () => {
  it("turns Markdown markers into the matching block types with one transaction", () => {
    for (const [marker, nodeName, expected] of [
      ["# ", "heading", "# Title"],
      ["> ", "blockquote", "> Quote"],
      ["- ", "bullet_list", "- Item"],
      ["* ", "bullet_list", "- Item"],
      ["+ ", "bullet_list", "- Item"],
      ["3. ", "ordered_list", "3. Item"],
    ] as const) {
      const fixture = makeView();
      const result = typeText(fixture, marker);
      expect(result.handled).toBe(true);
      expect(result.transactionCount).toBe(1);
      expect(fixture.view.state.doc.firstChild?.type.name).toBe(nodeName);
      fixture.view.dispatch(
        fixture.view.state.tr.insertText(
          nodeName === "heading"
            ? "Title"
            : nodeName === "blockquote"
              ? "Quote"
              : "Item",
        ),
      );
      expect(markdown(fixture)).toBe(expected);
    }
  });

  it("accepts NBSP as the browser-delivered marker terminator", () => {
    for (const [marker, nodeName, expected] of [
      ["##\u00a0", "heading", "## Heading"],
      [">\u00a0", "blockquote", "> Quote"],
      ["-\u00a0", "bullet_list", "- Item"],
      ["2.\u00a0", "ordered_list", "2. Item"],
    ] as const) {
      const fixture = makeView();
      expect(typeText(fixture, marker).handled).toBe(true);
      expect(fixture.view.state.doc.firstChild?.type.name).toBe(nodeName);
      fixture.view.dispatch(
        fixture.view.state.tr.insertText(
          nodeName === "heading"
            ? "Heading"
            : nodeName === "blockquote"
              ? "Quote"
              : "Item",
        ),
      );
      expect(serializeMarkdown(fixture.view.state.doc)).toBe(expected);
    }
  });

  it("supports every heading level and the commonmark profile", () => {
    for (let level = 1; level <= 6; level += 1) {
      const fixture = makeView();
      const result = typeText(fixture, `${"#".repeat(level)} `);
      expect(result.handled).toBe(true);
      expect(fixture.view.state.doc.firstChild?.attrs.level).toBe(level);
    }

    const commonmark = makeView("", "commonmark");
    expect(typeText(commonmark, "## ").handled).toBe(true);
    commonmark.view.dispatch(commonmark.view.state.tr.insertText("Heading"));
    expect(markdown(commonmark)).toBe("## Heading");
  });

  it("only changes a paragraph marker at the line start", () => {
    const existing = makeView("Existing");
    expect(typeText(existing, "# ").handled).toBe(true);
    expect(existing.view.state.doc.firstChild?.type.name).toBe("heading");
    expect(markdown(existing)).toBe("# Existing");

    const middle = makeView("Existing");
    middle.view.dispatch(
      middle.view.state.tr.setSelection(
        TextSelection.create(middle.view.state.doc, 4),
      ),
    );
    expect(typeText(middle, "# ").handled).toBe(false);
    expect(middle.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(middle.view.state.doc.textContent).toBe("Exi# sting");
  });

  it("keeps markers literal in headings, code blocks, tables, and code marks", () => {
    const heading = makeView("# Existing");
    expect(typeText(heading, "# ").handled).toBe(false);
    expect(heading.view.state.doc.firstChild?.type.name).toBe("heading");
    expect(heading.view.state.doc.firstChild?.textContent).toContain("# ");

    const codeBlock = makeView("```js\ncode\n```");
    expect(typeText(codeBlock, "# ").handled).toBe(false);
    expect(codeBlock.view.state.doc.firstChild?.type.name).toBe("code_block");
    expect(codeBlock.view.state.doc.firstChild?.textContent).toContain("# ");

    const table = makeView("| A | B |\n| --- | --- |\n| C | D |");
    expect(table.view.state.selection).toBeInstanceOf(TextSelection);
    expect(hasTableAncestor(table.view.state.selection as TextSelection)).toBe(
      true,
    );
    expect(typeText(table, "# ").handled).toBe(false);
    expect(table.view.state.doc.firstChild?.type.name).toBe("table");
    let headingCount = 0;
    table.view.state.doc.descendants((node) => {
      if (node.type.name === "heading") headingCount += 1;
    });
    expect(headingCount).toBe(0);

    const codeMark = schema.marks.code!.create();
    const markedParagraph = schema.nodes.paragraph!.create(
      null,
      schema.text("#", [codeMark]),
    );
    const markedDoc = schema.topNodeType.create(null, [markedParagraph]);
    const marked = makeView("", "github", markedDoc);
    marked.view.dispatch(
      marked.view.state.tr.setSelection(
        TextSelection.create(marked.view.state.doc, 2),
      ),
    );
    expect(typeText(marked, " ").handled).toBe(false);
    expect(marked.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(marked.view.state.doc.firstChild?.firstChild?.marks).toContainEqual(
      codeMark,
    );

    const stored = makeView();
    stored.view.dispatch(
      stored.view.state.tr
        .setSelection(TextSelection.create(stored.view.state.doc, 1))
        .setStoredMarks([codeMark]),
    );
    expect(typeText(stored, "# ").handled).toBe(false);
    expect(stored.view.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("rejects unsafe ordered markers and preserves an ambiguous list literal", () => {
    for (const marker of ["0. ", "1234567890. "]) {
      const fixture = makeView();
      expect(typeText(fixture, marker).handled).toBe(false);
      expect(fixture.view.state.doc.firstChild?.type.name).toBe("paragraph");
      expect(fixture.view.state.doc.textContent).toBe(marker);
    }

    const mismatch = makeView("1. one\n\nSecond");
    mismatch.view.dispatch(
      mismatch.view.state.tr.setSelection(
        TextSelection.create(
          mismatch.view.state.doc,
          startOfLastBlock(mismatch),
        ),
      ),
    );
    expect(typeText(mismatch, "9. ").handled).toBe(false);
    expect(mismatch.view.state.doc.childCount).toBe(2);
    expect(mismatch.view.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(mismatch.view.state.doc.lastChild?.textContent).toBe("9. Second");

    const matching = makeView("1. one\n\nSecond");
    matching.view.dispatch(
      matching.view.state.tr.setSelection(
        TextSelection.create(
          matching.view.state.doc,
          startOfLastBlock(matching),
        ),
      ),
    );
    expect(typeText(matching, "2. ").handled).toBe(true);
    expect(matching.view.state.doc.firstChild?.type.name).toBe("ordered_list");
    expect(matching.view.state.doc.firstChild?.childCount).toBe(2);
    expect(serializeMarkdown(matching.view.state.doc)).toBe(
      "1. one\n2. Second",
    );
  });

  it("does not apply while an IME composition is active", () => {
    const fixture = makeView();
    fixture.view.dom.dispatchEvent(
      new Event("compositionstart", { bubbles: true }),
    );
    expect(fixture.view.composing).toBe(true);
    const result = typeText(fixture, "# ");
    expect(result.handled).toBe(false);
    expect(fixture.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(fixture.view.state.doc.firstChild?.textContent).toBe("# ");
  });

  it("does not retry against an external source after compositionend", async () => {
    const fixture = makeView();
    fixture.view.dom.dispatchEvent(
      new Event("compositionstart", { bubbles: true }),
    );
    expect(fixture.view.composing).toBe(true);
    expect(fixture.inputRules.props.handleDOMEvents?.compositionend).toBe(
      undefined,
    );

    // Model a pending host update whose escaped source `\#\# ` is represented
    // as ordinary paragraph text, including the marker terminator.
    const external = schema.topNodeType.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("## ")),
    ]);
    const externalState = EditorState.create({
      schema,
      doc: external,
      selection: TextSelection.atEnd(external),
      plugins: fixture.view.state.plugins,
    });
    fixture.view.updateState(externalState);
    expect(fixture.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(fixture.view.state.doc.firstChild?.textContent).toBe("## ");

    fixture.view.dom.dispatchEvent(
      new Event("compositionend", { bubbles: true }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(fixture.transactions).toHaveLength(0);
    expect(fixture.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(fixture.view.state.doc.firstChild?.textContent).toBe("## ");
  });

  it("does not serialize the untouched virtual starter H1 as a blank source", () => {
    const parsed = parseMarkdown("", "github");
    const prepared = prepareStarterDocument("", parsed.doc);
    const fixture = makeView("", "github", prepared.doc, [
      createStarterPlugin(prepared.state),
    ]);
    expect(getStarterState(fixture.view.state)?.untouched).toBe(true);
    expect(typeText(fixture, "# ").handled).toBe(false);
    expect(fixture.view.state.doc.firstChild?.type.name).toBe("heading");
    expect(fixture.view.state.doc.firstChild?.textContent).toBe("# ");
    expect(
      serializeStarterSource(
        fixture.view.state,
        "",
        serializeMarkdown(fixture.view.state.doc, parsed),
      ),
    ).toBe("# \\# ");
    expect(getStarterState(fixture.view.state)?.untouched).toBe(false);
  });

  it("does not add input-rule undo metadata when it transforms a marker", () => {
    const fixture = makeView();
    expect(typeText(fixture, "# ").handled).toBe(true);
    const last = fixture.transactions.at(-1)!;
    expect(last.getMeta(fixture.inputRules)).toBeUndefined();
  });

  it("does not reinterpret a cell selection as text input", () => {
    const fixture = makeView("| A | B |\n| --- | --- |\n| C | D |");
    const table = fixture.view.state.doc.firstChild!;
    const map = TableMap.get(table);
    const firstCellPos = map.map[0]! + 1;
    const lastCellPos = map.map[map.map.length - 1]! + 1;
    fixture.view.dispatch(
      fixture.view.state.tr.setSelection(
        CellSelection.create(fixture.view.state.doc, firstCellPos, lastCellPos),
      ),
    );
    expect(fixture.view.state.selection).toBeInstanceOf(CellSelection);
    expect(typeText(fixture, "# ", false).handled).toBe(false);
    expect(fixture.view.state.selection).toBeInstanceOf(CellSelection);
  });
});
