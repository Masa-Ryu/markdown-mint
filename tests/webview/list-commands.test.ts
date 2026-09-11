import { describe, expect, it } from "vitest";
import {
  AllSelection,
  EditorState,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import {
  activeListKind,
  createListCommand,
  isListActive,
  listKindForNode,
  type ListKind,
} from "../../src/webview/listCommands";
import { schema } from "../../src/core/index";

function paragraph(text: string, strong = false): PMNode {
  const mark = strong ? [schema.marks.strong!.create()] : undefined;
  return schema.nodes.paragraph!.create(null, schema.text(text, mark));
}

function heading(text: string): PMNode {
  return schema.nodes.heading!.create({ level: 1 }, schema.text(text));
}

function emptyParagraph(): PMNode {
  return schema.nodes.paragraph!.create();
}

function item(
  content: PMNode | PMNode[],
  checked: boolean | "mixed" | null = null,
): PMNode {
  const children = Array.isArray(content) ? content : [content];
  return schema.nodes.list_item!.create({ checked }, children);
}

function list(kind: "bullet" | "ordered", items: PMNode[], order = 1): PMNode {
  const type =
    kind === "bullet" ? schema.nodes.bullet_list! : schema.nodes.ordered_list!;
  return type.create(kind === "ordered" ? { order } : null, items);
}

function documentOf(...nodes: PMNode[]): PMNode {
  return schema.topNodeType.create(null, nodes);
}

function stateOf(doc: PMNode): EditorState {
  return EditorState.create({ schema, doc });
}

function textPosition(doc: PMNode, text: string, occurrence = 0): number {
  let seen = 0;
  let result: number | undefined;
  doc.descendants((node, pos) => {
    if (result !== undefined || !node.isText || !node.text) return;
    const offset = node.text.indexOf(text);
    if (offset < 0) return;
    if (seen === occurrence) result = pos + offset;
    seen += 1;
  });
  if (result === undefined) throw new Error(`text not found: ${text}`);
  return result;
}

function selectText(
  state: EditorState,
  text: string,
  occurrence = 0,
): EditorState {
  const from = textPosition(state.doc, text, occurrence);
  return state.apply(
    state.tr.setSelection(
      TextSelection.create(state.doc, from, from + text.length),
    ),
  );
}

function run(state: EditorState, kind: ListKind): EditorState {
  let dispatched: Transaction | undefined;
  const command = createListCommand(kind, schema);
  expect(
    command(state, (tr) => {
      dispatched = tr;
    }),
  ).toBe(true);
  if (!dispatched) throw new Error("command did not dispatch a transaction");
  return state.apply(dispatched);
}

function runMaybe(
  state: EditorState,
  kind: ListKind,
): { state: EditorState; ran: boolean } {
  let dispatched: Transaction | undefined;
  const ran = createListCommand(kind, schema)(state, (tr) => {
    dispatched = tr;
  });
  return { state: dispatched ? state.apply(dispatched) : state, ran };
}

describe("list toolbar commands", () => {
  it("wraps paragraphs and toggles a bullet list back to paragraphs", () => {
    let state = selectText(
      stateOf(documentOf(paragraph("alpha", true))),
      "alpha",
    );

    state = run(state, "bullet");
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).child(0).textContent).toBe("alpha");
    expect(
      state.doc.child(0).child(0).child(0).firstChild?.marks[0]?.type.name,
    ).toBe("strong");
    expect(isListActive(state, "bullet")).toBe(true);

    state = run(state, "bullet");
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).textContent).toBe("alpha");
    expect(activeListKind(state)).toBeNull();
  });

  it("wraps a heading as a paragraph while retaining its inline content", () => {
    let state = selectText(stateOf(documentOf(heading("Heading"))), "Heading");
    state = run(state, "bullet");
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).child(0).textContent).toBe("Heading");

    state = run(state, "bullet");
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).textContent).toBe("Heading");
  });

  it("wraps multiple selected paragraphs as sibling list items", () => {
    let state = stateOf(
      documentOf(paragraph("one"), paragraph("two"), paragraph("three")),
    );
    state = selectText(state, "one");
    const from = state.selection.from;
    const to = textPosition(state.doc, "two") + "two".length;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, from, to)),
    );
    state = run(state, "ordered");

    expect(state.doc.childCount).toBe(2);
    expect(state.doc.child(0).type.name).toBe("ordered_list");
    expect(state.doc.child(0).childCount).toBe(2);
    expect(state.doc.child(0).child(0).textContent).toBe("one");
    expect(state.doc.child(0).child(1).textContent).toBe("two");
    expect(state.doc.child(1).textContent).toBe("three");
  });

  it("converts only selected sibling items without nesting or moving neighbors", () => {
    let state = stateOf(
      documentOf(
        list("bullet", [
          item(paragraph("first")),
          item(paragraph("second")),
          item(paragraph("third")),
        ]),
      ),
    );
    state = selectText(state, "second");
    state = run(state, "ordered");

    expect(state.doc.childCount).toBe(3);
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(1).type.name).toBe("ordered_list");
    expect(state.doc.child(2).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).textContent).toBe("first");
    expect(state.doc.child(1).child(0).textContent).toBe("second");
    expect(state.doc.child(2).child(0).textContent).toBe("third");
    expect(state.doc.child(1).child(0).childCount).toBe(1);
  });

  it("converts a contiguous partial selection of list items as one sibling list", () => {
    let state = stateOf(
      documentOf(
        list("bullet", [
          item(paragraph("first")),
          item(paragraph("middle one")),
          item(paragraph("middle two")),
          item(paragraph("last")),
        ]),
      ),
    );
    state = selectText(state, "middle one");
    const from = state.selection.from;
    const to = textPosition(state.doc, "middle two") + "middle two".length;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, from, to)),
    );
    state = run(state, "ordered");

    expect(state.doc.childCount).toBe(3);
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(1).type.name).toBe("ordered_list");
    expect(state.doc.child(1).childCount).toBe(2);
    expect(state.doc.child(2).type.name).toBe("bullet_list");
    expect(state.doc.child(0).textContent).toBe("first");
    expect(state.doc.child(1).textContent).toBe("middle onemiddle two");
    expect(state.doc.child(2).textContent).toBe("last");
  });

  it("keeps the selected item focused after a split so the next click toggles it", () => {
    let state = stateOf(
      documentOf(
        list("bullet", [
          item(paragraph("before")),
          item(paragraph("selected")),
          item(paragraph("after")),
        ]),
      ),
    );
    state = selectText(state, "selected");
    state = run(state, "ordered");
    expect(
      state.doc.textBetween(state.selection.from, state.selection.to),
    ).toBe("selected");

    state = run(state, "ordered");
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(1).type.name).toBe("paragraph");
    expect(state.doc.child(1).textContent).toBe("selected");
    expect(state.doc.child(2).type.name).toBe("bullet_list");
  });

  it("applies and toggles task lists using unchecked list-item attributes", () => {
    let state = selectText(stateOf(documentOf(paragraph("todo"))), "todo");
    state = run(state, "task");
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).attrs.checked).toBe(false);
    expect(activeListKind(state)).toBe("task");

    state = run(state, "task");
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).textContent).toBe("todo");
  });

  it("converts a selected plain item to a task while preserving checked neighbors", () => {
    let state = stateOf(
      documentOf(
        list("bullet", [
          item(paragraph("plain")),
          item(paragraph("checked"), true),
        ]),
      ),
    );
    state = selectText(state, "plain");
    state = run(state, "task");

    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).attrs.checked).toBe(false);
    expect(state.doc.child(0).child(1).attrs.checked).toBe(true);
  });

  it("preserves nested lists when converting the containing item", () => {
    const nested = list("bullet", [item(paragraph("nested"))]);
    let state = stateOf(
      documentOf(
        list("bullet", [
          item([paragraph("outer"), nested]),
          item(paragraph("sibling")),
        ]),
      ),
    );
    state = selectText(state, "outer");
    state = run(state, "ordered");

    expect(state.doc.childCount).toBe(2);
    expect(state.doc.child(0).type.name).toBe("ordered_list");
    expect(state.doc.child(0).child(0).child(1).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).child(1).child(0).textContent).toBe(
      "nested",
    );
    expect(state.doc.child(1).type.name).toBe("bullet_list");
    expect(state.doc.child(1).child(0).textContent).toBe("sibling");
  });

  it("toggles a converted nested item back into its parent list level", () => {
    const nested = list("bullet", [
      item(paragraph("child", true)),
      item(paragraph("sibling")),
    ]);
    let state = stateOf(
      documentOf(
        list("bullet", [
          item([paragraph("parent"), nested]),
          item(paragraph("tail")),
        ]),
      ),
    );
    state = selectText(state, "child");
    state = run(state, "ordered");
    expect(state.doc.child(0).child(0).child(1).type.name).toBe("ordered_list");
    expect(
      state.doc.textBetween(state.selection.from, state.selection.to),
    ).toBe("child");

    state = run(state, "ordered");
    expect(
      state.doc.textBetween(state.selection.from, state.selection.to),
    ).toBe("child");
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).textContent).toContain("parent");
    expect(state.doc.child(0).child(0).child(1).type.name).toBe("paragraph");
    expect(state.doc.child(0).child(0).child(1).textContent).toBe("child");
    expect(state.doc.child(0).child(0).child(2).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).child(2).child(0).textContent).toBe(
      "sibling",
    );
    expect(state.doc.child(0).child(1).textContent).toBe("tail");
  });

  it("reports active kinds only when selected items agree", () => {
    let state = selectText(
      stateOf(
        documentOf(
          list("bullet", [item(paragraph("one")), item(paragraph("two"))]),
        ),
      ),
      "one",
    );
    expect(activeListKind(state)).toBe("bullet");
    expect(isListActive(state, "bullet")).toBe(true);
    expect(isListActive(state, "ordered")).toBe(false);

    state = run(state, "task");
    expect(activeListKind(state)).toBe("task");
  });

  it("supports Meta+A all-document selection for applying and removing lists", () => {
    let state = stateOf(documentOf(paragraph("alpha"), paragraph("beta")));
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    state = run(state, "task");
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).attrs.checked).toBe(false);
    expect(state.doc.child(0).child(1).attrs.checked).toBe(false);

    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    state = run(state, "task");
    expect(state.doc.childCount).toBe(2);
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(1).type.name).toBe("paragraph");
    expect(state.doc.textContent).toBe("alphabeta");
  });

  it("includes empty boundary paragraphs in an all-document list selection", () => {
    let state = stateOf(
      documentOf(emptyParagraph(), paragraph("middle"), emptyParagraph()),
    );
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    state = run(state, "task");

    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(0).childCount).toBe(3);
    expect(state.doc.child(0).child(0).attrs.checked).toBe(false);
    expect(state.doc.child(0).child(1).textContent).toBe("middle");
    expect(state.doc.child(0).child(2).attrs.checked).toBe(false);
  });

  it("wraps selected paragraph children inside a blockquote", () => {
    const quote = schema.nodes.blockquote!.create(null, [
      paragraph("quoted one"),
      paragraph("quoted two"),
    ]);
    let state = stateOf(documentOf(quote));
    state = selectText(state, "quoted one");
    const from = state.selection.from;
    const to = textPosition(state.doc, "quoted two") + "quoted two".length;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, from, to)),
    );
    state = run(state, "bullet");

    expect(state.doc.child(0).type.name).toBe("blockquote");
    expect(state.doc.child(0).childCount).toBe(1);
    expect(state.doc.child(0).child(0).type.name).toBe("bullet_list");
    expect(state.doc.child(0).child(0).childCount).toBe(2);
    expect(state.doc.child(0).child(0).textContent).toBe(
      "quoted onequoted two",
    );
  });

  it("leaves code blocks unchanged instead of forcing them into list items", () => {
    const code = schema.nodes.code_block!.create(
      null,
      schema.text("const x = 1;"),
    );
    const state = selectText(stateOf(documentOf(code)), "const x = 1;");
    const result = runMaybe(state, "bullet");
    expect(result.ran).toBe(false);
    expect(result.state.doc.eq(state.doc)).toBe(true);
  });

  it("classifies homogeneous list nodes and rejects mixed task state", () => {
    const bullet = list("bullet", [item(paragraph("a")), item(paragraph("b"))]);
    const task = list("bullet", [
      item(paragraph("a"), false),
      item(paragraph("b"), true),
    ]);
    const mixed = list("bullet", [
      item(paragraph("a"), false),
      item(paragraph("b")),
    ]);
    expect(listKindForNode(bullet)).toBe("bullet");
    expect(listKindForNode(task)).toBe("task");
    expect(listKindForNode(mixed)).toBeNull();
  });

  it("keeps ordered-list numbering when a middle item is converted", () => {
    let state = stateOf(
      documentOf(
        list(
          "ordered",
          [
            item(paragraph("one")),
            item(paragraph("two")),
            item(paragraph("three")),
          ],
          4,
        ),
      ),
    );
    state = selectText(state, "two");
    state = run(state, "bullet");

    expect(state.doc.child(0).attrs.order).toBe(4);
    expect(state.doc.child(1).type.name).toBe("bullet_list");
    expect(state.doc.child(2).attrs.order).toBe(6);
  });
});
