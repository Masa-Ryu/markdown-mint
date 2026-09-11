import { describe, expect, it } from "vitest";
import { CellSelection } from "prosemirror-tables";
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import {
  PROFILE_FEATURES,
  buildProfileFeatureSource,
  createProfileFeatureCommand,
  getProfileFeatures,
  type ProfileFeatureId,
  type ProfileFeatureProfile,
  type ProfileFeatureValues,
} from "../../src/webview/profileFeatures";
import {
  parseMarkdown,
  renderMarkdownDocument,
  schema,
  serializeMarkdown,
} from "../../src/core/index";

const core = { schema, parseMarkdown };

function stateFrom(
  source: string,
  profile: ProfileFeatureProfile = "github",
): EditorState {
  return EditorState.create({
    schema,
    doc: parseMarkdown(source, profile).doc,
  });
}

function textPosition(doc: PMNode, text: string, occurrence = 0): number {
  let seen = 0;
  let result: number | undefined;
  doc.descendants((node, position) => {
    if (result !== undefined || !node.isText || !node.text) return;
    const offset = node.text.indexOf(text);
    if (offset < 0) return;
    if (seen === occurrence) result = position + offset;
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

function selectRange(
  state: EditorState,
  startText: string,
  endText: string,
): EditorState {
  const from = textPosition(state.doc, startText);
  const end = textPosition(state.doc, endText) + endText.length;
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, from, end)),
  );
}

function run(
  state: EditorState,
  profile: "github" | "gitlab" | "commonmark",
  feature: ProfileFeatureId,
  values: ProfileFeatureValues = {},
): { state: EditorState; transactions: Transaction[] } {
  let dispatched: Transaction | undefined;
  const ran = createProfileFeatureCommand(
    core,
    profile,
    feature,
    values,
  )(state, (transaction) => {
    dispatched = transaction;
  });
  expect(ran).toBe(true);
  if (!dispatched) throw new Error("profile feature command did not dispatch");
  return { state: state.apply(dispatched), transactions: [dispatched] };
}

describe("profile feature catalog and source", () => {
  it("exposes common advanced features and GitLab-only features by profile", () => {
    expect(getProfileFeatures("commonmark")).toEqual([]);
    expect(getProfileFeatures("github").map((feature) => feature.id)).toEqual([
      "alert",
      "details",
      "math",
      "mermaid",
    ]);
    expect(getProfileFeatures("gitlab").map((feature) => feature.id)).toEqual(
      PROFILE_FEATURES.map((feature) => feature.id),
    );
  });

  it("builds safe profile syntax for every catalog feature", () => {
    expect(
      buildProfileFeatureSource(
        "alert",
        { alertType: "WARNING", body: "check" },
        "github",
      ),
    ).toBe("> [!WARNING]\n> check");
    const details = buildProfileFeatureSource(
      "details",
      { summary: "A <summary>", body: "body\n</details>" },
      "github",
    );
    expect(details).toContain("</details>");
    expect(details).not.toContain("&lt;/details>");
    expect(
      buildProfileFeatureSource("math", { expression: "x^2" }, "github"),
    ).toBe("$$\nx^2\n$$");
    expect(
      buildProfileFeatureSource("math", { expression: "x`y" }, "gitlab"),
    ).toBe("```math\nx`y\n```");
    expect(
      buildProfileFeatureSource("mermaid", { source: "A --> ``` B" }, "github"),
    ).toBe("````mermaid\nA --> ``` B\n````");
    expect(
      buildProfileFeatureSource("details", { body: "body" }, "github"),
    ).toBeNull();
    expect(buildProfileFeatureSource("gitlab-toc", {}, "gitlab")).toBe(
      "[[_TOC_]]",
    );
    expect(
      buildProfileFeatureSource(
        "gitlab-description-list",
        { term: "Term", definition: "Description\nAnother description" },
        "gitlab",
      ),
    ).toBe("Term\n: Description\n: Another description");
    expect(
      buildProfileFeatureSource(
        "gitlab-diff-added",
        { text: "added" },
        "gitlab",
      ),
    ).toBe("{+ added +}");
    expect(
      buildProfileFeatureSource(
        "gitlab-diff-added",
        { text: "A   &  B" },
        "gitlab",
      ),
    ).toBe("{+ A   &  B +}");
    expect(
      buildProfileFeatureSource(
        "gitlab-diff-added",
        { text: "line one\nline two" },
        "gitlab",
      ),
    ).toBeNull();
    expect(
      buildProfileFeatureSource(
        "gitlab-diff-removed",
        { text: "{+ ambiguous +}" },
        "gitlab",
      ),
    ).toBeNull();
  });

  it("parses generated blocks as the expected source-preserving raw atoms", () => {
    const cases: Array<
      [ProfileFeatureId, "github" | "gitlab", ProfileFeatureValues, string]
    > = [
      ["alert", "github", { body: "body" }, "alert"],
      ["details", "github", { summary: "More", body: "body" }, "details"],
      ["math", "github", { expression: "x" }, "math-block"],
      ["math", "gitlab", { expression: "x" }, "math-block"],
      ["mermaid", "gitlab", { source: "graph TD\nA-->B" }, "protected-fence"],
      ["gitlab-toc", "gitlab", {}, "gitlab-toc"],
      [
        "gitlab-description-list",
        "gitlab",
        { term: "Term", definition: "Definition" },
        "gitlab-description-list",
      ],
    ];
    for (const [feature, profile, values, kind] of cases) {
      const source = buildProfileFeatureSource(feature, values, profile);
      expect(source).toBeTruthy();
      const node = parseMarkdown(source!, profile).doc.firstChild;
      expect(node?.type.name).toBe("raw_block");
      expect(node?.attrs.kind).toBe(kind);
    }
  });
});

