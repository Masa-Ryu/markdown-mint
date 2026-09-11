import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import {
  headingAnchorIds,
  parseMarkdown,
  renderFootnotesHtml,
  renderMarkdownDocument,
  renderNodeHtml,
  schema,
  serializeMarkdown,
  type Profile,
} from "../../src/core/index";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL("../fixtures/" + name, import.meta.url)),
    "utf8",
  );
}

function walk(node: PMNode, visit: (node: PMNode) => void): void {
  visit(node);
  node.forEach((child) => walk(child, visit));
}

function nodesOf(doc: PMNode): PMNode[] {
  const nodes: PMNode[] = [];
  walk(doc, (node) => nodes.push(node));
  return nodes;
}

function countKind(doc: PMNode, nodeType: string, kind: string): number {
  return nodesOf(doc).filter(
    (node) =>
      node.type.name === nodeType && String(node.attrs.kind ?? "") === kind,
  ).length;
}

function topLevelChildren(doc: PMNode): PMNode[] {
  const children: PMNode[] = [];
  doc.forEach((child) => children.push(child));
  return children;
}

describe("Markdown semantic fixture coverage", () => {
  const fixtures: Array<{
    file: string;
    profile: Profile;
    heading: string;
  }> = [
    {
      file: "semantic-common.md",
      profile: "commonmark",
      heading: "markdown-rich-editor-test",
    },
    {
      file: "semantic-github.md",
      profile: "github",
      heading: "github-markdown-test",
    },
    {
      file: "semantic-gitlab.md",
      profile: "gitlab",
      heading: "gitlab-markdown-test",
    },
  ];

  it.each(fixtures)(
    "preserves and renders $profile fixture semantics",
    ({ file, profile, heading }) => {
      const source = fixture(file);
      const snapshot = parseMarkdown(source, profile);
      const html = renderMarkdownDocument(snapshot.doc, profile, snapshot);

      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
      expect(html).toContain('<h1 id="' + heading + '">');
      expect(html).toContain('class="mm-code-block"');
      for (const comment of source.match(/<!--[\s\S]*?-->/g) ?? [])
        expect(html).not.toContain(comment);

      const anchors = headingAnchorIds(snapshot.doc, profile);
      expect(anchors.length).toBeGreaterThan(0);
      expect(anchors[0]?.id).toBe(heading);
      expect(html).toContain('id="' + anchors[0]?.id + '"');
      expect(countKind(snapshot.doc, "raw_inline", "footnote_ref")).toBe(2);
    },
  );

  it("renders GitHub alerts, math, Mermaid, emoji, and syntax-colored code", () => {
    const snapshot = parseMarkdown(fixture("semantic-github.md"), "github");
    const html = renderMarkdownDocument(snapshot.doc, "github", snapshot);

    expect(countKind(snapshot.doc, "raw_block", "alert")).toBe(5);
    expect(countKind(snapshot.doc, "raw_block", "details")).toBe(2);
    expect(countKind(snapshot.doc, "raw_block", "math-block")).toBe(2);
    expect(countKind(snapshot.doc, "raw_inline", "math_inline")).toBe(1);
    expect(countKind(snapshot.doc, "raw_inline", "emoji")).toBe(4);
    expect(html).toContain('class="markdown-alert markdown-alert-note"');
    expect(html).toContain('class="markdown-alert markdown-alert-caution"');
    expect(html).toContain('class="markdown-alert-icon"');
    for (const color of [
      "#3B82F6",
      "#6CA4F8",
      "#FB923C",
      "#F2A500",
      "#B8BEC8",
    ]) {
      expect(html).toContain(color);
    }
    expect(html).toContain('class="mm-math mm-math-inline"');
    expect(html).toContain('class="mm-math mm-math-block"');
    expect(html).toContain('data-mm-mermaid="true"');
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("🎉");
  });
  it("renders GitLab-specific TOC, description lists, mixed tasks, diffs, and dimensions", () => {
    const snapshot = parseMarkdown(fixture("semantic-gitlab.md"), "gitlab");
    const html = renderMarkdownDocument(snapshot.doc, "gitlab", snapshot);
    const all = nodesOf(snapshot.doc);
    const images = all.filter((node) => node.type.name === "image");

    expect(countKind(snapshot.doc, "raw_block", "gitlab-toc")).toBe(1);
    expect(
      countKind(snapshot.doc, "raw_block", "gitlab-description-list"),
    ).toBeGreaterThan(0);
    expect(countKind(snapshot.doc, "raw_block", "alert")).toBe(5);
    expect(countKind(snapshot.doc, "raw_block", "math-block")).toBe(2);
    expect(countKind(snapshot.doc, "raw_inline", "gitlab-inline-diff")).toBe(4);
    expect(images.some((image) => image.attrs.width === "300px")).toBe(true);
    expect(
      all.some(
        (node) =>
          node.type.name === "list_item" && node.attrs.checked === "mixed",
      ),
    ).toBe(true);
    expect(html).toContain('class="table-of-contents"');
    expect(html).toContain("<dl>");
    expect(html).toContain('data-task-state="mixed"');
    expect(html).toContain('class="gitlab-inline-diff"');
    expect(html).toContain('width="300px"');
  });

  it("keeps footnotes ordered by first reference and available after a neighboring edit", () => {
    const source =
      "# Heading\n\nBody[^second] then [^first].\n\n[^first]: First body\n[^second]: Second body\n";
    const snapshot = parseMarkdown(source, "github");
    const original = topLevelChildren(snapshot.doc);
    const changedHeading = schema.nodes.heading!.create(
      { level: 1 },
      schema.text("Changed"),
    );
    const changed = schema.topNodeType.create(null, [
      changedHeading,
      ...original.slice(1),
    ]);

    const html = renderMarkdownDocument(changed, "github");
    const footer = renderFootnotesHtml(changed, "github");
    const serialized = serializeMarkdown(changed, snapshot);
    const referenceNodes = nodesOf(changed).filter(
      (node) =>
        node.type.name === "raw_inline" &&
        (node.attrs.kind === "footnote_ref" ||
          node.attrs.kind === "footnote_anchor"),
    );
    const individualHtml = referenceNodes.map((node) =>
      renderNodeHtml(node, "github", changed),
    );

    expect(html).toContain('class="footnotes"');
    expect(html.indexOf("Second body")).toBeLessThan(
      html.indexOf("First body"),
    );
    expect(html).toContain('href="#fn-second"');
    expect(html).toContain('href="#fn-first"');
    expect(individualHtml[0]).toContain(">1</a>");
    expect(individualHtml[1]).toContain(">2</a>");
    expect(footer).toContain('class="footnotes"');
    expect(footer).not.toContain("Changed");
    expect(serialized.startsWith("# Changed")).toBe(true);
    expect(serialized.indexOf("[^second]:")).toBeGreaterThan(
      serialized.indexOf("# Changed"),
    );
    expect(serialized).toContain("[^first]: First body");
  });
  it("groups safe inline HTML pairs and keeps linked image dimensions and suffix text", () => {
    const inline = parseMarkdown(
      "<strong>*bold*</strong> + <kbd>Ctrl</kbd> + <sup>2</sup>\n",
      "github",
    );
    const paragraph = inline.doc.child(0);
    expect(
      nodesOf(paragraph).filter(
        (node) =>
          node.type.name === "raw_inline" && node.attrs.kind === "html-pair",
      ),
    ).toHaveLength(3);
    const inlineHtml = renderMarkdownDocument(inline.doc, "github", inline);
    expect(inlineHtml).toContain("<strong><em>bold</em></strong>");
    expect(inlineHtml).toContain("<kbd>Ctrl</kbd>");
    expect(inlineHtml).toContain("<sup>2</sup>");
    expect(serializeMarkdown(inline.doc, inline)).toBe(
      "<strong>*bold*</strong> + <kbd>Ctrl</kbd> + <sup>2</sup>\n",
    );

    const linked = parseMarkdown(
      "[![alt](img.png){width=300px}](https://example.test) trailing\n",
      "gitlab",
    );
    const image = nodesOf(linked.doc).find(
      (node) => node.type.name === "image",
    );
    expect(image?.attrs.width).toBe("300px");
    expect(image?.marks.map((mark) => mark.type.name)).toContain("link");
    expect(linked.doc.textContent).toContain("trailing");
    expect(renderMarkdownDocument(linked.doc, "gitlab", linked)).toContain(
      '<a href="https://example.test"><img',
    );
    expect(serializeMarkdown(linked.doc, linked)).toBe(
      "[![alt](img.png){width=300px}](https://example.test) trailing\n",
    );
  });

  it("recognizes inline math without turning escaped dollars or brackets into equations", () => {
    const escaped = parseMarkdown(
      "Price \\$5 and \\$10; literal \\[label\\].\n",
      "github",
    );
    expect(
      nodesOf(escaped.doc).some((node) => node.attrs?.kind === "math_inline"),
    ).toBe(false);
    expect(renderMarkdownDocument(escaped.doc, "github", escaped)).toContain(
      "[label]",
    );

    const codeSpan =
      String.fromCharCode(96) + "\\$z$" + String.fromCharCode(96);
    const math = parseMarkdown("$x\\$y$ and " + codeSpan, "github");
    expect(countKind(math.doc, "raw_inline", "math_inline")).toBe(1);
    const mathAtom = nodesOf(math.doc).find(
      (node) =>
        node.type.name === "raw_inline" && node.attrs.kind === "math_inline",
    );
    expect(mathAtom?.attrs.source).toBe("$x\\$y$");
    expect(math.doc.textContent).toContain("\\$z$");
  });
  it("keeps details and footnotes inside longer fences literal", () => {
    const fence = String.fromCharCode(96).repeat(4);
    const source =
      fence +
      "markdown\n<details>\n<summary>literal</summary>\n\n[^inside]: literal\n</details>\n" +
      fence +
      "\n";
    const snapshot = parseMarkdown(source, "github");

    expect(snapshot.doc.child(0).type.name).toBe("code_block");
    expect(countKind(snapshot.doc, "raw_block", "details")).toBe(0);
    expect(snapshot.footnotes).toHaveLength(0);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("leaves whitespace-only documents editable while preserving their source bytes", () => {
    for (const source of [" \n", "  \r\n\r\n", "\t\r\n"]) {
      const snapshot = parseMarkdown(source, "github");
      expect(snapshot.doc.childCount).toBe(1);
      expect(snapshot.doc.child(0).type.name).toBe("paragraph");
      expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
    }
  });
  it("sanitizes unsafe HTML while preserving approved inline elements", () => {
    const source =
      '<strong onclick="alert(1)">Safe</strong> <script>alert(1)</script> <!-- hidden -->';
    const snapshot = parseMarkdown(source, "github");
    const html = renderMarkdownDocument(snapshot.doc, "github", snapshot);

    expect(html).toContain("<strong>Safe</strong>");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("hidden");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("uses unique heading anchors for duplicate headings", () => {
    const snapshot = parseMarkdown("# Same\n\n# Same\n", "github");
    const anchors = headingAnchorIds(snapshot.doc, "github");

    expect(anchors.map((anchor) => anchor.id)).toEqual(["same", "same-1"]);
    const html = renderMarkdownDocument(snapshot.doc, "github", snapshot);
    expect(html).toContain('<h1 id="same">');
    expect(html).toContain('<h1 id="same-1">');
  });
  it.each([
    ["semantic-github.md", "github"],
    ["semantic-gitlab.md", "gitlab"],
  ] as const)(
    "keeps $1 footnote definitions at their source location after a heading edit",
    (file, profile) => {
      const source = fixture(file);
      const snapshot = parseMarkdown(source, profile);
      const children = topLevelChildren(snapshot.doc);
      const heading = children[0]!;
      const changedHeading = schema.nodes.heading!.create(
        heading.attrs,
        schema.text(heading.textContent + " updated"),
        heading.marks,
      );
      const changed = schema.topNodeType.create(null, [
        changedHeading,
        ...children.slice(1),
      ]);
      const serialized = serializeMarkdown(changed, snapshot);
      const expected = source.replace(/^(# [^\r\n]+)$/m, "$1 updated");

      expect(serialized).toBe(expected);
    },
  );

  it("keeps repeated footnote references numbered and backlinked", () => {
    const snapshot = parseMarkdown(
      "First[^a] and again[^a].\n\n[^a]: Body\n",
      "github",
    );
    const references = nodesOf(snapshot.doc).filter(
      (node) =>
        node.type.name === "raw_inline" && node.attrs.kind === "footnote_ref",
    );
    const individualHtml = references.map((node) =>
      renderNodeHtml(node, "github", snapshot.doc),
    );
    const html = renderMarkdownDocument(snapshot.doc, "github", snapshot);

    const definitionSnapshot = parseMarkdown("[^a]: Body\n", "github");
    const repeatedNode = schema.nodes.raw_inline!.create({
      source: "[^a]",
      kind: "footnote_ref",
    });
    const repeatedDoc = schema.topNodeType.create(null, [
      schema.nodes.paragraph!.create(null, [
        repeatedNode,
        schema.text(" and "),
        repeatedNode,
      ]),
    ]);
    const positions: number[] = [];
    repeatedDoc.descendants((node, position) => {
      if (node === repeatedNode) positions.push(position);
    });
    const repeatedPosition = positions[1];
    if (repeatedPosition === undefined)
      throw new Error("expected repeated footnote position");
    const repeatedHtml = renderNodeHtml(repeatedNode, "github", {
      document: repeatedDoc,
      footnotes: definitionSnapshot.footnotes ?? [],
      nodePosition: repeatedPosition,
    });

    expect(individualHtml[0]).toContain('id="fnref-a"');
    expect(individualHtml[1]).toContain('id="fnref-a-2"');
    expect(html.match(/class="footnote-backref"/g)).toHaveLength(2);
    expect(repeatedHtml).toContain('id="fnref-a-2"');
  });
});
