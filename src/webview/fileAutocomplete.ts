import {
  MAX_WORKSPACE_FILE_SEARCH_RESULTS,
  isWorkspaceFileSearchQuery,
  type WorkspaceFileCandidate,
} from "../shared/workspaceFileSearch";

export const DEFAULT_FILE_AUTOCOMPLETE_DEBOUNCE_MS = 0;

export type FileAutocompleteSearchState =
  "idle" | "loading" | "results" | "empty";

export type FileAutocompleteTimingPhase =
  | "input"
  | "search-dispatch"
  | "host-result"
  | "dom-update"
  | "paint-opportunity";

export interface FileAutocompleteOptions {
  readonly input: HTMLInputElement;
  readonly onQuery: (query: string) => void;
  readonly onSelect?: (candidate: WorkspaceFileCandidate) => void;
  readonly onEnter?: () => void;
  readonly onEscape?: () => void;
  readonly debounceMs?: number;
  readonly onSearchTiming?: (
    phase: FileAutocompleteTimingPhase,
    query: string,
  ) => void;
}

let nextAutocompleteId = 0;

/**
 * The shared input-side controller for link and image file suggestions.
 * Discovery and ranking stay in the extension host; this class only owns the
 * small popup and the keyboard/focus contract around the input element.
 */
export class FileAutocomplete {
  private readonly input: HTMLInputElement;
  private readonly onQuery: (query: string) => void;
  private readonly onSelect:
    ((candidate: WorkspaceFileCandidate) => void) | undefined;
  private readonly onEnter: (() => void) | undefined;
  private readonly onEscape: (() => void) | undefined;
  private readonly onSearchTiming:
    ((phase: FileAutocompleteTimingPhase, query: string) => void) | undefined;
  private readonly debounceMs: number;
  private readonly popup: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  private readonly inputHandler: () => void;
  private readonly keydownHandler: (event: KeyboardEvent) => void;
  private readonly pointerMoveHandler: (event: PointerEvent) => void;
  private readonly pointerDownHandler: (event: PointerEvent) => void;
  private readonly clickHandler: (event: MouseEvent) => void;
  private queryTimer: ReturnType<typeof setTimeout> | undefined;
  private candidates: readonly WorkspaceFileCandidate[] = [];
  private activeIndex = -1;
  private enabled = false;
  private searchRequested = false;
  private searchState: FileAutocompleteSearchState = "idle";
  private searchId = 0;
  private suppressSubmit = false;
  private suppressSubmitTimer: number | undefined;

  public constructor(options: FileAutocompleteOptions) {
    this.input = options.input;
    this.onQuery = options.onQuery;
    this.onSelect = options.onSelect;
    this.onEnter = options.onEnter;
    this.onEscape = options.onEscape;
    this.onSearchTiming = options.onSearchTiming;
    this.debounceMs = Math.max(
      0,
      Math.min(options.debounceMs ?? DEFAULT_FILE_AUTOCOMPLETE_DEBOUNCE_MS, 20),
    );
    const ownerDocument = this.input.ownerDocument;
    this.popup = ownerDocument.createElement("div");
    this.popup.className = "mm-file-autocomplete";
    this.popup.id = `mm-file-autocomplete-${++nextAutocompleteId}`;
    this.popup.hidden = true;
    this.popup.setAttribute("role", "listbox");
    this.popup.setAttribute("aria-label", "Workspace files");
    this.footer = ownerDocument.createElement("div");
    this.footer.className = "mm-file-autocomplete-footer";
    this.footer.setAttribute("role", "status");
    this.footer.setAttribute("aria-live", "polite");
    this.footer.hidden = true;
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-controls", this.popup.id);
    this.input.setAttribute("aria-expanded", "false");
    this.input.autocomplete = "off";
    this.input.parentElement?.append(this.popup, this.footer);

    this.inputHandler = () => this.handleInput();
    this.keydownHandler = (event) => this.handleKeyDown(event);
    this.pointerMoveHandler = (event) => {
      const index = this.optionIndex(event.target);
      if (index !== undefined) this.setActiveIndex(index);
    };
    this.pointerDownHandler = (event) => {
      const target = event.target;
      if (target instanceof Node && this.popup.contains(target))
        event.preventDefault();
      const index = this.optionIndex(target);
      if (index !== undefined) this.setActiveIndex(index);
    };
    this.clickHandler = (event) => this.handleClick(event);
    this.input.addEventListener("input", this.inputHandler);
    this.input.addEventListener("keydown", this.keydownHandler);
    this.popup.addEventListener("pointermove", this.pointerMoveHandler);
    this.popup.addEventListener("pointerdown", this.pointerDownHandler);
    this.popup.addEventListener("click", this.clickHandler);
  }

