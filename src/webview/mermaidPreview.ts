import { mermaidThemeSignature, renderSafeMermaidSvg } from "./mermaidEnhancer";
import {
  normalizeMermaidSource,
  type MermaidValidationSnapshot,
} from "./mermaidValidation";

type PreviewRenderKind = "validated-input" | "built-in-template";

interface PreviewRequest {
  readonly generation: number;
  readonly source: string;
  readonly target: string;
  readonly kind: PreviewRenderKind;
  readonly theme: string;
}

const MAX_TEMPLATE_CACHE_ENTRIES = 64;

/** One running render and one latest pending render, across modal sessions. */
export class MermaidPreview {
  readonly element: HTMLElement;
  readonly status: HTMLElement;
  readonly diagram: HTMLElement;
  private source = "";
  private target = "";
  private generation = 0;
  private renderKind: PreviewRenderKind = "validated-input";
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

  /** Render an internal catalog source directly, without a validation snapshot. */
  renderTemplate(source: string, target: string): void {
    if (this.disposed || !target) return;
    this.source = source;
    this.target = target;
    this.renderKind = "built-in-template";
    ++this.generation;
    this.canRender = true;
    this.pending = null;
    this.diagram.replaceChildren();
    this.enqueue();
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
    this.canRender = false;
    ++this.generation;
    this.pending = null;
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

  private enqueue(): void {
    const request: PreviewRequest = {
      source: this.source,
      target: this.target,
      generation: this.generation,
      kind: this.renderKind,
      theme: this.currentThemeSignature(),
    };
    if (request.kind === "built-in-template") {
      const key = this.cacheKey(request);
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
      const svg = await this.render(request.source, this.element);
      this.onRuntimeReady?.();
      if (!this.isCurrent(request)) return;
      if (request.kind === "built-in-template")
        this.rememberTemplateSvg(request, svg);
      this.diagram.replaceChildren(svg);
      this.setStatus("rendered");
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

  private cacheKey(request: PreviewRequest): string {
    return JSON.stringify([request.source, request.theme]);
  }

  private rememberTemplateSvg(request: PreviewRequest, svg: SVGElement): void {
    const key = this.cacheKey(request);
    this.templateSvgCache.delete(key);
    this.templateSvgCache.set(key, svg.cloneNode(true) as SVGElement);
    while (this.templateSvgCache.size > MAX_TEMPLATE_CACHE_ENTRIES) {
      const oldest = this.templateSvgCache.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.templateSvgCache.delete(oldest);
    }
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
