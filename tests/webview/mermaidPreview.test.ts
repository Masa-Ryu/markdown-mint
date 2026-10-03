import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidPreview } from "../../src/webview/mermaidPreview";
import type { MermaidValidationSnapshot } from "../../src/webview/mermaidValidation";

const previews: MermaidPreview[] = [];
afterEach(() => {
  previews.forEach((preview) => preview.dispose());
  previews.length = 0;
  document.body.replaceChildren();
  document.body.className = "";
});
const valid = (source: string): MermaidValidationSnapshot => ({
  source,
  status: "valid",
  valid: true,
  diagramType: "flowchart",
});
const svg = (text: string): SVGElement => {
  const result = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  result.textContent = text;
  return result;
};
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Mermaid modal preview requests", () => {
  it("runs one render and retains only the latest pending request", async () => {
    const resolvers: Array<(svg: SVGElement) => void> = [];
    const render = vi.fn(
      (_source: string) =>
        new Promise<SVGElement>((resolve) => resolvers.push(resolve)),
    );
    const preview = new MermaidPreview(document, render);
    previews.push(preview);
    preview.setSource("A", "1:draft");
    preview.accept(valid("A"), "1:draft");
    for (const source of ["B", "C", "D"]) {
      preview.setSource(source, "1:draft");
      preview.accept(valid(source), "1:draft");
    }
    expect(render).toHaveBeenCalledTimes(1);
    resolvers[0]!(svg("stale"));
    await flush();
    expect(preview.diagram.textContent).toBe("");
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]?.[0]).toBe("D");
    resolvers[1]!(svg("latest"));
    await flush();
    expect(preview.diagram.textContent).toBe("latest");
    expect(preview.element.dataset.previewState).toBe("rendered");
  });

  it("separates rendering failure, syntax error, runtime failure, checking and empty", async () => {
    const preview = new MermaidPreview(document, async () => {
      throw new Error("render failed");
    });
    previews.push(preview);
    preview.setSource("A", "draft");
    preview.accept(valid("A"), "draft");
    await flush();
    expect(preview.element.dataset.previewState).toBe("failed");
    preview.accept(
      { source: "A", status: "invalid", valid: false, error: "parse failed" },
      "draft",
    );
    expect(preview.element.dataset.previewState).toBe("invalid");
    preview.accept(
      {
        source: "A",
        status: "invalid",
        valid: false,
        errorKind: "runtime",
        error: "offline",
      },
      "draft",
    );
    expect(preview.element.dataset.previewState).toBe("unavailable");
    preview.setSource("B", "draft");
    expect(preview.element.dataset.previewState).toBe("checking");
    preview.setSource("", "draft");
    expect(preview.element.dataset.previewState).toBe("empty");
    expect(preview.diagram.childElementCount).toBe(0);
  });

  it("invalidates old targets, sessions, themes, and disposed results", async () => {
    const resolvers: Array<(svg: SVGElement) => void> = [];
    const render = vi.fn(
      () => new Promise<SVGElement>((resolve) => resolvers.push(resolve)),
    );
    const preview = new MermaidPreview(document, render);
    previews.push(preview);
    preview.setSource("same", "1:candidate");
    preview.accept(valid("same"), "1:candidate");
    preview.clear();
    preview.setSource("same", "2:draft");
    preview.accept(valid("same"), "1:candidate");
    expect(render).toHaveBeenCalledTimes(1);
    preview.accept(valid("same"), "2:draft");
    document.body.className = "vscode-light";
    await flush();
    resolvers[0]!(svg("old"));
    await flush();
    expect(preview.diagram.textContent).toBe("");
    expect(render).toHaveBeenCalledTimes(2);
    preview.dispose();
    resolvers[1]!(svg("closed"));
    await flush();
    expect(preview.diagram.textContent).toBe("");
  });
});
