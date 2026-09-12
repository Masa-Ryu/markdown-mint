import { describe, expect, it } from "vitest";
import {
  codeLanguageMetadata,
  codeLanguageSuffix,
  isValidCodeLanguageIdentifier,
  highlightCodeSpans,
  replaceCodeLanguageIdentifier,
  renderAdvancedBlock,
  renderCodeBlock,
  renderMath,
} from "../../src/core/visualRendering";

describe("visual rendering helpers", () => {
  it("highlights common aliases and returns editable text ranges", () => {
    const source = 'const value = "ok";';
    const html = renderCodeBlock(source, "ts");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-string");
    expect(highlightCodeSpans(source, "typescript")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 0, to: 5, className: "hljs-keyword" }),
      ]),
    );
  });

  it("keeps unknown languages as escaped plain code", () => {
    const source = '<tag attr="&value">';
    const html = renderCodeBlock(source, "made-up-language");
    expect(html).not.toContain('<span class="hljs');
    expect(html).toContain("&lt;tag");
    expect(html).toContain("made-up-language");
    expect(html).toContain('data-mm-highlight="unsupported"');
    expect(highlightCodeSpans(source, "made-up-language")).toEqual([]);
  });

  it("separates saved identifiers from display and highlight metadata", () => {
    expect(codeLanguageMetadata("ts")).toMatchObject({
      identifier: "ts",
      label: "TypeScript",
      badge: "TS",
      highlightLanguage: "typescript",
      kind: "known",
    });
    expect(codeLanguageMetadata("py")).toMatchObject({
      identifier: "py",
      label: "Python",
      badge: "PY",
      highlightLanguage: "python",
      kind: "known",
    });
    expect(codeLanguageMetadata("html").label).toBe("HTML");
    expect(codeLanguageMetadata("toml").label).toBe("TOML");
    expect(codeLanguageMetadata("tsx").label).toBe("TSX");
    expect(codeLanguageMetadata("ts").aliases).toEqual(
      expect.arrayContaining(["ts", "typescript"]),
    );
    expect(codeLanguageMetadata("tsx").aliases).not.toEqual(
      expect.arrayContaining(["ts", "typescript"]),
    );
    expect(codeLanguageMetadata("html").aliases).not.toEqual(
      expect.arrayContaining(["xml"]),
    );
    expect(codeLanguageMetadata("xml").aliases).not.toEqual(
      expect.arrayContaining(["html"]),
    );
    expect(codeLanguageMetadata("toml").aliases).not.toEqual(
      expect.arrayContaining(["ini"]),
    );
    expect(codeLanguageMetadata("ini").aliases).not.toEqual(
      expect.arrayContaining(["toml"]),
    );
    expect(codeLanguageMetadata("javascript").aliases).not.toEqual(
      expect.arrayContaining(["jsx"]),
    );
    expect(codeLanguageMetadata("jsx")).toMatchObject({
      label: "JSX",
      highlightLanguage: "javascript",
      kind: "known",
    });
    expect(codeLanguageMetadata("jsx").aliases).not.toEqual(
      expect.arrayContaining(["javascript"]),
    );
    expect(codeLanguageMetadata("C++")).toMatchObject({
      label: "C++",
      highlightLanguage: "cpp",
      kind: "known",
    });
    expect(codeLanguageMetadata("C#")).toMatchObject({
      label: "C#",
      highlightLanguage: "csharp",
      kind: "known",
    });
    expect(codeLanguageMetadata("acme-dsl")).toMatchObject({
      identifier: "acme-dsl",
      label: "acme-dsl",
      badge: "CODE",
      kind: "custom",
    });
    expect(replaceCodeLanguageIdentifier('ts title="example.ts"', "js")).toBe(
      'js title="example.ts"',
    );
    expect(codeLanguageSuffix('ts title="example.ts"')).toBe(
      ' title="example.ts"',
    );
    expect(codeLanguageSuffix("ts")).toBe("");
    expect(isValidCodeLanguageIdentifier("C++")).toBe(true);
    expect(isValidCodeLanguageIdentifier("C#")).toBe(true);
    expect(isValidCodeLanguageIdentifier("bad language")).toBe(false);
    expect(isValidCodeLanguageIdentifier("bad\nlanguage")).toBe(false);
    expect(isValidCodeLanguageIdentifier("bad\u0085language")).toBe(false);
    expect(isValidCodeLanguageIdentifier("```js")).toBe(false);
  });

  it("renders a themed code card header and a line-number gutter", () => {
    const html = renderCodeBlock("const first = 1;\nreturn first;", "ts");
    expect(html).toContain('class="mm-code-block"');
    expect(html).toContain('class="mm-code-block-header"');
    expect(html).toContain('data-mm-code-action="copy"');
    expect(html).toContain('data-mm-code-action="expand"');
    expect(html).toContain('class="mm-code-language-label">TypeScript</span>');
    expect(html).toContain('<div class="mm-code-line-numbers"');
    expect(html).toContain("<span>1</span><span>2</span>");

    const unknown = renderCodeBlock("plain", "made-up-language");
    expect(unknown).toContain('data-language="made-up-language"');
    expect(unknown).not.toContain('class="language-made-up-language hljs"');
    expect(unknown).toContain('data-mm-code-language="made-up-language"');
    expect(unknown).toContain('data-mm-code-language-kind="custom"');
    expect(unknown).toContain(
      'class="mm-code-language-label">made-up-language</span>',
    );
    expect(unknown).toContain(
      'class="mm-code-language-icon" aria-hidden="true">CODE</span>',
    );
    expect(unknown).not.toContain("mm-code-language-chevron");
    expect(renderCodeBlock("print(1)", "py")).toContain(
      'class="mm-code-language-icon" aria-hidden="true">PY</span>',
    );
    expect(renderCodeBlock("plain", "")).toContain(
      'data-mm-code-language-kind="unspecified"',
    );
    expect(renderCodeBlock("plain", "plaintext")).toContain(
      'data-mm-code-language-kind="plain"',
    );
  });

  it("renders inline and display math without trusting commands", () => {
    const inline = renderMath("E=mc^2", false);
    const block = renderMath("\\frac{1}{2}", true);
    expect(inline).toContain("katex");
    expect(block).toContain("katex-display");
    // KaTeX positions scripts and fractions with generated style attributes;
    // the production Webview CSP explicitly permits those attributes.
    expect(inline).toMatch(/class="msupsub"[\s\S]*style="/);
    expect(block).toMatch(/class="mfrac"[\s\S]*style="/);
    expect(renderMath("\\href{javascript:alert(1)}{x}", false)).not.toContain(
      'href="javascript:',
    );
  });

  it("keeps advanced source local and explicit", () => {
    const mermaid = renderAdvancedBlock(
      "protected-fence",
      "```mermaid\nflowchart TD\n A-->B\n```",
    );
    expect(mermaid).toContain('data-mm-mermaid="true"');
    expect(
      renderAdvancedBlock("plantuml", "@startuml\nA -> B\n@enduml"),
    ).toContain("Offline preview unavailable");
    expect(renderAdvancedBlock("geojson", '{"type":"Feature"}')).toContain(
      "Static GEOJSON",
    );
  });

  it("renders valid static assets locally as bounded SVG", () => {
    const geojson = renderAdvancedBlock(
      "geojson",
      JSON.stringify({
        type: "Feature",
        properties: { name: "A" },
        geometry: { type: "Point", coordinates: [139.7, 35.6] },
      }),
    );
    expect(geojson).toContain('class="mm-static-asset mm-static-geojson"');
    expect(geojson).toContain("<svg");
    expect(geojson).toContain("A (139.7, 35.6)");

    const stl = renderAdvancedBlock(
      "stl",
      [
        "solid triangle",
        "facet normal 0 0 1",
        " outer loop",
        "  vertex 0 0 0",
        "  vertex 1 0 0",
        "  vertex 0 1 0",
        " endloop",
        "endfacet",
        "endsolid triangle",
      ].join("\n"),
    );
    expect(stl).toContain('class="mm-static-asset mm-static-stl"');
    expect(stl).toContain("<polygon");
  });

  it("does not hide source when bounded work is skipped", () => {
    const source = "x".repeat(250_001);
    const html = renderCodeBlock(source, "ts");
    expect(html).toContain('data-mm-highlight="skipped-large"');
    expect(html).toContain("x".repeat(1_000));
  });
});
