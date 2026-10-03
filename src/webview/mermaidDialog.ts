import { MermaidPreview } from "./mermaidPreview";
import { MermaidTemplatePicker } from "./mermaidTemplatePicker";
import {
  MermaidTemplateSession,
  type MermaidDraftSnapshot,
} from "./mermaidTemplateSession";
import {
  MermaidValidationController,
  type MermaidValidationSnapshot,
} from "./mermaidValidation";

export interface MermaidDialogDisplayState {
  readonly screen: "closed" | "picker" | "editor";
  readonly pickerOrigin: "initial" | "editor" | null;
  readonly confirmation: "apply" | "restore" | null;
  readonly imeActive: boolean;
}

/** Mermaid-only modal UI. The editor owns all document writes and draft validation. */
export class MermaidDialog {
  readonly element: HTMLElement;
  private readonly session = new MermaidTemplateSession();
  private readonly preview = new MermaidPreview();
  private readonly picker: MermaidTemplatePicker;
  private readonly candidateValidation: MermaidValidationController;
  private readonly editor: HTMLElement;
  private readonly codePane: HTMLElement;
  private readonly previewPane: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly restore: HTMLButtonElement;
  private readonly confirmation: HTMLElement;
  private readonly confirmationText: HTMLElement;
  private inputSnapshot: MermaidDraftSnapshot | null = null;
  private active = false;
  private picking = false;
  private pickerOrigin: "initial" | "editor" | null = null;
  private sessionId = 0;
  private composing = false;
  private compositionEndedAt = -Infinity;
  private confirmationFocus: HTMLElement | null = null;
  private disposed = false;

  constructor(
    private readonly options: {
      dialog: HTMLDialogElement;
      bodyField: HTMLElement;
      input: HTMLTextAreaElement;
      onScreenChange(editing: boolean): void;
      onDisplayStateChange(state: MermaidDialogDisplayState): void;
      onRuntimeReady(): void;
    },
  ) {
    this.element = document.createElement("div");
    this.element.className = "mm-mermaid-workspace";
    this.element.hidden = true;
    this.toolbar = document.createElement("div");
    this.toolbar.className = "mm-mermaid-editor-toolbar";
    const templates = this.button("Templates", () => this.showPicker());
    this.restore = this.button("Undo replacement", () => this.requestRestore());
    this.restore.dataset.mermaidRestore = "true";
    this.toolbar.append(templates, this.restore);
    this.editor = document.createElement("div");
    this.editor.className = "mm-mermaid-code-preview";
    this.codePane = document.createElement("div");
    this.codePane.className = "mm-mermaid-code-pane";
    this.previewPane = document.createElement("div");
    this.previewPane.className = "mm-mermaid-preview-slot";
    this.editor.append(this.codePane, this.previewPane);
    this.candidateValidation = new MermaidValidationController((snapshot) => {
      if (this.active && this.picking) {
        this.preview.accept(snapshot, this.previewTarget);
        this.options.onRuntimeReady();
      }
    });
    this.picker = new MermaidTemplatePicker({
      select: (source) => {
        if (!this.active || !this.picking) return;
        this.preview.setSource(source, this.previewTarget);
        this.candidateValidation.schedule(source);
      },
    });
    this.confirmation = document.createElement("div");
    this.confirmation.className = "mm-mermaid-replacement-confirmation";
    this.confirmation.setAttribute("role", "group");
    this.confirmation.setAttribute("aria-label", "Confirm code replacement");
    this.confirmation.hidden = true;
    this.confirmationText = document.createElement("p");
    this.confirmationText.setAttribute("role", "status");
    this.confirmation.append(this.confirmationText);
    this.element.append(
      this.toolbar,
      this.confirmation,
      this.editor,
      this.picker.element,
    );
    options.dialog.addEventListener("keydown", this.onKeyDown, true);
    options.dialog.addEventListener(
      "compositionstart",
      this.onCompositionStart,
      true,
    );
    options.dialog.addEventListener(
      "compositionend",
      this.onCompositionEnd,
      true,
    );
  }

