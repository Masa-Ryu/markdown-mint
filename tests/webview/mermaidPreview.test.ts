import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidPreview } from "../../src/webview/mermaidPreview";
import {
  buildMermaidTemplateSource,
  getMermaidTemplates,
} from "../../src/webview/mermaidTemplates";
import type {
  MermaidValidationResult,
  MermaidValidationSnapshot,
} from "../../src/webview/mermaidValidation";

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
const candidateValid: MermaidValidationResult = {
  valid: true,
  diagramType: "flowchart",
};
const candidate = (
  id: string,
  direction: "TD" | "LR" | undefined = undefined,
) => ({
  id,
  direction,
  source: buildMermaidTemplateSource(id, direction ? { direction } : {}),
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

  it("validates an internal candidate immediately, then reuses its theme-scoped SVG cache", async () => {
    const render = vi.fn(async (source: string) => svg(source));
    const validate = vi.fn(async () => candidateValid);
    const onRuntimeReady = vi.fn();
    const preview = new MermaidPreview(
      document,
      render,
      onRuntimeReady,
      validate,
    );
    previews.push(preview);

    const flowchart = candidate("flowchart-basic", "TD");
    preview.renderTemplate(
      flowchart.id,
      flowchart.direction,
      flowchart.source,
      "1:candidate",
    );
    await Promise.resolve();
    expect(validate).toHaveBeenCalledTimes(1);
    await flush();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(preview.diagram.textContent).toBe(flowchart.source);
    expect(preview.element.dataset.previewCache).toBe("miss");

    const horizontal = candidate("flowchart-basic", "LR");
    preview.renderTemplate(
      horizontal.id,
      horizontal.direction,
      horizontal.source,
      "1:candidate",
    );
    await flush();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(2);

    preview.renderTemplate(
      flowchart.id,
      flowchart.direction,
      flowchart.source,
      "2:draft",
    );
    expect(render).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(preview.diagram.textContent).toBe(flowchart.source);
    expect(preview.element.dataset.previewCache).toBe("hit");
    expect(onRuntimeReady).toHaveBeenCalledTimes(3);
  });

  it("revalidates and rerenders a candidate after the active theme changes", async () => {
    const render = vi.fn(async (source: string) => svg(source));
    const validate = vi.fn(async () => candidateValid);
    const preview = new MermaidPreview(document, render, undefined, validate);
    previews.push(preview);
    document.body.className = "vscode-light";
    await flush();

    const flowchart = candidate("flowchart-basic", "TD");
    preview.renderTemplate(
      flowchart.id,
      flowchart.direction,
      flowchart.source,
      "1:candidate",
    );
    await flush();
    document.body.className = "vscode-dark";
    await flush();
    await flush();
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(preview.element.dataset.previewCache).toBe("miss");
  });

  it("coalesces candidate validation and rendering to one running plus the latest pending request", async () => {
    const validationResolvers: Array<
      (result: MermaidValidationResult) => void
    > = [];
    const validate = vi.fn(
      (_source: string) =>
        new Promise<MermaidValidationResult>((resolve) =>
          validationResolvers.push(resolve),
        ),
    );
    const render = vi.fn(async (source: string) => svg(source));
    const preview = new MermaidPreview(document, render, undefined, validate);
    previews.push(preview);
    const A = candidate("flowchart-basic", "TD");
    const B = candidate("flowchart-decision", "TD");
    const C = candidate("flowchart-grouped", "TD");
    preview.renderTemplate(A.id, A.direction, A.source, "1:candidate");
    await Promise.resolve();
    expect(validate).toHaveBeenCalledTimes(1);
    preview.renderTemplate(B.id, B.direction, B.source, "1:candidate");
    preview.renderTemplate(C.id, C.direction, C.source, "1:candidate");
    expect(render).toHaveBeenCalledTimes(0);
    validationResolvers[0]!(candidateValid);
    await flush();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate.mock.calls[1]?.[0]).toBe(C.source);
    expect(render).toHaveBeenCalledTimes(0);
    validationResolvers[1]!(candidateValid);
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0]).toBe(C.source);
    expect(preview.diagram.textContent).toBe(C.source);
    expect(preview.element.dataset.templateCacheEntries).toBe("1");
  });

  it("keeps one running render while candidates change and does not cache stale output", async () => {
    const renderResolvers: Array<(svg: SVGElement) => void> = [];
    const render = vi.fn(
      (source: string) =>
        new Promise<SVGElement>((resolve) => {
          renderResolvers.push((result) => {
            result.dataset.source = source;
            resolve(result);
          });
        }),
    );
    const validate = vi.fn(async () => candidateValid);
    const preview = new MermaidPreview(document, render, undefined, validate);
    previews.push(preview);
    const A = candidate("flowchart-basic", "TD");
    const B = candidate("flowchart-decision", "TD");
    const C = candidate("flowchart-grouped", "TD");
    preview.renderTemplate(A.id, A.direction, A.source, "1:candidate");
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    preview.renderTemplate(B.id, B.direction, B.source, "1:candidate");
    preview.renderTemplate(C.id, C.direction, C.source, "1:candidate");
    expect(validate).toHaveBeenCalledTimes(1);
    renderResolvers[0]!(svg("stale"));
    await flush();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]?.[0]).toBe(C.source);
    renderResolvers[1]!(svg("current"));
    await flush();
    expect(preview.diagram.textContent).toBe("current");

    preview.renderTemplate(A.id, A.direction, A.source, "1:candidate");
    await flush();
    expect(validate).toHaveBeenCalledTimes(3);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid candidates, limits the cache to the built-in catalog, and clears it on close", async () => {
    const render = vi.fn(async (source: string) => svg(source));
    const validate = vi.fn(async () => candidateValid);
    const preview = new MermaidPreview(document, render, undefined, validate);
    previews.push(preview);
    validate.mockResolvedValueOnce({
      valid: false,
      error: "Invalid built-in source",
      errorKind: "syntax",
    });
    const first = candidate("flowchart-basic", "TD");
    preview.renderTemplate(
      first.id,
      first.direction,
      first.source,
      "1:candidate",
    );
    await flush();
    expect(preview.element.dataset.previewState).toBe("invalid");
    expect(render).not.toHaveBeenCalled();

    for (const template of getMermaidTemplates()) {
      const directions = template.directions ?? [undefined];
      for (const direction of directions) {
        const item = candidate(template.id, direction);
        preview.renderTemplate(
          item.id,
          item.direction,
          item.source,
          "1:candidate",
        );
        await flush();
      }
    }
    expect(
      Number(preview.element.dataset.templateCacheEntries),
    ).toBeLessThanOrEqual(16);
    expect(Number(preview.element.dataset.templateCacheEntries)).toBe(16);
    preview.clear();
    expect(preview.element.dataset.templateCacheEntries).toBe("0");
    preview.renderTemplate(
      first.id,
      first.direction,
      first.source,
      "2:candidate",
    );
    await flush();
    expect(validate).toHaveBeenCalled();
    expect(preview.element.dataset.previewCache).toBe("miss");
  });
});
