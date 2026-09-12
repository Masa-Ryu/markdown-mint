import { describe, expect, it } from "vitest";
import { DOMSerializer, type Node as PMNode } from "prosemirror-model";
import {
  formatMarkdown,
  inspectCompatibility,
  parseMarkdown,
  renderMarkdown,
  schema,
  serializeMarkdown,
} from "../../src/core/index";

function replaceTopLevel(
  snapshot: ReturnType<typeof parseMarkdown>,
  index: number,
  replacement: PMNode,
): PMNode {
  const children: PMNode[] = [];
  snapshot.doc.forEach((child) => children.push(child));
  children[index] = replacement;
  return schema.topNodeType.create(null, children);
}

function childrenOf(node: PMNode): PMNode[] {
  const children: PMNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

describe("Markdown core", () => {
  it("parses common rich Markdown into the shared PM schema", () => {
    const snapshot = parseMarkdown(
      "# Heading\n\nText **bold** *em* ~~strike~~ `code` [link](https://example.com).\n\n- [ ] todo\n- [x] done\n\n![picture](image.png)\n",
    );
    expect(snapshot.doc.child(0).type.name).toBe("heading");
    expect(
      snapshot.doc
        .child(1)
        .child(1)
        .marks.map((mark) => mark.type.name),
    ).toContain("strong");
    expect(snapshot.doc.child(2).child(0).attrs.checked).toBe(false);
    expect(snapshot.doc.child(2).child(1).attrs.checked).toBe(true);
    expect(snapshot.doc.child(3).child(0).attrs.alt).toBe("picture");
    expect(snapshot.doc.child(1).textContent).toContain("code");
  });

  it("preserves a complete source on a no-op, including CRLF", () => {
    const source = "# Heading\r\n\r\nfirst\r\n\r\nsecond\r\n";
    const snapshot = parseMarkdown(source);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
    expect(snapshot.lineEnding).toBe("crlf");
  });

  it("reuses untouched top-level blocks when a neighboring block changes", () => {
    const source = 'before\n\n<div data-x="1">raw</div>\n\n# after\n';
    const snapshot = parseMarkdown(source);
    const replacement = schema.nodes.heading!.create(
      { level: 1 },
      schema.text("changed"),
    );
    const document = replaceTopLevel(snapshot, 2, replacement);
    const serialized = serializeMarkdown(document, snapshot);
    expect(serialized).toContain('<div data-x="1">raw</div>');
    expect(serialized).toContain("# changed");
    expect(serialized).toMatch(
      /^before\n\n<div data-x="1">raw<\/div>\n\n# changed\n$/,
    );
  });

  it("keeps table dimensions and pipes in text and code spans", () => {
    const source = "| A | B |\n| --- | --- |\n| a\\|b | `x\\|y` |\n";
    const snapshot = parseMarkdown(source);
    const table = snapshot.doc.child(0);
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(2);
    expect(table.child(0).childCount).toBe(2);
    expect(table.child(1).child(1).textContent).toBe("x|y");
    const serialized = serializeMarkdown(snapshot.doc);
    expect(parseMarkdown(serialized).doc.eq(snapshot.doc)).toBe(true);
    expect(serialized).toContain("`x\\|y`");
  });

  it("maps only the safe br spelling to a table hard break", () => {
    const snapshot = parseMarkdown(
      "| A | B |\n| --- | --- |\n| a | left<br>right |\n",
    );
    const cell = snapshot.doc.child(0).child(1).child(1);
    expect(cell.child(0).child(1).type.name).toBe("hard_break");
    expect(
      parseMarkdown(serializeMarkdown(snapshot.doc)).doc.eq(snapshot.doc),
    ).toBe(true);
    const inlineDocument = parseMarkdown("a <span>unsafe</span>\n").doc;
    expect(inlineDocument.child(0).child(1).type.name).toBe("raw_inline");
    expect(inlineDocument.child(0).child(1).attrs.kind).toBe("html");
  });

  it("roundtrips nested marks and ordered-list continuation indentation", () => {
    for (const source of [
      "A **bold *and italic* end** text.\n",
      "A *em **strong** end*.\n",
      "9. one\n\n   paragraph\n10. two\n",
    ]) {
      const snapshot = parseMarkdown(source);
      const serialized = serializeMarkdown(snapshot.doc);
      expect(parseMarkdown(serialized).doc.eq(snapshot.doc)).toBe(true);
    }
  });

  it("keeps edited paragraph text that resembles block syntax as text", () => {
    const value = "# heading\n- list\n1) ordered\n---\n$$math";
    const document = schema.topNodeType.create(null, [
      schema.nodes.paragraph!.create(null, schema.text(value)),
    ]);
    const serialized = serializeMarkdown(document);
    expect(parseMarkdown(serialized).doc.eq(document)).toBe(true);
  });

  it("renders raw HTML and unsafe destinations as inert output", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script>\n\n[x](javascript:alert(1))\n",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(
      inspectCompatibility("[x](javascript:alert(1))\n").some(
        (entry) => entry.code === "unsafe-url",
      ),
    ).toBe(true);
  });

  it("keeps frontmatter and protected fences as source atoms", () => {
    const source =
      "---\ntitle: test\n---\n\n```mermaid\ngraph TD\n```\n\n# Heading\n";
    const snapshot = parseMarkdown(source);
    expect(snapshot.doc.child(0).type.name).toBe("raw_block");
    expect(snapshot.doc.child(0).attrs.kind).toBe("frontmatter");
    expect(snapshot.doc.child(1).attrs.kind).toBe("protected-fence");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("keeps fenced and nested details content through rendering", () => {
    const fencedSource =
      "<details>\n<summary>Example</summary>\n\n```html\n</details>\n```\n\n" +
      "After the fence\n</details>\n";
    const fencedSnapshot = parseMarkdown(fencedSource, "github");

    expect(fencedSnapshot.doc.childCount).toBe(1);
    expect(fencedSnapshot.doc.firstChild?.attrs.kind).toBe("details");
    expect(fencedSnapshot.doc.firstChild?.attrs.source).toBe(fencedSource);
    expect(serializeMarkdown(fencedSnapshot.doc, fencedSnapshot)).toBe(
      fencedSource,
    );
    const fencedHtml = renderMarkdown(fencedSource, "github");
    expect(fencedHtml).toContain("After the fence");
    expect(fencedHtml).toContain("&lt;/");

    const nestedSource =
      "<details>\n<summary>Outer</summary>\n\nOuter before\n\n" +
      "<details>\n<summary>Inner</summary>\n\nInner body\n</details>\n\n" +
      "Outer after\n</details>\n";
    const nestedSnapshot = parseMarkdown(nestedSource, "github");

    expect(nestedSnapshot.doc.childCount).toBe(1);
    expect(nestedSnapshot.doc.firstChild?.attrs.kind).toBe("details");
    expect(serializeMarkdown(nestedSnapshot.doc, nestedSnapshot)).toBe(
      nestedSource,
    );
    const nestedHtml = renderMarkdown(nestedSource, "github");
    expect(nestedHtml).toContain("Outer before");
    expect(nestedHtml).toContain("Inner body");
    expect(nestedHtml).toContain("Outer after");
  });

  it("keeps display math together when a line resembles a Setext underline", () => {
    const source =
      "$$\n\\sum_{n=1}^{100}\n\\frac{1}{n^2}\n=\n\\frac{\\pi^2}{6}\n$$\n";
    const snapshot = parseMarkdown(source, "github");

    expect(snapshot.doc.childCount).toBe(1);
    expect(snapshot.doc.firstChild?.type.name).toBe("raw_block");
    expect(snapshot.doc.firstChild?.attrs.kind).toBe("math-block");
    expect(snapshot.doc.firstChild?.attrs.source).toBe(source);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
    expect(renderMarkdown(source, "github")).toContain(
      'class="mm-math mm-math-block"',
    );
  });

  it("parses the complete multiline display and matrix stress cases", () => {
    const source = `## 14. Math Stress Test

Inline: $E = mc^2$

Inline complex:

$\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$

Block:

$$
\\sum_{n=1}^{100}
\\frac{1}{n^2}
=
\\frac{\\pi^2}{6}
$$

Matrix:

$$
A =
\\begin{bmatrix}
1 & 2 & 3 \\\\
4 & 5 & 6 \\\\
7 & 8 & 9
\\end{bmatrix}
$$
`;
    const snapshot = parseMarkdown(source, "github");
    const blocks = childrenOf(snapshot.doc).filter(
      (node) => node.attrs.kind === "math-block",
    );
    const headings = childrenOf(snapshot.doc).filter(
      (node) => node.type.name === "heading",
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.attrs.source).toContain("\n=\n");
    expect(blocks[1]?.attrs.source).toContain("\\begin{bmatrix}");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.attrs.level).toBe(2);
    const html = renderMarkdown(source, "github");
    expect(html.match(/katex-display/g) ?? []).toHaveLength(2);
    expect(html).toContain("mtable");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("keeps adjacent display math, following prose, and Setext headings distinct", () => {
    const source = "Title\n-----\n\n$$\na^2\n$$\n$$\nb^2\n$$\n\nAfter\n";
    const snapshot = parseMarkdown(source, "github");
    const children = childrenOf(snapshot.doc);
    expect(children.map((node) => node.type.name)).toEqual([
      "heading",
      "raw_block",
      "raw_block",
      "paragraph",
    ]);
    expect(children[0]?.attrs.level).toBe(2);
    expect(children[1]?.attrs.kind).toBe("math-block");
    expect(children[2]?.attrs.kind).toBe("math-block");
    expect(children[3]?.textContent).toBe("After");
  });

  it("preserves TeX escapes and excludes code or currency dollars", () => {
    const source =
      "`$code$` \\$5 and $x$ and $\\{x \\mid x > 0\\}$\n\n```markdown\n$x$\n$$\nnot math\n$$\n```\n";
    const snapshot = parseMarkdown(source, "github");
    const paragraph = snapshot.doc.firstChild!;
    const inlineMath = childrenOf(paragraph).filter(
      (node) => node.attrs.kind === "math_inline",
    );
    expect(inlineMath.map((node) => node.attrs.source)).toEqual([
      "$x$",
      "$\\{x \\mid x > 0\\}$",
    ]);
    expect(paragraph.textContent).toContain("$code$");
    expect(snapshot.doc.child(1).type.name).toBe("code_block");
    expect(snapshot.doc.child(1).textContent).toContain("$$");
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("does not let an unclosed delimiter hide later Markdown", () => {
    const source = "$$\nunclosed\n\n# Next heading\n\nVisible paragraph\n";
    const snapshot = parseMarkdown(source, "github");
    const children = childrenOf(snapshot.doc);
    expect(children.some((node) => node.attrs.kind === "math-block")).toBe(
      false,
    );
    expect(children.some((node) => node.type.name === "heading")).toBe(true);
    expect(snapshot.doc.textContent).toContain("Visible paragraph");
  });

  it("keeps existing math fences available in every Markdown profile", () => {
    for (const profile of ["github", "gitlab", "commonmark"] as const) {
      const snapshot = parseMarkdown("```math\nx^2\n```\n", profile);
      expect(snapshot.doc.childCount).toBe(1);
      expect(snapshot.doc.firstChild?.type.name).toBe("raw_block");
      expect(snapshot.doc.firstChild?.attrs.kind).toBe("math-block");
      expect(renderMarkdown("```math\nx^2\n```\n", profile)).toContain(
        "katex-display",
      );
    }
  });

  it("keeps nested quote, list, table, and details parsing unchanged", () => {
    const source =
      "> $$\n> quoted\n> $$\n\n- $$\n  listed\n  $$\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<details>\n\n$$\ninside\n$$\n\n</details>\n";
    const snapshot = parseMarkdown(source, "github");
    const children = childrenOf(snapshot.doc);
    expect(children[0]?.type.name).toBe("blockquote");
    expect(children[0]?.textContent).toContain("$$");
    expect(children[1]?.type.name).toBe("bullet_list");
    expect(children[1]?.textContent).toContain("$$");
    expect(children[2]?.type.name).toBe("table");
    expect(children[3]?.attrs.kind).toBe("details");
    expect(renderMarkdown(source, "github")).toContain("inside");
  });

  it("preserves inline math before Markdown-it can reinterpret its contents", () => {
    const source =
      "Inline $a * b$ and escaped $x\\$y$; code `$z$`; unclosed $nope.\n";
    const snapshot = parseMarkdown(source, "github");
    const paragraph = snapshot.doc.firstChild!;
    const math = childrenOf(paragraph).filter(
      (node) =>
        node.type.name === "raw_inline" && node.attrs.kind === "math_inline",
    );

    expect(math.map((node) => node.attrs.source)).toEqual([
      "$a * b$",
      "$x\\$y$",
    ]);
    expect(
      childrenOf(paragraph).some(
        (node) => node.type.name === "text" && node.textContent.includes("$z$"),
      ),
    ).toBe(true);
    expect(serializeMarkdown(snapshot.doc, snapshot)).toBe(source);
  });

  it("does not recognize an unmatched display delimiter or code math as math", () => {
    const source = "$$\nunclosed\n\n```markdown\n$x$\n```\n";
    const snapshot = parseMarkdown(source, "github");
    const nodes: PMNode[] = [];
    snapshot.doc.forEach((node) => nodes.push(node));

    expect(nodes[0]?.type.name).not.toBe("raw_block");
    expect(nodes[0]?.type.name).toBe("paragraph");
    expect(nodes[1]?.type.name).toBe("code_block");
    expect(nodes[1]?.textContent).toBe("$x$");
    expect(nodes.some((node) => node.attrs.kind === "math-block")).toBe(false);
  });

  it("keeps terminal line endings on raw atoms in canonical serialization", () => {
    for (const source of [
      "<div>raw</div>\n",
      "<div>raw</div>\r\n",
      "```mermaid\ngraph TD\n```\n",
      "$$\nmath\n$$\n",
    ]) {
      const snapshot = parseMarkdown(source);
      const serialized = serializeMarkdown(snapshot.doc);
      expect(parseMarkdown(serialized).doc.eq(snapshot.doc)).toBe(true);
    }
  });

  it("normalizes code block terminators without losing trailing blank lines", () => {
    const cases = [
      ["```\n\n```\n", "", "```\n\n```"],
      ["```js\na\n\n```\n", "a\n", "```js\na\n\n```"],
      ["~~~\na\n\n~~~\n", "a\n", "```\na\n\n```"],
      ["    a\n\n    b\n", "a\n\nb", "```\na\n\nb\n```"],
    ] as const;
    for (const [source, expectedText, expectedMarkdown] of cases) {
      const snapshot = parseMarkdown(source);
      expect(snapshot.doc.child(0).type.name).toBe("code_block");
      expect(snapshot.doc.child(0).textContent).toBe(expectedText);
      const serialized = serializeMarkdown(snapshot.doc);
      expect(serialized).toBe(expectedMarkdown);
      expect(parseMarkdown(serialized).doc.child(0).textContent).toBe(
        expectedText,
      );
    }
  });

  it("edits an empty fenced block while preserving surrounding Markdown", () => {
    const source = "before\n\n```\n\n```\n\nafter\n";
    const snapshot = parseMarkdown(source);
    const code = schema.nodes.code_block!.create(
      { params: "" },
      schema.text("edited\n"),
    );
    const children: PMNode[] = [];
    snapshot.doc.forEach((child) => children.push(child));
    children[1] = code;
    const serialized = serializeMarkdown(
      schema.topNodeType.create(null, children),
      snapshot,
    );
    expect(serialized).toBe("before\n\n```\nedited\n\n```\n\nafter\n");
    expect(parseMarkdown(serialized).doc.child(0).textContent).toBe("before");
    expect(parseMarkdown(serialized).doc.child(1).textContent).toBe("edited\n");
    expect(parseMarkdown(serialized).doc.child(2).textContent).toBe("after");
  });

  it("formats with the Markdown Prettier plugin while preserving PM semantics", async () => {
    const formatted = await formatMarkdown(
      "# title\n\nA paragraph with enough words to wrap.\n",
      {
        printWidth: 24,
        proseWrap: "always",
      },
    );
    expect(formatted).toContain("# title");
    expect(
      parseMarkdown(formatted).doc.child(1).textContent.replace(/\s+/g, " "),
    ).toContain("A paragraph with enough words to wrap.");
    expect(
      await formatMarkdown(formatted, { printWidth: 24, proseWrap: "always" }),
    ).toBe(formatted);
    await expect(
      formatMarkdown("[bad](javascript:alert(1))\n"),
    ).rejects.toThrow(/formatting was skipped/i);
  });

  it("handles a long document with linear source matching", () => {
    const paragraphs = Array.from(
      { length: 5000 },
      (_, index) => `paragraph ${index}`,
    ).join("\n\n");
    const source = `${paragraphs}\n`;
    const snapshot = parseMarkdown(source);
    const children: PMNode[] = [];
    snapshot.doc.forEach((child) => children.push(child));
    children[2500] = schema.nodes.paragraph!.create(
      null,
      schema.text("changed"),
    );
    const serialized = serializeMarkdown(
      schema.topNodeType.create(null, children),
      snapshot,
    );
    expect(serialized).toContain("changed");
    expect(serialized).toContain("paragraph 4999");
  });

  it("preserves reference definitions when a block carrying their separator is removed", () => {
    for (const [source, expected] of [
      [
        "First\n\n[id]: https://example.org\n\nA [link][id].\n",
        "[id]: https://example.org\n\nA [link][id].\n",
      ],
      [
        "First\r\n\r\n[id]: https://example.org\r\n\r\nA [link][id].\r\n",
        "[id]: https://example.org\r\n\r\nA [link][id].\r\n",
      ],
    ] as const) {
      const snapshot = parseMarkdown(source);
      const remaining: PMNode[] = [];
      snapshot.doc.forEach((child) => remaining.push(child));
      const changed = schema.topNodeType.create(null, remaining.slice(1));
      const serialized = serializeMarkdown(changed, snapshot);
      expect(serialized).toBe(expected);
      expect(parseMarkdown(serialized).doc.eq(changed)).toBe(true);
    }
  });

  it("keeps duplicate block source slices valid when blocks are moved", () => {
    const snapshot = parseMarkdown("A\n\nB\n\nA\n");
    const original: PMNode[] = [];
    snapshot.doc.forEach((child) => original.push(child));
    const moved = schema.topNodeType.create(null, [
      original[2]!,
      original[0]!,
      original[1]!,
    ]);
    const serialized = serializeMarkdown(moved, snapshot);
    expect(serialized).toBe("A\n\nA\n\nB\n");
    expect(parseMarkdown(serialized).doc.eq(moved)).toBe(true);
  });

  it("bounds user supplied link and image destinations", () => {
    const link = schema.marks.link!.create({
      href: "https://example.org/a path/(part)|pipe\nnext",
    });
    const paragraph = schema.nodes.paragraph!.create(
      null,
      schema.text("link", [link]),
    );
    const image = schema.nodes.image!.create({
      src: "https://example.org/image path/(part)|pipe\nnext",
      alt: "picture",
      title: null,
    });
    const document = schema.topNodeType.create(null, [
      paragraph,
      schema.nodes.paragraph!.create(null, image),
    ]);
    const serialized = serializeMarkdown(document);
    expect(serialized).not.toMatch(/\]\([^)]*\r?\n/);
    expect(serialized).toContain(
      "<https://example.org/a path/(part)|pipe next>",
    );
    expect(serialized).toContain(
      "<https://example.org/image path/(part)|pipe next>",
    );
    expect(
      parseMarkdown(serialized).doc.child(0).child(0).marks[0]?.type.name,
    ).toBe("link");
    expect(parseMarkdown(serialized).doc.child(1).child(0).type.name).toBe(
      "image",
    );
  });

  it("roundtrips table alignment through ProseMirror DOM serialization", () => {
    const cell = schema.nodes.table_cell!.create(
      { colspan: 1, rowspan: 1, colwidth: null, alignment: "center" },
      schema.nodes.paragraph!.create(null, schema.text("value")),
    );
    const dom = DOMSerializer.fromSchema(schema).serializeNode(
      cell,
    ) as HTMLElement;
    expect(dom.style.textAlign).toBe("center");
    expect(dom.outerHTML).toContain("text-align: center");
  });

  it("does not put unsafe link or image URLs into the live editor DOM", () => {
    const link = schema.marks.link!.create({ href: "javascript:alert(1)" });
    const paragraph = schema.nodes.paragraph!.create(
      null,
      schema.text("open", [link]),
    );
    const image = schema.nodes.image!.create({
      src: "data:text/html,<script>alert(1)</script>",
      alt: "fallback",
      title: null,
    });
    const pmDocument = schema.topNodeType.create(null, [
      paragraph,
      schema.nodes.paragraph!.create(null, image),
    ]);
    const dom = globalThis.document.createElement("div");
    dom.appendChild(
      DOMSerializer.fromSchema(schema).serializeFragment(pmDocument.content),
    );
    expect(dom.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(dom.querySelector("img")?.hasAttribute("src")).toBe(false);
  });
});
