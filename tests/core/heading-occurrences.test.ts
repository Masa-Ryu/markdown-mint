import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import {
  headingAnchorIds,
  parseMarkdown,
  renderMarkdownDocument,
  renderNodeHtml,
  renderSourceFragment,
  type Profile,
} from "../../src/core/index";

function details(summary: string, body: string): string {
  return `<details open>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function htmlRoot(html: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

function headingIds(html: string): string[] {
  return Array.from(
    htmlRoot(html).querySelectorAll("h1,h2,h3"),
    (node) => node.id,
  );
}

describe("heading ids at shared Details body occurrences", () => {
  it.each<Profile>(["commonmark", "github", "gitlab"])(
    "keeps cached bodies while allocating distinct anchors in %s",
    (profile) => {
      const source = [details("A", "# Shared"), details("B", "# Shared")].join(
        "\n\n",
      );
      const snapshot = parseMarkdown(source, profile);
      expect(snapshot.doc.child(0).firstChild).toBe(
        snapshot.doc.child(1).firstChild,
      );
      const expected = ["shared", "shared-1"];
      expect(
        headingAnchorIds(snapshot.doc, profile).map((anchor) => anchor.id),
      ).toEqual(expected);
      expect(
        headingIds(renderMarkdownDocument(snapshot.doc, profile, snapshot)),
      ).toEqual(expected);
      expect(headingIds(renderNodeHtml(snapshot.doc, profile))).toEqual(
        expected,
      );
      expect(headingIds(renderSourceFragment(source, profile))).toEqual(
        expected,
      );
    },
  );

  it("uses the same occurrence ids for nested reused bodies, full HTML, and every TOC", () => {
    const nested = details("Inner", "## Shared");
    const body = `# Shared\n\n${nested}`;
    const source = [
      "[[_TOC_]]",
      "# Outside",
      details("A", body),
      details("B", body),
      "# Shared",
      "[[_TOC_]]",
    ].join("\n\n");
    const snapshot = parseMarkdown(source, "gitlab");
    expect(snapshot.doc.child(2).child(1)).toBe(snapshot.doc.child(3).child(1));
    const expected = [
      "outside",
      "shared",
      "shared-1",
      "shared-2",
      "shared-3",
      "shared-4",
    ];
    const root = htmlRoot(
      renderMarkdownDocument(snapshot.doc, "gitlab", snapshot),
    );
    expect(
      Array.from(root.querySelectorAll("h1,h2"), (node) => node.id),
    ).toEqual(expected);
    expect(
      headingAnchorIds(snapshot.doc, "gitlab").map((anchor) => anchor.id),
    ).toEqual(expected);
    for (const toc of root.querySelectorAll("nav")) {
      expect(
        Array.from(toc.querySelectorAll("a"), (link) =>
          link.getAttribute("href"),
        ),
      ).toEqual(expected.map((id) => `#${id}`));
    }
    expect(root.querySelectorAll("nav")).toHaveLength(2);
  });

  it("uses the supplied document position when rendering a shared heading or enclosing Details independently", () => {
    const body = `# Shared\n\n${details("Inner", "## Shared")}`;
    const snapshot = parseMarkdown(
      ["# Shared", details("A", body), details("B", body)].join("\n\n"),
      "github",
    );
    const anchors = headingAnchorIds(snapshot.doc);
    for (const anchor of anchors) {
      const node = snapshot.doc.nodeAt(anchor.position)!;
      expect(
        headingIds(
          renderNodeHtml(node, "github", {
            document: snapshot.doc,
            nodePosition: anchor.position,
          }),
        ),
      ).toEqual([anchor.id]);
    }
    const occurrences: Array<{ node: PMNode; position: number }> = [];
    snapshot.doc.descendants((node, position) => {
      if (node.type.name === "details") occurrences.push({ node, position });
    });
    for (const occurrence of occurrences) {
      const expected = anchors
        .filter(
          (anchor) =>
            anchor.position > occurrence.position &&
            anchor.position < occurrence.position + occurrence.node.nodeSize,
        )
        .map((anchor) => anchor.id);
      expect(
        headingIds(
          renderNodeHtml(occurrence.node, "github", {
            document: snapshot.doc,
            nodePosition: occurrence.position,
          }),
        ),
      ).toEqual(expected);
    }
  });

  it("keeps fragment positions separate from document positions while sharing the slug sequence", () => {
    const source = [
      details("A", "# Shared"),
      "> [!NOTE]\n> # Shared",
      details("B", "# Shared"),
    ].join("\n\n");
    const snapshot = parseMarkdown(source);
    expect(
      headingIds(renderMarkdownDocument(snapshot.doc, "github", snapshot)),
    ).toEqual(["shared", "shared-2", "shared-1"]);
    expect(headingAnchorIds(snapshot.doc).map((anchor) => anchor.id)).toEqual([
      "shared",
      "shared-1",
    ]);
  });
});
