import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const documentCss = readFileSync(
  resolve(process.cwd(), "media/document.css"),
  "utf8",
);

describe("shared document styles", () => {
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
});
