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
    expect(preview.element.getAttribute("aria-busy")).toBe("true");
    expect(preview.status.hidden).toBe(true);
    expect(preview.status.textContent).toBe("");
    preview.setSource("", "draft");
    expect(preview.element.dataset.previewState).toBe("empty");
    expect(preview.element.getAttribute("aria-busy")).toBe("false");
    expect(preview.status.hidden).toBe(false);
    expect(preview.status.textContent).toBe(
      "Enter Mermaid code to see a preview.",
    );
    expect(preview.diagram.childElementCount).toBe(0);
  });

  it("uses aria-busy without progress text while checking and rendering", async () => {
    let finish!: (svg: SVGElement) => void;
    const preview = new MermaidPreview(
      document,
      () => new Promise<SVGElement>((resolve) => (finish = resolve)),
    );
    previews.push(preview);
    preview.setSource("A", "draft");
    expect(preview.element.getAttribute("aria-busy")).toBe("true");
    expect(preview.status.hidden).toBe(true);
    expect(preview.status.textContent).toBe("");
    preview.accept(valid("A"), "draft");
    expect(preview.element.dataset.previewState).toBe("rendering");
    expect(preview.element.getAttribute("aria-busy")).toBe("true");
    expect(preview.status.hidden).toBe(true);
    expect(preview.status.textContent).toBe("");
    finish(svg("rendered"));
    await flush();
    expect(preview.element.dataset.previewState).toBe("rendered");
    expect(preview.element.getAttribute("aria-busy")).toBe("false");
    expect(preview.status.hidden).toBe(true);
    expect(preview.status.textContent).toBe("");
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

  it("renders built-in sources directly and reuses its theme-scoped SVG cache", async () => {
    const render = vi.fn(async (source: string) => svg(source));
    const onRuntimeReady = vi.fn();
    const preview = new MermaidPreview(document, render, onRuntimeReady);
    previews.push(preview);

    preview.renderTemplate("template source", "1:candidate");
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    expect(preview.diagram.textContent).toBe("template source");
    expect(preview.element.dataset.previewCache).toBe("miss");

    preview.clear();
    preview.renderTemplate("template source", "2:draft");
    expect(render).toHaveBeenCalledTimes(1);
    expect(preview.diagram.textContent).toBe("template source");
    expect(preview.element.dataset.previewCache).toBe("hit");
    expect(onRuntimeReady).toHaveBeenCalledTimes(2);
  });

  it("keys built-in SVG cache entries by the active Mermaid theme", async () => {
    const render = vi.fn(async (source: string) => svg(source));
    const preview = new MermaidPreview(document, render);
    previews.push(preview);
    document.body.className = "vscode-light";
    await flush();

    preview.renderTemplate("same source", "1:candidate");
    await flush();
    preview.clear();
    document.body.className = "vscode-dark";
    await flush();
    preview.renderTemplate("same source", "2:candidate");
    await flush();
    expect(render).toHaveBeenCalledTimes(2);

    preview.clear();
    preview.renderTemplate("same source", "3:candidate");
    expect(render).toHaveBeenCalledTimes(2);
    expect(preview.element.dataset.previewCache).toBe("hit");
  });

  it("coalesces direct template requests to the latest candidate", async () => {
    const resolvers: Array<(svg: SVGElement) => void> = [];
    const render = vi.fn(
      (_source: string) =>
        new Promise<SVGElement>((resolve) => resolvers.push(resolve)),
    );
    const preview = new MermaidPreview(document, render);
    previews.push(preview);
    preview.renderTemplate("A", "1:candidate");
    preview.renderTemplate("B", "1:candidate");
    preview.renderTemplate("C", "1:candidate");
    expect(render).toHaveBeenCalledTimes(1);
    resolvers[0]!(svg("stale A"));
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]?.[0]).toBe("C");
    resolvers[1]!(svg("latest C"));
    await flush();
    expect(preview.diagram.textContent).toBe("latest C");
  });
});