  public open(): void {
    this.enabled = true;
    this.searchRequested = false;
    this.searchState = "idle";
    this.resetResults();
  }

  public close(): void {
    this.enabled = false;
    this.clear();
    this.clearSubmitSuppression();
  }

  public clear(): void {
    this.searchRequested = false;
    this.searchState = "idle";
    this.resetResults();
  }

  public setCandidates(candidates: readonly WorkspaceFileCandidate[]): void {
    if (
      !this.enabled ||
      !this.searchRequested ||
      !isWorkspaceFileSearchQuery(this.input.value)
    ) {
      this.clear();
      return;
    }
    const query = this.input.value.trim();
    this.reportTiming("host-result", query);
    const activePath = this.candidates[this.activeIndex]?.relativePath;
    this.candidates = candidates
      .slice(0, MAX_WORKSPACE_FILE_SEARCH_RESULTS)
      .filter(isSafeCandidate);
    const retainedIndex = activePath
      ? this.candidates.findIndex(
          (candidate) => candidate.relativePath === activePath,
        )
      : -1;
    this.activeIndex =
      retainedIndex >= 0 ? retainedIndex : this.candidates.length > 0 ? 0 : -1;
    this.searchState = this.candidates.length > 0 ? "results" : "empty";
    this.render();
    this.reportTiming("dom-update", query);
    this.schedulePaintOpportunity(query, this.searchId);
  }

  /** Consume the submit generated by a candidate-selection Enter key, once. */
  public consumeSubmit(): boolean {
    const suppressed = this.suppressSubmit;
    this.suppressSubmit = false;
    if (this.suppressSubmitTimer !== undefined) {
      clearTimeout(this.suppressSubmitTimer);
      this.suppressSubmitTimer = undefined;
    }
    return suppressed;
  }

  public dispose(): void {
    this.close();
    this.input.removeEventListener("input", this.inputHandler);
    this.input.removeEventListener("keydown", this.keydownHandler);
    this.popup.removeEventListener("pointermove", this.pointerMoveHandler);
    this.popup.removeEventListener("pointerdown", this.pointerDownHandler);
    this.popup.removeEventListener("click", this.clickHandler);
    this.popup.remove();
    this.footer.remove();
  }

