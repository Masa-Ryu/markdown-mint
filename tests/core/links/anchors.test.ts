import { describe, expect, it } from "vitest";
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
