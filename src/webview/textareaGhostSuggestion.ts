/** A display-only ghost layer that leaves the textarea value untouched. */
export class TextareaGhostSuggestion {
  private overlay: HTMLDivElement | undefined;
  private prefix: HTMLSpanElement | undefined;
  private suggestion: HTMLSpanElement | undefined;
  private suffix: HTMLSpanElement | undefined;
  private observer: ResizeObserver | undefined;
  private active = false;
  private listenersAttached = false;
  private sourceColor: string | undefined;

  constructor(private readonly input: HTMLTextAreaElement) {}

  show(prefix: string, suggestion: string, suffix: string): void {
    if (!suggestion) {
      this.hide();
      return;
    }
    this.ensureOverlay();
    if (!this.active) {
      this.sourceColor = this.input.ownerDocument.defaultView?.getComputedStyle(
        this.input,
      ).color;
    }
    this.active = true;
    this.input.classList.add("mm-ai-textarea-ghost-source");
    this.prefix!.textContent = prefix;
    this.suggestion!.textContent = suggestion;
    this.suffix!.textContent = suffix;
    this.sync();
  }

  sync(): void {
    if (!this.active || !this.overlay) return;
    const ownerDocument = this.input.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const parent = this.input.closest("dialog") ?? this.input.parentElement;
    if (!ownerWindow || !parent || !this.input.isConnected) return;
    const rect = this.input.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const style = ownerWindow.getComputedStyle(this.input);
    const overlay = this.overlay;
    overlay.style.left = `${rect.left - parentRect.left + parent.scrollLeft}px`;
    overlay.style.top = `${rect.top - parentRect.top + parent.scrollTop}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.boxSizing = style.boxSizing;
    overlay.style.borderStyle = "solid";
    overlay.style.borderColor = "transparent";
    overlay.style.borderWidth = style.borderWidth;
    overlay.style.padding = style.padding;
    const verticalScrollbar = Math.max(
      0,
      this.input.offsetWidth -
        this.input.clientWidth -
        cssPixels(style.borderLeftWidth) -
        cssPixels(style.borderRightWidth),
    );
    overlay.style.paddingRight = `${cssPixels(style.paddingRight) + verticalScrollbar}px`;
    overlay.style.font = style.font;
    overlay.style.lineHeight = style.lineHeight;
    overlay.style.letterSpacing = style.letterSpacing;
    overlay.style.wordSpacing = style.wordSpacing;
    overlay.style.textIndent = style.textIndent;
    overlay.style.textAlign = style.textAlign;
    overlay.style.direction = style.direction;
    overlay.style.tabSize = style.tabSize;
    overlay.style.whiteSpace = style.whiteSpace || "pre-wrap";
    overlay.style.overflowWrap = style.overflowWrap || "break-word";
    overlay.style.wordBreak = style.wordBreak;
    overlay.style.color = this.sourceColor ?? style.color;
    overlay.style.background = "transparent";
    overlay.style.scrollbarGutter = style.scrollbarGutter;
    overlay.scrollTop = this.input.scrollTop;
    overlay.scrollLeft = this.input.scrollLeft;
  }

  hide(): void {
    this.active = false;
    this.input.classList.remove("mm-ai-textarea-ghost-source");
    this.sourceColor = undefined;
    this.overlay?.remove();
    this.overlay = undefined;
    this.prefix = undefined;
    this.suggestion = undefined;
    this.suffix = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.listenersAttached) {
      const ownerDocument = this.input.ownerDocument;
      ownerDocument.defaultView?.removeEventListener(
        "resize",
        this.onViewportChange,
      );
      ownerDocument.removeEventListener("scroll", this.onViewportChange, true);
      this.input.removeEventListener("scroll", this.onScroll);
      this.listenersAttached = false;
    }
  }

  dispose(): void {
    this.hide();
  }

  private ensureOverlay(): void {
    if (this.overlay) return;
    const ownerDocument = this.input.ownerDocument;
    const overlay = ownerDocument.createElement("div");
    overlay.className = "mm-ai-textarea-ghost-overlay";
    overlay.setAttribute("aria-hidden", "true");
    const prefix = ownerDocument.createElement("span");
    const suggestion = ownerDocument.createElement("span");
    suggestion.className = "mm-ai-suggestion";
    const suffix = ownerDocument.createElement("span");
    overlay.append(prefix, suggestion, suffix);
    (this.input.closest("dialog") ?? this.input.parentElement)?.append(overlay);
    this.overlay = overlay;
    this.prefix = prefix;
    this.suggestion = suggestion;
    this.suffix = suffix;
    const ResizeObserverConstructor = ownerDocument.defaultView?.ResizeObserver;
    if (ResizeObserverConstructor) {
      this.observer = new ResizeObserverConstructor(() => this.sync());
      this.observer.observe(this.input);
    }
    if (!this.listenersAttached) {
      ownerDocument.defaultView?.addEventListener(
        "resize",
        this.onViewportChange,
      );
      ownerDocument.addEventListener("scroll", this.onViewportChange, true);
      this.input.addEventListener("scroll", this.onScroll, { passive: true });
      this.listenersAttached = true;
    }
  }

  private readonly onViewportChange = (): void => this.sync();
  private readonly onScroll = (): void => this.sync();
}

function cssPixels(value: string): number {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? pixels : 0;
}