  private handleInput(): void {
    this.suppressSubmit = false;
    const query = this.input.value.trim();
    this.searchId += 1;
    this.searchRequested = isWorkspaceFileSearchQuery(query);
    this.searchState = this.searchRequested ? "loading" : "idle";
    this.resetResults();
    if (this.enabled) this.reportTiming("input", query);
    if (!this.enabled || !this.searchRequested) return;
    const schedule = (): void => {
      this.queryTimer = undefined;
      if (
        this.enabled &&
        query === this.input.value.trim() &&
        isWorkspaceFileSearchQuery(query)
      ) {
        this.reportTiming("search-dispatch", query);
        this.onQuery(query);
      }
    };
    if (this.debounceMs === 0) schedule();
    else this.queryTimer = setTimeout(schedule, this.debounceMs);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    const visible = !this.popup.hidden;
    const plainEnter =
      event.key === "Enter" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey;
    if (event.key === "Escape" && visible) {
      event.preventDefault();
      event.stopPropagation();
      if (this.onEscape) this.onEscape();
      else {
        this.clear();
        this.input.focus();
      }
      return;
    }
    if (!visible) {
      if (plainEnter && this.input.value.trim() && this.onEnter) {
        event.preventDefault();
        event.stopPropagation();
        this.onEnter();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (this.candidates.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (this.activeIndex + delta + this.candidates.length) %
        this.candidates.length;
      this.setActiveIndex(nextIndex);
      return;
    }
    if (plainEnter && this.candidates[this.activeIndex]) {
      event.preventDefault();
      event.stopPropagation();
      this.selectActive(true);
      return;
    }
    if (plainEnter && this.input.value.trim() && this.onEnter) {
      event.preventDefault();
      event.stopPropagation();
      this.onEnter();
    }
  }

  private handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const option = target.closest<HTMLButtonElement>(
      "[data-mm-file-autocomplete-option]",
    );
    if (!option) return;
    const index = this.optionIndex(option);
    if (index === undefined) return;
    event.preventDefault();
    this.setActiveIndex(index);
    this.selectActive(false);
  }

  private selectActive(suppressSubmit: boolean): void {
    const candidate = this.candidates[this.activeIndex];
    if (!candidate) return;
    this.input.value = candidate.relativePath;
    this.searchRequested = false;
    this.searchState = "idle";
    this.resetResults();
    if (suppressSubmit) this.setSubmitSuppression();
    this.input.focus();
    this.onSelect?.(candidate);
  }

  private setActiveIndex(index: number): void {
    if (!this.candidates[index] || this.activeIndex === index) return;
    const previousIndex = this.activeIndex;
    this.activeIndex = index;
    this.updateActivePresentation(previousIndex, index);
  }

  private optionIndex(target: EventTarget | null): number | undefined {
    if (!(target instanceof Element)) return undefined;
    const option = target.closest<HTMLButtonElement>(
      "[data-mm-file-autocomplete-option]",
    );
    if (!option || !this.popup.contains(option)) return undefined;
    const index = Number(option.dataset.mmFileAutocompleteOption);
    return Number.isInteger(index) &&
      index >= 0 &&
      index < this.candidates.length
      ? index
      : undefined;
  }

  private setSubmitSuppression(): void {
    this.clearSubmitSuppression();
    this.suppressSubmit = true;
    const ownerWindow = this.input.ownerDocument.defaultView;
    this.suppressSubmitTimer = ownerWindow?.setTimeout(() => {
      this.suppressSubmit = false;
      this.suppressSubmitTimer = undefined;
    }, 0);
  }

  private clearSubmitSuppression(): void {
    if (this.suppressSubmitTimer !== undefined) {
      clearTimeout(this.suppressSubmitTimer);
      this.suppressSubmitTimer = undefined;
    }
    this.suppressSubmit = false;
  }

  private render(): void {
    this.popup.replaceChildren();
    const visible =
      this.enabled &&
      this.searchRequested &&
      isWorkspaceFileSearchQuery(this.input.value);
    this.popup.hidden = !visible;
    this.footer.hidden = !visible;
    this.popup.dataset.searchState = visible ? this.searchState : "idle";
    this.input.setAttribute("aria-expanded", String(visible));
    this.input.setAttribute(
      "aria-busy",
      String(visible && this.searchState === "loading"),
    );
    this.input.removeAttribute("aria-activedescendant");
    this.footer.textContent = "";
    if (!visible) return;

    if (this.searchState === "loading") {
      const loading = this.input.ownerDocument.createElement("div");
      loading.className = "mm-file-autocomplete-loading";
      loading.setAttribute("role", "status");
      loading.textContent = "Searching workspace files…";
      this.popup.append(loading);
      this.footer.textContent = "Searching workspace files…";
      return;
    }

    if (this.searchState === "empty") {
      const empty = this.input.ownerDocument.createElement("div");
      empty.className = "mm-file-autocomplete-empty";
      empty.textContent = "No matching workspace files.";
      this.popup.append(empty);
      this.footer.textContent = "Enter a path or URL manually.";
      return;
    }

    this.candidates.forEach((candidate, index) => {
      const option = this.input.ownerDocument.createElement("button");
      option.type = "button";
      option.className = "mm-file-autocomplete-option";
      option.tabIndex = -1;
      option.dataset.mmFileAutocompleteOption = String(index);
      option.id = `${this.popup.id}-option-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === this.activeIndex));
      const name = this.input.ownerDocument.createElement("span");
      name.className = "mm-file-autocomplete-name";
      name.textContent = candidate.fileName;
      const directory = this.input.ownerDocument.createElement("span");
      directory.className = "mm-file-autocomplete-directory";
      directory.textContent = candidate.directory;
      option.title = candidate.relativePath;
      option.append(name, directory);
      this.popup.append(option);
    });
    this.updateActivePresentation(-1, this.activeIndex);
  }

  private updateActivePresentation(
    previousIndex: number,
    nextIndex: number,
  ): void {
    const previous = this.optionAt(previousIndex);
    if (previous) {
      previous.classList.remove("is-active");
      previous.setAttribute("aria-selected", "false");
    }

    const next = this.optionAt(nextIndex);
    if (!next) {
      this.input.removeAttribute("aria-activedescendant");
      this.footer.textContent = "";
      return;
    }
    next.classList.add("is-active");
    next.setAttribute("aria-selected", "true");
    this.input.setAttribute("aria-activedescendant", next.id);
    this.footer.textContent = this.candidates[nextIndex]?.relativePath ?? "";
    this.ensureActiveVisible(next);
  }

  private optionAt(index: number): HTMLButtonElement | null {
    if (index < 0) return null;
    return this.popup.querySelector<HTMLButtonElement>(
      `[data-mm-file-autocomplete-option="${index}"]`,
    );
  }

  private ensureActiveVisible(active: HTMLElement): void {
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    const visibleBottom = this.popup.scrollTop + this.popup.clientHeight;
    if (this.popup.clientHeight <= 0) return;
    if (top < this.popup.scrollTop) this.popup.scrollTop = top;
    else if (bottom > visibleBottom)
      this.popup.scrollTop = bottom - this.popup.clientHeight;
  }

  private resetResults(): void {
    if (this.queryTimer !== undefined) {
      clearTimeout(this.queryTimer);
      this.queryTimer = undefined;
    }
    this.candidates = [];
    this.activeIndex = -1;
    this.render();
  }

  private schedulePaintOpportunity(query: string, searchId: number): void {
    const ownerWindow = this.input.ownerDocument.defaultView;
    if (!ownerWindow || typeof ownerWindow.requestAnimationFrame !== "function")
      return;
    ownerWindow.requestAnimationFrame(() =>
      this.reportTiming("paint-opportunity", query, searchId),
    );
  }

  private reportTiming(
    phase: FileAutocompleteTimingPhase,
    query: string,
    searchId = this.searchId,
  ): void {
    this.onSearchTiming?.(phase, query);
    const debugGlobal = globalThis as typeof globalThis & {
      __markdownMintDebugFileSearch?: boolean;
    };
    if (!debugGlobal.__markdownMintDebugFileSearch && !this.onSearchTiming)
      return;
    const performanceApi = this.input.ownerDocument.defaultView?.performance;
    if (!performanceApi || typeof performanceApi.mark !== "function") return;
    const marker = `markdown-mint:file-search:${searchId}:${phase}`;
    performanceApi.mark(marker);
    if (debugGlobal.__markdownMintDebugFileSearch)
      console.debug("[Markdown Mint] file search", {
        phase,
        query,
        searchId,
        timestamp: performanceApi.now(),
      });
  }
}

function isSafeCandidate(
  candidate: WorkspaceFileCandidate,
): candidate is WorkspaceFileCandidate {
  return (
    candidate.fileName.length > 0 &&
    candidate.fileName.length <= 1_024 &&
    candidate.directory.length > 0 &&
    candidate.directory.length <= 8_192 &&
    candidate.relativePath.length > 0 &&
    candidate.relativePath.length <= 8_192 &&
    /^(?:\.\/|\.\.\/)/.test(candidate.relativePath) &&
    !hasControlCharacter(
      `${candidate.fileName}${candidate.directory}${candidate.relativePath}`,
    ) &&
    !candidate.fileName.includes("\\") &&
    !candidate.directory.includes("\\") &&
    !candidate.relativePath.includes("\\") &&
    !/[?#]/.test(candidate.relativePath)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
