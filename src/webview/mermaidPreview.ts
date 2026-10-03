import { mermaidThemeSignature, renderSafeMermaidSvg } from "./mermaidEnhancer";
import {
  buildMermaidTemplateSource,
  getMermaidTemplate,
  type MermaidTemplateDirection,
} from "./mermaidTemplates";
import {
  ensureMermaidRuntime,
  mermaidRuntimeVersionFromGlobal,
  normalizeMermaidSource,
  validateMermaidSource,
  type MermaidValidationSnapshot,
} from "./mermaidValidation";

type PreviewRenderKind = "validated-input" | "built-in-template";

interface PreviewRequest {
  readonly generation: number;
  readonly source: string;
  readonly target: string;
  readonly kind: PreviewRenderKind;
  readonly theme: string;
  readonly templateId?: string;
  readonly direction?: string;
}

const MAX_TEMPLATE_CACHE_ENTRIES = 16;

function markPerformance(name: string, request: PreviewRequest): void {
  try {
    globalThis.performance?.mark(name, {
      detail: {
        templateId: request.templateId,
        direction: request.direction,
        target: request.target,
        generation: request.generation,
      },
    });
  } catch {
    // Preview measurements must not affect rendering.
  }
}

/** One running validation/render and one latest pending candidate per session. */
export class MermaidPreview {
  readonly element: HTMLElement;
  readonly status: HTMLElement;
  readonly diagram: HTMLElement;
  private source = "";
  private target = "";
  private generation = 0;
  private renderKind: PreviewRenderKind = "validated-input";
  private templateIdentity:
    { templateId: string; direction?: MermaidTemplateDirection } | undefined;
  private canRender = false;
  private running = false;
  private pending: PreviewRequest | null = null;
  private disposed = false;
  private readonly templateSvgCache = new Map<string, SVGElement>();
  private readonly observer: MutationObserver;

  constructor(
    ownerDocument: Document = document,
    private readonly render = renderSafeMermaidSvg,
    private readonly onRuntimeReady?: () => void,
    private readonly validate = validateMermaidSource,
  ) {
    this.element = ownerDocument.createElement("section");
    this.element.className = "mm-mermaid-preview mm-document-content";
    this.element.setAttribute("aria-label", "Diagram preview");
    this.status = ownerDocument.createElement("p");
    this.status.className = "mm-mermaid-preview-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.diagram = ownerDocument.createElement("div");
    this.diagram.className = "mm-mermaid mm-mermaid-preview-diagram";
    this.element.append(this.status, this.diagram);
    this.observer = new MutationObserver(() => {
      if (this.disposed || !this.target) return;
      ++this.generation;
      this.pending = null;
      this.diagram.replaceChildren();
      if (this.canRender) this.enqueue();
    });
    for (const host of [ownerDocument.documentElement, ownerDocument.body]) {
      if (host)
        this.observer.observe(host, {
          attributes: true,
          attributeFilter: [
            "class",
            "style",
            "data-vscode-theme-id",
            "data-vscode-theme-kind",
          ],
        });
    }
  }

  /** Set user text without authorizing a render until its validation succeeds. */
  setSource(source: string, target: string): void {
    if (this.disposed) return;
    this.source = source;
    this.target = target;
    this.renderKind = "validated-input";
    this.templateIdentity = undefined;
    ++this.generation;
    this.canRender = false;
    this.pending = null;
    this.element.removeAttribute("data-preview-cache");
    this.diagram.replaceChildren();
    const hasSource = Boolean(normalizeMermaidSource(source));
    this.setStatus(
      hasSource ? "checking" : "empty",
      hasSource
        ? { busy: true }
        : { message: "Enter Mermaid code to see a preview." },
    );
  }