describe("profile feature insertion commands", () => {
  it("inserts a block and places the caret in the following paragraph", () => {
    const state = selectText(stateFrom("before\n\nAfter"), "before");
    const result = run(state, "github", "alert", { body: "body" });
    expect(result.transactions).toHaveLength(1);
    expect(result.state.doc.firstChild?.type.name).toBe("raw_block");
    expect(result.state.doc.firstChild?.attrs.kind).toBe("alert");
    expect(result.state.doc.child(1).textContent).toBe("After");
    expect(result.state.selection.$from.parent.textContent).toBe("After");
    expect(result.state.selection.from).toBeGreaterThanOrEqual(1);
  });

  it("inserts after a selected top-level raw block", () => {
    const initial = stateFrom("> [!NOTE]\n> existing\n\nAfter");
    const selected = initial.apply(
      initial.tr.setSelection(NodeSelection.create(initial.doc, 0)),
    );
    const next = run(selected, "github", "details", {
      summary: "More",
      body: "body",
    }).state;
    expect(next.doc.child(0)?.attrs.kind).toBe("alert");
    expect(next.doc.child(1)?.attrs.kind).toBe("details");
    expect(next.doc.child(2)?.textContent).toBe("After");
  });

  it("replaces pure top-level heading and paragraph ranges without duplication", () => {
    let heading = selectText(
      stateFrom("# Keep selected tail\n\nAfter"),
      "selected",
    );
    heading = run(heading, "github", "alert", { body: "heading body" }).state;
    expect(heading.doc.child(0)?.textContent).toBe("Keep ");
    expect(heading.doc.child(1)?.attrs.kind).toBe("alert");
    expect(heading.doc.child(2)?.textContent).toBe(" tail");
    expect(heading.doc.child(3)?.textContent).toBe("After");

    const selected = selectRange(
      stateFrom("Before\n\nselected one\n\nselected two\n\nAfter"),
      "selected one",
      "selected two",
    );
    const next = run(selected, "github", "alert", {
      body: "selected one\nselected two",
    }).state;
    expect(next.doc.childCount).toBe(3);
    expect(next.doc.child(0)?.textContent).toBe("Before");
    expect(next.doc.child(1)?.attrs.kind).toBe("alert");
    expect(next.doc.child(2)?.textContent).toBe("After");
  });

  it("keeps blocks outside a selected table or list", () => {
    let tableState = selectText(
      stateFrom("| Name | Value |\n| --- | --- |\n| Alpha | A |"),
      "Alpha",
    );
    tableState = run(tableState, "github", "details", {
      summary: "More",
      body: "body",
    }).state;
    expect(tableState.doc.firstChild?.type.name).toBe("table");
    expect(tableState.doc.child(1)?.type.name).toBe("raw_block");
    expect(tableState.doc.child(1)?.attrs.kind).toBe("details");

    let listState = selectText(stateFrom("- one\n- two"), "one");
    listState = run(listState, "github", "math", { expression: "x" }).state;
    expect(listState.doc.firstChild?.type.name).toBe("bullet_list");
    expect(listState.doc.child(1)?.type.name).toBe("raw_block");
  });

  it("applies GitLab inline diff while preserving marks and surrounding text", () => {
    let state = selectText(
      stateFrom("**before selected after**", "gitlab"),
      "selected",
    );
    state = run(state, "gitlab", "gitlab-diff-added", { text: "new" }).state;
    const paragraph = state.doc.firstChild!;
    expect(paragraph.textContent).toContain("before ");
    expect(paragraph.textContent).toContain(" after");
    const diff = paragraph.child(1)!;
    expect(diff.type.name).toBe("raw_inline");
    expect(diff.attrs.kind).toBe("gitlab-inline-diff");
    expect(diff.marks.some((mark) => mark.type.name === "strong")).toBe(true);
    expect(serializeMarkdown(state.doc)).toContain("{+ new +}");
  });

  it("supports caret/list/table-cell insertion while rejecting unsafe selections", () => {
    const github = selectText(stateFrom("text"), "text");
    expect(
      createProfileFeatureCommand(core, "commonmark", "alert", { body: "x" })(
        github,
      ),
    ).toBe(false);
    expect(
      createProfileFeatureCommand(core, "github", "gitlab-diff-added", {
        text: "x",
      })(github),
    ).toBe(false);

    const empty = stateFrom("text", "gitlab");
    const emptyResult = run(empty, "gitlab", "gitlab-diff-added", {
      text: "A & B",
    }).state;
    const emptyDiff = emptyResult.doc.firstChild?.firstChild;
    expect(emptyDiff?.type.name).toBe("raw_inline");
    expect(emptyDiff?.attrs.source).toBe("{+ A & B +}");
    expect(renderMarkdownDocument(emptyResult.doc, "gitlab")).toContain(
      "A &amp; B",
    );
    expect(renderMarkdownDocument(emptyResult.doc, "gitlab")).not.toContain(
      "&amp;amp",
    );

    let list = selectText(stateFrom("- one", "gitlab"), "one");
    list = run(list, "gitlab", "gitlab-diff-removed", { text: "item" }).state;
    expect(list.doc.firstChild?.type.name).toBe("bullet_list");
    expect(
      list.doc.firstChild?.firstChild?.firstChild?.firstChild?.type.name,
    ).toBe("raw_inline");

    let tableText = selectText(
      stateFrom("| A | B |\n| --- | --- |\n| a | b |", "gitlab"),
      "a",
    );
    tableText = run(tableText, "gitlab", "gitlab-diff-added", {
      text: "cell",
    }).state;
    expect(
      tableText.doc.firstChild?.child(1)?.firstChild?.firstChild?.firstChild
        ?.type.name,
    ).toBe("raw_inline");

    const code = selectText(stateFrom("```\ncode\n```", "gitlab"), "code");
    expect(
      createProfileFeatureCommand(core, "gitlab", "gitlab-diff-added", {
        text: "x",
      })(code),
    ).toBe(false);

    const table = selectText(
      stateFrom("| A | B |\n| --- | --- |\n| a | b |", "gitlab"),
      "a",
    );
    const cellPos = 2;
    const cellSelection = table.apply(
      table.tr.setSelection(CellSelection.create(table.doc, cellPos, cellPos)),
    );
    expect(
      createProfileFeatureCommand(core, "gitlab", "gitlab-diff-added", {
        text: "x",
      })(cellSelection),
    ).toBe(false);
  });

  it("inserts the profile-specific math atom for GitHub and GitLab", () => {
    for (const profile of ["github", "gitlab"] as const) {
      const next = run(
        selectText(stateFrom("before\n\nAfter", profile), "before"),
        profile,
        "math",
        { expression: "x^2" },
      ).state;
      const first = next.doc.firstChild!;
      expect(first.type.name).toBe("raw_block");
      expect(first.attrs.kind).toBe("math-block");
      expect(first.attrs.source).toContain(
        profile === "github" ? "$$" : "math",
      );
    }
  });

  it("rejects unbalanced details while preserving nested and fenced literal bodies", () => {
    const base = selectText(stateFrom("Before\n\nAfter"), "Before");
    const unbalanced = createProfileFeatureCommand(core, "github", "details", {
      summary: "More",
      body: "literal\n</details>",
    });
    expect(unbalanced(base)).toBe(false);

    const nestedBody =
      "<details>\n<summary>Nested</summary>\n\ninside\n\n</details>";
    const nestedSource = buildProfileFeatureSource(
      "details",
      { summary: "Outer", body: nestedBody },
      "github",
    );
    expect(nestedSource).toBeTruthy();
    const nested = run(base, "github", "details", {
      summary: "Outer",
      body: nestedBody,
    }).state;
    expect(nested.doc.firstChild?.attrs.source).toBe(nestedSource);

    const fencedBody = "```text\n</details>\n```";
    const fencedSource = buildProfileFeatureSource(
      "details",
      { summary: "Code", body: fencedBody },
      "github",
    );
    expect(fencedSource).toBeTruthy();
    const fenced = run(base, "github", "details", {
      summary: "Code",
      body: fencedBody,
    }).state;
    expect(fenced.doc.firstChild?.attrs.source).toBe(fencedSource);
  });

  it("keeps existing footnote source metadata when a block is inserted", () => {
    const source = "See [^1].\n\n[^1]: Footnote body\n\nAfter";
    const parsed = parseMarkdown(source, "github");
    const state = selectText(
      EditorState.create({ schema, doc: parsed.doc }),
      "After",
    );
    const next = run(state, "github", "alert", { body: "inserted" }).state;
    const serialized = serializeMarkdown(next.doc, parsed);
    expect(serialized).toContain("[^1]: Footnote body");
    expect(serialized).toContain("> [!NOTE]");
    expect(parseMarkdown(serialized, "github").footnotes?.[0]?.content).toBe(
      "Footnote body",
    );
  });
});
