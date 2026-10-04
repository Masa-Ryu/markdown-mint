import { MermaidPreview } from "./mermaidPreview";
import { MermaidTemplatePicker } from "./mermaidTemplatePicker";
import { MermaidTemplateSession } from "./mermaidTemplateSession";
import type { MermaidTemplateApplication } from "./mermaidTemplateSession";
import { getMermaidTemplate } from "./mermaidTemplates";
import type { MermaidValidationSnapshot } from "./mermaidValidation";

export interface MermaidDialogDisplayState {
  readonly screen: "closed" | "picker" | "editor";
  readonly pickerOrigin: "initial" | "editor" | null;
  readonly confirmation: "apply" | null;
  readonly imeActive: boolean;
}

export interface MermaidAppliedTemplate extends MermaidTemplateApplication {
  readonly diagram: string;
}

interface MermaidInputSnapshot {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: "forward" | "backward" | "none";
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

/** Mermaid-only modal UI. The editor owns all document writes and draft validation. */
export class MermaidDialog {
  readonly element: HTMLElement;
  private readonly session = new MermaidTemplateSession();
  private readonly preview: MermaidPreview;
  private readonly picker: MermaidTemplatePicker;
  private readonly editor: HTMLElement;
  private readonly codePane: HTMLElement;
  private readonly previewPane: HTMLElement;
  private readonly confirmation: HTMLElement;
  private readonly confirmationText: HTMLElement;
  private pickerReturnSnapshot: MermaidInputSnapshot | null = null;
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
    this.preview = new MermaidPreview(
      document,
      undefined,
      options.onRuntimeReady,
    );
    this.element = document.createElement("div");
    this.element.className = "mm-mermaid-workspace";
    this.element.hidden = true;
    this.editor = document.createElement("div");
    this.editor.className = "mm-mermaid-code-preview";
    this.codePane = document.createElement("div");
    this.codePane.className = "mm-mermaid-code-pane";
    this.previewPane = document.createElement("div");
    this.previewPane.className = "mm-mermaid-preview-slot";
    this.editor.append(this.codePane, this.previewPane);
    this.picker = new MermaidTemplatePicker({
      select: (selection) => {
        if (!this.active || !this.picking) return;
        this.preview.renderTemplate(
          selection.template.id,
          selection.direction,
          selection.source,
          this.previewTarget,
        );
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
    this.element.append(this.confirmation, this.editor, this.picker.element);
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
  get appliedTemplate(): MermaidAppliedTemplate | null {
    const source = this.options.input.value;
    const application = this.session.appliedTemplateFor(source);
    const template = application
      ? getMermaidTemplate(application.id)
      : undefined;
    return application && template
      ? { ...application, diagram: template.diagram }
      : null;
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
    if (pick) this.showPicker("initial");
    else this.showCode(false);
  }

  inputChanged(): void {
    if (!this.active) return;
    this.session.noteUserInput(this.options.input.value);
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

  openTemplates(): void {
    if (
      !this.active ||
      this.picking ||
      this.session.confirmation ||
      this.imeActive ||
      this.disposed
    )
      return;
    this.showPicker("editor");
  }

  confirmReplacement(): void {
    if (!this.active || !this.session.confirmation || this.imeActive) return;
    this.session.confirm();
    this.finishApply();
  }

  cancelReplacement(): void {
    if (!this.active || !this.session.confirmation || this.imeActive) return;
    this.reject();
  }

  close(): void {
    this.active = false;
    this.picking = false;
    this.pickerOrigin = null;
    ++this.sessionId;
    this.session.close();
    this.preview.clear();
    this.hideConfirmation();
    this.element.hidden = true;
    this.pickerReturnSnapshot = null;
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
    this.pickerReturnSnapshot = this.captureInput();
    this.picking = true;
    this.pickerOrigin = origin;
    this.editor.hidden = true;
    this.picker.element.hidden = false;
    this.options.onScreenChange(false);
    this.picker.previewSlot.append(this.preview.element);
    this.picker.open();
    this.options.onDisplayStateChange(this.displayState);
  }

  private showCode(returningFromPicker: boolean): void {
    if (!this.active || this.session.confirmation) return;
    this.picking = false;
    this.picker.element.hidden = true;
    this.editor.hidden = false;
    this.previewPane.append(this.preview.element);
    this.session.syncDraft(this.options.input.value);
    const appliedTemplate = this.session.appliedTemplateFor(
      this.options.input.value,
    );
    if (appliedTemplate)
      this.preview.renderTemplate(
        appliedTemplate.id,
        appliedTemplate.direction,
        appliedTemplate.source,
        this.previewTarget,
      );
    else this.preview.setSource(this.options.input.value, this.previewTarget);
    this.options.onScreenChange(true);
    this.options.input.focus({ preventScroll: true });
    if (returningFromPicker && this.pickerReturnSnapshot)
      this.applyPickerReturnSnapshot(this.pickerReturnSnapshot);
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
    this.session.syncDraft(this.options.input.value);
    const selected = this.picker.selection;
    const application: MermaidTemplateApplication = {
      id: selected.template.id,
      ...(selected.direction ? { direction: selected.direction } : {}),
      source,
    };
    const result = this.session.requestApply(application);
    if (result === "confirm") this.showConfirmation();
    else if (result === "applied") this.finishApply();
    else this.showCode(true);
  }

  private showConfirmation(): void {
    this.confirmationFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.confirmationText.textContent =
      "Replace your current code with this template? This will discard your current input.";
    this.confirmation.hidden = false;
    this.options.input.readOnly = true;
    this.picker.element.inert = true;
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
    this.picker.element.inert = false;
  }

  private finishApply(): void {
    this.hideConfirmation();
    this.options.input.value = this.session.source;
    this.showCode(false);
    this.options.input.setSelectionRange(0, 0);
    this.options.input.scrollTop = this.options.input.scrollLeft = 0;
  }

  private captureInput(): MermaidInputSnapshot {
    const input = this.options.input;
    return {
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      selectionDirection: input.selectionDirection,
      scrollTop: input.scrollTop,
      scrollLeft: input.scrollLeft,
    };
  }

  private applyPickerReturnSnapshot(snapshot: MermaidInputSnapshot): void {
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
      if (event.isComposing || event.keyCode === 229 || this.imeActive) {
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
}