  get isEditing(): boolean {
    return this.active && !this.picking && !this.session.confirmation;
  }
  get canSubmit(): boolean {
    return this.isEditing && !this.imeActive;
  }
  get displayState(): MermaidDialogDisplayState {
    return {
      screen: !this.active ? "closed" : this.picking ? "picker" : "editor",
      pickerOrigin: this.pickerOrigin,
      confirmation: this.session.confirmation,
      imeActive: this.imeActive,
    };
  }
  private get previewTarget(): string {
    return `${this.sessionId}:${this.picking ? "candidate" : "draft"}`;
  }

  start(source: string, protectedSource: boolean, pick: boolean): void {
    this.close();
    ++this.sessionId;
    this.active = true;
    this.session.start(source, protectedSource);
    this.options.input.value = source;
    this.codePane.append(this.options.bodyField);
    this.element.hidden = false;
    this.picker.reset();
    this.restore.hidden = true;
    if (pick) this.showPicker("initial");
    else this.showCode(false);
  }

  inputChanged(): void {
    if (!this.active) return;
    this.session.edit(this.options.input.value);
    if (this.isEditing)
      this.preview.setSource(this.session.source, this.previewTarget);
  }

  acceptDraftValidation(snapshot: MermaidValidationSnapshot): void {
    if (this.isEditing) this.preview.accept(snapshot, this.previewTarget);
  }

  continueWithTemplate(): void {
    if (
      !this.active ||
      !this.picking ||
      this.session.confirmation ||
      this.imeActive
    )
      return;
    this.requestApply(this.picker.source);
  }

  returnToCode(): void {
    if (
      !this.active ||
      !this.picking ||
      this.session.confirmation ||
      this.imeActive
    )
      return;
    this.showCode(true);
  }

  confirmReplacement(): void {
    if (!this.active || !this.session.confirmation || this.imeActive) return;
    this.finishReplacement(this.session.confirm());
  }

  cancelReplacement(): void {
    if (!this.active || !this.session.confirmation || this.imeActive) return;
    this.reject();
  }

  handleEscape(): boolean {
    if (!this.active) return false;
    if (this.imeActive) return true;
    if (this.session.confirmation) {
      this.reject();
      return true;
    }
    if (this.picking) {
      this.returnToCode();
      return true;
    }
    return false;
  }

  close(): void {
    this.active = false;
    this.picking = false;
    this.pickerOrigin = null;
    ++this.sessionId;
    this.session.close();
    this.candidateValidation.cancel();
    this.preview.clear();
    this.hideConfirmation();
    this.element.hidden = true;
    this.inputSnapshot = null;
    this.confirmationFocus = null;
    this.composing = false;
    this.compositionEndedAt = -Infinity;
    if (this.element.parentElement) this.element.after(this.options.bodyField);
    this.options.onDisplayStateChange(this.displayState);
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    this.preview.dispose();
    this.candidateValidation.dispose();
    const dialog = this.options.dialog;
    dialog.removeEventListener("keydown", this.onKeyDown, true);
    dialog.removeEventListener(
      "compositionstart",
      this.onCompositionStart,
      true,
    );
    dialog.removeEventListener("compositionend", this.onCompositionEnd, true);
  }

  private showPicker(origin: "initial" | "editor" = "editor"): void {
    if (!this.active || this.session.confirmation || this.imeActive) return;
    this.inputSnapshot = this.captureInput();
    this.picking = true;
    this.pickerOrigin = origin;
    this.editor.hidden = this.toolbar.hidden = true;
    this.picker.element.hidden = false;
    this.options.onScreenChange(false);
    this.picker.previewSlot.append(this.preview.element);
    this.picker.open();
    this.options.onDisplayStateChange(this.displayState);
  }

  private showCode(restoreInput: boolean): void {
    if (!this.active || this.session.confirmation) return;
    this.picking = false;
    this.candidateValidation.cancel();
    this.picker.element.hidden = true;
    this.editor.hidden = this.toolbar.hidden = false;
    this.previewPane.append(this.preview.element);
    this.preview.setSource(this.options.input.value, this.previewTarget);
    this.options.onScreenChange(true);
    this.options.input.focus({ preventScroll: true });
    if (restoreInput && this.inputSnapshot)
      this.restoreInput(this.inputSnapshot);
    this.options.onDisplayStateChange(this.displayState);
  }

