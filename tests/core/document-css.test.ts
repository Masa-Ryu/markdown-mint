import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const documentCss = readFileSync(
  resolve(process.cwd(), "media/document.css"),
  "utf8",
);

describe("shared document math styles", () => {
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
});
