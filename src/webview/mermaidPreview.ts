import { renderSafeMermaidSvg } from "./mermaidEnhancer";
import {
  normalizeMermaidSource,
  type MermaidValidationSnapshot,
} from "./mermaidValidation";

interface PreviewRequest {
  readonly generation: number;
  readonly source: string;
  readonly target: string;
}

/** One running render and one latest pending render, across modal sessions. */
export class MermaidPreview {
  readonly element: HTMLElement;
  readonly status: HTMLElement;
  readonly diagram: HTMLElement;
  private source = "";
  private target = "";
  private generation = 0;
  private valid = false;
  private running = false;
  private pending: PreviewRequest | null = null;
  private disposed = false;
  private readonly observer: MutationObserver;

  constructor(
    ownerDocument: Document = document,
    private readonly render = renderSafeMermaidSvg,
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
      if (this.valid) this.enqueue();
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

  setSource(source: string, target: string): void {
    if (this.disposed) return;
    this.source = source;
    this.target = target;
    ++this.generation;
    this.valid = false;
    this.pending = null;
    this.diagram.replaceChildren();
    const hasSource = Boolean(normalizeMermaidSource(source));
    this.setStatus(
      hasSource ? "checking" : "empty",
      hasSource
        ? { busy: true }
        : { message: "Enter Mermaid code to see a preview." },
    );
  }

  accept(snapshot: MermaidValidationSnapshot, target: string): void {
    if (
      this.disposed ||
      !target ||
      target !== this.target ||
      snapshot.source !== this.source
    )
      return;
    if (snapshot.status === "valid") {
      this.valid = true;
      this.enqueue();
    } else {
      this.valid = false;
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
    this.valid = false;
    ++this.generation;
    this.pending = null;
    this.diagram.replaceChildren();
    this.setStatus("empty");
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.observer.disconnect();
  }

  private enqueue(): void {
    this.pending = {
      source: this.source,
      target: this.target,
      generation: this.generation,
    };
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
      if (!this.isCurrent(request)) return;
      this.diagram.replaceChildren(svg);
      this.setStatus("rendered");
    } catch (error) {
      if (!this.isCurrent(request)) return;
      this.diagram.replaceChildren();
      const detail =
        error instanceof Error
          ? error.message.replace(/\s+/g, " ").slice(0, 250)
          : "";
      this.setStatus("failed", {
        message:
          "Preview could not render. Syntax validation still controls insertion." +
          (detail ? " " + detail : ""),
      });
    } finally {
      this.running = false;
      if (this.pending && !this.disposed) void this.run();
    }
  }

  private isCurrent(request: PreviewRequest): boolean {
    return (
      !this.disposed &&
      this.valid &&
      request.generation === this.generation &&
      request.target === this.target &&
      request.source === this.source
    );
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
