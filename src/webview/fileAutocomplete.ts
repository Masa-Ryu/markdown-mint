import {
  isWorkspaceFileSearchQuery,
  type WorkspaceFileCandidate,
} from "../shared/workspaceFileSearch";

export interface FileAutocompleteOptions {
  readonly input: HTMLInputElement;
  readonly onQuery: (query: string) => void;
  readonly onSelect?: (candidate: WorkspaceFileCandidate) => void;
  readonly onEnter?: () => void;
  readonly onEscape?: () => void;
  readonly debounceMs?: number;
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
  private suppressSubmit = false;
  private suppressSubmitTimer: number | undefined;

  public constructor(options: FileAutocompleteOptions) {
    this.input = options.input;
    this.onQuery = options.onQuery;
    this.onSelect = options.onSelect;
    this.onEnter = options.onEnter;
    this.onEscape = options.onEscape;
    this.debounceMs = Math.max(0, Math.min(options.debounceMs ?? 75, 250));
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
    this.resetState();
  }

  public close(): void {
    this.enabled = false;
    this.clear();
    this.clearSubmitSuppression();
  }

  public clear(): void {
    this.searchRequested = false;
    this.resetState();
  }

  private resetState(): void {
    if (this.queryTimer !== undefined) {
      clearTimeout(this.queryTimer);
      this.queryTimer = undefined;
    }
    this.candidates = [];
    this.activeIndex = -1;
    this.render();
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
    const activePath = this.candidates[this.activeIndex]?.relativePath;
    this.candidates = candidates.slice(0, 10).filter(isSafeCandidate);
    const retainedIndex = activePath
      ? this.candidates.findIndex(
          (candidate) => candidate.relativePath === activePath,
        )
      : -1;
    this.activeIndex =
      retainedIndex >= 0 ? retainedIndex : this.candidates.length > 0 ? 0 : -1;
    this.render();
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
    this.searchRequested = isWorkspaceFileSearchQuery(this.input.value);
    this.resetState();
    if (!this.enabled || !this.searchRequested) return;
    const query = this.input.value.trim();
    const schedule = (): void => {
      this.queryTimer = undefined;
      if (
        this.enabled &&
        query === this.input.value.trim() &&
        isWorkspaceFileSearchQuery(query)
      )
        this.onQuery(query);
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
      this.activeIndex =
        (this.activeIndex + delta + this.candidates.length) %
        this.candidates.length;
      this.render();
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
    this.resetState();
    if (suppressSubmit) this.setSubmitSuppression();
    this.input.focus();
    this.onSelect?.(candidate);
  }

  private setActiveIndex(index: number): void {
    if (!this.candidates[index] || this.activeIndex === index) return;
    this.activeIndex = index;
    this.render();
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
    this.input.setAttribute("aria-expanded", String(visible));
    this.input.removeAttribute("aria-activedescendant");
    this.footer.textContent = "";
    if (!visible) return;

    if (this.candidates.length === 0) {
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
    const active = this.popup.querySelector<HTMLButtonElement>(
      `[data-mm-file-autocomplete-option="${this.activeIndex}"]`,
    );
    if (active) {
      active.classList.add("is-active");
      this.input.setAttribute("aria-activedescendant", active.id);
      this.footer.textContent =
        this.candidates[this.activeIndex]?.relativePath ?? "";
      this.ensureActiveVisible(active);
    }
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