  private requestApply(source: string): void {
    if (
      !this.active ||
      !this.picking ||
      this.session.confirmation ||
      this.imeActive
    )
      return;
    this.session.edit(this.options.input.value);
    const result = this.session.requestApply(
      source,
      this.inputSnapshot ?? this.captureInput(),
    );
    if (result === "confirm") this.showConfirmation();
    else if (result === "applied") this.finishReplacement();
    else this.showCode(true);
  }

  private requestRestore(): void {
    if (!this.isEditing || this.imeActive) return;
    this.session.edit(this.options.input.value);
    const snapshot = this.session.requestRestore();
    if (snapshot === "confirm") this.showConfirmation();
    else if (snapshot === "ready")
      this.finishReplacement(this.session.confirm());
  }

  private showConfirmation(): void {
    this.confirmationFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.confirmationText.textContent =
      this.session.confirmation === "restore"
        ? "Restore the code before replacement? This will discard your current input."
        : "Replace your current code with this template? You can undo this replacement here.";
    this.confirmation.hidden = false;
    this.options.input.readOnly = true;
    this.picker.element.inert = true;
    this.toolbar.inert = true;
    this.options.onScreenChange(false);
    this.options.onDisplayStateChange(this.displayState);
  }

  private reject(): void {
    this.session.reject();
    this.hideConfirmation();
    this.options.onScreenChange(this.isEditing);
    this.options.onDisplayStateChange(this.displayState);
    this.confirmationFocus?.focus({ preventScroll: true });
  }

  private hideConfirmation(): void {
    this.confirmation.hidden = true;
    this.options.input.readOnly = false;
    this.picker.element.inert = this.toolbar.inert = false;
  }

  private finishReplacement(snapshot?: MermaidDraftSnapshot): void {
    this.hideConfirmation();
    this.options.input.value = this.session.source;
    this.restore.hidden = !this.session.canRestore;
    this.showCode(false);
    if (snapshot) this.restoreInput(snapshot);
    else {
      this.options.input.setSelectionRange(0, 0);
      this.options.input.scrollTop = this.options.input.scrollLeft = 0;
    }
  }

  private captureInput(): MermaidDraftSnapshot {
    const input = this.options.input;
    return {
      source: input.value,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      selectionDirection: input.selectionDirection,
      scrollTop: input.scrollTop,
      scrollLeft: input.scrollLeft,
    };
  }

  private restoreInput(snapshot: MermaidDraftSnapshot): void {
    const input = this.options.input;
    input.setSelectionRange(
      snapshot.selectionStart,
      snapshot.selectionEnd,
      snapshot.selectionDirection,
    );
    input.scrollTop = snapshot.scrollTop;
    input.scrollLeft = snapshot.scrollLeft;
  }

  private get imeActive(): boolean {
    return this.composing || Date.now() - this.compositionEndedAt < 50;
  }
  private readonly onCompositionStart = (): void => {
    this.composing = true;
    if (this.active && !this.picking) this.options.onScreenChange(false);
    this.options.onDisplayStateChange(this.displayState);
  };
  private readonly onCompositionEnd = (): void => {
    this.composing = false;
    this.compositionEndedAt = Date.now();
    if (this.isEditing) this.options.onScreenChange(true);
    this.options.onDisplayStateChange(this.displayState);
    const sessionId = this.sessionId;
    setTimeout(() => {
      if (this.active && this.sessionId === sessionId)
        this.options.onDisplayStateChange(this.displayState);
    }, 55);
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.active) return;
    if (
      this.picking &&
      this.imeActive &&
      ["ArrowUp", "ArrowDown", "Home", "End", " "].includes(event.key)
    ) {
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === "Escape") {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        this.imeActive ||
        this.handleEscape()
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    } else if (
      event.key === "Enter" &&
      (event.isComposing ||
        event.keyCode === 229 ||
        this.imeActive ||
        (!this.isEditing && (event.ctrlKey || event.metaKey)))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  private button(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      if (!this.imeActive) action();
    });
    return button;
  }
}