  /** Validate and render a built-in candidate immediately through the shared queue. */
  renderTemplate(
    templateId: string,
    direction: MermaidTemplateDirection | undefined,
    source: string,
    target: string,
  ): void {
    if (this.disposed || !target) return;
    const template = getMermaidTemplate(templateId);
    if (
      !template ||
      (direction && !template.directions?.includes(direction)) ||
      source !==
        buildMermaidTemplateSource(templateId, direction ? { direction } : {})
    )
      return;
    this.source = source;
    this.target = target;
    this.renderKind = "built-in-template";
    this.templateIdentity = {
      templateId,
      ...(direction ? { direction } : {}),
    };
    ++this.generation;
    this.canRender = true;
    this.pending = null;
    this.diagram.replaceChildren();
    this.enqueue(this.templateIdentity);
  }

  /** User-authored input reaches the renderer only with its current valid snapshot. */
  accept(snapshot: MermaidValidationSnapshot, target: string): void {
    if (
      this.disposed ||
      !target ||
      target !== this.target ||
      snapshot.source !== this.source
    )
      return;
    if (snapshot.status === "valid") {
      this.renderKind = "validated-input";
      this.templateIdentity = undefined;
      this.canRender = true;
      this.enqueue();
    } else {
      this.canRender = false;
      ++this.generation;
      this.pending = null;
      this.diagram.replaceChildren();
      const state =
        snapshot.errorKind === "runtime" ? "unavailable" : snapshot.status;
      this.setStatus(
        state,
        snapshot.status === "checking"
          ? { busy: true }
          : {
              message:
                snapshot.status === "empty"
                  ? "Enter Mermaid code to see a preview."
                  : snapshot.error?.trim() ||
                    (state === "unavailable"
                      ? "Mermaid validator is unavailable."
                      : "Mermaid syntax is invalid."),
            },
      );
    }
  }

  clear(): void {
    this.target = this.source = "";
    this.templateIdentity = undefined;
    this.canRender = false;
    ++this.generation;
    this.pending = null;
    this.templateSvgCache.clear();
    this.element.dataset.templateCacheEntries = "0";
    this.element.removeAttribute("data-preview-cache");
    this.diagram.replaceChildren();
    this.setStatus("empty");
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.templateSvgCache.clear();
    this.observer.disconnect();
  }

  private enqueue(
    identity:
      | { templateId: string; direction?: MermaidTemplateDirection }
      | undefined = this.templateIdentity,
  ): void {
    const request: PreviewRequest = {
      source: this.source,
      target: this.target,
      generation: this.generation,
      kind: this.renderKind,
      theme: this.currentThemeSignature(),
      ...(identity
        ? {
            templateId: identity.templateId,
            ...(identity.direction ? { direction: identity.direction } : {}),
          }
        : {}),
    };
    if (request.kind === "built-in-template") {
      markPerformance("markdown-mint-mermaid-template-selected", request);
      const key = this.cacheKey(request, mermaidRuntimeVersionFromGlobal());
      const cached = this.templateSvgCache.get(key);
      if (cached) {
        // Refresh insertion order for bounded least-recently-used eviction.
        this.templateSvgCache.delete(key);
        this.templateSvgCache.set(key, cached);
        this.element.dataset.previewCache = "hit";
        if (this.isCurrent(request)) {
          this.diagram.replaceChildren(cached.cloneNode(true));
          this.setStatus("rendered");
          this.onRuntimeReady?.();
          markPerformance("markdown-mint-mermaid-template-dom", request);
          this.markNextPaint(request);
        }
        return;
      }
      this.element.dataset.previewCache = "miss";
    }
    this.pending = request;
    this.setStatus("rendering", { busy: true });
    if (!this.running) void this.run();
  }

