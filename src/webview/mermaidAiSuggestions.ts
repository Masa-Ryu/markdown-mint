import { matchCompletionInput } from "../core/inlineCompletion";
import {
  AI_LIMITS,
  isAiHostMessage,
  type AiHostMessage,
  type AiSuggestionAdoptionCheck,
  type AiSuggestionAdoptionValidation,
  type AiSuggestionRequest,
  type AiSuggestionResult,
  type AiSuggestionState,
  type AiTrigger,
  type AiWebviewMessage,
} from "../shared/aiSuggestions";
import { MAX_MERMAID_SOURCE_LENGTH } from "../shared/mermaid";
import type { MermaidDialogDisplayState } from "./mermaidDialog";
import {
  validateMermaidSource,
  type MermaidValidationResult,
} from "./mermaidValidation";
import { TextareaGhostSuggestion } from "./textareaGhostSuggestion";
import { isSuggestionInputType } from "./suggestionInputTypes";

interface MermaidSnapshot {
  readonly request: AiSuggestionRequest;
  readonly source: string;
  readonly position: number;
  readonly markdown: string;
  readonly documentId: string;
  readonly version: number;
  readonly revision: number;
  readonly dialogGeneration: number;
}
interface MermaidCandidate {
  readonly snapshot: MermaidSnapshot;
  readonly remaining: string;
}
interface PendingAdoption {
  readonly check: AiSuggestionAdoptionCheck;
  readonly candidate: MermaidCandidate;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface MermaidAiSuggestionsOptions {
  readonly input: HTMLTextAreaElement;
  canSuggest(): boolean;
  synced(): boolean;
  version(): number;
  documentId(): string | undefined;
  markdown(): string;
  dialogGeneration(): number;
  post(message: AiWebviewMessage): void;
  validate?(source: string): Promise<MermaidValidationResult>;
  reportStatus?(message: string): void;
}

/** Suggestions for the Mermaid dialog's unsaved textarea draft. */
export class MermaidAiSuggestionsController {
  private readonly ghost: TextareaGhostSuggestion;
  private state: AiSuggestionState | undefined;
  private displayState: MermaidDialogDisplayState = {
    screen: "closed",
    pickerOrigin: null,
    confirmation: null,
    imeActive: false,
  };
  private observedSource = "";
  private revision = 0;
  private sequence = 0;
  private adoptionSequence = 0;
  private pending: MermaidSnapshot | undefined;
  private validating: MermaidSnapshot | undefined;
  private candidate: MermaidCandidate | undefined;
  private adoption: PendingAdoption | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private compositionTimer: ReturnType<typeof setTimeout> | undefined;
  private beforeInputType: string | undefined;
  private composing = false;
  private compositionEndedAt = -Infinity;
  private accepting = false;
  private disposed = false;
  private suppressedKey: string | undefined;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly options: MermaidAiSuggestionsOptions) {
    this.ghost = new TextareaGhostSuggestion(options.input);
  }

  public attach(): void {
    const input = this.options.input;
    const listen = (
      target: EventTarget,
      type: string,
      listener: EventListener,
      capture = false,
    ): void => {
      target.addEventListener(type, listener, capture);
      this.cleanup.push(() =>
        target.removeEventListener(type, listener, capture),
      );
    };
    listen(
      input,
      "beforeinput",
      (event) => {
        this.beforeInputType = (event as InputEvent).inputType;
        if (!this.candidate) this.cancelPending();
      },
      true,
    );
    listen(input, "input", (event) => this.inputChanged(event as InputEvent));
    listen(
      input,
      "keydown",
      (event) => this.keyDown(event as KeyboardEvent),
      true,
    );
    listen(input, "compositionstart", () => this.compositionStart(), true);
    listen(input, "compositionend", () => this.compositionEnd(), true);
    for (const type of ["paste", "drop"])
      listen(input, type, () => this.invalidate(), true);
    for (const type of ["select", "keyup", "click"])
      listen(input, type, () => this.deferSelectionCheck());
    listen(input, "blur", () => this.invalidate(), true);
    listen(input, "scroll", () => this.ghost.sync());
    listen(input.ownerDocument, "selectionchange", () => {
      if (input.ownerDocument.activeElement === input)
        this.checkSelectionSnapshot();
    });
    listen(input.ownerDocument, "visibilitychange", () => {
      if (input.ownerDocument.hidden) this.invalidate();
    });
  }

