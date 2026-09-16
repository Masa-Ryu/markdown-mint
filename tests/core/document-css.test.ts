import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const documentCss = readFileSync(
  resolve(process.cwd(), "media/document.css"),
  "utf8",
);

describe("shared document styles", () => {
  it("uses one bounded responsive width for shared document surfaces", () => {
    expect(documentCss).not.toContain("--mm-document-width: 800px");
    expect(documentCss).toMatch(
      /:root\s*\{[\s\S]*?--mm-document-width:\s*85%;[\s\S]*?--mm-document-min-width:\s*640px;[\s\S]*?--mm-document-max-width:\s*1800px;/,
    );

    const sharedDocumentRule = documentCss.match(
      /\.markdown-body,\s*\.mm-document-content\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(sharedDocumentRule).toBeDefined();
    expect(sharedDocumentRule).toContain(
      `width: min(
    100%,
    max(var(--mm-document-width), var(--mm-document-min-width)),
    var(--mm-document-max-width)
  );`,
    );

    const responsiveWidth = (viewport: number) =>
      Math.min(viewport, Math.max(viewport * 0.85, 640), 1800);
    for (const viewport of [360, 500, 640, 800, 960, 1440, 2560, 6016]) {
      expect(responsiveWidth(viewport)).toBeLessThanOrEqual(viewport);
      expect(responsiveWidth(viewport)).toBeLessThanOrEqual(1800);
    }
    expect(responsiveWidth(500)).toBe(500);
    expect(responsiveWidth(960)).toBe(816);
    expect(responsiveWidth(1440)).toBe(1224);
    expect(responsiveWidth(2560)).toBe(1800);
    expect(responsiveWidth(6016)).toBe(1800);
  });

  it("centers only flowchart-v2 node labels for Mermaid diagrams", () => {
    expect(documentCss).toContain(
      `.markdown-body
  .mm-mermaid
  svg[aria-roledescription="flowchart-v2"]
  .node
  .label
  text:not([text-anchor]),
.mm-document-content
  .mm-mermaid
  svg[aria-roledescription="flowchart-v2"]
  .node
  .label
  text:not([text-anchor]) {
  text-anchor: middle;
}`,
    );
  });

  it("keeps tall KaTeX glyphs inside a readable line box", () => {
    expect(documentCss).toMatch(
      /\.markdown-body \.mm-math-inline \.katex,\s*\.mm-document-content \.mm-math-inline \.katex\s*\{\s*font-size:\s*1\.25em;\s*line-height:\s*1\.3;/,
    );
    expect(documentCss).toMatch(
      /\.markdown-body \.mm-math-block > \.katex-display > \.katex,\s*\.mm-document-content \.mm-math-block > \.katex-display > \.katex\s*\{\s*font-size:\s*1\.35em;\s*line-height:\s*1\.3;/,
    );
    expect(documentCss).toMatch(
      /\.markdown-body \.mm-math-fallback,\s*\.mm-document-content \.mm-math-fallback\s*\{[\s\S]*?font-size:\s*1\.05em;\s*line-height:\s*1\.45;/,
    );
  });

  it("uses one code font metric for gutters and bodies across preview surfaces", () => {
    expect(documentCss).toMatch(
      /\.markdown-body \.mm-code-block,\s*\.mm-document-content \.mm-code-block\s*\{[\s\S]*?--mm-code-font-size:\s*0\.92em;[\s\S]*?--mm-code-line-height:\s*1\.5;/,
    );
    expect(documentCss).toMatch(
      /\.markdown-body \.mm-code-line-numbers,\s*\.mm-document-content \.mm-code-line-numbers\s*\{[\s\S]*?font-size:\s*var\(--mm-code-font-size\);[\s\S]*?line-height:\s*var\(--mm-code-line-height\);/,
    );
    expect(documentCss).toMatch(
      /\.markdown-body \.mm-code-block-pre,\s*\.mm-document-content \.mm-code-block-pre\s*\{[\s\S]*?font-size:\s*var\(--mm-code-font-size\);[\s\S]*?line-height:\s*var\(--mm-code-line-height\);/,
    );
    expect(documentCss).toMatch(
      /\.markdown-body \.mm-code-block-pre code,\s*\.mm-document-content \.mm-code-block-pre code\s*\{[\s\S]*?font-size:\s*inherit;[\s\S]*?line-height:\s*inherit;/,
    );
  });

  it("assigns outer spacing to rich wrappers and clears their inner display margins", () => {
    expect(documentCss).toMatch(
      /\.mm-document-content \.mm-code-block-view\s*\{[\s\S]*?margin:\s*0 0 1em;/,
    );
    expect(documentCss).toMatch(
      /\.mm-document-content \.mm-alert-node-view\s*\{[\s\S]*?margin:\s*1em 0;/,
    );
    expect(documentCss).toMatch(
      /\.mm-document-content \.mm-rendered-node\[data-mm-block-margin="flow"\]\s*\{[\s\S]*?margin:\s*1em 0;/,
    );
    expect(documentCss).toContain(
      `.mm-document-content .mm-rendered-node[data-mm-block-margin] > :first-child,
.mm-document-content .mm-rendered-node[data-mm-block-margin] > :last-child {
  margin-block-start: 0;
  margin-block-end: 0;
}`,
    );
  });

  it("keeps TOC and description lists in the ordinary document flow", () => {
    expect(documentCss).toMatch(
      /\.markdown-body \.table-of-contents,[\s\S]*?\.mm-document-content dl\s*\{[\s\S]*?margin:\s*1em 0;/,
    );
    expect(documentCss).toContain(
      ".mm-document-content > .mm-rendered-node:first-child",
    );
    expect(documentCss).toContain(
      ".mm-document-content > .mm-rendered-node:last-child",
    );
  });

  it("removes only terminal container and list-child margins", () => {
    expect(documentCss).toMatch(
      /details\s*>\s*:not\(\[hidden\]\):not\(:has\(~ :not\(\[hidden\]\)\)\)[\s\S]*?margin-block-end:\s*0;/,
    );
    expect(documentCss).toContain(
      ".markdown-body :is(ul, ol) > li:first-child",
    );
  });
});
