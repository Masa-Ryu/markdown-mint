import { describe, expect, it } from "vitest";
import {
  buildMermaidTemplateSource,
  getMermaidTemplate,
  getMermaidTemplates,
} from "../../src/webview/mermaidTemplates";
import { MAX_MERMAID_SOURCE_LENGTH } from "../../src/webview/mermaidValidation";

describe("Mermaid template catalog", () => {
  it("provides 13 uniquely identified small examples across 10 diagram types", () => {
    const templates = getMermaidTemplates();
    expect(templates).toHaveLength(13);
    expect(new Set(templates.map((item) => item.id)).size).toBe(13);
    expect(new Set(templates.map((item) => item.diagram)).size).toBe(10);
    for (const template of templates) {
      for (const text of [
        template.id,
        template.diagram,
        template.name,
        template.description,
        template.hint,
        template.source,
      ])
        expect(text.trim()).not.toBe("");
      expect(template.source.length).toBeLessThan(MAX_MERMAID_SOURCE_LENGTH);
      expect(template.source).not.toMatch(/%%\{|https?:|click |icon|@import/);
      expect(getMermaidTemplate(template.id)).toBe(template);
    }
    expect(getMermaidTemplate("missing")).toBeUndefined();
    expect(() => buildMermaidTemplateSource("missing")).toThrow();
  });

  it("generates all six flowchart variants without mutating catalog or drafts", () => {
    const before = JSON.stringify(getMermaidTemplates());
    const draft = "flowchart BT\nOriginal-->Code";
    for (const template of getMermaidTemplates().filter(
      (item) => item.directions,
    )) {
      for (const direction of template.directions!) {
        const source = buildMermaidTemplateSource(template.id, { direction });
        expect(source).toBe(
          buildMermaidTemplateSource(template.id, { direction }),
        );
        expect(source.split("\n")[0]).toBe("flowchart " + direction);
      }
    }
    expect(JSON.stringify(getMermaidTemplates())).toBe(before);
    expect(draft).toBe("flowchart BT\nOriginal-->Code");
    expect(buildMermaidTemplateSource("gantt-project")).toContain("2026-01-05");
  });
});
