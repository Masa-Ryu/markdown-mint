export type DialogCancelReason = "backdrop" | "escape" | "cancel-button";

export interface ModalCancelBehaviorOptions {
  readonly dialog: HTMLDialogElement;
  readonly getSnapshot: () => unknown;
  readonly onCancelRequest: (reason: DialogCancelReason) => void;
  /**
   * A second dialog can be stacked above the editing dialog. In that case the
   * editing dialog must not react to pointer events intended for the top one.
   */
  readonly isActive?: () => boolean;
}

interface PointerSequence {
  readonly pointerId: number;
  readonly downOutside: boolean;
}

/** Serialize the semantic values of a dialog for exact snapshot comparison. */
export function serializeDialogSnapshot(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

/** Return whether a pointer coordinate is outside the dialog's own rectangle. */
export function isPointerOutsideDialog(
  dialog: HTMLDialogElement,
  event: Pick<PointerEvent, "clientX" | "clientY">,
): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

/**
 * Shared event and snapshot plumbing for input dialogs.
 *
 * EditorApp owns the document-specific cancel policy and the discard dialog;
 * this class only identifies a cancel request and reports whether the current
 * semantic input values differ from the snapshot captured at open time.
 */
export class ModalCancelBehavior {
  private readonly dialog: HTMLDialogElement;
  private readonly getSnapshot: () => unknown;
  private readonly onCancelRequest: (reason: DialogCancelReason) => void;
  private readonly isActive: () => boolean;
  private initialSnapshot: string | null = null;
  private hasSnapshot = false;
  private pointerSequence: PointerSequence | null = null;
  private suppressNextNativeCancel = false;
  private lastFocusedElement: HTMLElement | null = null;
  private installed = false;

  private readonly keydownHandler = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || (!event.isComposing && event.keyCode !== 229))
      return;
    this.suppressNextNativeCancel = true;
    queueMicrotask(() => {
      this.suppressNextNativeCancel = false;
    });
  };

  private readonly cancelHandler = (event: Event): void => {
    if (!this.dialog.open) return;
    // Always suppress the browser's implicit close. EditorApp decides whether
    // this is a clean close or needs the discard confirmation.
    event.preventDefault();
    if (
      event instanceof KeyboardEvent &&
      (event.isComposing || event.keyCode === 229)
    )
      return;
    if (this.suppressNextNativeCancel) {
      this.suppressNextNativeCancel = false;
      return;
    }
    if (this.isActive()) this.requestCancel("escape");
  };

  private readonly pointerDownHandler = (event: PointerEvent): void => {
    if (!this.canHandlePointer(event)) return;
    this.pointerSequence = {
      pointerId: this.pointerId(event),
      downOutside: isPointerOutsideDialog(this.dialog, event),
    };
  };

  private readonly pointerUpHandler = (event: PointerEvent): void => {
    if (!this.canHandlePointer(event)) return;
    const sequence = this.pointerSequence;
    const currentPointerId = this.pointerId(event);
    if (!sequence || sequence.pointerId !== currentPointerId) return;
    this.pointerSequence = null;
    const upOutside = isPointerOutsideDialog(this.dialog, event);
    if (!sequence.downOutside || !upOutside) return;
    event.preventDefault();
    this.requestCancel("backdrop");
  };

  private readonly pointerCancelHandler = (event: PointerEvent): void => {
    if (this.pointerSequence?.pointerId === this.pointerId(event))
      this.pointerSequence = null;
  };

  private readonly focusInHandler = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !this.dialog.contains(target))
      return;
    if (target.closest(".mm-dialog-actions")) return;
    this.lastFocusedElement = target;
  };

  private readonly closeHandler = (): void => {
    // A programmatic close is a committed close path owned by EditorApp. It
    // must not leave the old draft snapshot attached to the next opening.
    this.clearSnapshot();
  };

  public constructor(options: ModalCancelBehaviorOptions) {
    this.dialog = options.dialog;
    this.getSnapshot = options.getSnapshot;
    this.onCancelRequest = options.onCancelRequest;
    this.isActive = options.isActive ?? (() => true);
  }

  public install(): void {
    if (this.installed) return;
    this.installed = true;
    const ownerDocument = this.dialog.ownerDocument;
    ownerDocument.addEventListener(
      "pointerdown",
      this.pointerDownHandler,
      true,
    );
    ownerDocument.addEventListener("pointerup", this.pointerUpHandler, true);
    ownerDocument.addEventListener(
      "pointercancel",
      this.pointerCancelHandler,
      true,
    );
    this.dialog.addEventListener("cancel", this.cancelHandler);
    this.dialog.addEventListener("keydown", this.keydownHandler, true);
    this.dialog.addEventListener("focusin", this.focusInHandler);
    this.dialog.addEventListener("close", this.closeHandler);
  }

  public dispose(): void {
    if (!this.installed) return;
    this.installed = false;
    const ownerDocument = this.dialog.ownerDocument;
    ownerDocument.removeEventListener(
      "pointerdown",
      this.pointerDownHandler,
      true,
    );
    ownerDocument.removeEventListener("pointerup", this.pointerUpHandler, true);
    ownerDocument.removeEventListener(
      "pointercancel",
      this.pointerCancelHandler,
      true,
    );
    this.dialog.removeEventListener("cancel", this.cancelHandler);
    this.dialog.removeEventListener("keydown", this.keydownHandler, true);
    this.dialog.removeEventListener("focusin", this.focusInHandler);
    this.dialog.removeEventListener("close", this.closeHandler);
    this.clearSnapshot();
  }

  public captureSnapshot(): void {
    this.initialSnapshot = this.readSnapshot();
    this.hasSnapshot = true;
    this.pointerSequence = null;
    this.suppressNextNativeCancel = false;
    this.lastFocusedElement = null;
    this.rememberActiveElement();
  }

  public clearSnapshot(): void {
    this.initialSnapshot = null;
    this.hasSnapshot = false;
    this.pointerSequence = null;
    this.suppressNextNativeCancel = false;
    this.lastFocusedElement = null;
  }

  public isDirty(): boolean {
    if (!this.hasSnapshot) return false;
    const currentSnapshot = this.readSnapshot();
    // A failed read is treated as dirty so a draft is never discarded without
    // a confirmation merely because serialization failed.
    return (
      currentSnapshot === null ||
      this.initialSnapshot === null ||
      currentSnapshot !== this.initialSnapshot
    );
  }

  public requestCancel(reason: DialogCancelReason): void {
    if (!this.dialog.open || !this.isActive()) return;
    this.onCancelRequest(reason);
  }

  public getLastFocusedElement(): HTMLElement | null {
    if (
      this.lastFocusedElement?.isConnected &&
      this.dialog.contains(this.lastFocusedElement)
    )
      return this.lastFocusedElement;
    const active = this.dialog.ownerDocument.activeElement;
    if (active instanceof HTMLElement && this.dialog.contains(active))
      return active;
    return this.dialog.querySelector<HTMLElement>(
      "input, textarea, select, [role='grid'], [contenteditable='true']",
    );
  }

  private readSnapshot(): string | null {
    try {
      return serializeDialogSnapshot(this.getSnapshot());
    } catch {
      return null;
    }
  }

  private rememberActiveElement(): void {
    const active = this.dialog.ownerDocument.activeElement;
    if (active instanceof HTMLElement && this.dialog.contains(active))
      this.lastFocusedElement = active;
  }

  private canHandlePointer(event: Pick<PointerEvent, "button">): boolean {
    if (!this.dialog.open || !this.isActive()) return false;
    return event.button === undefined || event.button === 0;
  }

  private pointerId(event: Pick<PointerEvent, "pointerId">): number {
    return typeof event.pointerId === "number" ? event.pointerId : 0;
  }
}