  public get ownsFocusedSurface(): boolean {
    return (
      !this.disposed &&
      this.options.input.ownerDocument.activeElement === this.options.input &&
      this.isEligible()
    );
  }

  public surfaceStateChanged(state: MermaidDialogDisplayState): void {
    const wasEligible = this.dialogAllowsSuggestions();
    const sourceChanged = this.observedSource !== this.options.input.value;
    this.observedSource = this.options.input.value;
    this.displayState = state;
    const isEligible = this.dialogAllowsSuggestions();
    if (!isEligible || !wasEligible || sourceChanged) this.invalidate();
  }

  public onNativeDocumentChanged(
    documentId: string | undefined,
    version: number,
    markdown: string,
  ): void {
    const snapshot =
      this.pending ?? this.validating ?? this.candidate?.snapshot;
    if (
      snapshot &&
      (snapshot.documentId !== documentId ||
        snapshot.version !== version ||
        snapshot.markdown !== markdown)
    )
      this.invalidate();
  }

  public invalidate(): void {
    if (this.disposed) return;
    this.revision += 1;
    this.suppressedKey = undefined;
    this.clearTimer();
    this.cancelAdoption();
    this.cancelPending();
    this.clearCandidate(true);
    this.validating = undefined;
  }

  public handleMessage(message: AiHostMessage): void {
    if (this.disposed || !isAiHostMessage(message)) return;
    if (message.type === "ai-suggestion-state") {
      this.setState(message);
      return;
    }
    if (message.type === "ai-suggestion-trigger") {
      if (this.ownsFocusedSurface) this.manualTrigger(message.invocationId);
      return;
    }
    if (message.type === "ai-suggestion-snapshot-check") {
      const snapshot = this.pending;
      this.options.post({
        protocolVersion: 1,
        type: "ai-suggestion-snapshot-validation",
        requestId: message.requestId,
        sessionId: message.sessionId,
        current: Boolean(
          snapshot &&
          snapshot.request.requestId === message.requestId &&
          snapshot.request.sessionId === message.sessionId &&
          this.isCurrent(snapshot),
        ),
      });
      return;
    }
    if (message.type === "ai-suggestion-adoption-validation") {
      this.finishAdoption(message);
      return;
    }
    if (message.type === "ai-suggestion-result") void this.result(message);
  }

  private setState(state: AiSuggestionState): void {
    if (
      this.state &&
      state.sessionId === this.state.sessionId &&
      state.settingsGeneration < this.state.settingsGeneration
    )
      return;
    const changed =
      this.state?.sessionId !== state.sessionId ||
      this.state?.settingsGeneration !== state.settingsGeneration;
    const wasRestoring = this.state?.autoRestoreOnInput === true;
    const restoring = state.autoRestoreOnInput === true;
    if (
      changed ||
      state.active === false ||
      (!state.autoTrigger && this.hasAutomaticWork()) ||
      (this.state?.availability !== state.availability &&
        state.availability !== "ready" &&
        !(wasRestoring && restoring && state.availability === "preparing"))
    )
      this.invalidate();
    this.state = state;
  }

  private hasAutomaticWork(): boolean {
    return Boolean(
      this.timer !== undefined ||
      this.pending?.request.trigger === "auto" ||
      this.candidate?.snapshot.request.trigger === "auto",
    );
  }

  private dialogAllowsSuggestions(): boolean {
    return (
      this.displayState.screen === "editor" &&
      this.displayState.confirmation === null &&
      !this.displayState.imeActive
    );
  }

