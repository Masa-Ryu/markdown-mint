import { describe, expect, it } from "vitest";
import {
  highlightCodeSpans,
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
    expect(html).not.toContain("<span");
    expect(html).toContain("&lt;tag");
    expect(html).toContain("made-up-language");
    expect(highlightCodeSpans(source, "made-up-language")).toEqual([]);
  });

  it("renders inline and display math without trusting commands", () => {
    const inline = renderMath("E=mc^2", false);
    const block = renderMath("\\frac{1}{2}", true);
    expect(inline).toContain("katex");
    expect(block).toContain("katex-display");
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
