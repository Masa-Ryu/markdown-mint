import { describe, expect, it, vi } from "vitest";
import * as anchorModule from "../../../src/core/links/anchors";
import {
  collectHeadingAnchors,
  headingAnchorIds,
  parseMarkdown,
  renderMarkdownDocument,
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