  private isEligible(): boolean {
    return (
      !this.disposed &&
      this.dialogAllowsSuggestions() &&
      this.options.canSuggest() &&
      Boolean(this.options.documentId()) &&
      this.state?.active !== false
    );
  }

  private inputChanged(event: InputEvent): void {
    const inputType = this.beforeInputType ?? event.inputType;
    this.beforeInputType = undefined;
    if (this.accepting) {
      this.accepting = false;
      this.revision += 1;
      this.clearTimer();
      this.cancelPending();
      this.clearCandidate(false);
      return;
    }
    if (this.composing || event.isComposing) {
      this.revision += 1;
      this.cancelPending();
      this.clearCandidate(true);
      return;
    }
    this.revision += 1;
    if (this.keepMatchingInput(inputType)) return;
    this.cancelAdoption();
    this.cancelPending();
    this.clearCandidate(true);
    this.validating = undefined;
    this.suppressedKey = undefined;
    if (isSuggestionInputType(inputType)) this.scheduleAuto(true);
  }

  private keepMatchingInput(inputType: string): boolean {
    const candidate = this.candidate;
    const input = this.options.input;
    if (
      !candidate ||
      !inputType.startsWith("insert") ||
      input.selectionStart !== input.selectionEnd ||
      input.selectionStart < candidate.snapshot.position
    )
      return false;
    const typed = input.value.slice(
      candidate.snapshot.position,
      input.selectionStart,
    );
    const expected =
      candidate.snapshot.source.slice(0, candidate.snapshot.position) +
      typed +
      candidate.snapshot.source.slice(candidate.snapshot.position);
    const match = matchCompletionInput(candidate.remaining, typed);
    if (!match || input.value !== expected) return false;
    if (!match.remaining) {
      this.clearCandidate(false);
      return true;
    }
    const snapshot: MermaidSnapshot = {
      ...candidate.snapshot,
      source: input.value,
      position: input.selectionStart,
      markdown: this.options.markdown(),
      version: this.options.version(),
      revision: this.revision,
      dialogGeneration: this.options.dialogGeneration(),
    };
    this.candidate = { snapshot, remaining: match.remaining };
    this.renderCandidate(this.candidate);
    return true;
  }

  private compositionStart(): void {
    if (this.compositionTimer !== undefined)
      clearTimeout(this.compositionTimer);
    this.compositionTimer = undefined;
    this.composing = true;
    this.revision += 1;
    this.cancelPending();
    this.clearCandidate(true);
    this.validating = undefined;
  }

  private compositionEnd(): void {
    this.composing = false;
    this.compositionEndedAt = Date.now();
    if (this.compositionTimer !== undefined)
      clearTimeout(this.compositionTimer);
    this.compositionTimer = setTimeout(() => {
      this.compositionTimer = undefined;
      if (
        this.ownsFocusedSurface &&
        this.state?.autoTrigger &&
        isSuggestionInputType(this.beforeInputType ?? "insertCompositionText")
      )
        this.scheduleAuto(true);
    }, 55);
  }

  private deferSelectionCheck(): void {
    setTimeout(() => this.checkSelectionSnapshot(), 0);
  }

  private checkSelectionSnapshot(): void {
    const snapshot =
      this.pending ?? this.candidate?.snapshot ?? this.validating;
    if (!snapshot) return;
    const input = this.options.input;
    if (
      input.selectionStart !== snapshot.position ||
      input.selectionEnd !== snapshot.position ||
      input.value !== snapshot.source
    )
      this.invalidate();
  }