  private async run(): Promise<void> {
    const request = this.pending;
    this.pending = null;
    if (!request || this.disposed) return;
    this.running = true;
    try {
      if (request.kind === "built-in-template") {
        const runtime = await ensureMermaidRuntime();
        if (!this.isCurrent(request)) return;
        if (runtime)
          markPerformance(
            "markdown-mint-mermaid-template-runtime-ready",
            request,
          );
        const validation = await this.validate(request.source, runtime);
        this.onRuntimeReady?.();
        if (!this.isCurrent(request)) return;
        markPerformance(
          "markdown-mint-mermaid-template-validation-end",
          request,
        );
        if (!validation.valid) {
          this.diagram.replaceChildren();
          this.setStatus(
            validation.errorKind === "runtime" ? "unavailable" : "invalid",
            {
              message:
                validation.error?.trim() ||
                (validation.errorKind === "runtime"
                  ? "Mermaid validator is unavailable."
                  : "Template syntax is invalid."),
            },
          );
          return;
        }
      }
      if (!this.isCurrent(request)) return;
      if (request.kind === "built-in-template")
        markPerformance("markdown-mint-mermaid-template-render-start", request);
      const svg = await this.render(request.source, this.element);
      if (request.kind !== "built-in-template") this.onRuntimeReady?.();
      if (request.kind === "built-in-template")
        markPerformance("markdown-mint-mermaid-template-render-end", request);
      if (!this.isCurrent(request)) return;
      if (request.kind === "built-in-template")
        this.rememberTemplateSvg(request, svg);
      this.diagram.replaceChildren(svg);
      this.setStatus("rendered");
      if (request.kind === "built-in-template") {
        markPerformance("markdown-mint-mermaid-template-dom", request);
        this.markNextPaint(request);
      }
    } catch (error) {
      this.onRuntimeReady?.();
      if (!this.isCurrent(request)) return;
      this.diagram.replaceChildren();
      const detail =
        error instanceof Error
          ? error.message.replace(/\s+/g, " ").slice(0, 250)
          : "";
      this.setStatus("failed", {
        message:
          (request.kind === "built-in-template"
            ? "Template preview could not render."
            : "Preview could not render. Syntax validation still controls insertion.") +
          (detail ? " " + detail : ""),
      });
    } finally {
      this.running = false;
      if (this.pending && !this.disposed) void this.run();
      else if (
        !this.disposed &&
        this.canRender &&
        request.generation === this.generation &&
        request.theme !== this.currentThemeSignature()
      ) {
        ++this.generation;
        this.diagram.replaceChildren();
        this.enqueue();
      }
    }
  }

  private isCurrent(request: PreviewRequest): boolean {
    return (
      !this.disposed &&
      this.canRender &&
      request.generation === this.generation &&
      request.target === this.target &&
      request.source === this.source &&
      request.kind === this.renderKind &&
      request.theme === this.currentThemeSignature()
    );
  }

  private currentThemeSignature(): string {
    try {
      return mermaidThemeSignature(this.element);
    } catch {
      return "default";
    }
  }

  private cacheKey(request: PreviewRequest, runtimeVersion: string): string {
    const ownerDocument = this.element.ownerDocument;
    const width = ownerDocument.defaultView?.innerWidth ?? 0;
    return JSON.stringify([
      request.templateId,
      request.direction ?? "",
      request.source,
      request.theme,
      runtimeVersion,
      width,
    ]);
  }

  private rememberTemplateSvg(request: PreviewRequest, svg: SVGElement): void {
    const key = this.cacheKey(request, mermaidRuntimeVersionFromGlobal());
    this.templateSvgCache.delete(key);
    this.templateSvgCache.set(key, svg.cloneNode(true) as SVGElement);
    while (this.templateSvgCache.size > MAX_TEMPLATE_CACHE_ENTRIES) {
      const oldest = this.templateSvgCache.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.templateSvgCache.delete(oldest);
    }
    this.element.dataset.templateCacheEntries = String(
      this.templateSvgCache.size,
    );
  }

  private markNextPaint(request: PreviewRequest): void {
    const view = this.element.ownerDocument.defaultView;
    if (!view?.requestAnimationFrame) return;
    view.requestAnimationFrame(() => {
      if (this.isCurrent(request))
        markPerformance("markdown-mint-mermaid-template-next-frame", request);
    });
  }

  private setStatus(
    state: string,
    options: { message?: string; busy?: boolean } = {},
  ): void {
    this.element.dataset.previewState = state;
    this.element.setAttribute("aria-busy", String(options.busy ?? false));
    this.status.textContent = options.message ?? "";
    this.status.hidden = !options.message;
  }
}
