import { describe, expect, it, vi } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import * as anchorModule from "../../../src/core/links/anchors";
import {
  collectHeadingAnchors,
  documentRenderContextKey,
  headingAnchorIds,
  parseMarkdown,
  renderFootnotesHtml,
  renderMarkdownDocument,
  renderNodeHtml,
  schema,
  type Profile,
} from "../../../src/core/index";

function renderedHeadingIds(html: string): string[] {
  const root = document.createElement("div");
  root.innerHTML = html;
  return Array.from(
    root.querySelectorAll("h1,h2,h3,h4,h5,h6"),
    (heading) => heading.id,
  );
}

function renderedHeadingTexts(html: string): string[] {
  const root = document.createElement("div");
  root.innerHTML = html;
  return Array.from(
    root.querySelectorAll("h1,h2,h3,h4,h5,h6"),
    (heading) => heading.textContent ?? "",
  );
}

describe("profile-aware heading anchors", () => {
  it.each<Profile>(["github", "gitlab", "commonmark"])(
    "keeps Unicode and uses document-wide final-id collision handling in %s",
    (profile) => {
      const source = [
        "# A",
        "# A",
        "# A-1",
        "# が",
        "# café",
        "# This heading has a :tada: in it",
        "# ![diagram](image.png)",
      ].join("\n\n");
      const snapshot = parseMarkdown(source, profile);
      const anchors = collectHeadingAnchors(snapshot, profile);

      expect(anchors.map((anchor) => anchor.id)).toEqual([
        "a",
        "a-1",
        "a-1-1",
        "が",
        "café",
        "this-heading-has-a-tada-in-it",
        "diagram",
      ]);
      expect(anchors.map((anchor) => anchor.displayText)).toEqual([
        "A",
        "A",
        "A-1",
        "が",
        "café",
        "This heading has a tada in it",
        "diagram",
      ]);
      expect(new Set(anchors.map((anchor) => anchor.occurrenceId)).size).toBe(
        anchors.length,
      );
      expect(
        anchors.every(
          (anchor) => anchor.verifiable === (profile !== "commonmark"),
        ),
      ).toBe(true);
      expect(
        anchors.every((anchor) =>
          profile === "commonmark"
            ? anchor.verification === "unknown"
            : anchor.verification === "verified",
        ),
      ).toBe(true);
      expect(
        renderedHeadingIds(
          renderMarkdownDocument(snapshot.doc, profile, snapshot),
        ),
      ).toEqual(anchors.map((anchor) => anchor.id));
    },
  );

  it("keeps GitLab spaces and existing hyphens instead of compressing them", () => {
    const snapshot = parseMarkdown("## A  B\n\n## A---B\n", "gitlab");
    expect(
      collectHeadingAnchors(snapshot, "gitlab").map((anchor) => anchor.id),
    ).toEqual(["a--b", "a---b"]);
  });

  it.each<Profile>(["github", "gitlab", "commonmark"])(
    "uses rendered text for Markdown inside safe HTML pairs in %s",
    (profile) => {
      const source = [
        "# _Hi_",
        "# <strong>_Hi_</strong>",
        "# <strong><em>_Hi_</em></strong>",
        "# <strong>`a_b`</strong>",
        "# <strong>a_b</strong>",
        "# <strong>\\_literal\\_</strong>",
      ].join("\n\n");
      const snapshot = parseMarkdown(source, profile);
      const anchors = collectHeadingAnchors(snapshot, profile);
      const rendered = renderMarkdownDocument(snapshot.doc, profile, snapshot);

      expect(
        anchors.map(({ displayText, id }) => ({ displayText, id })),
      ).toEqual([
        { displayText: "Hi", id: "hi" },
        { displayText: "Hi", id: "hi-1" },
        { displayText: "Hi", id: "hi-2" },
        { displayText: "a_b", id: "a_b" },
        { displayText: "a_b", id: "a_b-1" },
        { displayText: "_literal_", id: "_literal_" },
      ]);
      expect(renderedHeadingTexts(rendered)).toEqual([
        "Hi",
        "Hi",
        "Hi",
        "a_b",
        "a_b",
        "_literal_",
      ]);
      expect(renderedHeadingIds(rendered)).toEqual(
        anchors.map((anchor) => anchor.id),
      );
      expect(new Set(renderedHeadingIds(rendered)).size).toBe(anchors.length);
    },
  );

  it.each<Profile>(["github", "gitlab", "commonmark"])(
    "keeps HTML pair anchor text aligned with protected literals in %s",
    (profile) => {
      const source = [
        "# Example `<strong>OLD</strong>` and <strong>KEEP</strong>.",
        "# Example <strong>A `</strong>` KEEP</strong>.",
      ].join("\n\n");
      const snapshot = parseMarkdown(source, profile);
      const anchors = collectHeadingAnchors(snapshot, profile);
      const rendered = renderMarkdownDocument(snapshot.doc, profile, snapshot);

      expect(anchors.map((anchor) => anchor.displayText)).toEqual([
        "Example <strong>OLD</strong> and KEEP.",
        "Example A </strong> KEEP.",
      ]);
      expect(renderedHeadingTexts(rendered)).toEqual(
        anchors.map((anchor) => anchor.displayText),
      );
      expect(renderedHeadingIds(rendered)).toEqual(
        anchors.map((anchor) => anchor.id),
      );
    },
  );

  it("does not reuse an inherited anchor map from another profile", () => {
    const snapshot = parseMarkdown("# A  B", "gitlab");
    const githubSnapshot = parseMarkdown("# A  B", "github");
    const githubAnchor = collectHeadingAnchors(githubSnapshot, "github")[0]!;
    const html = renderMarkdownDocument(snapshot.doc, "gitlab", {
      document: snapshot.doc,
      profile: "github",
      headingAnchors: new Map([[githubAnchor.occurrenceId, githubAnchor]]),
    });

    expect(renderedHeadingIds(html)).toEqual(["a--b"]);
  });

  it("uses the historical display-only CommonMark shape without claiming standard fragments", () => {
    const snapshot = parseMarkdown("## A  B\n\n## café\n", "commonmark");
    const anchors = collectHeadingAnchors(snapshot, "commonmark");
    expect(anchors.map((anchor) => anchor.id)).toEqual(["a-b", "café"]);
    expect(anchors.every((anchor) => !anchor.verifiable)).toBe(true);
  });

  it("includes source-backed Alert headings in rendered order", () => {
    const source = ["# A", "> [!NOTE]\n> # A", "# A"].join("\n\n");
    const snapshot = parseMarkdown(source, "github");
    const anchors = collectHeadingAnchors(snapshot, "github");

    expect(anchors.map((anchor) => anchor.id)).toEqual(["a", "a-1", "a-2"]);
    expect(
      anchors.some((anchor) => anchor.renderRoot.startsWith("fragment:")),
    ).toBe(true);
    expect(
      headingAnchorIds(snapshot.doc, "github").map((anchor) => anchor.id),
    ).toEqual(["a", "a-2"]);
    expect(
      renderedHeadingIds(
        renderMarkdownDocument(snapshot.doc, "github", snapshot),
      ),
    ).toEqual(["a", "a-1", "a-2"]);
  });

  it("collects the parent document once when rendering multiple source fragments", () => {
    const source = [
      "# Main",
      "> [!NOTE]\n> # Alert one",
      "> [!TIP]\n> # Alert two",
    ].join("\n\n");
    const snapshot = parseMarkdown(source, "github");
    const collectSpy = vi.spyOn(anchorModule, "collectHeadingAnchors");

    try {
      expect(
        renderedHeadingIds(
          renderMarkdownDocument(snapshot.doc, "github", snapshot),
        ),
      ).toEqual(["main", "alert-one", "alert-two"]);
      expect(collectSpy).toHaveBeenCalledTimes(1);
    } finally {
      collectSpy.mockRestore();
    }
  });

  it("shares document render context and caches unchanged footnote fragments", () => {
    const source = [
      "# Main",
      "",
      "Ordinary paragraph.",
      "",
      "References [^first] and [^second].",
      "",
      "[^first]: # Footnote heading",
      "",
      "[^second]: Second footnote body.",
    ].join("\n");
    const snapshot = parseMarkdown(source, "github");
    const collectSpy = vi.spyOn(anchorModule, "collectHeadingAnchors");

    try {
      const initialKey = documentRenderContextKey(snapshot.doc, "github");
      renderMarkdownDocument(snapshot.doc, "github", snapshot);
      headingAnchorIds(snapshot.doc, "github");
      renderFootnotesHtml(snapshot.doc, "github", snapshot.doc);
      let firstReference: Parameters<typeof renderNodeHtml>[0] | undefined;
      snapshot.doc.descendants((node) => {
        if (
          !firstReference &&
          node.type.name === "raw_inline" &&
          node.attrs.kind === "footnote_ref"
        )
          firstReference = node;
      });
      if (firstReference)
        renderNodeHtml(firstReference, "github", snapshot.doc);
      expect(collectSpy).toHaveBeenCalledTimes(1);

      const firstOptions = collectSpy.mock.calls[0]?.[2];
      const firstDefinition = snapshot.footnotes?.[0];
      expect(firstOptions?.parseFootnote).toBeTypeOf("function");
      expect(firstDefinition).toBeDefined();
      const originalFragment = firstOptions!.parseFootnote!(
        firstDefinition!,
        "github",
      );

      const children: PMNode[] = [];
      snapshot.doc.forEach((node) => children.push(node));
      children[1] = schema.nodes.paragraph!.create(
        null,
        schema.text("Edited paragraph."),
      );
      const editedDocument = schema.topNodeType.create(null, children);
      expect(documentRenderContextKey(editedDocument, "github")).toBe(
        initialKey,
      );
      renderMarkdownDocument(editedDocument, "github");
      expect(collectSpy).toHaveBeenCalledTimes(2);

      const updatedOptions = collectSpy.mock.calls[1]?.[2];
      expect(updatedOptions!.parseFootnote!(firstDefinition!, "github")).toBe(
        originalFragment,
      );
      expect(
        updatedOptions!.parseFootnote!(firstDefinition!, "gitlab"),
      ).not.toBe(originalFragment);

      const changedHeading = schema.nodes.heading!.create(
        { level: 1 },
        schema.text("Changed heading"),
      );
      children[0] = changedHeading;
      const changedDocument = schema.topNodeType.create(null, children);
      expect(documentRenderContextKey(changedDocument, "github")).not.toBe(
        initialKey,
      );

      const reorderedReferences = parseMarkdown(
        source.replace(
          "References [^first] and [^second].",
          "References [^second] and [^first].",
        ),
        "github",
      );
      expect(
        documentRenderContextKey(reorderedReferences.doc, "github"),
      ).not.toBe(initialKey);

      const changedFootnote = parseMarkdown(
        source.replace("# Footnote heading", "# Updated footnote heading"),
        "github",
      );
      expect(documentRenderContextKey(changedFootnote.doc, "github")).not.toBe(
        initialKey,
      );
    } finally {
      collectSpy.mockRestore();
    }
  });

  it("shares one context for a 100-heading and 100-footnote document", () => {
    const headings = Array.from(
      { length: 100 },
      (_, index) => "# Heading " + (index + 1),
    );
    const references = Array.from(
      { length: 100 },
      (_, index) =>
        "Paragraph " + (index + 1) + " [^note-" + (index + 1) + "].",
    );
    const definitions = Array.from(
      { length: 100 },
      (_, index) =>
        "[^note-" + (index + 1) + "]: Note body " + (index + 1) + ".",
    );
    const snapshot = parseMarkdown(
      [...headings, "Ordinary paragraph.", ...references, ...definitions].join(
        "\n\n",
      ),
      "github",
    );
    const collectSpy = vi.spyOn(anchorModule, "collectHeadingAnchors");

    try {
      const initialKey = documentRenderContextKey(snapshot.doc, "github");
      renderMarkdownDocument(snapshot.doc, "github", snapshot);
      renderFootnotesHtml(snapshot.doc, "github", snapshot.doc);
      expect(headingAnchorIds(snapshot.doc, "github")).toHaveLength(100);

      const referencesInDocument: Array<{ node: PMNode; position: number }> =
        [];
      snapshot.doc.descendants((node, position) => {
        if (
          node.type.name === "raw_inline" &&
          node.attrs.kind === "footnote_ref"
        )
          referencesInDocument.push({ node, position });
      });
      expect(referencesInDocument).toHaveLength(100);
      expect(
        renderNodeHtml(referencesInDocument[0]!.node, "github", {
          document: snapshot.doc,
          nodePosition: referencesInDocument[0]!.position,
        }),
      ).toContain(">1</a>");
      expect(
        renderNodeHtml(referencesInDocument[99]!.node, "github", {
          document: snapshot.doc,
          nodePosition: referencesInDocument[99]!.position,
        }),
      ).toContain(">100</a>");
      expect(collectSpy).toHaveBeenCalledTimes(1);

      const children: PMNode[] = [];
      snapshot.doc.forEach((node) => children.push(node));
      children[100] = schema.nodes.paragraph!.create(
        null,
        schema.text("Ordinary paragraph edited."),
      );
      const editedDocument = schema.topNodeType.create(null, children);
      expect(documentRenderContextKey(editedDocument, "github")).toBe(
        initialKey,
      );
      expect(
        renderFootnotesHtml(editedDocument, "github", editedDocument),
      ).toContain("Note body 100.");
      expect(collectSpy).toHaveBeenCalledTimes(2);
    } finally {
      collectSpy.mockRestore();
    }
  });

  it("includes headings in a source-preserving Details fallback", () => {
    const source = [
      "# A",
      "<details>\n<p>Custom header</p>\n<summary>Title</summary>\n\n# A\n</details>",
      "# A",
    ].join("\n\n");
    const snapshot = parseMarkdown(source, "github");
    expect(snapshot.doc.child(1).type.name).toBe("raw_block");

    const anchors = collectHeadingAnchors(snapshot, "github");
    expect(anchors.map((anchor) => anchor.id)).toEqual(["a", "a-1", "a-2"]);
    expect(
      renderedHeadingIds(
        renderMarkdownDocument(snapshot.doc, "github", snapshot),
      ),
    ).toEqual(["a", "a-1", "a-2"]);
  });

  it("allocates unique anchors for rendered footnote headings", () => {
    const source = [
      "# Main",
      "",
      "First paragraph.",
      "",
      "Second paragraph with Text[^first] and Text[^second].",
      "",
      "[^first]: # Footnote heading",
      "",
      "[^second]: # Footnote heading",
    ].join("\n");
    const snapshot = parseMarkdown(source, "github");
    expect(snapshot.footnotes?.map((footnote) => footnote.content)).toEqual([
      "# Footnote heading",
      "# Footnote heading",
    ]);
    const anchors = collectHeadingAnchors(snapshot, "github");
    const rendered = renderedHeadingIds(
      renderMarkdownDocument(snapshot.doc, "github", snapshot),
    );

    expect(anchors.map(({ displayText, id }) => ({ displayText, id }))).toEqual(
      [
        { displayText: "Main", id: "main" },
        { displayText: "Footnote heading", id: "footnote-heading" },
        { displayText: "Footnote heading", id: "footnote-heading-1" },
      ],
    );
    expect(rendered).toEqual(anchors.map((anchor) => anchor.id));
    expect(new Set(rendered).size).toBe(rendered.length);
    expect(
      anchors
        .slice(1)
        .every((anchor) => anchor.renderRoot.startsWith("footnote:")),
    ).toBe(true);
  });

  it("uses the same collection for GitLab TOC links", () => {
    const source = ["[[_TOC_]]", "# A", "> [!NOTE]\n> # A", "# A"].join("\n\n");
    const snapshot = parseMarkdown(source, "gitlab");
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownDocument(snapshot.doc, "gitlab", snapshot);

    expect(
      Array.from(
        root.querySelectorAll<HTMLAnchorElement>(".table-of-contents a[href]"),
        (link) => link.getAttribute("href"),
      ),
    ).toEqual(["#a", "#a-1", "#a-2"]);
  });

  it("keeps footnote headings out of the GitLab table of contents", () => {
    const source = [
      "[[_TOC_]]",
      "# Main",
      "",
      "Text[^note].",
      "",
      "[^note]: # Footnote heading",
    ].join("\n");
    const snapshot = parseMarkdown(source, "gitlab");
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownDocument(snapshot.doc, "gitlab", snapshot);

    expect(
      Array.from(
        root.querySelectorAll<HTMLAnchorElement>(".table-of-contents a[href]"),
        (link) => link.getAttribute("href"),
      ),
    ).toEqual(["#main"]);
    expect(renderedHeadingIds(root.innerHTML)).toEqual([
      "main",
      "footnote-heading",
    ]);
  });

  it("keeps reused Details nodes separate by path rather than object identity", () => {
    const details = (label: string): string =>
      `<details open>\n<summary>${label}</summary>\n\n# Shared\n\n</details>`;
    const snapshot = parseMarkdown([details("A"), details("B")].join("\n\n"));
    const anchors = collectHeadingAnchors(snapshot, "github");

    expect(snapshot.doc.child(0).firstChild).toBe(
      snapshot.doc.child(1).firstChild,
    );
    expect(anchors.map((anchor) => anchor.id)).toEqual(["shared", "shared-1"]);
    expect(
      new Set(anchors.map((anchor) => anchor.nodePath.join("/"))).size,
    ).toBe(2);
  });
});