  private keyDown(event: KeyboardEvent): void {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      this.composing ||
      this.displayState.imeActive ||
      Date.now() - this.compositionEndedAt < 50 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    let handled = false;
    if (event.key === "Tab" && this.candidate) {
      handled = this.acceptCandidate();
    } else if (
      event.key === "Escape" &&
      (this.pending ||
        this.validating ||
        this.candidate ||
        this.timer !== undefined)
    ) {
      this.invalidate();
      this.suppressedKey = this.suppressionKey();
      handled = true;
    } else if (
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      this.invalidate();
    }
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  private scheduleAuto(afterUserInput: boolean): void {
    const state = this.state;
    if (!state?.autoTrigger || !this.ownsFocusedSurface) return;
    const canRestore =
      state.availability === "needs-authorization" &&
      state.autoRestoreOnInput === true &&
      afterUserInput;
    if (state.availability !== "ready" && !canRestore) return;
    if (this.suppressedKey === this.suppressionKey()) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.request("auto", undefined, afterUserInput);
    }, AI_LIMITS.debounceMs);
  }

  private manualTrigger(invocationId: string): void {
    this.invalidate();
    this.options.input.focus({ preventScroll: true });
    setTimeout(() => this.request("manual", invocationId), 0);
  }

  private request(
    trigger: AiTrigger,
    invocationId?: string,
    afterUserInput = false,
  ): void {
    const state = this.state;
    const input = this.options.input;
    if (
      !state ||
      !this.ownsFocusedSurface ||
      !this.options.synced() ||
      this.composing ||
      input.selectionStart !== input.selectionEnd ||
      (trigger === "auto" &&
        (!state.autoTrigger ||
          (state.availability !== "ready" &&
            !(afterUserInput && state.autoRestoreOnInput === true))))
    ) {
      if (trigger === "manual")
        this.options.reportStatus?.(
          "Place the cursor in the Mermaid source editor to request a suggestion.",
        );
      return;
    }
    const source = input.value;
    const position = input.selectionStart;
    const documentId = this.options.documentId();
    if (
      source.length > MAX_MERMAID_SOURCE_LENGTH ||
      hasForbiddenControl(source) ||
      !documentId ||
      !this.isSafePosition(source, position)
    ) {
      if (trigger === "manual")
        this.options.reportStatus?.(
          "The Mermaid source cannot be suggested here.",
        );
      return;
    }
    this.cancelPending();
    this.clearCandidate(true);
    const request: AiSuggestionRequest = {
      protocolVersion: 1,
      type: "ai-suggestion-request",
      requestId: `ai-mermaid-${Date.now()}-${++this.sequence}`,
      sessionId: state.sessionId,
      documentId,
      baseVersion: this.options.version(),
      editorRevision: this.revision,
      settingsGeneration: state.settingsGeneration,
      position: 0,
      targetKind: "mermaid",
      trigger,
      surfaceText: source,
      surfacePosition: position,
      ...(afterUserInput && trigger === "auto" ? { afterUserInput: true } : {}),
      ...(invocationId && trigger === "manual" ? { invocationId } : {}),
    };
    const snapshot: MermaidSnapshot = {
      request,
      source,
      position,
      markdown: this.options.markdown(),
      documentId,
      version: this.options.version(),
      revision: this.revision,
      dialogGeneration: this.options.dialogGeneration(),
    };
    this.pending = snapshot;
    this.pendingTimer = setTimeout(() => {
      if (this.pending === snapshot) {
        this.pending = undefined;
        this.postCancel(snapshot);
        if (trigger === "manual")
          this.options.reportStatus?.(
            "The Mermaid suggestion request timed out.",
          );
      }
      this.pendingTimer = undefined;
    }, AI_LIMITS.deadlineMs);
    this.options.post(request);
  }

  private async result(message: AiSuggestionResult): Promise<void> {
    const snapshot = this.pending;
    if (!snapshot || message.requestId !== snapshot.request.requestId) return;
    this.pending = undefined;
    this.validating = snapshot;
    if (this.pendingTimer !== undefined) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    for (const key of [
      "sessionId",
      "documentId",
      "baseVersion",
      "editorRevision",
      "settingsGeneration",
      "position",
      "targetKind",
    ] as const)
      if (message[key] !== snapshot.request[key]) return;
    if (!this.isCurrent(snapshot)) {
      this.validating = undefined;
      return;
    }
    if (message.reason !== "ready") {
      this.validating = undefined;
      if (snapshot.request.trigger === "manual")
        this.options.reportStatus?.(reasonText(message.reason));
      return;
    }
    const proposed =
      snapshot.source.slice(0, snapshot.position) +
      message.text +
      snapshot.source.slice(snapshot.position);
    let validation: MermaidValidationResult;
    try {
      validation = await (this.options.validate ?? validateMermaidSource)(
        proposed,
      );
    } catch {
      validation = { valid: false, errorKind: "runtime" };
    }
    if (this.validating !== snapshot) return;
    const current = this.isCurrent(snapshot);
    this.validating = undefined;
    if (!validation.valid || !current) {
      if (
        snapshot.request.trigger === "manual" &&
        validation.errorKind === "syntax"
      )
        this.options.reportStatus?.(
          "The Mermaid suggestion was skipped because it would make the diagram invalid.",
        );
      return;
    }
    const candidate = { snapshot, remaining: message.text };
    this.candidate = candidate;
    this.renderCandidate(candidate);
    this.options.reportStatus?.(
      "Suggestion available. Press Tab to accept or Escape to dismiss.",
    );
  }

  private isCurrent(snapshot: MermaidSnapshot): boolean {
    const state = this.state;
    const input = this.options.input;
    const ownsWork =
      this.pending === snapshot ||
      this.validating === snapshot ||
      this.candidate?.snapshot === snapshot;
    return Boolean(
      ownsWork &&
      this.isEligible() &&
      input.ownerDocument.activeElement === input &&
      state &&
      state.sessionId === snapshot.request.sessionId &&
      state.active !== false &&
      state.settingsGeneration === snapshot.request.settingsGeneration &&
      (snapshot.request.trigger === "manual" || state.autoTrigger) &&
      snapshot.documentId === this.options.documentId() &&
      snapshot.version === this.options.version() &&
      snapshot.markdown === this.options.markdown() &&
      snapshot.revision === this.revision &&
      snapshot.dialogGeneration === this.options.dialogGeneration() &&
      snapshot.source === input.value &&
      snapshot.position === input.selectionStart &&
      input.selectionStart === input.selectionEnd,
    );
  }

  private renderCandidate(candidate: MermaidCandidate): void {
    this.ghost.show(
      candidate.snapshot.source.slice(0, candidate.snapshot.position),
      candidate.remaining,
      candidate.snapshot.source.slice(candidate.snapshot.position),
    );
  }

  private acceptCandidate(): boolean {
    const candidate = this.candidate;
    if (!candidate || !this.isCurrent(candidate.snapshot)) {
      this.invalidate();
      return false;
    }
    if (this.state?.modelSelectionStale)
      return this.beginAdoptionValidation(candidate);
    return this.commitCandidate(candidate);
  }

  private beginAdoptionValidation(candidate: MermaidCandidate): boolean {
    if (this.adoption) return true;
    const request = candidate.snapshot.request;
    const check: AiSuggestionAdoptionCheck = {
      protocolVersion: 1,
      type: "ai-suggestion-adoption-check",
      attemptId: `ai-mermaid-adopt-${Date.now()}-${++this.adoptionSequence}`,
      requestId: request.requestId,
      sessionId: request.sessionId,
      documentId: request.documentId,
      baseVersion: request.baseVersion,
      editorRevision: request.editorRevision,
      settingsGeneration: request.settingsGeneration,
      position: request.position,
      targetKind: request.targetKind,
    };
    const pending: PendingAdoption = {
      check,
      candidate,
      timer: setTimeout(() => {
        if (this.adoption !== pending) return;
        this.adoption = undefined;
        this.clearCandidate(true);
        this.options.reportStatus?.(
          "The changed Copilot model could not be verified. Type again to request a new suggestion.",
        );
      }, AI_LIMITS.modelValidationDeadlineMs),
    };
    this.adoption = pending;
    this.options.post(check);
    return true;
  }

  private finishAdoption(validation: AiSuggestionAdoptionValidation): void {
    const pending = this.adoption;
    if (
      !pending ||
      pending.check.attemptId !== validation.attemptId ||
      pending.check.requestId !== validation.requestId ||
      pending.check.sessionId !== validation.sessionId
    )
      return;
    clearTimeout(pending.timer);
    this.adoption = undefined;
    if (
      this.candidate !== pending.candidate ||
      !validation.available ||
      !this.isCurrent(pending.candidate.snapshot)
    ) {
      if (this.candidate === pending.candidate) this.clearCandidate(true);
      this.options.reportStatus?.(
        "The model or suggestion changed. Type again to request a new suggestion.",
      );
      return;
    }
    if (this.state) this.state = { ...this.state, modelSelectionStale: false };
    this.commitCandidate(pending.candidate);
  }

  private commitCandidate(candidate: MermaidCandidate): boolean {
    if (!this.isCurrent(candidate.snapshot)) return false;
    const input = this.options.input;
    const position = candidate.snapshot.position;
    input.setRangeText(candidate.remaining, position, position, "end");
    this.candidate = undefined;
    this.postCancel(candidate.snapshot);
    this.ghost.hide();
    this.accepting = true;
    const InputEventConstructor = input.ownerDocument.defaultView?.InputEvent;
    const event = InputEventConstructor
      ? new InputEventConstructor("input", {
          bubbles: true,
          inputType: "insertText",
          data: candidate.remaining,
        })
      : new Event("input", { bubbles: true });
    input.dispatchEvent(event);
    return true;
  }

  private cancelPending(): void {
    const snapshot = this.pending;
    this.pending = undefined;
    if (this.pendingTimer !== undefined) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    if (snapshot) this.postCancel(snapshot);
  }

  private clearCandidate(sendCancel: boolean): void {
    const candidate = this.candidate;
    this.candidate = undefined;
    if (sendCancel && candidate) this.postCancel(candidate.snapshot);
    this.ghost.hide();
  }

  private cancelAdoption(): void {
    const adoption = this.adoption;
    this.adoption = undefined;
    if (adoption) clearTimeout(adoption.timer);
  }

  private postCancel(snapshot: MermaidSnapshot): void {
    this.options.post({
      protocolVersion: 1,
      type: "ai-suggestion-cancel",
      requestId: snapshot.request.requestId,
      sessionId: snapshot.request.sessionId,
    });
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private suppressionKey(): string {
    const state = this.state;
    const input = this.options.input;
    return [
      this.options.documentId() ?? "",
      this.options.version(),
      state?.sessionId ?? "",
      this.options.dialogGeneration(),
      input.selectionStart,
      input.value,
    ].join(":");
  }

  private isSafePosition(source: string, position: number): boolean {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position > source.length
    )
      return false;
    const code = source.charCodeAt(position);
    return !(code >= 0xdc00 && code <= 0xdfff);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
    if (this.compositionTimer !== undefined)
      clearTimeout(this.compositionTimer);
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.ghost.dispose();
    this.state = undefined;
  }
}

function hasForbiddenControl(source: string): boolean {
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    )
      return true;
  }
  return false;
}

function reasonText(reason: AiSuggestionResult["reason"]): string {
  switch (reason) {
    case "needs-authorization":
      return "Copilot access is not authorized. Use the Copilot control to enable suggestions.";
    case "no-model":
      return "No Copilot language model is available.";
    case "untrusted":
      return "Copilot suggestions are unavailable in Restricted Mode.";
    case "unsafe-suggestion":
      return "The suggestion did not preserve the Mermaid diagram.";
    case "invalid-context":
      return "The Mermaid source is too large or the cursor position is invalid.";
    case "timeout":
      return "The Copilot suggestion request timed out.";
    case "stale":
    case "cancelled":
      return "The Mermaid suggestion was cancelled because the editor changed.";
    default:
      return "No Mermaid suggestion is available.";
  }
}
